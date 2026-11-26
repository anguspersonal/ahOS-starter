import { describe, expect, it } from "vitest";
import { serverRegistry } from "./serverRegistry.js";

describe("graph_node_level action registration (#1448)", () => {
	it("registers graph_node_level with auditLog: true and annotations.readOnlyHint === false", () => {
		const registry = serverRegistry();

		const action = registry.get("graph_node_level");
		expect(action).toBeDefined();
		expect((action as any).auditLog).toBe(true);
		expect(action?.annotations.readOnlyHint).toBe(false);
	});
});
