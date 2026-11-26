import { defineAction } from "../defineAction.js";
import {
	entityDeriveInputSchema,
	isCandidateForDerivation,
	isUndecodedBinaryText,
	buildDerivePrompt,
	buildEntityProperties,
	parseExtractionResponse,
	EXTRACT_ENTITIES_SYSTEM_PROMPT,
	MAX_DERIVE_ATTEMPTS,
	type EntityDeriveInput,
	type EntityDeriveOutput,
	type CandidateArtifact,
	type ExtractedEntity,
} from "../domain/derive.js";
import type {
	DerivationRecord,
	DeriveDecisionRecord,
	EntityDerivePorts,
} from "../domain/derivePorts.js";
import {
	classifyDecisionConfidenceBand,
	DERIVE_PREFILTER_MIN_PROBABILITY,
	probabilityOfYes,
	type DecisionJudgeResult,
} from "../../ports/decisionJudge.js";
import type { ActionContext } from "../types.js";

export type { EntityDerivePorts } from "../domain/derivePorts.js";

/** Pages scanned (at most) while looking for `limit` qualifying candidates. */
const MAX_CANDIDATE_PAGES = 10;
const CANDIDATE_PAGE_SIZE = 50;
const DERIVE_JUDGE_SYSTEM_PROMPT =
	"You screen knowledge-graph artifacts and candidate entities. Answer with a single token: yes or no.";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function extractNoulProbability(result: DecisionJudgeResult): number {
	if (typeof result.distribution?.yes === "number" && Number.isFinite(result.distribution.yes)) {
		return probabilityOfYes(result);
	}
	if (typeof result.distribution?.no === "number" && Number.isFinite(result.distribution.no)) {
		return Math.max(0, 1 - result.distribution.no);
	}
	if (result.choice.toLowerCase() === "no") {
		return result.confidence <= 0.5 ? result.confidence : Math.max(0, 1 - result.confidence);
	}
	return result.confidence;
}

function buildDurableEntitiesPrompt(text: string, title?: string | null): string {
	return [
		"Question: does this artifact contain durable named entities (people, organizations, projects, topics, events) worth extracting into the knowledge graph?",
		`Title: ${title ?? "(untitled)"}`,
		`Excerpt: ${text.slice(0, 1500)}`,
		"Answer yes or no.",
	].join("\n");
}

function buildEntityJudgePrompt(entity: ExtractedEntity, text: string, title?: string | null): string {
	return [
		`Question: is "${entity.title}" (${entity.entity_type}) a real, durable entity clearly supported by this artifact?`,
		`Artifact title: ${title ?? "(untitled)"}`,
		`Excerpt: ${text.slice(0, 1000)}`,
		"Answer yes or no.",
	].join("\n");
}

function previousAttempts(artifact: CandidateArtifact): number {
	const derivation = (artifact.processing_metadata as Record<string, any> | null | undefined)?.derivation;
	const attempts = derivation?.attempts;
	if (typeof attempts === "number" && Number.isFinite(attempts)) return attempts;
	return derivation?.status === "failed" ? 1 : 0;
}

async function selectCandidates(
	input: { artifactIds: string[]; limit: number; force: boolean },
	userId: string,
	ports: EntityDerivePorts,
): Promise<CandidateArtifact[]> {
	const now = Date.now();
	if (input.artifactIds.length > 0) {
		// Explicit ids are owner-scoped, subject to the same qualification rules
		// and to the same per-run limit as the cadence.
		const rows = await ports.fetchArtifactsByIds(userId, input.artifactIds);
		return rows
			.filter((r) => isCandidateForDerivation(r, input.force, now))
			.slice(0, input.limit);
	}

	const selected: CandidateArtifact[] = [];
	for (let page = 0; page < MAX_CANDIDATE_PAGES && selected.length < input.limit; page++) {
		const rows = await ports.fetchCandidatePage({
			userId,
			offset: page * CANDIDATE_PAGE_SIZE,
			pageSize: CANDIDATE_PAGE_SIZE,
		});
		for (const row of rows) {
			if (isCandidateForDerivation(row, input.force, now)) selected.push(row);
			if (selected.length >= input.limit) break;
		}
		if (rows.length < CANDIDATE_PAGE_SIZE) break;
	}
	return selected;
}

/**
 * Core derivation pipeline logic executing across candidate artifacts.
 *
 * Requires `context.userId`: derivation writes owner-scoped rows, so there is
 * no fallback identity (#1306 C1).
 */
export async function executeEntityDerive(
	rawInput: EntityDeriveInput,
	context: ActionContext,
	ports: EntityDerivePorts,
): Promise<EntityDeriveOutput> {
	const userId = context.userId;
	if (!userId) {
		throw new Error("entity_derive requires an owner userId; refusing to run without one");
	}

	const input = entityDeriveInputSchema.parse(rawInput);
	const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
	const force = input.force ?? false;
	const artifactIds = [...new Set([...(input.artifact_id ? [input.artifact_id] : []), ...(input.artifact_ids ?? [])])];

	const artifacts = await selectCandidates({ artifactIds, limit, force }, userId, ports);

	let totalEntitiesCreated = 0;
	let totalEntitiesLinked = 0;
	let totalRelationshipsCreated = 0;
	let failed = 0;
	const notes: string[] = [];

	const save = async (artifactId: string, record: DerivationRecord): Promise<boolean> => {
		try {
			await ports.saveDerivation(userId, artifactId, record);
			return true;
		} catch (err) {
			notes.push(`[${artifactId}] Could not persist derivation status: ${errMessage(err)}`);
			return false;
		}
	};

	for (const artifact of artifacts) {
		const attempts = previousAttempts(artifact) + 1;
		const now = () => new Date().toISOString();

		try {
			const text = (artifact.plain_text ?? "").trim();
			const skipReason =
				text.length < 50
					? "text content too short for derivation (< 50 chars)"
					: isUndecodedBinaryText(text)
						? "undecoded binary content detected (%PDF-1.4 or raw bytes)"
						: null;
			if (skipReason) {
				await save(artifact.id, {
					derived_at: now(),
					status: "skipped",
					attempts,
					skip_reason: skipReason,
				});
				notes.push(`[${artifact.id}] Skipped: ${skipReason}`);
				continue;
			}

			const judgeProbabilities: Record<string, number> = {};
			if (ports.judge) {
				const prefilter = await ports.judge.evaluate({
					kind: "noul",
					id: "contains_durable_entities",
					system: DERIVE_JUDGE_SYSTEM_PROMPT,
					prompt: buildDurableEntitiesPrompt(text, artifact.title),
				});
				if (prefilter) {
					const pDurable = extractNoulProbability(prefilter);
					judgeProbabilities.contains_durable_entities = Math.round(pDurable * 100) / 100;
					if (pDurable < DERIVE_PREFILTER_MIN_PROBABILITY) {
						const durableSkipReason = `contains_durable_entities below threshold (${pDurable.toFixed(2)} < ${DERIVE_PREFILTER_MIN_PROBABILITY.toFixed(2)})`;
						await save(artifact.id, {
							derived_at: now(),
							status: "skipped",
							attempts,
							skip_reason: durableSkipReason,
						});
						notes.push(`[${artifact.id}] Skipped: ${durableSkipReason}`);
						continue;
					}
				}
			}

			const llm = await ports.generate({
				system: EXTRACT_ENTITIES_SYSTEM_PROMPT,
				prompt: buildDerivePrompt(text, artifact.title, artifact.trust_override),
				provider: input.provider,
				model: input.model,
			});
			const extraction = parseExtractionResponse(llm.text, artifact.trust_override);

			const calibratedEntities: ExtractedEntity[] = [];
			for (const rawEntity of extraction.entities) {
				let entity = rawEntity;
				if (ports.judge) {
					const entityIdKey = `entity:${rawEntity.entity_type}:${rawEntity.title}`;
					const judged = await ports.judge.evaluate({
						kind: "noul",
						id: entityIdKey,
						system: DERIVE_JUDGE_SYSTEM_PROMPT,
						prompt: buildEntityJudgePrompt(rawEntity, text, artifact.title),
					});
					if (judged) {
						const calibrated = Math.round(extractNoulProbability(judged) * 100) / 100;
						judgeProbabilities[entityIdKey] = calibrated;
						if (classifyDecisionConfidenceBand(calibrated) === "discard") {
							notes.push(`[${artifact.id}] Dropped low-confidence entity "${rawEntity.title}" (${calibrated})`);
							continue;
						}
						entity = { ...rawEntity, confidence: calibrated };
					}
				}
				calibratedEntities.push(entity);
			}

			const titleToEntityId = new Map<string, string>();
			const decisionEntities: DeriveDecisionRecord["entities"] = [];
			const decisionRelationships: DeriveDecisionRecord["relationships"] = [];
			let createdCount = 0;
			let linkedCount = 0;
			let relsCreated = 0;
			let writeFailures = 0;

			for (const entity of calibratedEntities) {
				try {
					const { id: entityId, created } = await resolveEntity(userId, entity, ports);
					if (created) createdCount++;
					await ports.linkArtifactEntity(userId, artifact.id, entityId, entity.confidence);
					linkedCount++;
					titleToEntityId.set(entity.title.toLowerCase(), entityId);
					decisionEntities.push({
						id: entityId,
						title: entity.title,
						entity_type: entity.entity_type,
						created,
						confidence: entity.confidence,
					});
				} catch (err) {
					writeFailures++;
					notes.push(`[${artifact.id}] Entity "${entity.title}" failed: ${errMessage(err)}`);
				}
			}

			for (const rel of extraction.relationships) {
				const fromId = titleToEntityId.get(rel.source_title.toLowerCase());
				const toId = titleToEntityId.get(rel.target_title.toLowerCase());
				if (!fromId || !toId || fromId === toId) continue;
				try {
					await ports.createRelationship(userId, {
						fromEntityId: fromId,
						toEntityId: toId,
						relationshipType: rel.relationship_type,
						confidence: rel.confidence,
						artifactId: artifact.id,
					});
					relsCreated++;
					decisionRelationships.push({ from: fromId, to: toId, relationship_type: rel.relationship_type });
				} catch (err) {
					writeFailures++;
					notes.push(
						`[${artifact.id}] Edge ${rel.source_title} -> ${rel.target_title} failed: ${errMessage(err)}`,
					);
				}
			}

			totalEntitiesCreated += createdCount;
			totalEntitiesLinked += linkedCount;
			totalRelationshipsCreated += relsCreated;

			if (writeFailures > 0) {
				failed++;
				await save(artifact.id, {
					derived_at: now(),
					status: "failed",
					attempts,
					provider: llm.provider,
					model: llm.model,
					error: `${writeFailures} write(s) failed; will retry (attempt ${attempts}/${MAX_DERIVE_ATTEMPTS})`,
				});
				continue;
			}

			const saved = await save(artifact.id, {
				derived_at: now(),
				status: "completed",
				attempts,
				provider: llm.provider,
				model: llm.model,
				entities_count: linkedCount,
				entities_created: createdCount,
				relationships_count: relsCreated,
			});
			if (!saved) failed++;

			if (decisionEntities.length > 0 || decisionRelationships.length > 0) {
				const confidence = averageConfidence(calibratedEntities);
				const band = confidence === null ? "auto_applied" : classifyDecisionConfidenceBand(confidence);
				const isPending = band === "pending";
				try {
					await ports.recordDecision({
						userId,
						artifactId: artifact.id,
						provider: llm.provider,
						model: llm.model,
						confidence,
						entities: decisionEntities,
						relationships: decisionRelationships,
						status: isPending ? "pending" : "auto_applied",
						requires_user_action: isPending,
						user_visible: isPending,
						review_type: isPending ? "clarification" : "suggestion",
						confidence_band: band,
						...(Object.keys(judgeProbabilities).length > 0 ? { judge_probabilities: judgeProbabilities } : {}),
					});
				} catch (err) {
					notes.push(`[${artifact.id}] system_decisions record failed: ${errMessage(err)}`);
				}
			}

			notes.push(
				`[${artifact.id}] Derived ${linkedCount} entities (${createdCount} new) and ${relsCreated} relationships (${llm.provider}:${llm.model})`,
			);
		} catch (err) {
			failed++;
			const msg = errMessage(err);
			notes.push(`[${artifact.id}] Failed: ${msg}`);
			await save(artifact.id, {
				derived_at: now(),
				status: "failed",
				attempts,
				error: msg.slice(0, 500),
			});
		}
	}

	let remaining: number | null = null;
	if (artifactIds.length === 0) {
		try {
			remaining = await ports.countUnderived(userId);
		} catch (err) {
			notes.push(`remaining_underived unavailable: ${errMessage(err)}`);
		}
	}

	return {
		processed: artifacts.length,
		entities_created: totalEntitiesCreated,
		entities_linked: totalEntitiesLinked,
		relationships_created: totalRelationshipsCreated,
		remaining_underived: remaining,
		failed,
		notes,
	};
}

async function resolveEntity(
	userId: string,
	entity: ExtractedEntity,
	ports: EntityDerivePorts,
): Promise<{ id: string; created: boolean }> {
	// A failed lookup throws (it is not treated as "not found"), so a read error
	// can never fall through to creating a duplicate.
	const existing = await ports.findEntity(userId, entity.entity_type, entity.title);
	if (existing) return { id: existing, created: false };
	const withProps: ExtractedEntity = { ...entity, properties: buildEntityProperties(entity) };
	return { id: await ports.createEntity(userId, withProps), created: true };
}

function averageConfidence(entities: ExtractedEntity[]): number | null {
	if (entities.length === 0) return null;
	const sum = entities.reduce((acc, e) => acc + e.confidence, 0);
	return Math.round((sum / entities.length) * 100) / 100;
}

/**
 * Builds the typed entity_derive action over injected ports (ADR-100, ADR-101 §3).
 * Ports are a required parameter: there is no environment-reading default.
 */
export function createEntityDeriveAction(ports: EntityDerivePorts) {
	return defineAction({
		id: "entity_derive",
		domain: "kg",
		description:
			"Extracts structured entities and relationships from enriched artifacts and links them into the knowledge graph",
		schema: entityDeriveInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		expose: {
			mcp: false,
			http: false,
			ui_agent: false,
			reason: "app_internal",
			note: "LLM batch work runs in the engine through system_jobs (ADR-101 §4)",
		},
		async run(input, context) {
			return executeEntityDerive(input, context, ports);
		},
	});
}
