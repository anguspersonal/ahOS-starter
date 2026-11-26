import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "../../actions/defineAction.js";
import type { ActionAuditRecord } from "../../actions/types.js";
import { actionCadence } from "./actionCadence.js";

const echoAction = defineAction({
	id: "echo",
	title: "Echo",
	description: "Echoes a message back with caller metadata",
	domain: "system",
	schema: z.object({ message: z.string() }),
	run: async (input, ctx) => ({
		echoed: input.message,
		caller: ctx.caller,
	}),
});

describe("actionCadence (#1554)", () => {
	it("runs echo once through executeAction with caller 'worker'", async () => {
		const auditRecords: ActionAuditRecord[] = [];
		const cadence = actionCadence({
			name: "derive",
			intervalMs: 60_000,
			actionId: "echo",
			registry: (id) => (id === "echo" ? echoAction : undefined),
			input: { message: "tick-hello" },
			userId: "user-123",
			auditSink: async (record) => {
				auditRecords.push(record);
			},
		});

		const counts = await cadence.run();
		expect(counts).toMatchObject({
			echoed: "tick-hello",
			caller: "worker",
		});
		expect(auditRecords).toHaveLength(1);
		expect(auditRecords[0]).toMatchObject({
			actionId: "echo",
			caller: "worker",
			userId: "user-123",
			outcome: "success",
		});
	});

	it("supports async input and userId callbacks and optional mapResult", async () => {
		const cadence = actionCadence({
			name: "derive",
			intervalMs: 60_000,
			actionId: "echo",
			registry: {
				get: (id) => (id === "echo" ? echoAction : undefined),
			},
			input: async () => ({ message: "dynamic-input" }),
			userId: async () => "user-dynamic",
			mapResult: (res: { echoed: string }) => ({ mappedEcho: res.echoed }),
		});

		const counts = await cadence.run();
		expect(counts).toEqual({ mappedEcho: "dynamic-input" });
	});

	it("throws synchronously at build time when actionId is unknown", () => {
		expect(() =>
			actionCadence({
				name: "derive",
				intervalMs: 60_000,
				actionId: "does_not_exist",
				registry: () => undefined,
				input: {},
			}),
		).toThrow(/Unknown cadence action: does_not_exist/);
	});

	it("throws synchronously at build time when expose.worker is false", () => {
		const nonWorkerAction = defineAction({
			id: "ui_only_action",
			title: "UI Only",
			description: "Test action not exposed to worker",
			domain: "system",
			schema: z.object({}),
			expose: {
				mcp: false,
				http: false,
				ui_agent: true,
				worker: false,
				cli: false,
				a2a: false,
				reason: "client_local",
				note: "Browser-local test action",
			},
			run: async () => ({ ok: true }),
		});

		expect(() =>
			actionCadence({
				name: "derive",
				intervalMs: 60_000,
				actionId: "ui_only_action",
				registry: (id) => (id === "ui_only_action" ? nonWorkerAction : undefined),
				input: {},
			}),
		).toThrow(/Action ui_only_action is not exposed to worker/);
	});

	it("ensures every runner.registerCadence( call in engine/main.ts uses actionCadence(...) or createJobRunnerCadence(...)", () => {
		const mainPath = path.resolve(import.meta.dirname, "../main.ts");
		const source = fs.readFileSync(mainPath, "utf8");

		const callSites: string[] = [];
		const needle = "runner.registerCadence(";
		let searchIdx = 0;
		while (true) {
			const idx = source.indexOf(needle, searchIdx);
			if (idx === -1) break;
			const snippet = source.slice(idx, idx + 220);
			callSites.push(snippet);
			searchIdx = idx + needle.length;
		}

		expect(callSites.length).toBeGreaterThanOrEqual(3);
		for (const snippet of callSites) {
			const inner = snippet.slice(needle.length).trimStart();
			const isAllowed =
				inner.startsWith("actionCadence(") || inner.startsWith("createJobRunnerCadence(");
			expect(
				isAllowed,
				`Expected runner.registerCadence to pass actionCadence(...) or createJobRunnerCadence(...), got:\n${snippet}`,
			).toBe(true);
		}
	});
});
