import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	defineAction,
	executeAction,
	setDefaultAuditSink,
	stderrAuditSink,
	type ActionAuditRecord,
} from "@ahkms/core";

vi.mock("../instrument.js", () => ({
	Sentry: {
		captureException: vi.fn(),
		isInitialized: () => false,
	},
}));

import { Sentry } from "../instrument.js";
import { toMcpTool } from "./adapters/mcp.js";
import { configureLedger, ledgerHealth } from "./ledger.js";

const echoAction = defineAction({
	id: "echo_action",
	description: "Echoes a string value",
	schema: z.object({ value: z.string() }),
	annotations: { readOnlyHint: true },
	run: async (input) => ({ echoed: input.value }),
});

function createFakeLedgerClient(
	responder: (payload: Record<string, unknown>) => Promise<{ error: { code?: string; message: string } | null }> = async () => ({
		error: null,
	}),
) {
	const inserts: Array<{ table: string; payload: Record<string, unknown> }> = [];
	const client = {
		from: (table: string) => ({
			insert: (payload: Record<string, unknown>) => {
				inserts.push({ table, payload });
				return responder(payload);
			},
		}),
	};
	return { client, inserts };
}

describe("configureLedger and ledgerHealth (#1412)", () => {
	afterEach(() => {
		setDefaultAuditSink(stderrAuditSink);
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("1. installs default sink that writes [audit:action] and inserts into action_ledger for executeAction and toMcpTool", async () => {
		const stderrLines: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...args) => {
			stderrLines.push(args.map(String).join(" "));
		});

		const { client, inserts } = createFakeLedgerClient();
		configureLedger(client as never);

		const result = await executeAction(
			echoAction,
			{ value: "x" },
			{ context: { caller: "http" } },
		);
		expect(result).toEqual({ echoed: "x" });
		expect(inserts).toHaveLength(1);
		expect(inserts[0].table).toBe("action_ledger");
		expect(inserts[0].payload.action_id).toBe("echo_action");
		expect(inserts[0].payload.caller).toBe("http");
		expect(
			stderrLines.filter((line) => line.startsWith("[audit:action] echo_action")),
		).toHaveLength(1);

		const tool = toMcpTool(echoAction);
		await tool.handler({ value: "x" });
		expect(inserts).toHaveLength(2);
		expect(inserts[1].table).toBe("action_ledger");
		expect(inserts[1].payload.caller).toBe("mcp");
	});

	it("2. on PGRST205 error resolves normal result, increments failuresSinceBoot, reports to Sentry with tags only, and logs to stderr without input keys or values", async () => {
		const stderrLines: string[] = [];
		vi.spyOn(console, "error").mockImplementation((...args) => {
			stderrLines.push(args.map(String).join(" "));
		});

		const { client } = createFakeLedgerClient(async () => ({
			error: {
				code: "PGRST205",
				message: "Could not find the table 'public.action_ledger' in the schema cache",
			},
		}));

		configureLedger(client as never);

		const result = await executeAction(
			echoAction,
			{ value: "secret-input-value" },
			{ context: { caller: "http", requestId: "req-missing-table" } },
		);

		expect(result).toEqual({ echoed: "secret-input-value" });

		const health = ledgerHealth();
		expect(health.installed).toBe(true);
		expect(health.failuresSinceBoot).toBe(1);
		expect(health.lastFailureAt).toBeTruthy();
		expect(health.lastFailureMessage).toContain("PGRST205");
		expect(health.sentry).toBe("off");

		expect(Sentry.captureException).toHaveBeenCalledTimes(1);
		const [, sentryContext] = vi.mocked(Sentry.captureException).mock.calls[0] as [
			unknown,
			Record<string, unknown>,
		];
		expect(sentryContext).toEqual({
			tags: {
				requestId: "req-missing-table",
				actionId: "echo_action",
			},
			fingerprint: ["action_ledger_sink_failure"],
		});
		expect(JSON.stringify(sentryContext)).not.toContain("value");
		expect(JSON.stringify(sentryContext)).not.toContain("secret-input-value");

		const matchingStderr = stderrLines.filter(
			(line) =>
				line.includes("req-missing-table") && line.includes("action_ledger"),
		);
		expect(matchingStderr.length).toBeGreaterThanOrEqual(1);
		for (const line of stderrLines) {
			expect(line).not.toContain("secret-input-value");
		}
	});

	it("3. rejects after 2000 ms of fake time when insert never resolves and increments failuresSinceBoot", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

		const { client } = createFakeLedgerClient(
			() => new Promise(() => {}),
		);
		const sink = configureLedger(client as never);

		const sampleRecord: ActionAuditRecord = {
			actionId: "echo_action",
			seam: "action",
			caller: "http",
			requestId: "req-timeout",
			userId: null,
			clientId: null,
			sessionId: null,
			outcome: "success",
			durationMs: 10,
			errorMessage: null,
			inputKeys: ["value"],
			inputSha256: "abc",
		};

		const promise = sink(sampleRecord);
		const assertion = expect(promise).rejects.toThrow(/timed out after 2000 ms/);
		await vi.advanceTimersByTimeAsync(2000);
		await assertion;

		expect(ledgerHealth().failuresSinceBoot).toBe(1);
	});

	it("4. static check: index.ts and http.ts call configureLedger( at the start of main() before createServer( and actionsRouter(", () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const indexSrc = readFileSync(resolve(here, "../index.ts"), "utf8");
		const httpSrc = readFileSync(resolve(here, "../http.ts"), "utf8");

		const indexMain = indexSrc.slice(indexSrc.indexOf("async function main()"));
		const indexConfigureIdx = indexMain.indexOf("configureLedger(");
		const indexCreateServerIdx = indexMain.indexOf("createServer(");
		expect(indexConfigureIdx).toBeGreaterThan(0);
		expect(indexCreateServerIdx).toBeGreaterThan(indexConfigureIdx);

		const httpMain = httpSrc.slice(httpSrc.indexOf("async function main()"));
		const httpConfigureIdx = httpMain.indexOf("configureLedger(");
		const httpActionsRouterIdx = httpMain.indexOf("actionsRouter(");
		const httpCreateServerIdx = httpMain.indexOf("createServer(");
		expect(httpConfigureIdx).toBeGreaterThan(0);
		expect(httpActionsRouterIdx).toBeGreaterThan(httpConfigureIdx);
		expect(httpCreateServerIdx).toBeGreaterThan(httpConfigureIdx);
	});
});
