import type { SupabaseClient } from "@supabase/supabase-js";
import { ledgerHealth, type LedgerHealth } from "../actions/ledger.js";
import { supabase } from "../supabase.js";
import type { DoctorCheck } from "./report.js";

function withSentryNote(detail: string, sentry?: "on" | "off"): string {
	return sentry === "off"
		? `${detail}; Sentry is off (SENTRY_DSN not initialized)`
		: detail;
}

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface LedgerVerifyRow {
	checked_count?: number | string | null;
	first_broken?: string | null;
}

export type LedgerCheckClient = Pick<SupabaseClient, "from"> &
	Partial<Pick<SupabaseClient, "rpc">>;

async function runChainCheck(
	client: LedgerCheckClient,
	now: Date,
): Promise<DoctorCheck | null> {
	if (typeof client.rpc !== "function") {
		return null;
	}

	const name = "action ledger chain";
	const sinceIso = new Date(now.getTime() - TWENTY_FOUR_HOURS_MS).toISOString();
	const { data, error } = await client.rpc("action_ledger_verify", {
		p_since: sinceIso,
	});

	if (error) {
		const code = (error as { code?: string }).code ?? "unknown";
		return {
			family: "wiring",
			name,
			status: "fail",
			detail: `action_ledger_verify failed (${code}): ${error.message}`,
			fix: "run `supabase db push` from `main` to apply the `*_action_ledger_chain.sql` migration",
		};
	}

	const row: LedgerVerifyRow | undefined = Array.isArray(data)
		? (data[0] as LedgerVerifyRow | undefined)
		: (data as LedgerVerifyRow | null | undefined) ?? undefined;
	const checkedCount = Number(row?.checked_count ?? 0);
	const firstBroken = row?.first_broken ?? null;

	if (firstBroken) {
		return {
			family: "wiring",
			name,
			status: "fail",
			detail: `hash chain broken at row ${firstBroken} (checked ${checkedCount} rows in last 24h)`,
			fix: `inspect public.action_ledger around id=${firstBroken} for out-of-band modification or deletion`,
		};
	}

	return {
		family: "wiring",
		name,
		status: "ok",
		detail: `${checkedCount} rows verified over last 24h; first_broken: null`,
		fix: "",
	};
}

/**
 * Runs the `ahos_doctor` wiring checks for the `action_ledger` audit sink, table, and hash chain.
 */
export async function ledgerChecks(
	client: LedgerCheckClient = supabase,
	health: Partial<LedgerHealth> & Pick<LedgerHealth, "installed" | "failuresSinceBoot"> = ledgerHealth(),
	now: Date = new Date(),
): Promise<DoctorCheck[]> {
	const name = "action ledger";
	const sentry = health.sentry;

	if (!health.installed) {
		return [
			{
				family: "wiring",
				name,
				status: "fail",
				detail: withSentryNote("action ledger sink is not installed in this process", sentry),
				fix: "call configureLedger() at boot in main()",
			},
		];
	}

	const { data, error } = await client
		.from("action_ledger")
		.select("created_at")
		.order("created_at", { ascending: false })
		.limit(1);

	const appendChain = async (primary: DoctorCheck): Promise<DoctorCheck[]> => {
		const chainCheck = await runChainCheck(client, now);
		return chainCheck ? [primary, chainCheck] : [primary];
	};

	if (error) {
		const code = (error as { code?: string }).code ?? "unknown";
		if (code === "PGRST205" || code === "42P01") {
			return appendChain({
				family: "wiring",
				name,
				status: "fail",
				detail: withSentryNote(
					`action_ledger table missing (${code}): ${error.message}`,
					sentry,
				),
				fix: "run `supabase db push` from `main` to apply the `*_action_ledger.sql` migration",
			});
		}

		return appendChain({
			family: "wiring",
			name,
			status: "fail",
			detail: withSentryNote(
				`could not read action_ledger (${code}): ${error.message}`,
				sentry,
			),
			fix: "verify Supabase connectivity and action_ledger table permissions",
		});
	}

	const rows = Array.isArray(data) ? (data as Array<{ created_at?: string }>) : [];
	const newestCreatedAt = rows[0]?.created_at;

	if (!newestCreatedAt) {
		if (health.failuresSinceBoot > 0) {
			return appendChain({
				family: "wiring",
				name,
				status: "warn",
				detail: withSentryNote(
					`no rows in action_ledger; ${health.failuresSinceBoot} sink failures since boot (last at ${health.lastFailureAt ?? "unknown"}: ${health.lastFailureMessage ?? "unknown"})`,
					sentry,
				),
				fix: "inspect [audit:ledger] stderr logs and Sentry for action_ledger sink errors",
			});
		}

		return appendChain({
			family: "wiring",
			name,
			status: "warn",
			detail: withSentryNote(
				"action_ledger has no rows yet; 0 sink failures since boot",
				sentry,
			),
			fix: "invoke any registry action and re-check action_ledger",
		});
	}

	const ageMin = Math.max(
		0,
		Math.round((now.getTime() - new Date(newestCreatedAt).getTime()) / 60_000),
	);

	if (health.failuresSinceBoot > 0) {
		return appendChain({
			family: "wiring",
			name,
			status: "warn",
			detail: withSentryNote(
				`${health.failuresSinceBoot} sink failures since boot (last at ${health.lastFailureAt ?? "unknown"}: ${health.lastFailureMessage ?? "unknown"}); newest row ${ageMin} min ago`,
				sentry,
			),
			fix: "inspect [audit:ledger] stderr logs and Sentry for action_ledger sink errors",
		});
	}

	return appendChain({
		family: "wiring",
		name,
		status: "ok",
		detail: withSentryNote(
			`0 sink failures since boot; newest row ${ageMin} min ago`,
			sentry,
		),
		fix: "",
	});
}
