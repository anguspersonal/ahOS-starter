import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineAction } from "./defineAction.js";
import { exposureOf } from "./exposure.js";
import { createEntityDeriveAction } from "./definitions/entityDerive.js";
import { createEntitySynthesizeAction } from "./definitions/entitySynthesize.js";
import { ACTION_SURFACES, EXPOSURE_OPT_OUT_REASONS, type ActionDefinition } from "./types.js";

const dummy = { schema: z.object({ v: z.string().optional() }), run: async () => ({ ok: true }) };

describe("Action exposure (ADR-105 R3, R4)", () => {
	it("case 1: defineAction with no expose gives default exposure with no reason", () => {
		const action = defineAction({ id: "x", description: "Default", ...dummy });
		const expected = { mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false };
		expect(action.expose).toEqual(expected);
		expect(action.expose?.reason).toBeUndefined();
		expect(exposureOf(action)).toEqual(expected);
	});

	it("case 2: expose { mcp: false } without reason throws exact message", () => {
		expect(() =>
			defineAction({ id: "x", description: "Off", ...dummy, expose: { mcp: false } }),
		).toThrowError(
			'Action "x" turns off mcp without expose.reason (one of: client_local, owner_only, app_internal, legacy_twin, owner_decision_pending)',
		);
	});

	it("case 3: invalid reason, missing note, or reason when nothing is turned off", () => {
		expect(() =>
			defineAction({ id: "x", description: "Bad reason", ...dummy, expose: { mcp: false, reason: "bad" as any, note: "n" } }),
		).toThrowError(/has invalid expose.reason/);

		expect(() =>
			defineAction({ id: "x", description: "Empty note", ...dummy, expose: { mcp: false, reason: "owner_only", note: "" } }),
		).toThrowError(/without a non-empty expose.note/);

		expect(() =>
			defineAction({ id: "x", description: "All on", ...dummy, expose: { reason: "owner_only", note: "n" } }),
		).toThrowError(/reason given but nothing is turned off/);
	});

	it("case 4: cli: true throws naming #1455; a2a: true throws naming #1456", () => {
		expect(() => defineAction({ id: "x", description: "CLI", ...dummy, expose: { cli: true } })).toThrowError(/#1455/);
		expect(() => defineAction({ id: "x", description: "A2A", ...dummy, expose: { a2a: true } })).toThrowError(/#1456/);
	});

	it("case 5: exposureOf on hand-built ActionDefinition with no expose returns defaults", () => {
		const handBuilt: ActionDefinition = {
			id: "hb", name: "hb", description: "Hand built", ...dummy,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		};
		expect(handBuilt.expose).toBeUndefined();
		expect(exposureOf(handBuilt)).toEqual({ mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false });
	});

	it("case 6: core engine actions are worker only, reason app_internal", () => {
		const derive = createEntityDeriveAction({} as any);
		expect(exposureOf(derive)).toEqual({
			mcp: false, http: false, ui_agent: false, worker: true, cli: false, a2a: false,
			reason: "app_internal",
			note: "LLM batch work runs in the engine through system_jobs (ADR-101 §4)",
		});

		const synth = createEntitySynthesizeAction({} as any);
		expect(exposureOf(synth)).toEqual({
			mcp: true, http: true, ui_agent: true, worker: true, cli: false, a2a: false,
		});
	});

	it("exports ACTION_SURFACES and EXPOSURE_OPT_OUT_REASONS constants", () => {
		expect(ACTION_SURFACES).toEqual(["mcp", "http", "ui_agent", "worker", "cli", "a2a"]);
		expect(EXPOSURE_OPT_OUT_REASONS).toEqual(["client_local", "owner_only", "app_internal", "legacy_twin", "owner_decision_pending"]);
	});

	it("accepts valid formerIds and stores on definition", () => {
		const action = defineAction({
			id: "new_action",
			description: "Has former ids",
			...dummy,
			formerIds: [{ id: "old_action", until: "2026-12-31" }],
		});
		expect(action.formerIds).toEqual([{ id: "old_action", until: "2026-12-31" }]);
	});

	it("rejects invalid formerIds (non-snake_case, self-matching, non-ISO date, duplicates)", () => {
		expect(() =>
			defineAction({ id: "action_a", description: "desc", ...dummy, formerIds: [{ id: "bad-name", until: "2026-12-31" }] }),
		).toThrowError(/must be snake_case/);

		expect(() =>
			defineAction({ id: "action_a", description: "desc", ...dummy, formerIds: [{ id: "action_a", until: "2026-12-31" }] }),
		).toThrowError(/cannot equal its live id/);

		expect(() =>
			defineAction({ id: "action_a", description: "desc", ...dummy, formerIds: [{ id: "old_a", until: "not-a-date" }] }),
		).toThrowError(/must be an ISO date/);

		expect(() =>
			defineAction({
				id: "action_a",
				description: "desc",
				...dummy,
				formerIds: [
					{ id: "old_a", until: "2026-12-31" },
					{ id: "old_a", until: "2026-12-31" },
				],
			}),
		).toThrowError(/duplicate former id/);
	});
});
