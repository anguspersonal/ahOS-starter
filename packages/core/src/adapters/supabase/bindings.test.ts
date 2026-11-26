import { describe, expect, it, vi } from "vitest";
import { createSupabaseBindingRepository } from "./bindings.js";
import type { BindingRow } from "../../ports/bindings.js";

const U = "user-123";
const DOM_WORK = "dom-work";

type Store = {
	entities?: any[];
	bindings?: any[];
	user_integrations?: any[];
};

function makeClient(store: Store, selected?: string[]) {
	function makeBuilder(table: keyof Store) {
		const filters: Record<string, unknown> = {};
		const rows = () =>
			(store[table] ?? []).filter((row) =>
				Object.entries(filters).every(([k, v]) => row[k] === v),
			);
		const builder: any = {
			select(cols: string) {
				selected?.push(`${table}:${cols}`);
				return builder;
			},
			eq(col: string, val: unknown) {
				filters[col] = val;
				return builder;
			},
			is(col: string, val: unknown) {
				filters[col] = val;
				return builder;
			},
			order() {
				return builder;
			},
			maybeSingle() {
				return Promise.resolve({ data: rows()[0] ?? null, error: null });
			},
			insert(payload: unknown) {
				const toInsert = Array.isArray(payload) ? payload : [payload];
				store[table] = [...(store[table] ?? []), ...toInsert];
				return Promise.resolve({ error: null });
			},
			update(payload: Record<string, unknown>) {
				const mutFilters: Record<string, unknown> = {};
				const mutBuilder: any = {
					eq(col: string, val: unknown) {
						mutFilters[col] = val;
						return mutBuilder;
					},
					then(onFulfilled: (v: any) => unknown, onRejected?: (e: any) => unknown) {
						store[table] = (store[table] ?? []).map((row) =>
							Object.entries(mutFilters).every(([k, v]) => row[k] === v) ? { ...row, ...payload } : row,
						);
						return Promise.resolve({ error: null }).then(onFulfilled, onRejected);
					},
				};
				return mutBuilder;
			},
			delete() {
				const mutFilters: Record<string, unknown> = {};
				const mutBuilder: any = {
					eq(col: string, val: unknown) {
						mutFilters[col] = val;
						return mutBuilder;
					},
					then(onFulfilled: (v: any) => unknown, onRejected?: (e: any) => unknown) {
						store[table] = (store[table] ?? []).filter(
							(row) => !Object.entries(mutFilters).every(([k, v]) => row[k] === v),
						);
						return Promise.resolve({ error: null }).then(onFulfilled, onRejected);
					},
				};
				return mutBuilder;
			},
			then(onFulfilled: (v: any) => unknown, onRejected?: (e: any) => unknown) {
				return Promise.resolve({ data: rows(), error: null }).then(onFulfilled, onRejected);
			},
		};
		return builder;
	}
	return { from: vi.fn((table: keyof Store) => makeBuilder(table)) } as any;
}

describe("createSupabaseBindingRepository", () => {
	it("lists active domain entities for the owner", async () => {
		const client = makeClient({
			entities: [
				{ id: DOM_WORK, user_id: U, entity_type: "domain", title: "work", archived: false },
				{ id: "dom-archived", user_id: U, entity_type: "domain", title: "old", archived: true },
			],
		});
		const repo = createSupabaseBindingRepository({ client, ownerId: () => U });
		const domains = await repo.listDomains();
		expect(domains).toHaveLength(1);
		expect(domains[0].id).toBe(DOM_WORK);
	});

	it("finds scoped binding first and falls back to domain-agnostic binding", async () => {
		const client = makeClient({
			bindings: [
				{
					id: "b-global",
					user_id: U,
					domain_entity_id: null,
					name: "notion.inbox_db",
					target_kind: "literal",
					target_ref: { value: "GLOBAL" },
				},
				{
					id: "b-work",
					user_id: U,
					domain_entity_id: DOM_WORK,
					name: "notion.inbox_db",
					target_kind: "literal",
					target_ref: { value: "SCOPED" },
				},
			],
		});
		const repo = createSupabaseBindingRepository({ client, ownerId: U });
		expect((await repo.findBinding("notion.inbox_db", DOM_WORK))?.id).toBe("b-work");
		expect((await repo.findBinding("notion.inbox_db", "dom-other"))?.id).toBe("b-global");
	});

	it("never selects a secret column when resolving integration_config bindings", async () => {
		const selected: string[] = [];
		const client = makeClient(
			{
				user_integrations: [
					{
						user_id: U,
						provider: "notion_work",
						config: { tasks_database_id: "SAFE-ID" },
						credential_ref: "NOTION_API_KEY",
					},
				],
			},
			selected,
		);
		const repo = createSupabaseBindingRepository({ client, ownerId: U });

		const safe: BindingRow = {
			id: "b1",
			domain_entity_id: DOM_WORK,
			name: "notion.inbox_db",
			target_kind: "integration_config",
			target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
		};
		expect(await repo.resolveBindingValue(safe)).toBe("SAFE-ID");

		const attemptSecret: BindingRow = {
			...safe,
			target_ref: { provider: "notion_work", json_path: "credential_ref" },
		};
		expect(await repo.resolveBindingValue(attemptSecret)).toBeNull();

		expect(selected).toContain("user_integrations:config");
		expect(selected.join("|")).not.toMatch(/credential_ref|status|routing|expires_at/);
	});

	it("resolves entity and literal bindings", async () => {
		const client = makeClient({
			entities: [
				{
					id: "e1",
					user_id: U,
					title: "Project X",
					description: "Desc",
					properties: { code: "PX-9" },
				},
			],
		});
		const repo = createSupabaseBindingRepository({ client, ownerId: U });

		expect(
			await repo.resolveBindingValue({
				id: "b",
				domain_entity_id: null,
				name: "project.name",
				target_kind: "entity",
				target_ref: { entity_id: "e1", property: "title" },
			}),
		).toBe("Project X");
		expect(
			await repo.resolveBindingValue({
				id: "b",
				domain_entity_id: null,
				name: "project.code",
				target_kind: "entity",
				target_ref: { entity_id: "e1", property: "code" },
			}),
		).toBe("PX-9");
		expect(
			await repo.resolveBindingValue({
				id: "b",
				domain_entity_id: null,
				name: "const.tz",
				target_kind: "literal",
				target_ref: { value: "Europe/London" },
			}),
		).toBe("Europe/London");
	});

	it("supports exact lookup, create, update, and delete on bindings", async () => {
		const store: Store = { bindings: [] };
		const client = makeClient(store);
		const repo = createSupabaseBindingRepository({ client, ownerId: U });

		await repo.createBinding!({
			domain_entity_id: DOM_WORK,
			name: "notion.inbox_db",
			target_kind: "literal",
			target_ref: { value: "v1" },
		});
		store.bindings![0].id = "b1";

		expect(await repo.findExactBinding!("notion.inbox_db", null)).toBeNull();
		expect((await repo.findExactBinding!("notion.inbox_db", DOM_WORK))?.id).toBe("b1");

		await repo.updateBinding!("b1", { target_kind: "literal", target_ref: { value: "v2" } });
		expect(store.bindings![0].target_ref).toEqual({ value: "v2" });

		await repo.deleteBinding!("b1");
		expect(store.bindings).toHaveLength(0);
	});
});
