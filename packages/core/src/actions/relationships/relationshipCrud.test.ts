import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { buildRegistry, AdapterUnavailableError } from "../buildRegistry.js";
import { exposureOf } from "../exposure.js";
import { createActionContext } from "../defineAction.js";
import type { RelationshipsPort, RelationshipCrudOutput } from "../../ports/relationships.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const fakeResult: RelationshipCrudOutput = {
	success: true,
	operation: "get",
	id: "00000000-0000-0000-0000-000000000001",
	count: 1,
	message: "Found relationship",
};

describe("relationship_crud in core (issue #1537)", () => {
	it("acceptance 1: buildRegistry({ relationships: fakePort }) holds relationship_crud and runs the port once", async () => {
		const fakePort: RelationshipsPort = {
			relationshipCrud: vi.fn().mockResolvedValue(fakeResult),
		};

		const registry = buildRegistry({ relationships: fakePort });
		const action = registry.get("relationship_crud");

		expect(action).toBeDefined();
		expect(action?.id).toBe("relationship_crud");

		const ctx = createActionContext({ userId: "user-123" });
		const input = {
			operation: "get" as const,
			id: "00000000-0000-0000-0000-000000000001",
		};

		const result = await action!.run(input, ctx);
		expect(result).toEqual(fakeResult);
		expect(fakePort.relationshipCrud).toHaveBeenCalledTimes(1);
		expect(fakePort.relationshipCrud).toHaveBeenCalledWith(input, ctx);
	});

	it("acceptance 2: its exposure equals what #1407 set (mcp off, reason owner_decision_pending, note naming choice against entity_relate); schema keys equal dev's", () => {
		const fakePort: RelationshipsPort = {
			relationshipCrud: vi.fn().mockResolvedValue(fakeResult),
		};

		const registry = buildRegistry({ relationships: fakePort });
		const action = registry.get("relationship_crud");
		expect(action).toBeDefined();

		const exposure = exposureOf(action!);
		expect(exposure).toEqual({
			mcp: false,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
			reason: "owner_decision_pending",
			note: "web-only until the owner chooses between it and entity_relate on MCP",
		});

		const schemaKeys = Object.keys((action!.schema as any).shape).sort();
		expect(schemaKeys).toEqual([
			"confidence_score",
			"filter",
			"from_entity_id",
			"id",
			"metadata",
			"operation",
			"relationship_type",
			"role",
			"to_entity_id",
		]);
	});

	it("acceptance 3: static: packages/web/src/lib/relationshipActions.ts contains no z.object(", () => {
		const webFilePath = path.resolve(__dirname, "../../../../web/src/lib/relationshipActions.ts");
		expect(fs.existsSync(webFilePath)).toBe(true);

		const content = fs.readFileSync(webFilePath, "utf8");
		expect(content).not.toContain("z.object(");
	});

	it("throws AdapterUnavailableError when unwired relationships adapter is invoked", async () => {
		const registry = buildRegistry({});
		const action = registry.get("relationship_crud");
		expect(action).toBeDefined();

		await expect(
			action!.run({ operation: "get", id: "00000000-0000-0000-0000-000000000001" }, createActionContext()),
		).rejects.toThrow(AdapterUnavailableError);
	});
});
