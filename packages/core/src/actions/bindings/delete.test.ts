import { describe, expect, it } from "vitest";
import { createBindingDeleteAction } from "./delete.js";
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
			deleteBinding: async (id) => {
				const idx = rows.findIndex((r) => r.id === id);
				if (idx >= 0) rows.splice(idx, 1);
			},
		},
	};
}

describe("createBindingDeleteAction", () => {
	it("hard-deletes the exact binding and throws when missing", async () => {
		const { repo, rows } = makeRepo([
			{
				id: "b1",
				domain_entity_id: DOM_WORK,
				name: "notion.inbox_db",
				target_kind: "literal",
				target_ref: { value: "scoped" },
			},
			{
				id: "b2",
				domain_entity_id: null,
				name: "notion.inbox_db",
				target_kind: "literal",
				target_ref: { value: "global" },
			},
		]);
		const action = createBindingDeleteAction(repo);

		const out = await action.run({ name: "notion.inbox_db", scope: "work" }, ctx);
		expect(out.text).toBe("Deleted binding 'notion.inbox_db' (scope 'work').");
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe("b2");

		await expect(action.run({ name: "notion.inbox_db", scope: "work" }, ctx)).rejects.toThrow(
			/No binding named 'notion\.inbox_db' \(scope 'work'\) to delete\./,
		);
	});
});
