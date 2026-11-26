import { describe, expect, it, vi } from "vitest";
import { buildNotionProperties, type NotionDatabaseSchema } from "./taskProperties.js";

describe("buildNotionProperties", () => {
	const schema: NotionDatabaseSchema = {
		properties: [{ name: "Status", type: "select", options: ["Open"] }],
	};

	it("calls injected loadSchema once when schema is omitted and never when provided", async () => {
		const loadSchema = vi.fn().mockResolvedValue(schema);
		await buildNotionProperties({
			propertyMap: { status: "Status" },
			tasksDatabaseId: "db1",
			properties: { status: "Open" },
			loadSchema,
		});
		expect(loadSchema).toHaveBeenCalledTimes(1);
		expect(loadSchema).toHaveBeenCalledWith("db1");

		const loadSchema2 = vi.fn();
		await buildNotionProperties({
			propertyMap: { status: "Status" },
			tasksDatabaseId: "db1",
			properties: { status: "Open" },
			schema,
			loadSchema: loadSchema2,
		});
		expect(loadSchema2).not.toHaveBeenCalled();
	});

	it("rejects select values outside the schema's options", async () => {
		await expect(
			buildNotionProperties({
				propertyMap: { status: "Status" },
				tasksDatabaseId: "db1",
				properties: { status: "Invalid" },
				schema,
			}),
		).rejects.toThrow("'Invalid' is not a valid option for 'Status' (select). Valid options: Open");
	});
});
