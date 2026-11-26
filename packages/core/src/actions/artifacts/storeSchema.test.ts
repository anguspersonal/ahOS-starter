import { describe, expect, it } from "vitest";
import { executeAction } from "../adapters/direct.js";
import {
	createStoreSchemaAction,
	parseDefinition,
	parseOpenApi,
} from "./storeSchema.js";
import type { OpenApiDoc } from "../../ports/schema.js";

const SPEC: OpenApiDoc = {
	definitions: {
		entities: {
			required: ["user_id", "name"],
			properties: {
				id: {
					format: "uuid",
					type: "string",
					description: "Note:\nThis is a Primary Key.<pk/>",
				},
				user_id: { format: "uuid", type: "string" },
				name: { format: "text", type: "string" },
				kind: { format: "entity_kind", type: "string", enum: ["project", "org"] },
				created_at: { format: "timestamp with time zone", type: "string" },
			},
		},
		artifacts: {
			required: ["user_id"],
			properties: {
				id: { format: "uuid", type: "string" },
				title: { format: "text", type: "string" },
				user_id: { format: "uuid", type: "string" },
			},
		},
	},
};

describe("parseDefinition & parseOpenApi", () => {
	it("maps format, type, required, enum, and description and sorts tables by name", () => {
		const table = parseDefinition("entities", SPEC.definitions!.entities);
		expect(table.columns.find((c) => c.name === "name")?.requiredOnInsert).toBe(true);
		expect(table.columns.find((c) => c.name === "created_at")?.requiredOnInsert).toBe(false);
		expect(table.columns.find((c) => c.name === "kind")?.enumValues).toEqual(["project", "org"]);
		expect(parseOpenApi(SPEC).map((t) => t.name)).toEqual(["artifacts", "entities"]);
	});
});

describe("createStoreSchemaAction", () => {
	it("lists all exposed tables when table is omitted", async () => {
		const action = createStoreSchemaAction({ fetchOpenApi: async () => SPEC });
		const result = await executeAction(action, {});
		expect(result.summary).toContain("2 table(s)/view(s)");
		expect(result.summary).toContain("artifacts  (3 column(s))");
		expect(result.summary).toContain("entities  (5 column(s))");
	});

	it("renders columns and json fence for a specific table", async () => {
		const action = createStoreSchemaAction({ fetchOpenApi: async () => SPEC });
		const result = await executeAction(action, { table: "entities" });
		expect(result.summary).toContain("entities — 5 column(s)");
		expect(result.summary).toContain("name  text (json: string)  [required-on-insert]");
		expect(result.summary).toContain("Note: This is a Primary Key.<pk/>");
		expect(action.formatMcp?.(result)).toBe(result.summary);
	});

	it("throws when PostgREST publishes no definitions or table is unknown", async () => {
		const emptyAction = createStoreSchemaAction({
			fetchOpenApi: async () => ({ definitions: {} }),
		});
		await expect(executeAction(emptyAction, {})).rejects.toThrow(/no table definitions/);

		const action = createStoreSchemaAction({ fetchOpenApi: async () => SPEC });
		await expect(executeAction(action, { table: "missing" })).rejects.toThrow(
			/no table or view named 'missing'/,
		);
	});
});
