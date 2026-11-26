import { z } from "zod";
import { DOMAINS } from "../../domain/domains.js";
import type {
	CleanStateArtifactEvaluation,
	CleanStateArtifactSnapshot,
	CleanStateCheckResult,
	CleanStateLayerStatus,
	CleanStateLayers,
	CleanStateLedgerSummary,
	CleanStatePort,
	CleanStateVerdict,
} from "../../ports/cleanState.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const cleanStateCheckInputSchema = z
	.object({
		artifact_id: z
			.string()
			.uuid()
			.optional()
			.describe("Specific artifact UUID to evaluate against Layers 1–5."),
		domain: z
			.enum(DOMAINS)
			.optional()
			.describe("Domain ('angus' or 'work') to evaluate recent artifacts when artifact_id is omitted."),
		window_days: z
			.number()
			.int()
			.min(1)
			.max(90)
			.default(7)
			.optional()
			.describe("Lookback window in days for domain or ledger evaluation (default 7)."),
		session_id: z
			.string()
			.min(1)
			.optional()
			.describe("Optional MCP session ID to scope Layer 5 action_ledger error checks."),
	})
	.refine((val) => Boolean(val.artifact_id || val.domain), {
		message: "At least one of artifact_id or domain is required",
		path: ["artifact_id"],
	});

export type CleanStateCheckInput = z.infer<typeof cleanStateCheckInputSchema>;

const STUB_TEXT_PATTERN = /\[stub\]|\[unconfirmed\]|^stub:/i;
const GRAPH_HYGIENE_REL_TYPES = new Set([
	"attended",
	"about",
	"mentions",
	"promise_to",
	"primary",
]);
const SYNTHESIS_KINDS = new Set([
	"synthesized",
	"synthesized_unattended",
	"evidence_aggregated_unattended",
]);

function isDriveOrigin(snapshot: CleanStateArtifactSnapshot): boolean {
	if (snapshot.source_drive_file_id) return true;
	if (
		snapshot.surface === "gdrive" ||
		snapshot.surface === "gdrive_work" ||
		snapshot.surface === "google_drive" ||
		snapshot.source_channel === "google_drive"
	) {
		return true;
	}
	if (
		snapshot.source_url &&
		/https?:\/\/(docs|drive)\.google\.com\//i.test(snapshot.source_url)
	) {
		return true;
	}
	return false;
}

function isGmailOrigin(snapshot: CleanStateArtifactSnapshot): boolean {
	return snapshot.surface === "gmail_ingest" || snapshot.source_channel === "gmail";
}

function isNotionOrigin(snapshot: CleanStateArtifactSnapshot): boolean {
	return snapshot.surface === "notion" || snapshot.source_channel === "notion";
}

/**
 * Pure evaluator for a single artifact snapshot + ledger summary against the
 * 5-layer Clean State contract (ADR-114, #1997).
 */
export function evaluateArtifactCleanState(
	snapshot: CleanStateArtifactSnapshot,
	ledger: CleanStateLedgerSummary,
): CleanStateArtifactEvaluation {
	const missing: string[] = [];

	// --- Layer 1: Artifact Integrity ---
	let layer1: CleanStateLayerStatus = "ok";
	const trimmedContent = (snapshot.content ?? "").trim();
	const isStubMeta =
		snapshot.processing_metadata?.stub === true ||
		snapshot.processing_metadata?.unconfirmed === true;

	if (!trimmedContent || STUB_TEXT_PATTERN.test(trimmedContent) || isStubMeta) {
		layer1 = "fail";
		missing.push(
			"Layer 1 (Artifact Integrity): content is empty or contains stub/unconfirmed text — update via artifact_update or enrich_next.",
		);
	}

	if (isDriveOrigin(snapshot)) {
		if (!snapshot.source_url || !snapshot.source_drive_file_id) {
			layer1 = "fail";
			missing.push(
				"Layer 1 (Artifact Integrity): Drive-originated artifact is missing source_url or source_drive_file_id — populate via artifact_update.",
			);
		}
		const hasDriveLink = snapshot.external_links.some((l) => l.kind === "google_drive");
		if (!hasDriveLink) {
			layer1 = "fail";
			missing.push(
				"Layer 1 (Artifact Integrity): missing canonical external pointer (kind = 'google_drive') in artifact_external_links — record via external_link_create.",
			);
		}
	} else if (isGmailOrigin(snapshot)) {
		const hasGmailLink = snapshot.external_links.some((l) => l.kind === "gmail");
		if (!hasGmailLink) {
			layer1 = "fail";
			missing.push(
				"Layer 1 (Artifact Integrity): missing canonical external pointer (kind = 'gmail') in artifact_external_links — record via external_link_create.",
			);
		}
	} else if (isNotionOrigin(snapshot)) {
		const hasNotionLink = snapshot.external_links.some((l) => l.kind.startsWith("notion"));
		if (!hasNotionLink) {
			layer1 = "fail";
			missing.push(
				"Layer 1 (Artifact Integrity): missing canonical external pointer (kind = 'notion_*') in artifact_external_links — record via external_link_create.",
			);
		}
	}

	if (!snapshot.has_embedding) {
		layer1 = "fail";
		missing.push(
			`Layer 1 (Artifact Integrity): embedding is missing (embedding IS NOT NULL required) — run artifact_embed_backfill({ artifact_id: "${snapshot.id}" }).`,
		);
	}

	// --- Layer 2: Graph Hygiene ---
	let layer2: CleanStateLayerStatus = "ok";
	const hasHygieneLinks = snapshot.entity_links.some((l) =>
		GRAPH_HYGIENE_REL_TYPES.has(l.relationship_type),
	);
	if (snapshot.derivation_status !== "completed") {
		layer2 = "fail";
		missing.push(
			`Layer 2 (Graph Hygiene): derivation_status is '${snapshot.derivation_status ?? "null"}' (expected 'completed') — run entity_derive_next({ artifact_id: "${snapshot.id}" }).`,
		);
	}
	if (!hasHygieneLinks) {
		layer2 = "fail";
		missing.push(
			`Layer 2 (Graph Hygiene): no linked entities (attended/about/mentions/promise_to) in artifact_entity_links — link mentioned people, organisations, and projects via artifact_sync_entities or link_upsert.`,
		);
	} else if (snapshot.structural_relationship_count <= 0) {
		if (layer2 === "ok") {
			layer2 = "warn";
		}
		missing.push(
			"Layer 2 (Graph Hygiene): linked entities have zero structural relationships in entity_relationships — connect related entities via entity_relate.",
		);
	}

	// --- Layer 3: Task Parity ---
	let layer3: CleanStateLayerStatus = "ok";
	const hasTaskLink = snapshot.external_links.some((l) => l.kind === "task");
	const explicitZeroCommitments =
		snapshot.processing_metadata?.zero_commitments === true ||
		snapshot.processing_metadata?.commitments_count === 0 ||
		snapshot.processing_metadata?.no_tasks === true ||
		snapshot.content_subtype === "daily_log";

	if (!hasTaskLink && !explicitZeroCommitments) {
		layer3 = "warn";
		missing.push(
			`Layer 3 (Task Parity): no spawned task lineage (kind = 'task') in artifact_external_links and no explicit zero-commitments marker — create tasks via task_create + external_link_create({ artifact_id: "${snapshot.id}", kind: "task" }) or mark processing_metadata.zero_commitments = true.`,
		);
	}

	// --- Layer 4: Synthesis Alignment ---
	let layer4: CleanStateLayerStatus = "ok";
	const hasSynthesisMarker = snapshot.external_links.some((l) => SYNTHESIS_KINDS.has(l.kind));
	if (!hasSynthesisMarker) {
		layer4 = "fail";
		missing.push(
			`Layer 4 (Synthesis Alignment): missing synthesis lineage marker (kind = 'synthesized' or 'synthesized_unattended') in artifact_external_links — fold into Daily Log / State Doc via the sync (dos) ritual.`,
		);
	}

	// --- Layer 5: Ledger Health ---
	let layer5: CleanStateLayerStatus = "ok";
	if (ledger.error_count > 0) {
		layer5 = "fail";
		const failedNames = (ledger.failed_actions ?? [])
			.map((a) => a.action_id)
			.filter(Boolean)
			.slice(0, 5);
		const suffix = failedNames.length > 0 ? ` (${failedNames.join(", ")})` : "";
		missing.push(
			`Layer 5 (Ledger Health): ${ledger.error_count} unresolved tool error(s) in action_ledger${suffix} — inspect via ledger_query({ status: "error" }).`,
		);
	}

	const layers: CleanStateLayers = {
		layer1_artifact_integrity: layer1,
		layer2_graph_hygiene: layer2,
		layer3_task_parity: layer3,
		layer4_synthesis_alignment: layer4,
		layer5_ledger_health: layer5,
	};

	return {
		id: snapshot.id,
		title: snapshot.title?.trim() || "(untitled artifact)",
		layers,
		missing,
	};
}

function computeOverallVerdict(
	evaluations: CleanStateArtifactEvaluation[],
	ledger: CleanStateLedgerSummary,
): CleanStateVerdict {
	if (ledger.error_count > 0) return "fail";
	let hasWarn = false;
	for (const ev of evaluations) {
		const statuses = Object.values(ev.layers) as CleanStateLayerStatus[];
		if (statuses.includes("fail")) return "fail";
		if (statuses.includes("warn")) hasWarn = true;
	}
	return hasWarn ? "warn" : "ok";
}

function renderCleanStateReport(
	verdict: CleanStateVerdict,
	evaluations: CleanStateArtifactEvaluation[],
	ledger: CleanStateLedgerSummary,
): string {
	const lines: string[] = [
		`clean_state_check (ADR-114) — verdict: ${verdict.toUpperCase()} (${evaluations.length} artifact(s) evaluated, ledger errors: ${ledger.error_count})`,
	];

	for (const ev of evaluations) {
		const { layers } = ev;
		lines.push(
			`- [${ev.id}] "${ev.title}": L1=${layers.layer1_artifact_integrity} L2=${layers.layer2_graph_hygiene} L3=${layers.layer3_task_parity} L4=${layers.layer4_synthesis_alignment} L5=${layers.layer5_ledger_health}`,
		);
		for (const item of ev.missing) {
			lines.push(`    * ${item}`);
		}
	}

	return lines.join("\n");
}

/**
 * Read-only Core action evaluating an `artifact_id` or recent `domain` window
 * against the 5-layer Clean State contract (ADR-114, #1997).
 */
export function createCleanStateCheckAction(
	port: CleanStatePort,
): ActionDefinition<typeof cleanStateCheckInputSchema, CleanStateCheckResult> {
	return defineAction({
		id: "clean_state_check",
		description:
			"Evaluate an artifact or recent domain window against the 5-layer Clean State contract (ADR-114): Layer 1 artifact integrity, Layer 2 graph hygiene, Layer 3 task parity, Layer 4 synthesis alignment, and Layer 5 action_ledger health. Read-only; returns per-layer verdicts and remediation steps.",
		annotations: { readOnlyHint: true },
		schema: cleanStateCheckInputSchema,
		run: async ({ input, ctx }) => {
			if (!ctx.userId) {
				throw new Error("clean_state_check requires an authenticated userId in context");
			}

			const data = await port.loadEvaluationData({
				userId: ctx.userId,
				artifactId: input.artifact_id,
				domain: input.domain,
				windowDays: input.window_days ?? 7,
				sessionId: input.session_id,
			});

			if (input.artifact_id && data.artifacts.length === 0) {
				throw new Error(`Artifact not found: ${input.artifact_id}`);
			}

			const evaluations = data.artifacts.map((snapshot) =>
				evaluateArtifactCleanState(snapshot, data.ledger),
			);
			const verdict = computeOverallVerdict(evaluations, data.ledger);
			const clean = verdict === "ok";
			const text = renderCleanStateReport(verdict, evaluations, data.ledger);

			return {
				clean,
				verdict,
				artifacts: evaluations,
				text,
			};
		},
	});
}
