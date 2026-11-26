import { STUCK_APPROVAL_AFTER_MS } from "@ahkms/core/engine";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "../supabase.js";
import type { DoctorCheck } from "./report.js";

const CHECK_NAME = "stuck action approvals";
const FAIL_AFTER_MS = 2 * 60 * 60 * 1000;
const SAMPLE_LIMIT = 5;

interface StuckApprovalRow {
	id: string;
	title: string | null;
	resolved_at: string | null;
}

export type ApprovalCheckClient = Pick<SupabaseClient, "from">;

export async function approvalChecks(
	client: ApprovalCheckClient = supabase,
	now: Date = new Date(),
): Promise<DoctorCheck[]> {
	const cutoffIso = new Date(now.getTime() - STUCK_APPROVAL_AFTER_MS).toISOString();
	const { data, count, error } = await client
		.from("system_decisions")
		.select("id, title, resolved_at", { count: "exact" })
		.eq("decision_type", "action_approval")
		.eq("status", "approved")
		.lt("resolved_at", cutoffIso)
		.order("resolved_at", { ascending: true })
		.limit(SAMPLE_LIMIT);

	if (error || count === null || count === undefined) {
		return [
			{
				family: "wiring",
				name: CHECK_NAME,
				status: "warn",
				detail: error ? `could not read system_decisions: ${error.message}` : "system_decisions query returned null count",
				fix: "verify Supabase connectivity and system_decisions permissions",
			},
		];
	}

	if (count === 0) {
		return [{ family: "wiring", name: CHECK_NAME, status: "ok", detail: "no action_approval rows stuck at approved past 30 minutes.", fix: "" }];
	}

	const rows = Array.isArray(data) ? (data as StuckApprovalRow[]) : [];
	const oldestMs = rows[0]?.resolved_at ? Date.parse(rows[0].resolved_at) : Number.NaN;
	const isFail = !Number.isNaN(oldestMs) && now.getTime() - oldestMs > FAIL_AFTER_MS;
	const summaries = rows.map((r) => `${r.id} (${r.title ?? "untitled"}, claimed at ${r.resolved_at ?? "unknown"})`).join(", ");
	const moreSuffix = count > rows.length ? ` and ${count - rows.length} more` : "";

	return [
		{
			family: "wiring",
			name: CHECK_NAME,
			status: isFail ? "fail" : "warn",
			detail: `${count} stuck approval row(s) — each call may or may not have run: ${summaries}${moreSuffix}`,
			fix: isFail
				? "verify the engine service is running the approval_expiry cadence; never re-run a stuck call — check action_ledger for its decision id first"
				: "never re-run a stuck call; check action_ledger for its decision id first (the engine approval_expiry cadence will mark it failed)",
		},
	];
}
