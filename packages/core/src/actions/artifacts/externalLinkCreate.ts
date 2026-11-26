import { z } from "zod";
import { DOMAIN_PROVIDER } from "../../domain/domains.js";
import {
	DAILY_LOG_CONTENT_SUBTYPE,
	DAILY_LOG_LINK_KIND,
	EVIDENCE_AGGREGATED,
	EVIDENCE_CLOSING_KINDS,
	STATE_DOC_LINK_KIND,
	SYNTHESIZED,
	SYNTHESIS_MARKER_KINDS,
} from "../../domain/vocab.js";
import type { ExternalLink, ExternalLinkRepository } from "../../ports/externalLinks.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export class ActionPreconditionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionPreconditionError";
	}
}

export const createExternalLinkInput = {
	artifact_id: z
		.string()
		.uuid()
		.describe("UUID of the artifact this link belongs to."),
	provider: z
		.string()
		.min(1)
		.describe(
			"External system identifier — e.g. 'internal' for links to other Supabase rows. For Notion, use the WORKSPACE-scoped provider the rest of the system writes ('notion_work' / 'notion_personal'), not a bare 'notion': provider is part of the unique key, so mixing the two fragments an artifact's ledger and a synthesis marker written under the wrong one will not be found by the reads that look for it.",
		),
	kind: z
		.string()
		.min(1)
		.describe(
			`What the link represents. Two families, and mixing them up breaks real reads. POINTERS say "this artifact corresponds to that external object": 'task' | 'event' | '${DAILY_LOG_LINK_KIND}' (a Daily Log twin pointing at its Notion page, provider the domain's 'notion_work' or 'notion_personal', external_id the page id; #562, ADR-050 §7. Guarded, #2313: refused unless the artifact IS a twin and carries no '${DAILY_LOG_LINK_KIND}' pointer naming another page or provider, so the only late write it allows is the pointer attach on a pointerless twin) | '${STATE_DOC_LINK_KIND}' (a Daily Log twin pointing at the State Doc page it was folded into, the SECOND consumption hop, ADR-051 §10 / Erratum 1: artifact_id the TWIN, external_id the State Doc page id, provider the domain's; written by the attended dos session on the owner's approval and by nothing else. Never on an atom: atoms are consumed at hop 1 by a log, and the tool refuses it). SYNTHESIS MARKERS say "this atom went through the Synthesize step": 'synthesized' | 'synthesized_unattended'. For a marker, the kind names the STEP and external_id names the OBJECT (the Daily Log page id). 'synthesized' asserts the human was in the loop, read, corrected, confirmed, and is what an attended ritual writes. 'synthesized_unattended' asserts the opposite: a machine-written draft nobody has confirmed. It is written ONLY by #561's unattended fallback sweep and by nothing else, because the distinction is the whole point, if an attended run wrote it, or the sweep wrote 'synthesized', a swept day would become indistinguishable from a day the owner actually verified (ADR-050 §6, §8). NEVER stamp a synthesis marker on a Daily Log twin: the twin is the ritual's output, not an atom it consumed, and dos_synthesis_coverage buckets markers by the artifact's captured_at, so it would add a phantom count to the very day it reports on. No kind is named 'state_doc', nothing writes one, and the State Doc is a mutable projection that is deliberately NOT twinned (ADR-022/ADR-040, ADR-050 §7). (ADR-013 §7, ADR-018 §5).`,
		),
	external_id: z
		.string()
		.min(1)
		.describe(
			"External identifier — e.g. a Notion page id for the entry the artifact was folded into.",
		),
	external_url: z
		.string()
		.url()
		.optional()
		.describe(
			"Optional convenience URL for humans/agents; never required for lookups.",
		),
	dedup_key: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Optional pre-creation idempotency key for the 1->many case (e.g. one of several tasks/events spawned from the same atom). Scoped to (artifact_id, provider, kind); see task_create's single_task/dedup_key dedup guard (issue #141).",
		),
	run_id: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Run marker obtained by the dos ritual at Step 0. Required when kind='synthesized': ADR-050 §6 defines 'synthesized' as the Synthesize step completing with the human in the loop during the ritual. Callers without a ritual run_id may stamp 'synthesized_unattended' only (#1139).",
		),
};

export const createExternalLinkSchema = z.object(createExternalLinkInput);

export type ExternalLinkCreateInput = z.infer<typeof createExternalLinkSchema>;

export interface ExternalLinkCreateOutput {
	text: string;
}

export type ExternalLinkCreatePort = Pick<
	ExternalLinkRepository,
	"recordExternalLink" | "getArtifactContentSubtype"
>;

/** The two fields that identify which page, in which workspace, a `daily_log` pointer names. */
export type ExistingDailyLogPointer = Pick<ExternalLink, "provider" | "external_id">;

/**
 * The strict read the `daily_log` pointer guard needs (#2313): every `daily_log` pointer
 * the artifact already carries.
 *
 * It MUST throw when the read fails. The shared `getExternalLinks` adapter answers `[]`
 * on a query error, which this guard would take as "no pointers" and write a second one,
 * so that adapter is deliberately not what this port is built from. The surface supplies
 * it (`ActionAdapters.externalLinkCreate`); where none is wired, the guard refuses.
 */
export interface ExternalLinkCreateGuardPort {
	getDailyLogPointers(artifactId: string): Promise<ExistingDailyLogPointer[]>;
}

/**
 * The two rows that would be wrong forever if written: a hop-2 `consumed_by_state` on an
 * atom (atoms are consumed by a log at hop 1, never by the State Doc directly), and a
 * hop-1 synthesis marker on a Daily Log twin (the twin is the ritual's output, and
 * `dos_synthesis_coverage` would count it against the very day it narrates). No
 * marker-deletion path exists anywhere in the codebase, so both are checked BEFORE the
 * write, with one read of the artifact, and a failed read refuses rather than skips,
 * because "could not check" and "checked, fine" must not produce the same row.
 *
 * A `daily_log` pointer is read for the same reason (#2313): on a non-twin it makes
 * `hasDailyLogTwin` answer `twin_present: true` for a page that has no twin, and nothing
 * deletes it either.
 *
 * Every other kind (task, event, or any provider-specific pointer) skips the read:
 * nothing about those depends on what the artifact is.
 */
async function assertKindFitsArtifact(
	port: ExternalLinkCreatePort,
	artifactId: string,
	kind: string,
): Promise<void> {
	const isHop2 = kind === STATE_DOC_LINK_KIND;
	const isMarker = (SYNTHESIS_MARKER_KINDS as readonly string[]).includes(kind);
	const isEvidenceClosing = (EVIDENCE_CLOSING_KINDS as readonly string[]).includes(kind);
	const isDailyLogPointer = kind === DAILY_LOG_LINK_KIND;
	if (!isHop2 && !isMarker && !isEvidenceClosing && !isDailyLogPointer) return;

	const { data, error } = await port.getArtifactContentSubtype(artifactId);
	if (error) {
		throw new Error(
			`Could not read artifact ${artifactId} to check that kind '${kind}' fits it: ${error}. Nothing was written, a wrong marker is permanent (no marker-deletion path exists), so this check is never skipped on a failed read.`,
		);
	}
	if (!data) {
		throw new Error(
			`Artifact ${artifactId} was not found for this user. Nothing was written.`,
		);
	}
	const isTwin = data.content_subtype === DAILY_LOG_CONTENT_SUBTYPE;
	if (isHop2 && !isTwin) {
		throw new ActionPreconditionError(
			`Refused: kind '${STATE_DOC_LINK_KIND}' belongs on a Daily Log twin (content_subtype '${DAILY_LOG_CONTENT_SUBTYPE}'), and ${artifactId} is not one. Atoms are consumed by a daily log (kind 'synthesized', hop 1), never by the State Doc directly (ADR-051 §10). Stamp the TWIN of the log that consumed this atom instead. Nothing was written.`,
		);
	}
	if (isEvidenceClosing && !isTwin) {
		throw new ActionPreconditionError(
			`Refused: kind '${kind}' is only valid on daily_log twin artifacts (content_subtype '${DAILY_LOG_CONTENT_SUBTYPE}'), and ${artifactId} is not one (ADR-108 §5, ADR-109 §1). Evidence day-closing links belong on the day's Daily Log twin, never on an atom. Nothing was written.`,
		);
	}
	if (isDailyLogPointer && !isTwin) {
		throw new ActionPreconditionError(
			`Refused: kind '${DAILY_LOG_LINK_KIND}' belongs on a Daily Log twin (content_subtype '${DAILY_LOG_CONTENT_SUBTYPE}'), and ${artifactId} is not one. A '${DAILY_LOG_LINK_KIND}' pointer on any other artifact makes the Daily Log page look twinned when it is not (#2313). This tool attaches a pointer to an existing twin; it never creates or backfills one. Nothing was written.`,
		);
	}
	if (isMarker && isTwin) {
		throw new ActionPreconditionError(
			`Refused: ${artifactId} is a Daily Log twin, and a twin never carries a synthesis marker ('${kind}'). It is the ritual's output, not an atom it consumed; a marker here would add a phantom count to its own day in dos_synthesis_coverage (ADR-050 §7). To record that this log was folded into the State Doc, use kind '${STATE_DOC_LINK_KIND}'. Nothing was written.`,
		);
	}
}

/**
 * A twin points at exactly one Daily Log page, under one provider (#2313). A second
 * `daily_log` pointer naming another page or another provider makes `choosePointer`
 * report the twin as a pointer conflict, which leaves it unattributable in the queue,
 * so it is refused before the write. An exact repeat of the pointer already there is let
 * through: the upsert is a no-op and a retried repair must not fail.
 *
 * Runs after `assertKindFitsArtifact`, so the artifact is already known to be a twin.
 */
async function assertNoOtherDailyLogPointer(
	guard: ExternalLinkCreateGuardPort | undefined,
	artifactId: string,
	provider: string,
	externalId: string,
): Promise<void> {
	if (!guard) {
		throw new Error(
			`Could not check the existing '${DAILY_LOG_LINK_KIND}' pointers on ${artifactId}: no strict existing-pointer read is wired on this surface. Nothing was written, an unchecked write is never taken as "no pointers" (#2313).`,
		);
	}
	let existing: ExistingDailyLogPointer[];
	try {
		existing = await guard.getDailyLogPointers(artifactId);
	} catch (err) {
		throw new Error(
			`Could not read the existing '${DAILY_LOG_LINK_KIND}' pointers on ${artifactId}: ${err instanceof Error ? err.message : String(err)}. Nothing was written, a failed read is never taken as "no pointers" (#2313).`,
		);
	}
	const other = existing.find(
		(link) => link.provider !== provider || link.external_id !== externalId,
	);
	if (other) {
		throw new ActionPreconditionError(
			`Refused: Daily Log twin ${artifactId} already carries a '${DAILY_LOG_LINK_KIND}' pointer (${other.provider}/${other.external_id}), and a twin points at exactly one page under one provider. A second pointer naming another page or provider makes the twin a pointer conflict in the Daily Log queue (#2313). Nothing was written.`,
		);
	}
}

/**
 * Record a cross-store lineage link from an artifact to an external item. Idempotent
 * via the table's unique constraint on (artifact_id, provider, kind, external_id), so
 * re-runnable synthesis passes don't create duplicates. See ADR-013 §5 (lineage) and
 * §7 (consumption marker), ADR-018 §5 (synthesis consumers marking atoms consumed),
 * Issue #1539.
 */
export function createExternalLinkCreateAction(
	port: ExternalLinkCreatePort,
	guard?: ExternalLinkCreateGuardPort,
): ActionDefinition<typeof createExternalLinkSchema, ExternalLinkCreateOutput> {
	return defineAction({
		id: "external_link_create",
		domain: "artifacts",
		description:
			"Record cross-store lineage from an artifact to an external item, or a synthesis marker. A twin " +
			"must never carry a synthesis marker and an atom must never carry 'consumed_by_state'. " +
			"'synthesized' means a human was in the loop; 'synthesized_unattended' does not. They are not " +
			"interchangeable. Full notes: docs/guides/tools/external_link_create.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		schema: createExternalLinkSchema,
		run: async (args) => {
			const hasRunId = typeof args.run_id === "string" && args.run_id.trim().length > 0;
			if (args.kind === SYNTHESIZED && !hasRunId) {
				throw new ActionPreconditionError(
					"Refused: kind 'synthesized' asserts the human was in the loop during the dos ritual (ADR-050 §6) and requires a ritual `run_id` (obtained at Step 0). Non-dos writers and automated runs without a run_id may stamp 'synthesized_unattended' only (#1139).",
				);
			}
			if (args.kind === EVIDENCE_AGGREGATED && !hasRunId) {
				throw new ActionPreconditionError(
					"Refused: run_id is required when kind='evidence_aggregated' (ADR-108 §5, #1780). Non-dos writers and automated runs without a run_id may stamp 'evidence_aggregated_unattended' only.",
				);
			}
			const isMarker = (SYNTHESIS_MARKER_KINDS as readonly string[]).includes(args.kind);
			const isEvidenceClosing = (EVIDENCE_CLOSING_KINDS as readonly string[]).includes(
				args.kind,
			);
			const isDailyLogPointer = args.kind === DAILY_LOG_LINK_KIND;
			if (isMarker || isEvidenceClosing || isDailyLogPointer) {
				const allowedProviders = Object.values(DOMAIN_PROVIDER) as readonly string[];
				if (!allowedProviders.includes(args.provider)) {
					// Cite the rule the caller actually broke: the Daily Log pointer rule comes
					// from #2313 (ADR-050 §7 for the pointer itself), not the evidence rule.
					const source = isDailyLogPointer ? "ADR-050 §7, #2313" : "ADR-108 §5";
					throw new ActionPreconditionError(
						`Refused: kind '${args.kind}' requires a Notion domain provider (${allowedProviders.map((p) => `'${p}'`).join(" or ")}), got '${args.provider}' (${source}). Nothing was written.`,
					);
				}
			}
			await assertKindFitsArtifact(port, args.artifact_id, args.kind);
			if (isDailyLogPointer) {
				await assertNoOtherDailyLogPointer(
					guard,
					args.artifact_id,
					args.provider,
					args.external_id,
				);
			}
			const result = await port.recordExternalLink(args.artifact_id, {
				provider: args.provider,
				kind: args.kind,
				external_id: args.external_id,
				external_url: args.external_url ?? null,
				dedup_key: args.dedup_key ?? null,
			});

			if (!result.ok) {
				throw new Error(
					`Failed to record external link: ${result.error}. If this mentions an undefined relation, apply supabase/migrations/20260606140000_047_add_artifact_external_links.sql.`,
				);
			}

			return {
				text: `Linked artifact ${args.artifact_id} → ${args.provider}/${args.kind}/${args.external_id}.`,
			};
		},
		formatMcp: (output) => output.text,
	});
}

export const createExternalLinkAction = createExternalLinkCreateAction;
