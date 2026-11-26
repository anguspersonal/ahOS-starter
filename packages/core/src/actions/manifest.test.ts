import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
	buildActionManifest,
	serialiseManifest,
	checkFormerIds,
	validateActionManifest,
	type ActionManifest,
} from "./manifest.js";
import { buildRegistry } from "./buildRegistry.js";
import { EXPOSURE_OPT_OUT_REASONS } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe("Action manifest (ADR-105 R2, R10, R11)", () => {
	it("case 1: committed action-manifest.json equals serialiseManifest(buildActionManifest(buildRegistry({})))", () => {
		const committedPath = path.resolve(__dirname, "../../action-manifest.json");
		expect(fs.existsSync(committedPath)).toBe(true);
		const committedText = fs.readFileSync(committedPath, "utf8");
		const freshText = serialiseManifest(buildActionManifest(buildRegistry({})));
		if (committedText !== freshText) {
			throw new Error("Committed action-manifest.json is stale; run npm run gen:action-manifest -w @ahkms/core and commit the result");
		}
		expect(committedText).toBe(freshText);
	});

	it("case 2: manifest shape follows {\"version\":1,\"actions\":{ then one line per action sorted by id, then }}", () => {
		const committedPath = path.resolve(__dirname, "../../action-manifest.json");
		const text = fs.readFileSync(committedPath, "utf8");
		const lines = text.trimEnd().split("\n");

		expect(lines[0]).toBe('{"version":1,"actions":{');
		expect(lines[lines.length - 1]).toBe("}}");

		const parsed = JSON.parse(text) as ActionManifest;
		expect(parsed.version).toBe(1);
		expect(Object.keys(parsed.actions).sort()).toEqual(buildRegistry({}).list().map((a) => a.id).sort());


		const sortedIds = Object.keys(parsed.actions).sort();
		expect(Object.keys(parsed.actions)).toEqual(sortedIds);

		for (const [, entry] of Object.entries(parsed.actions)) {
			expect(typeof entry.description).toBe("string");
			expect(entry.domain === null || typeof entry.domain === "string").toBe(true);
			expect(entry.annotations).toBeDefined();
			expect(typeof entry.annotations.readOnlyHint).toBe("boolean");
			expect(typeof entry.annotations.destructiveHint).toBe("boolean");
			expect(typeof entry.annotations.idempotentHint).toBe("boolean");
			expect(typeof entry.annotations.openWorldHint).toBe("boolean");

			expect(typeof entry.expose.mcp).toBe("boolean");
			expect(typeof entry.expose.http).toBe("boolean");
			expect(typeof entry.expose.ui_agent).toBe("boolean");
			expect(typeof entry.expose.worker).toBe("boolean");
			expect(typeof entry.expose.cli).toBe("boolean");
			expect(typeof entry.expose.a2a).toBe("boolean");

			const anyDefaultOff = !entry.expose.mcp || !entry.expose.http || !entry.expose.ui_agent || !entry.expose.worker;
			if (anyDefaultOff) {
				expect(entry.expose.reason).toBeDefined();
				expect(typeof entry.expose.note).toBe("string");
				expect(entry.expose.note!.length).toBeGreaterThan(0);
			} else {
				expect(entry.expose.reason).toBeUndefined();
				expect(entry.expose.note).toBeUndefined();
			}

			expect(entry.input_schema.type).toBe("object");
			expect(Array.isArray(entry.former_ids)).toBe(true);
		}

		expect(parsed.actions.entity_derive.expose).toMatchObject({
			worker: true,
			mcp: false,
			http: false,
			ui_agent: false,
			reason: "app_internal",
		});
		expect(parsed.actions.entity_synthesize.expose).toMatchObject({
			worker: true,
			mcp: true,
			http: true,
			ui_agent: true,
			cli: false,
			a2a: false,
		});
	});

	it("case 3: input_schema equals z.toJSONSchema(action.schema, { target: 'openapi-3.0', io: 'input' })", () => {
		const registry = buildRegistry({});
		const manifest = buildActionManifest(registry);

		for (const action of registry.list()) {
			const expected = z.toJSONSchema(action.schema, { target: "openapi-3.0", io: "input" });
			expect(manifest.actions[action.id].input_schema).toEqual(expected);
		}
	});

	it("case 4: every id and former id matches ^[a-z][a-z0-9]*(_[a-z0-9]+)*$, no former id equals live id or duplicate", () => {
		const registry = buildRegistry({});
		const manifest = buildActionManifest(registry);
		const regex = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;

		for (const id of Object.keys(manifest.actions)) {
			expect(regex.test(id)).toBe(true);
		}

		expect(() => checkFormerIds(manifest, "2026-10-12")).not.toThrow();

		const badIdManifest: ActionManifest = {
			version: 1,
			actions: { "bad-id": { ...manifest.actions.entity_derive } } as any,
		};
		expect(() => checkFormerIds(badIdManifest, "2026-10-12")).toThrowError(/not snake_case/);

		const liveCollisionManifest: ActionManifest = {
			version: 1,
			actions: {
				action_a: {
					...manifest.actions.entity_derive,
					former_ids: [{ id: "action_b", until: "2027-01-01" }],
				},
				action_b: {
					...manifest.actions.entity_synthesize,
					former_ids: [],
				},
			},
		};
		expect(() => checkFormerIds(liveCollisionManifest, "2026-10-12")).toThrowError(/equals a live action id/);

		const dupFormerManifest: ActionManifest = {
			version: 1,
			actions: {
				action_a: {
					...manifest.actions.entity_derive,
					former_ids: [{ id: "old_x", until: "2027-01-01" }],
				},
				action_b: {
					...manifest.actions.entity_synthesize,
					former_ids: [{ id: "old_x", until: "2027-01-01" }],
				},
			},
		};
		expect(() => checkFormerIds(dupFormerManifest, "2026-10-12")).toThrowError(/duplicates former id/);
	});

	it("case 5: checkFormerIds with expired fixture fails with exact message, non-ISO date fails", () => {
		const expiredFixture: ActionManifest = {
			version: 1,
			actions: {
				x: {
					description: "Test action x",
					domain: null,
					annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
					expose: { mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false },
					input_schema: { type: "object" },
					former_ids: [{ id: "old_x", until: "2026-10-01" }],
				},
			},
		};

		expect(() => checkFormerIds(expiredFixture, "2026-10-02")).toThrowError(
			"remove former id old_x of x; its window closed on 2026-10-01",
		);

		const badDateFixture: ActionManifest = {
			version: 1,
			actions: {
				x: {
					description: "Test action x",
					domain: null,
					annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
					expose: { mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false },
					input_schema: { type: "object" },
					former_ids: [{ id: "old_x", until: "not-an-iso-date" }],
				},
			},
		};
		expect(() => checkFormerIds(badDateFixture, "2026-10-02")).toThrowError(/not an ISO date/);
	});

	it("case 6: a reason outside EXPOSURE_OPT_OUT_REASONS in a hand-edited fixture fails", () => {
		const badReasonFixture: ActionManifest = {
			version: 1,
			actions: {
				x: {
					description: "Test action x",
					domain: null,
					annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
					expose: {
						mcp: false,
						http: true,
						ui_agent: true,
						worker: true,
						cli: false,
						a2a: false,
						reason: "invalid_reason" as any,
						note: "Testing bad reason",
					},
					input_schema: { type: "object" },
					former_ids: [],
				},
			},
		};

		expect(() => validateActionManifest(badReasonFixture)).toThrowError(/has invalid expose\.reason/);
		expect(() => serialiseManifest(badReasonFixture)).toThrowError(/has invalid expose\.reason/);
	});

	it("case 7: action-manifest.json resolves with type: json", async () => {
		const manifest = await import("../../action-manifest.json", { with: { type: "json" } });
		expect(manifest.default.version).toBe(1);
		expect(Object.keys(manifest.default.actions).sort()).toEqual(buildRegistry({}).list().map((a) => a.id).sort());
	});
});

