/**
 * @ahkms/core/adapters - Supabase adapter for GmailReconcileStore (ADR-100, ADR-101, Issue #1579, #2013).
 *
 * Implements the Supabase read queries used by Gmail workflow reconciliation
 * plus Tier-2 email priority triage decision logging in `public.system_decisions`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
	EmailIntentCategory,
	EmailStorageTier,
	GmailSweepAction,
} from "../../domain/emailTriage.js";
import type {
	CandidateGmailArtifactRow,
	CandidateGmailExternalLinkRow,
	GmailAccountDomain,
	GmailReconcileStore,
	GmailTriageDecisionFilter,
	GmailTriageDecisionOverrideInput,
	GmailTriageDecisionRecord,
	GmailTriageStorePort,
	TaskExternalLinkRow,
} from "../../ports/gmailReconcile.js";

export type GmailReconcileSupabaseClient = Pick<SupabaseClient, "from">;

export const GMAIL_CANDIDATE_ARTIFACTS_OR_FILTER =
	"source_channel.ilike.%gmail%,source_url.ilike.%mail.google.com%,source_channel.eq.email";

export const GMAIL_CANDIDATE_LINKS_OR_FILTER =
	"provider.ilike.%gmail%,provider.ilike.%google%,kind.eq.thread,kind.eq.email,kind.eq.gmail_thread";

export const GMAIL_TRIAGE_DECISION_TYPE = "gmail_priority_triage";
export const GMAIL_TRIAGE_STAGE = "organize";

export interface SupabaseGmailReconcileStore
	extends Omit<GmailReconcileStore, keyof GmailTriageStorePort>,
		Required<GmailTriageStorePort> {
	recordTriageDecision(
		decision: GmailTriageDecisionRecord,
		userId?: string,
	): Promise<GmailTriageDecisionRecord | null>;
}

interface SystemDecisionRowShape {
	id?: string;
	user_id?: string | null;
	artifact_id?: string | null;
	decision_type?: string | null;
	confidence_score?: number | null;
	decision_payload?: Record<string, unknown> | null;
	created_at?: string | null;
	resolved_at?: string | null;
}

function buildDecisionPayload(
	decision: GmailTriageDecisionRecord,
): Record<string, unknown> {
	const storageTier: EmailStorageTier =
		decision.storage_tier ??
		(decision.artifact_id ? "tier_3_full_artifact" : "tier_2_decision_log");

	return {
		workflow_name: GMAIL_TRIAGE_DECISION_TYPE,
		thread_id: decision.thread_id,
		message_id: decision.message_id,
		account: decision.account,
		sender: decision.sender,
		subject: decision.subject,
		snippet: decision.snippet ?? null,
		intent_category: decision.intent_category,
		priority: decision.priority,
		confidence: decision.confidence,
		storage_tier: storageTier,
		gmail_action: decision.gmail_action,
		artifact_id: decision.artifact_id ?? null,
		promoted_artifact_id: decision.artifact_id ?? null,
		linked_entity_ids: decision.linked_entity_ids ?? [],
		reasons: decision.reasons ?? [],
		received_at: decision.received_at ?? null,
		overridden_at: decision.overridden_at ?? null,
		route: decision.route ?? null,
		natural_route: decision.natural_route ?? null,
		thinking_mode: decision.thinking_mode ?? null,
		requires_human: decision.requires_human ?? null,
		hitl_reasons: decision.hitl_reasons ?? [],
		mode: decision.mode ?? null,
		applied: decision.applied ?? null,
		over_budget: decision.over_budget ?? null,
		rubric_version: decision.rubric_version ?? null,
		rationale: decision.rationale ?? null,
		sender_kind: decision.sender_kind ?? null,
		gmail_category: decision.gmail_category ?? null,
		gmail_category_contradiction: decision.gmail_category_contradiction ?? null,
		draft_id: decision.draft_id ?? null,
		draft_reply: decision.draft_reply ?? null,
		extracted_tasks: decision.extracted_tasks ?? [],
		extracted_entities: decision.extracted_entities ?? [],
		created_task_count: decision.created_task_count ?? 0,
	};
}

const PIPELINE_STRING_FIELDS = [
	"route",
	"natural_route",
	"thinking_mode",
	"mode",
	"rubric_version",
	"rationale",
	"sender_kind",
	"gmail_category",
	"draft_id",
	"draft_reply",
] as const;

const PIPELINE_BOOLEAN_FIELDS = [
	"requires_human",
	"applied",
	"over_budget",
	"gmail_category_contradiction",
] as const;

/** Read the ADR-118 pipeline fields back off a stored payload; absent on older rows. */
function readPipelineFields(payload: Record<string, unknown>): Partial<GmailTriageDecisionRecord> {
	const out: Record<string, unknown> = {};
	for (const key of PIPELINE_STRING_FIELDS) {
		if (typeof payload[key] === "string") out[key] = payload[key];
	}
	for (const key of PIPELINE_BOOLEAN_FIELDS) {
		if (typeof payload[key] === "boolean") out[key] = payload[key];
	}
	if (Array.isArray(payload.hitl_reasons)) {
		out.hitl_reasons = payload.hitl_reasons.filter((r): r is string => typeof r === "string");
	}
	if (Array.isArray(payload.extracted_tasks)) out.extracted_tasks = payload.extracted_tasks;
	if (Array.isArray(payload.extracted_entities)) out.extracted_entities = payload.extracted_entities;
	if (typeof payload.created_task_count === "number") out.created_task_count = payload.created_task_count;
	return out as Partial<GmailTriageDecisionRecord>;
}

function mapRowToTriageDecisionRecord(
	row: SystemDecisionRowShape,
	fallback?: GmailTriageDecisionRecord,
): GmailTriageDecisionRecord | null {
	const payload = (row.decision_payload ?? {}) as Record<string, unknown>;
	const threadId =
		typeof payload.thread_id === "string"
			? payload.thread_id
			: fallback?.thread_id;
	if (!threadId) {
		return null;
	}

	const messageId =
		typeof payload.message_id === "string"
			? payload.message_id
			: (fallback?.message_id ?? threadId);
	const account =
		typeof payload.account === "string"
			? (payload.account as GmailAccountDomain | string)
			: (fallback?.account ?? "personal");
	const sender =
		typeof payload.sender === "string"
			? payload.sender
			: (fallback?.sender ?? "");
	const subject =
		typeof payload.subject === "string"
			? payload.subject
			: (fallback?.subject ?? "");
	const snippet =
		typeof payload.snippet === "string"
			? payload.snippet
			: (fallback?.snippet ?? null);
	const intentCategory =
		typeof payload.intent_category === "string"
			? (payload.intent_category as EmailIntentCategory)
			: (fallback?.intent_category ?? "fyi");
	const priority =
		typeof payload.priority === "number"
			? payload.priority
			: (fallback?.priority ?? 3);
	const confidence =
		typeof payload.confidence === "number"
			? payload.confidence
			: typeof row.confidence_score === "number"
				? row.confidence_score
				: (fallback?.confidence ?? 1);
	const gmailAction =
		typeof payload.gmail_action === "string"
			? (payload.gmail_action as GmailSweepAction)
			: (fallback?.gmail_action ?? "keep_inbox");
	const artifactId =
		typeof row.artifact_id === "string"
			? row.artifact_id
			: typeof payload.artifact_id === "string"
				? payload.artifact_id
				: typeof payload.promoted_artifact_id === "string"
					? payload.promoted_artifact_id
					: (fallback?.artifact_id ?? null);
	const storageTier =
		typeof payload.storage_tier === "string"
			? (payload.storage_tier as EmailStorageTier)
			: (fallback?.storage_tier ??
				(artifactId ? "tier_3_full_artifact" : "tier_2_decision_log"));
	const linkedEntityIds = Array.isArray(payload.linked_entity_ids)
		? payload.linked_entity_ids.filter(
				(id): id is string => typeof id === "string",
			)
		: (fallback?.linked_entity_ids ?? []);
	const reasons = Array.isArray(payload.reasons)
		? payload.reasons.filter((r): r is string => typeof r === "string")
		: (fallback?.reasons ?? []);
	const receivedAt =
		typeof payload.received_at === "string"
			? payload.received_at
			: (fallback?.received_at ?? null);
	const overriddenAt =
		typeof payload.overridden_at === "string"
			? payload.overridden_at
			: (fallback?.overridden_at ?? null);

	return {
		...(fallback ? pickPipelineFields(fallback) : {}),
		...readPipelineFields(payload),
		...(row.id ? { id: row.id } : fallback?.id ? { id: fallback.id } : {}),
		thread_id: threadId,
		message_id: messageId,
		account,
		sender,
		subject,
		snippet,
		intent_category: intentCategory,
		priority,
		confidence,
		storage_tier: storageTier,
		gmail_action: gmailAction,
		artifact_id: artifactId,
		linked_entity_ids: linkedEntityIds,
		reasons,
		received_at: receivedAt,
		created_at: row.created_at ?? fallback?.created_at ?? null,
		overridden_at: overriddenAt,
	};
}

function pickPipelineFields(record: GmailTriageDecisionRecord): Partial<GmailTriageDecisionRecord> {
	const payload = buildDecisionPayload(record);
	return readPipelineFields(payload);
}

export function createSupabaseGmailReconcileStore(
	client: GmailReconcileSupabaseClient,
	getUserId?: () => string | undefined,
): SupabaseGmailReconcileStore {
	const resolveUserId = (explicitUserId?: string): string | undefined =>
		explicitUserId ?? getUserId?.();

	async function recordTriageDecisions(
		decisions: GmailTriageDecisionRecord[],
		userId?: string,
	): Promise<GmailTriageDecisionRecord[]> {
		if (decisions.length === 0) {
			return [];
		}

		const effectiveUserId = resolveUserId(userId);
		const rows = decisions.map((decision) => {
			const storageTier: EmailStorageTier =
				decision.storage_tier ??
				(decision.artifact_id ? "tier_3_full_artifact" : "tier_2_decision_log");
			const row: Record<string, unknown> = {
				artifact_id: decision.artifact_id ?? null,
				decision_type: GMAIL_TRIAGE_DECISION_TYPE,
				stage: GMAIL_TRIAGE_STAGE,
				title: `Triage [${decision.account}] P${decision.priority} (${decision.intent_category}): ${decision.subject || "(no subject)"}`,
				description: `Sender: ${decision.sender} | Action: ${decision.gmail_action} | Tier: ${storageTier}`,
				confidence_score: decision.confidence,
				blocking: false,
				user_visible: true,
				// ADR-118: a thread the HITL gate held for review is a pending clarification
				// in decision_review; everything else was applied by the machine.
				requires_user_action: decision.route === "review",
				review_type: decision.route === "review" ? "clarification" : "suggestion",
				status: decision.route === "review" ? "pending" : "auto_applied",
				decision_payload: buildDecisionPayload(decision),
			};
			if (effectiveUserId) {
				row.user_id = effectiveUserId;
			}
			return row;
		});

		const { data, error } = await client
			.from("system_decisions")
			.insert(rows)
			.select(
				"id, user_id, artifact_id, decision_type, confidence_score, decision_payload, created_at",
			);

		if (error) {
			console.error(
				"[GmailWorkflow] recordTriageDecisions failed:",
				error.message,
			);
			return [];
		}

		const insertedRows = Array.isArray(data)
			? (data as SystemDecisionRowShape[])
			: [];
		if (insertedRows.length > 0) {
			return insertedRows
				.map((row, idx) => mapRowToTriageDecisionRecord(row, decisions[idx]))
				.filter((rec): rec is GmailTriageDecisionRecord => rec !== null);
		}

		return decisions.map((decision) => ({
			...decision,
			storage_tier:
				decision.storage_tier ??
				(decision.artifact_id ? "tier_3_full_artifact" : "tier_2_decision_log"),
			artifact_id: decision.artifact_id ?? null,
			linked_entity_ids: decision.linked_entity_ids ?? [],
			reasons: decision.reasons ?? [],
		}));
	}

	async function recordTriageDecision(
		decision: GmailTriageDecisionRecord,
		userId?: string,
	): Promise<GmailTriageDecisionRecord | null> {
		const recorded = await recordTriageDecisions([decision], userId);
		return recorded[0] ?? null;
	}

	async function listTriageDecisions(
		filter: GmailTriageDecisionFilter = {},
	): Promise<GmailTriageDecisionRecord[]> {
		const effectiveUserId = resolveUserId(filter.userId);
		let query = client
			.from("system_decisions")
			.select(
				"id, user_id, artifact_id, decision_type, confidence_score, decision_payload, created_at, resolved_at",
			)
			.eq("decision_type", GMAIL_TRIAGE_DECISION_TYPE)
			.order("created_at", { ascending: false })
			.limit(filter.limit ?? 100);

		if (effectiveUserId) {
			query = query.eq("user_id", effectiveUserId);
		}
		if (filter.since) {
			query = query.gte("created_at", filter.since);
		}

		const { data, error } = await query;

		if (error) {
			console.error(
				"[GmailWorkflow] listTriageDecisions failed:",
				error.message,
			);
			return [];
		}

		const rows = Array.isArray(data) ? (data as SystemDecisionRowShape[]) : [];
		const records = rows
			.map((row) => mapRowToTriageDecisionRecord(row))
			.filter((rec): rec is GmailTriageDecisionRecord => rec !== null);

		return records.filter((rec) => {
			if (
				filter.account &&
				filter.account !== "all" &&
				rec.account !== filter.account
			) {
				return false;
			}
			if (
				typeof filter.minPriority === "number" &&
				rec.priority < filter.minPriority
			) {
				return false;
			}
			if (
				typeof filter.maxPriority === "number" &&
				rec.priority > filter.maxPriority
			) {
				return false;
			}
			if (
				filter.intentCategory &&
				rec.intent_category !== filter.intentCategory
			) {
				return false;
			}
			if (filter.storageTier && rec.storage_tier !== filter.storageTier) {
				return false;
			}
			return true;
		});
	}

	async function listDecidedThreadIds(
		threadIds: string[],
		userId?: string,
	): Promise<Set<string>> {
		const decided = new Set<string>();
		if (threadIds.length === 0) {
			return decided;
		}
		const effectiveUserId = resolveUserId(userId);
		let query = client
			.from("system_decisions")
			.select("decision_payload")
			.eq("decision_type", GMAIL_TRIAGE_DECISION_TYPE)
			.in("decision_payload->>thread_id", threadIds)
			.limit(threadIds.length * 4);
		if (effectiveUserId) {
			query = query.eq("user_id", effectiveUserId);
		}
		const { data, error } = await query;
		if (error) {
			console.warn("[GmailWorkflow] listDecidedThreadIds failed:", error.message);
			return decided;
		}
		for (const row of (data ?? []) as Array<{ decision_payload?: Record<string, unknown> | null }>) {
			const id = row.decision_payload?.thread_id;
			if (typeof id === "string") decided.add(id);
		}
		return decided;
	}

	async function overrideTriageDecision(
		override: GmailTriageDecisionOverrideInput,
	): Promise<GmailTriageDecisionRecord | null> {
		const effectiveUserId = resolveUserId(override.userId);
		let query = client
			.from("system_decisions")
			.select(
				"id, user_id, artifact_id, decision_type, confidence_score, decision_payload, created_at, resolved_at",
			)
			.eq("decision_type", GMAIL_TRIAGE_DECISION_TYPE)
			.order("created_at", { ascending: false })
			.limit(100);

		if (effectiveUserId) {
			query = query.eq("user_id", effectiveUserId);
		}

		const { data, error } = await query;
		if (error) {
			console.error(
				"[GmailWorkflow] overrideTriageDecision lookup failed:",
				error.message,
			);
			return null;
		}

		const rows = Array.isArray(data) ? (data as SystemDecisionRowShape[]) : [];
		const matchedRow = rows.find((row) => {
			const payload = (row.decision_payload ?? {}) as Record<string, unknown>;
			if (payload.thread_id !== override.thread_id) {
				return false;
			}
			if (override.account && payload.account !== override.account) {
				return false;
			}
			return true;
		});

		if (!matchedRow || !matchedRow.id) {
			return null;
		}

		const existingRecord = mapRowToTriageDecisionRecord(matchedRow);
		if (!existingRecord) {
			return null;
		}

		const overriddenAt = new Date().toISOString();
		const updatedReasons = [...(existingRecord.reasons ?? [])];
		if (override.reason) {
			updatedReasons.push(`override:${override.reason}`);
		}

		const updatedRecord: GmailTriageDecisionRecord = {
			...existingRecord,
			...(override.priority !== undefined
				? { priority: override.priority }
				: {}),
			...(override.intent_category !== undefined
				? { intent_category: override.intent_category }
				: {}),
			...(override.gmail_action !== undefined
				? { gmail_action: override.gmail_action }
				: {}),
			...(override.storage_tier !== undefined
				? { storage_tier: override.storage_tier }
				: {}),
			reasons: updatedReasons,
			overridden_at: overriddenAt,
		};

		const updatedPayload = buildDecisionPayload(updatedRecord);
		let updateQuery = client
			.from("system_decisions")
			.update({
				decision_payload: updatedPayload,
				status: "modified",
				resolved_at: overriddenAt,
				...(override.reason ? { resolution_notes: override.reason } : {}),
			})
			.eq("id", matchedRow.id);

		if (effectiveUserId) {
			updateQuery = updateQuery.eq("user_id", effectiveUserId);
		}

		const { data: updatedData, error: updateErr } = await updateQuery.select(
			"id, user_id, artifact_id, decision_type, confidence_score, decision_payload, created_at, resolved_at",
		);

		if (updateErr) {
			console.error(
				"[GmailWorkflow] overrideTriageDecision update failed:",
				updateErr.message,
			);
			return null;
		}

		const updatedRows = Array.isArray(updatedData)
			? (updatedData as SystemDecisionRowShape[])
			: [];
		if (updatedRows[0]) {
			return mapRowToTriageDecisionRecord(updatedRows[0], updatedRecord);
		}
		return updatedRecord;
	}

	return {
		async listCandidateGmailArtifacts(userId?: string): Promise<CandidateGmailArtifactRow[]> {
			const effectiveUserId = resolveUserId(userId);
			let query = client
				.from("artifacts")
				.select("id, user_id, source_channel, source_url, processing_metadata, tags, text, created_at");

			if (effectiveUserId) {
				query = query.eq("user_id", effectiveUserId);
			}

			const { data, error } = await query.or(GMAIL_CANDIDATE_ARTIFACTS_OR_FILTER);

			if (error) {
				console.error("[GmailWorkflow] query artifacts failed:", error.message);
				return [];
			}

			return (data ?? []) as CandidateGmailArtifactRow[];
		},

		async listCandidateGmailExternalLinks(userId?: string): Promise<CandidateGmailExternalLinkRow[]> {
			const effectiveUserId = resolveUserId(userId);
			let query = client
				.from("artifact_external_links")
				.select("artifact_id, provider, kind, external_id, external_url");

			if (effectiveUserId) {
				query = query.eq("user_id", effectiveUserId);
			}

			const { data, error } = await query.or(GMAIL_CANDIDATE_LINKS_OR_FILTER);

			if (error) {
				console.error("[GmailWorkflow] query links failed:", error.message);
				return [];
			}

			return (data ?? []) as CandidateGmailExternalLinkRow[];
		},

		async hasEntityLinksForArtifacts(artifactIds: string[]): Promise<boolean> {
			if (artifactIds.length === 0) {
				return false;
			}

			const { count, error } = await client
				.from("artifact_entity_links")
				.select("artifact_id", { count: "exact", head: true })
				.in("artifact_id", artifactIds);

			if (error) {
				console.warn("[GmailWorkflow] artifact_entity_links query warning:", error.message);
				return false;
			}

			return (count ?? 0) > 0;
		},

		async listTaskExternalLinksForArtifacts(artifactIds: string[]): Promise<TaskExternalLinkRow[]> {
			if (artifactIds.length === 0) {
				return [];
			}

			const { data, error } = await client
				.from("artifact_external_links")
				.select("external_id, provider, kind")
				.in("artifact_id", artifactIds)
				.eq("kind", "task");

			if (error) {
				console.warn("[GmailWorkflow] task links query warning:", error.message);
				return [];
			}

			return (data ?? []) as TaskExternalLinkRow[];
		},

		recordTriageDecisions,
		recordTriageDecision,
		listTriageDecisions,
		listDecidedThreadIds,
		overrideTriageDecision,
	};
}
