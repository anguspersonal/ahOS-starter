import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	setDefaultAuditSink,
	stderrAuditSink,
} from "../adapters/direct.js";
import { createActionContext } from "../defineAction.js";
import { exposureOf } from "../exposure.js";
import type { ActionManifest } from "../manifest.js";
import type { ActionAuditRecord } from "../types.js";
import {
	clientActionRecordSchema,
	createClientActionRecordAction,
} from "./clientActionRecord.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const manifestPath = path.resolve(__dirname, "../../../action-manifest.json");

const VALID_RECORD_1 = {
	action_id: "graph_filter",
	request_id: "11111111-1111-4111-8111-111111111111",
	trace_id: "trace-turn-1",
	outcome: "success" as const,
	duration_ms: 12,
	input_keys: ["entity_types", "query"],
	input_sha256: "a".repeat(64),
};

const VALID_RECORD_2 = {
	action_id: "view_screen",
	request_id: "22222222-2222-4222-8222-222222222222",
	outcome: "error" as const,
	duration_ms: 4,
	input_keys: ["include_record"],
	input_sha256: "b".repeat(64),
};

describe("client_action_record action (#1558, ADR-105 R9, §5)", () => {
	afterEach(() => {
		setDefaultAuditSink(stderrAuditSink);
	});

	it("1. exposes http only with reason app_internal and validates 1..50 records schema", () => {
		const action = createClientActionRecordAction();
		expect(action.id).toBe("client_action_record");
		expect(exposureOf(action)).toEqual({
			mcp: false,
			http: true,
			ui_agent: false,
			worker: false,
			cli: false,
			a2a: false,
			reason: "app_internal",
			note: expect.any(String),
		});
		expect(action.expose?.note?.length).toBeGreaterThan(0);

		expect(
			clientActionRecordSchema.parse({
				records: [VALID_RECORD_1, VALID_RECORD_2],
			}),
		).toEqual({
			records: [VALID_RECORD_1, VALID_RECORD_2],
		});

		const fiftyRecords = Array.from({ length: 50 }, (_, idx) => ({
			...VALID_RECORD_1,
			request_id: `00000000-0000-4000-8000-${String(idx + 1).padStart(12, "0")}`,
		}));
		expect(
			clientActionRecordSchema.parse({ records: fiftyRecords }).records,
		).toHaveLength(50);

		expect(() => clientActionRecordSchema.parse({ records: [] })).toThrow();
		expect(() =>
			clientActionRecordSchema.parse({
				records: [...fiftyRecords, VALID_RECORD_1],
			}),
		).toThrow();
		expect(() =>
			clientActionRecordSchema.parse({
				records: [{ ...VALID_RECORD_1, request_id: "not-a-uuid" }],
			}),
		).toThrow();
		expect(() =>
			clientActionRecordSchema.parse({
				records: [{ ...VALID_RECORD_1, outcome: "pending_approval" }],
			}),
		).toThrow();
		expect(() =>
			clientActionRecordSchema.parse({
				records: [{ ...VALID_RECORD_1, duration_ms: -1 }],
			}),
		).toThrow();
	});

	it("2. passes one audit record per entry to the audit sink with seam client_local and caller ui_agent", async () => {
		const recorded: ActionAuditRecord[] = [];
		setDefaultAuditSink((rec) => {
			recorded.push(rec);
		});

		const action = createClientActionRecordAction();
		const res = await action.run(
			{
				records: [
					VALID_RECORD_1,
					{
						...VALID_RECORD_2,
						outcome: "validation_error",
					},
				],
			},
			{
				...createActionContext({
					caller: "ui_agent",
					userId: "user-owner-1",
				}),
				sessionId: "sess-web-1",
			},
		);

		expect(res).toEqual({ recorded: 2 });
		expect(recorded).toHaveLength(2);
		expect(recorded[0]).toMatchObject({
			actionId: "graph_filter",
			seam: "client_local",
			caller: "ui_agent",
			requestId: VALID_RECORD_1.request_id,
			traceId: "trace-turn-1",
			userId: "user-owner-1",
			sessionId: "sess-web-1",
			outcome: "success",
			durationMs: 12,
			inputKeys: ["entity_types", "query"],
			inputSha256: "a".repeat(64),
		});
		expect(recorded[1]).toMatchObject({
			actionId: "view_screen",
			seam: "client_local",
			caller: "ui_agent",
			requestId: VALID_RECORD_2.request_id,
			traceId: null,
			userId: "user-owner-1",
			sessionId: "sess-web-1",
			outcome: "validation_error",
			durationMs: 4,
			inputKeys: ["include_record"],
			inputSha256: "b".repeat(64),
		});
	});

	it("3. rejects the whole batch when any action_id is not a client_local manifest id", async () => {
		const recorded: ActionAuditRecord[] = [];
		setDefaultAuditSink((rec) => {
			recorded.push(rec);
		});

		const manifest = JSON.parse(
			fs.readFileSync(manifestPath, "utf8"),
		) as ActionManifest;
		const clientLocalIds = Object.entries(manifest.actions)
			.filter(([, entry]) => entry.expose.reason === "client_local")
			.map(([id]) => id);
		expect(clientLocalIds.sort()).toEqual(["graph_filter", "view_screen"]);

		const action = createClientActionRecordAction();
		const ctx = createActionContext({
			caller: "ui_agent",
			userId: "user-owner-1",
		});

		await expect(
			action.run(
				{
					records: [
						VALID_RECORD_1,
						{
							...VALID_RECORD_2,
							action_id: "capture",
						},
					],
				},
				ctx,
			),
		).rejects.toThrow(/client_local/i);

		expect(recorded).toHaveLength(0);

		await expect(
			action.run(
				{
					records: [
						{
							...VALID_RECORD_1,
							action_id: "unknown_browser_action",
						},
					],
				},
				ctx,
			),
		).rejects.toThrow(/client_local/i);

		expect(recorded).toHaveLength(0);
	});

	it("4. rejects any caller other than ui_agent without writing to the audit sink", async () => {
		const recorded: ActionAuditRecord[] = [];
		setDefaultAuditSink((rec) => {
			recorded.push(rec);
		});

		const action = createClientActionRecordAction();

		for (const badCaller of ["ui", "http", "mcp", "worker", "cli"] as const) {
			await expect(
				action.run(
					{ records: [VALID_RECORD_1] },
					createActionContext({ caller: badCaller, userId: "user-owner-1" }),
				),
			).rejects.toThrow(/ui_agent/i);
		}

		expect(recorded).toHaveLength(0);
	});
});
