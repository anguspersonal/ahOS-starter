import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createActionContext } from "../defineAction.js";
import { buildRegistry } from "../buildRegistry.js";
import { createMcpResultProbeAction } from "./mcpResultProbe.js";

function expectedMarker(prefix: "TEXT-" | "DATA-", nonce: string, suffix: ":text" | ":data"): string {
	const digest = createHash("sha256").update(`${nonce}${suffix}`).digest("hex");
	return `${prefix}${digest.slice(0, 8)}`;
}

describe("mcp_result_probe action (#2399)", () => {
	const action = createMcpResultProbeAction();
	const ctx = createActionContext();

	it("returns text_marker and data_marker matching sha256(nonce + suffix) with 8 lowercase hex chars", async () => {
		const result = await action.run({ nonce: "kiwi" }, ctx);

		expect(result.nonce).toBe("kiwi");
		expect(result.text_marker).toBe(expectedMarker("TEXT-", "kiwi", ":text"));
		expect(result.data_marker).toBe(expectedMarker("DATA-", "kiwi", ":data"));
		expect(result.text_marker).toMatch(/^TEXT-[0-9a-f]{8}$/);
		expect(result.data_marker).toMatch(/^DATA-[0-9a-f]{8}$/);
		expect(result.note.toLowerCase()).toContain("structured");
	});

	it("produces different markers for different nonces and identical markers for the same nonce", async () => {
		const r1 = await action.run({ nonce: "alpha" }, ctx);
		const r2 = await action.run({ nonce: "alpha" }, ctx);
		const r3 = await action.run({ nonce: "beta" }, ctx);

		expect(r1.text_marker).toBe(r2.text_marker);
		expect(r1.data_marker).toBe(r2.data_marker);
		expect(r1.text_marker).not.toBe(r3.text_marker);
		expect(r1.data_marker).not.toBe(r3.data_marker);
	});

	it("formatMcp prints nonce and text_marker and never prints data_marker", async () => {
		const result = await action.run({ nonce: "kiwi" }, ctx);
		const formatted = action.formatMcp!(result);

		expect(formatted).toContain("kiwi");
		expect(formatted).toContain(result.text_marker);
		expect(formatted).not.toContain(result.data_marker);
	});

	it("schema rejects empty nonce and nonce longer than 64 characters, and accepts 1..64 chars", () => {
		expect(action.schema.safeParse({ nonce: "" }).success).toBe(false);
		expect(action.schema.safeParse({ nonce: "a".repeat(65) }).success).toBe(false);
		expect(action.schema.safeParse({}).success).toBe(false);
		expect(action.schema.safeParse({ nonce: "a" }).success).toBe(true);
		expect(action.schema.safeParse({ nonce: "a".repeat(64) }).success).toBe(true);
	});

	it("buildRegistry({}) registers mcp_result_probe with expose.mcp true and readOnlyHint true", () => {
		const registry = buildRegistry({});
		const registered = registry.get("mcp_result_probe");

		expect(registered).toBeDefined();
		expect(registered!.expose?.mcp).toBe(true);
		expect(registered!.annotations.readOnlyHint).toBe(true);
		expect(registered!.annotations.idempotentHint).toBe(true);
		expect(registered!.annotations.destructiveHint).toBe(false);
		expect(registered!.annotations.openWorldHint).toBe(false);
		expect(registered!.needsApproval).toBeUndefined();
	});
});
