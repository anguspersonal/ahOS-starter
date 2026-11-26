import { describe, expect, it } from "vitest";
import { createBindingCreateAction } from "./create.js";
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
			createBinding: async (input) => {
				rows.push({ id: `b-${rows.length + 1}`, ...input });
			},
		},
	};
}

describe("createBindingCreateAction", () => {
	it("creates a domain-agnostic or scoped binding", async () => {
		const { repo, rows } = makeRepo();
		const action = createBindingCreateAction(repo);

		const globalOut = await action.run(
			{ name: "const.timezone", target_kind: "literal", target_ref: { value: "Europe/London" } },
			ctx,
		);
		expect(globalOut.text).toBe("Created binding 'const.timezone' (domain-agnostic) -> literal.");
		expect(rows[0]).toMatchObject({ domain_entity_id: null, name: "const.timezone" });

		const scopedOut = await action.run(
			{
				name: "notion.inbox_db",
				scope: "work",
				target_kind: "integration_config",
				target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
			},
			ctx,
		);
		expect(scopedOut.text).toContain("scope 'work'");
		expect(rows[1].domain_entity_id).toBe(DOM_WORK);
	});

	it("rejects mismatched target_ref shape and duplicate (name, scope)", async () => {
		const { repo, rows } = makeRepo([
			{
				id: "b1",
				domain_entity_id: DOM_WORK,
				name: "notion.inbox_db",
				target_kind: "literal",
				target_ref: { value: "v" },
			},
		]);
		const action = createBindingCreateAction(repo);

		await expect(
			action.run(
				{ name: "notion.inbox_db", target_kind: "integration_config", target_ref: { value: "bad" } },
				ctx,
			),
		).rejects.toThrow(/target_ref does not match target_kind/);

		await expect(
			action.run(
				{ name: "notion.inbox_db", scope: "work", target_kind: "literal", target_ref: { value: "v2" } },
				ctx,
			),
		).rejects.toThrow(/already exists.*binding_update/s);
		expect(rows).toHaveLength(1);
	});
});
