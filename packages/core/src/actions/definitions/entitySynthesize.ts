import { defineAction } from "../defineAction.js";
import {
	buildSynthesizePrompt,
	entitySynthesizeInputSchema,
	parseSynthesizedProfile,
	resolveSynthesizeModel,
	SYNTHESIZE_SYSTEM_PROMPT,
	type EntitySynthesizeInput,
	type EntitySynthesizeOutput,
} from "../domain/synthesize.js";
import type { EntitySynthesizePorts } from "../domain/synthesizePorts.js";
import type { ActionContext } from "../types.js";

export type { EntitySynthesizePorts } from "../domain/synthesizePorts.js";
export type { EntitySynthesizeInput, EntitySynthesizeOutput } from "../domain/synthesize.js";

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export async function executeEntitySynthesize(
	rawInput: EntitySynthesizeInput,
	context: ActionContext,
	ports: EntitySynthesizePorts,
): Promise<EntitySynthesizeOutput> {
	const userId = context.userId;
	if (!userId) {
		throw new Error("entity_synthesize requires an owner userId; refusing to run without one");
	}

	const input = entitySynthesizeInputSchema.parse(rawInput);
	const maxArtifacts = Math.min(Math.max(input.max_artifacts ?? 10, 1), 10);
	const dryRun = input.dry_run ?? false;
	const provider = input.provider ?? "gemini";
	const model = resolveSynthesizeModel(provider, input.model);

	const entity = await ports.fetchEntity(userId, input.entity_id);
	if (!entity) {
		throw new Error(`Entity ${input.entity_id} not found`);
	}

	const allLinked = await ports.fetchLinkedArtifacts(userId, input.entity_id, maxArtifacts);
	const artifacts = allLinked.filter((a) => (a.plain_text ?? "").trim().length > 0);

	if (artifacts.length === 0) {
		await ports.recordDecision({
			userId,
			entityId: entity.id,
			artifactIds: [],
			provider,
			model,
			outcome: "skipped",
			error: "no evidence",
		});
		return {
			status: "skipped",
			entity_id: entity.id,
			dry_run: dryRun,
			artifacts_used: [],
			reason: "no evidence",
		};
	}

	const prompt = buildSynthesizePrompt(
		{
			title: entity.title,
			entity_type: entity.entity_type,
			description: entity.description,
		},
		artifacts,
	);

	const artifactIds = artifacts.map((a) => a.id);
	let llmText: string;
	let resolvedProvider = provider;
	let resolvedModel = model;

	try {
		const llm = await ports.generate({
			system: SYNTHESIZE_SYSTEM_PROMPT,
			prompt,
			provider,
			model,
		});
		llmText = llm.text;
		resolvedProvider = llm.provider;
		resolvedModel = llm.model;
	} catch (err) {
		const msg = errMessage(err);
		await ports.recordDecision({
			userId,
			entityId: entity.id,
			artifactIds,
			provider,
			model,
			outcome: "error",
			error: msg,
		});
		return {
			status: "error",
			entity_id: entity.id,
			dry_run: dryRun,
			artifacts_used: artifactIds,
			provider,
			model,
			reason: msg,
		};
	}

	let profile;
	try {
		profile = parseSynthesizedProfile(llmText);
	} catch (err) {
		const msg = `LLM output validation failed: ${errMessage(err)}`;
		await ports.recordDecision({
			userId,
			entityId: entity.id,
			artifactIds,
			provider: resolvedProvider,
			model: resolvedModel,
			outcome: "error",
			error: msg,
		});
		return {
			status: "error",
			entity_id: entity.id,
			dry_run: dryRun,
			artifacts_used: artifactIds,
			provider: resolvedProvider,
			model: resolvedModel,
			reason: msg,
		};
	}

	if (dryRun) {
		await ports.recordDecision({
			userId,
			entityId: entity.id,
			artifactIds,
			provider: resolvedProvider,
			model: resolvedModel,
			outcome: "completed",
			profile,
		});
		return {
			status: "completed",
			entity_id: entity.id,
			profile,
			dry_run: true,
			artifacts_used: artifactIds,
			provider: resolvedProvider,
			model: resolvedModel,
		};
	}

	const updatedProperties = {
		...((entity.properties as Record<string, unknown> | null) ?? {}),
		synthesis: {
			synthesized_at: new Date().toISOString(),
			provider: resolvedProvider,
			model: resolvedModel,
			artifacts_used: artifactIds,
			key_facts: profile.key_facts,
			timeline: profile.timeline,
		},
	};

	const updated = await ports.updateEntityProfile(userId, {
		entityId: entity.id,
		description: profile.summary,
		properties: updatedProperties,
		expectedUpdatedAt: entity.updated_at,
	});

	if (!updated) {
		await ports.recordDecision({
			userId,
			entityId: entity.id,
			artifactIds,
			provider: resolvedProvider,
			model: resolvedModel,
			outcome: "conflict",
			profile,
			error: "Concurrent update conflict",
		});
		return {
			status: "conflict",
			entity_id: entity.id,
			profile,
			dry_run: false,
			artifacts_used: artifactIds,
			provider: resolvedProvider,
			model: resolvedModel,
			reason: "Entity was updated concurrently",
		};
	}

	await ports.recordDecision({
		userId,
		entityId: entity.id,
		artifactIds,
		provider: resolvedProvider,
		model: resolvedModel,
		outcome: "completed",
		profile,
	});

	return {
		status: "completed",
		entity_id: entity.id,
		profile,
		dry_run: false,
		artifacts_used: artifactIds,
		provider: resolvedProvider,
		model: resolvedModel,
	};
}

export function formatSynthesizeResult(result: EntitySynthesizeOutput): string {
	const lines: string[] = [];
	lines.push("Entity Synthesis Result:");
	lines.push(`Status: ${result.status}`);
	lines.push(`Entity ID: ${result.entity_id}`);
	lines.push(`Dry Run: ${result.dry_run}`);
	lines.push(`Artifacts Used: ${result.artifacts_used.length}`);
	if (result.provider) lines.push(`Provider: ${result.provider}`);
	if (result.model) lines.push(`Model: ${result.model}`);
	if (result.reason) lines.push(`Reason: ${result.reason}`);

	if (result.profile) {
		lines.push("\nSynthesized Summary:");
		lines.push(JSON.stringify(result.profile.summary));

		if (result.profile.key_facts && result.profile.key_facts.length > 0) {
			lines.push("\nKey Facts:");
			for (const fact of result.profile.key_facts) {
				lines.push(`- ${JSON.stringify(fact)}`);
			}
		}

		if (result.profile.timeline && result.profile.timeline.length > 0) {
			lines.push("\nTimeline:");
			for (const item of result.profile.timeline) {
				lines.push(`- [${item.date ?? "undated"}] ${JSON.stringify(item.event)}`);
			}
		}
	}

	return lines.join("\n");
}

export function createEntitySynthesizeAction(ports: EntitySynthesizePorts) {
	return defineAction({
		id: "entity_synthesize",
		domain: "kg",
		description:
			"Synthesize a concise, factual profile for an entity from evidence in its linked artifacts and update " +
			"entities.description and properties.synthesis. Supports dry_run (makes LLM call and returns profile " +
			"without writing back). Uses Gemini by default, with optional Anthropic routing. Returns plain text with " +
			"LLM output safely quoted.",
		schema: entitySynthesizeInputSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		formatMcp: formatSynthesizeResult,
		async run(input, context) {
			return executeEntitySynthesize(input, context, ports);
		},
	});
}

