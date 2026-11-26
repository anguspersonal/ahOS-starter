/**
 * Supabase ActionApprovalStore adapter (ADR-100 §1, ADR-104 G4, G7, G8, #1417).
 *
 * Persists parked outward agent action calls as pending rows in
 * `public.system_decisions` (`decision_type = 'action_approval'`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
	ApprovalFinishResolution,
	ApprovalInboxStore,
	ApprovalRequest,
	ApprovalResolutionOutcome,
	ClaimedApproval,
	PendingApprovalInboxRow,
} from "../../actions/gate.js";

export interface SupabaseActionApprovalStoreOptions {
	now?: () => Date;
	ttlDays?: number;
}

const MS_PER_DAY = 86_400_000;

export function createSupabaseActionApprovalStore(
	client: Pick<SupabaseClient, "from">,
	{ now = () => new Date(), ttlDays = 7 }: SupabaseActionApprovalStoreOptions = {},
): ApprovalInboxStore {
	return {
		async park(request: ApprovalRequest): Promise<{ decisionId: string }> {
			if (!request.userId) {
				throw new Error(
					"system_decisions action_approval requires a non-null user_id",
				);
			}

			const inputKeys =
				request.input !== null &&
				typeof request.input === "object" &&
				!Array.isArray(request.input)
					? Object.keys(request.input as Record<string, unknown>)
					: [];

			const expiresAt = new Date(
				now().getTime() + ttlDays * MS_PER_DAY,
			).toISOString();

			const keysLabel = inputKeys.length > 0 ? inputKeys.join(", ") : "none";
			const description = `Action ${request.actionId} requested by ${request.caller} (input keys: ${keysLabel})`;

			const payload = {
				decision_type: "action_approval",
				review_type: "approval",
				stage: "act",
				status: "pending",
				title: `Approve ${request.actionId}`,
				description,
				decision_payload: {
					action_id: request.actionId,
					input: request.input ?? null,
					input_keys: inputKeys,
					caller: request.caller,
					request_id: request.requestId,
					client_id: request.clientId ?? null,
					session_id: request.sessionId ?? null,
				},
				input_sha256: request.inputSha256,
				user_id: request.userId,
				requires_user_action: true,
				user_visible: true,
				blocking: false,
				expires_at: expiresAt,
			};

			const { data, error } = await client
				.from("system_decisions")
				.insert(payload)
				.select("id")
				.single();

			if (error) {
				const code = error.code ? ` [${error.code}]` : "";
				throw new Error(`system_decisions insert failed${code}: ${error.message}`);
			}

			const id = (data as { id?: unknown } | null)?.id;
			if (typeof id !== "string" || !id) {
				throw new Error("system_decisions insert failed: missing id in response");
			}

			return { decisionId: id };
		},

		async claim(
			decisionId: string,
			approverUserId: string,
			notes?: string | null,
		): Promise<ClaimedApproval | null> {
			const nowIso = now().toISOString();
			const { data, error } = await client
				.from("system_decisions")
				.update({
					status: "approved",
					resolved_by: approverUserId,
					resolved_at: nowIso,
					resolution_notes: notes ?? null,
				})
				.eq("id", decisionId)
				.eq("decision_type", "action_approval")
				.eq("user_id", approverUserId)
				.eq("status", "pending")
				.is("resolved_at", null)
				.gt("expires_at", nowIso)
				.select("*");

			if (error) {
				const code = error.code ? ` [${error.code}]` : "";
				throw new Error(
					`system_decisions claim failed for decision ${decisionId}${code}: ${error.message}`,
				);
			}

			const rows = Array.isArray(data) ? data : data ? [data] : [];
			const row = rows[0] as Record<string, unknown> | undefined;
			if (!row) {
				return null;
			}

			const payload =
				(row.decision_payload as Record<string, unknown> | null | undefined) ??
				{};

			return {
				decisionId: String(row.id ?? decisionId),
				actionId: String(payload.action_id ?? ""),
				input: payload.input,
				inputSha256: String(row.input_sha256 ?? ""),
				caller: String(payload.caller ?? ""),
				userId: String(row.user_id ?? ""),
			};
		},

		async finish(
			decisionId: string,
			resolution: ApprovalResolutionOutcome | ApprovalFinishResolution,
			errorMsg?: string,
		): Promise<void> {
			const outcome: ApprovalResolutionOutcome =
				typeof resolution === "string"
					? resolution
					: (resolution.outcome ?? resolution.status ?? "executed");
			const errText =
				typeof resolution === "string" ? errorMsg : resolution.error;
			const resolutionData: { outcome: ApprovalResolutionOutcome; error?: string } =
				errText !== undefined ? { outcome, error: errText } : { outcome };

			const { data, error } = await client
				.from("system_decisions")
				.update({
					status: outcome,
					resolution_data: resolutionData,
				})
				.eq("id", decisionId)
				.eq("status", "approved")
				.select("id");

			if (error) {
				const code = error.code ? ` [${error.code}]` : "";
				throw new Error(
					`system_decisions finish failed for decision ${decisionId}${code}: ${error.message}`,
				);
			}

			const rows = Array.isArray(data) ? data : data ? [data] : [];
			if (rows.length === 0) {
				throw new Error(
					`system_decisions finish matched zero approved rows for decision ${decisionId}`,
				);
			}
		},

		async reject(
			decisionId: string,
			approverUserId: string,
			notes?: string | null,
		): Promise<boolean> {
			const nowIso = now().toISOString();
			const { data, error } = await client
				.from("system_decisions")
				.update({
					status: "rejected",
					resolved_by: approverUserId,
					resolved_at: nowIso,
					resolution_notes: notes ?? null,
				})
				.eq("id", decisionId)
				.eq("decision_type", "action_approval")
				.eq("user_id", approverUserId)
				.eq("status", "pending")
				.is("resolved_at", null)
				.select("id");

			if (error) {
				const code = error.code ? ` [${error.code}]` : "";
				throw new Error(
					`system_decisions reject failed for decision ${decisionId}${code}: ${error.message}`,
				);
			}

			const rows = Array.isArray(data) ? data : data ? [data] : [];
			return rows.length > 0;
		},

		async listPending(
			userId: string,
			limit: number,
		): Promise<PendingApprovalInboxRow[]> {
			const nowIso = now().toISOString();
			const { data, error } = await client
				.from("system_decisions")
				.select("id, decision_payload, created_at, expires_at")
				.eq("decision_type", "action_approval")
				.eq("user_id", userId)
				.eq("status", "pending")
				.is("resolved_at", null)
				.gt("expires_at", nowIso)
				.order("created_at", { ascending: false })
				.limit(limit);

			if (error) {
				const code = error.code ? ` [${error.code}]` : "";
				throw new Error(
					`system_decisions listPending failed${code}: ${error.message}`,
				);
			}

			const rows = Array.isArray(data) ? data : [];
			return rows.map((raw) => {
				const row = raw as Record<string, unknown>;
				const payload =
					(row.decision_payload as Record<string, unknown> | null | undefined) ??
					{};
				return {
					decision_id: String(row.id ?? ""),
					action_id:
						typeof payload.action_id === "string" ? payload.action_id : null,
					input: payload.input === undefined ? null : payload.input,
					input_keys: Array.isArray(payload.input_keys)
						? (payload.input_keys as string[])
						: null,
					caller: typeof payload.caller === "string" ? payload.caller : null,
					client_id:
						typeof payload.client_id === "string" ? payload.client_id : null,
					session_id:
						typeof payload.session_id === "string" ? payload.session_id : null,
					created_at: String(row.created_at ?? ""),
					expires_at:
						typeof row.expires_at === "string" ? row.expires_at : null,
				};
			});
		},
	};
}
