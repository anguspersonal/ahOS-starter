import { describe, expect, it } from "vitest";
import { ledgerChecks } from "./ledgerChecks.js";

function createFakeReadClient(result: {
	data: Array<{ created_at: string }> | null;
	error: { code?: string; message: string } | null;
}) {
	const selectedColumns: string[] = [];
	const client = {
		from: (table: string) => ({
			select: (columns: string) => {
				expect(table).toBe("action_ledger");
				selectedColumns.push(columns);
				return {
					order: () => ({
						limit: async () => result,
					}),
				};
			},
		}),
	};
	return { client, selectedColumns };
}

describe("ledgerChecks (#1412)", () => {
	const now = new Date("2026-10-16T12:00:00.000Z");
	const threeMinutesAgo = new Date(now.getTime() - 3 * 60_000).toISOString();

	it("5. returns ok with 0 sink failures and newest row 3 min ago, selecting created_at only", async () => {
		const { client, selectedColumns } = createFakeReadClient({
			data: [{ created_at: threeMinutesAgo }],
			error: null,
		});

		const checks = await ledgerChecks(
			client as never,
			{ installed: true, failuresSinceBoot: 0 },
			now,
		);

		expect(selectedColumns).toEqual(["created_at"]);
		expect(checks).toHaveLength(1);
		expect(checks[0].family).toBe("wiring");
		expect(checks[0].name).toBe("action ledger");
		expect(checks[0].status).toBe("ok");
		expect(checks[0].detail).toContain("0 sink failures since boot");
		expect(checks[0].detail).toContain("newest row 3 min ago");
	});

	it("6. returns warn when failuresSinceBoot > 0 with last failure time and message", async () => {
		const { client } = createFakeReadClient({
			data: [{ created_at: threeMinutesAgo }],
			error: null,
		});

		const checks = await ledgerChecks(
			client as never,
			{
				installed: true,
				failuresSinceBoot: 2,
				lastFailureAt: "2026-10-16T11:58:00.000Z",
				lastFailureMessage: "action_ledger insert timed out after 2000 ms",
				sentry: "off",
			},
			now,
		);

		expect(checks).toHaveLength(1);
		expect(checks[0].status).toBe("warn");
		expect(checks[0].detail).toContain("2 sink failures since boot");
		expect(checks[0].detail).toContain("2026-10-16T11:58:00.000Z");
		expect(checks[0].detail).toContain(
			"action_ledger insert timed out after 2000 ms",
		);
		expect(checks[0].detail).toContain("Sentry is off");
	});

	it("7. returns fail on PGRST205 or 42P01 naming supabase db push from main and *_action_ledger.sql, and fail with code on other read errors", async () => {
		for (const code of ["PGRST205", "42P01"]) {
			const { client } = createFakeReadClient({
				data: null,
				error: {
					code,
					message: "table public.action_ledger does not exist",
				},
			});

			const checks = await ledgerChecks(
				client as never,
				{ installed: true, failuresSinceBoot: 0 },
				now,
			);

			expect(checks).toHaveLength(1);
			expect(checks[0].status).toBe("fail");
			expect(checks[0].detail).toContain(code);
			expect(checks[0].fix).toContain("supabase db push");
			expect(checks[0].fix).toContain("main");
			expect(checks[0].fix).toContain("*_action_ledger.sql");
		}

		const { client: otherClient } = createFakeReadClient({
			data: null,
			error: {
				code: "42501",
				message: "permission denied for table action_ledger",
			},
		});

		const otherChecks = await ledgerChecks(
			otherClient as never,
			{ installed: true, failuresSinceBoot: 0 },
			now,
		);
		expect(otherChecks).toHaveLength(1);
		expect(otherChecks[0].status).toBe("fail");
		expect(otherChecks[0].detail).toContain("42501");
	});

	it("8. returns warn when no rows exist and fail when installed is false naming configureLedger()", async () => {
		const { client } = createFakeReadClient({
			data: [],
			error: null,
		});

		const emptyChecks = await ledgerChecks(
			client as never,
			{ installed: true, failuresSinceBoot: 0 },
			now,
		);
		expect(emptyChecks).toHaveLength(1);
		expect(emptyChecks[0].status).toBe("warn");

		const uninstalledChecks = await ledgerChecks(
			client as never,
			{ installed: false, failuresSinceBoot: 0 },
			now,
		);
		expect(uninstalledChecks).toHaveLength(1);
		expect(uninstalledChecks[0].status).toBe("fail");
		expect(uninstalledChecks[0].fix).toContain("configureLedger()");
	});

	it("9. checks action_ledger_verify over the last 24h: ok when first_broken is null, fail naming uuid when broken, fail with code on rpc error (#1493)", async () => {
		const rpcCalls: Array<{ fn: string; args: unknown }> = [];
		const baseClient = createFakeReadClient({
			data: [{ created_at: threeMinutesAgo }],
			error: null,
		}).client;

		const okClient = {
			...baseClient,
			rpc: async (fn: string, args: unknown) => {
				rpcCalls.push({ fn, args });
				return {
					data: [{ checked_count: 42, first_broken: null }],
					error: null,
				};
			},
		};

		const okChecks = await ledgerChecks(
			okClient as never,
			{ installed: true, failuresSinceBoot: 0 },
			now,
		);
		expect(rpcCalls).toEqual([
			{
				fn: "action_ledger_verify",
				args: { p_since: "2026-10-15T12:00:00.000Z" },
			},
		]);
		expect(okChecks).toHaveLength(2);
		expect(okChecks[1].name).toBe("action ledger chain");
		expect(okChecks[1].status).toBe("ok");
		expect(okChecks[1].detail).toContain("42");

		const brokenUuid = "11111111-2222-3333-4444-555555555555";
		const brokenClient = {
			...baseClient,
			rpc: async () => ({
				data: [{ checked_count: 10, first_broken: brokenUuid }],
				error: null,
			}),
		};

		const brokenChecks = await ledgerChecks(
			brokenClient as never,
			{ installed: true, failuresSinceBoot: 0 },
			now,
		);
		expect(brokenChecks).toHaveLength(2);
		expect(brokenChecks[1].name).toBe("action ledger chain");
		expect(brokenChecks[1].status).toBe("fail");
		expect(brokenChecks[1].detail).toContain(brokenUuid);

		const errClient = {
			...baseClient,
			rpc: async () => ({
				data: null,
				error: {
					code: "42883",
					message: "function public.action_ledger_verify does not exist",
				},
			}),
		};

		const errChecks = await ledgerChecks(
			errClient as never,
			{ installed: true, failuresSinceBoot: 0 },
			now,
		);
		expect(errChecks).toHaveLength(2);
		expect(errChecks[1].name).toBe("action ledger chain");
		expect(errChecks[1].status).toBe("fail");
		expect(errChecks[1].detail).toContain("42883");
	});
});
