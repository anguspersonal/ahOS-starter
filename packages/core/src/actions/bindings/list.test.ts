import { describe, expect, it } from "vitest";
import { createBindingListAction } from "./list.js";
import type { ActionContext } from "../types.js";
import type { BindingRepository, BindingRow, DomainRow } from "../../ports/bindings.js";

const ctx: ActionContext = { userId: "u1", caller: "mcp", requestId: "req-1" };

const DOM_WORK = "dom-work";
const DOM_PERSONAL = "dom-personal";

const DOMAINS: DomainRow[] = [
	{ id: DOM_WORK, title: "work" },
	{ id: DOM_PERSONAL, title: "personal" },
];

const ROWS: BindingRow[] = [
	{
		id: "b-work",
		domain_entity_id: DOM_WORK,
		name: "notion.inbox_db",
		target_kind: "integration_config",
		target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
	},
	{
		id: "b-personal",
		domain_entity_id: DOM_PERSONAL,
		name: "notion.inbox_db",
		target_kind: "integration_config",
		target_ref: { provider: "notion_personal", json_path: "tasks_database_id" },
	},
	{
		id: "b-drive",
		domain_entity_id: null,
		name: "drive.folder_id",
		target_kind: "literal",
		target_ref: { value: "root" },
	},
];

function makeRepo(rows: BindingRow[] = ROWS, domains: DomainRow[] = DOMAINS): BindingRepository {
	return {
		listDomains: async () => domains,
		listBindings: async (filter) =>
			rows.filter((r) => {
				if (filter?.name && r.name !== filter.name) return false;
				if (filter?.domainId && r.domain_entity_id !== filter.domainId) return false;
				return true;
			}),
		findBinding: async () => null,
		resolveBindingValue: async () => null,
	};
}

describe("createBindingListAction", () => {
	it("lists every binding when no filter is given", async () => {
		const action = createBindingListAction(makeRepo());
		const out = await action.run({}, ctx);
		expect(out.text).toContain("Bindings (3):");
		expect(out.text).toContain("drive.folder_id [(any)]");
		expect(out.text).toContain("notion.inbox_db [work]");
	});

	it("filters by scope/domain", async () => {
		const action = createBindingListAction(makeRepo());
		const out = await action.run({ scope: "work" }, ctx);
		expect(out.text).toContain("Bindings (1):");
		expect(out.text).toContain("notion.inbox_db [work]");
	});

	it("filters by exact binding name", async () => {
		const action = createBindingListAction(makeRepo());
		const out = await action.run({ name: "drive.folder_id" }, ctx);
		expect(out.text).toContain("Bindings (1):");
		expect(out.text).toContain("drive.folder_id");
	});

	it("reports no bindings found when empty", async () => {
		const action = createBindingListAction(makeRepo([]));
		const out = await action.run({}, ctx);
		expect(out.text).toBe("No bindings found.");
	});

	it("fails loud listing available domains on an unknown scope", async () => {
		const action = createBindingListAction(makeRepo());
		await expect(action.run({ domain: "work" }, ctx)).resolves.toBeDefined();
		const emptyDomainsAction = createBindingListAction(makeRepo(ROWS, []));
		await expect(emptyDomainsAction.run({ domain: "work" }, ctx)).rejects.toThrow(
			/Available domains: \(none seeded\)/,
		);
	});
});
