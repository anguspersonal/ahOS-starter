import { describe, expect, it } from "vitest";
import { createBindingUpdateAction } from "./update.js";
import type { ActionContext } from "../types.js";
import type { BindingRepository, BindingRow, DomainRow } from "../../ports/bindings.js";

const ctx: ActionContext = { userId: "u1", caller: "mcp", requestId: "req-1" };
const DOM_WORK = "dom-work";
const DOMAINS: DomainRow[] = [{ id: DOM_WORK, title: "work" }];

function makeRepo(rows: BindingRow[] = []): { repo: BindingRepository; rows: BindingRow[] } {
	return {
		rows,
		repo: {
			listDomains: async () => DOMAINS,
			listBindings: async () => rows,
			findBinding: async () => null,
			resolveBindingValue: async () => null,
			findExactBinding: async (name, domainId) =>
				rows.find((r) => r.name === name && r.domain_entity_id === domainId) ?? null,
			updateBinding: async (id, patch) => {
				const idx = rows.findIndex((r) => r.id === id);
				if (idx >= 0) rows[idx] = { ...rows[idx], ...patch };
			},
		},
	};
}

describe("createBindingUpdateAction", () => {
	it("updates target_kind and target_ref on the exact binding and validates shape", async () => {
		const { repo, rows } = makeRepo([
			{
				id: "b1",
				domain_entity_id: DOM_WORK,
				name: "notion.inbox_db",
				target_kind: "integration_config",
				target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
			},
		]);
		const action = createBindingUpdateAction(repo);

		await expect(
			action.run(
				{
					name: "notion.inbox_db",
					scope: "work",
					target_kind: "literal",
					target_ref: { provider: "notion_work" },
				},
				ctx,
			),
		).rejects.toThrow(/target_ref does not match target_kind/);

		const out = await action.run(
			{
				name: "notion.inbox_db",
				scope: "work",
				target_kind: "literal",
				target_ref: { value: "replaced" },
			},
			ctx,
		);
		expect(out.text).toBe("Updated binding 'notion.inbox_db' (scope 'work') -> literal.");
		expect(rows[0]).toMatchObject({ target_kind: "literal", target_ref: { value: "replaced" } });
	});

	it("throws when the target binding does not exist", async () => {
		const { repo } = makeRepo([]);
		const action = createBindingUpdateAction(repo);
		await expect(action.run({ name: "notion.inbox_db", scope: "work" }, ctx)).rejects.toThrow(
			/No binding named 'notion\.inbox_db' \(scope 'work'\) to update\./,
		);
	});
});
