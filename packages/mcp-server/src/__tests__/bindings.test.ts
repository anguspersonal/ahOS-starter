import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import { env } from "../env.js";
import {
	resolveNames,
	resolveBindingValue,
	type BindingRow,
} from "../tools/bindings.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { executeAction, extractRefs } from "@ahkms/core/actions";

async function runBindingAction(id: string, args: Record<string, unknown>) {
	const action = serverRegistry().get(id)!;
	const out = await executeAction(action, args);
	return { content: [{ type: "text" as const, text: action.formatMcp!(out) }] };
}

const listBindingsHandler = (args: Record<string, unknown>) => runBindingAction("binding_list", args);
const createBindingHandler = (args: Record<string, unknown>) => runBindingAction("binding_create", args);
const updateBindingHandler = (args: Record<string, unknown>) => runBindingAction("binding_update", args);
const deleteBindingHandler = (args: Record<string, unknown>) => runBindingAction("binding_delete", args);
const resolveCapabilityHandler = (args: Record<string, unknown>) => runBindingAction("capability_resolve", args);

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
});

const U = env.userId; // stubbed test user id
const DOM_WORK = "dom-work";
const DOM_PERSONAL = "dom-personal";

type Store = {
	entities?: any[];
	bindings?: any[];
	user_integrations?: any[];
};

/**
 * A supabase stub backed by the canned `store`: a chainable builder that records
 * .eq/.is filters, then filters the relevant table array by exact match on those
 * columns. Awaiting the builder yields {data: matchingRows}; maybeSingle() yields
 * {data: first}. Also supports the write surface the CRUD handlers exercise
 * (insert/update/delete), mutating `store` in place so later reads in the same
 * test observe the effect — same store-based mental model as the read stub, just
 * extended rather than replaced.
 */
function installStub(store: Store) {
	function makeBuilder(table: keyof Store) {
		const filters: Record<string, unknown> = {};
		const rows = () => (store[table] ?? []).filter((row) => Object.entries(filters).every(([k, v]) => row[k] === v));
		const builder: any = {
			select() {
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
			// update()/delete() return their own mutation-builder so callers can chain
			// further .eq() filters (mirrors the real supabase-js query builder), and
			// resolve when awaited (thenable), applying the mutation to `store` then.
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
	(supabase as any).from = vi.fn((table: keyof Store) => makeBuilder(table));
}

const DOMAIN_ROWS = [
	{ id: DOM_WORK, user_id: U, entity_type: "domain", title: "work", archived: false },
	{ id: DOM_PERSONAL, user_id: U, entity_type: "domain", title: "personal", archived: false },
];

function binding(domainId: string | null, ref: Record<string, unknown>, kind = "integration_config"): any {
	return { id: `b-${domainId ?? "global"}`, user_id: U, domain_entity_id: domainId, name: "notion.inbox_db", target_kind: kind, target_ref: ref };
}

describe("extractRefs", () => {
	it("returns each distinct {{name}} once, trimmed, in first-seen order", () => {
		const body = "A {{notion.inbox_db}} B {{ drive.folder_id }} C {{notion.inbox_db}}";
		expect(extractRefs(body)).toEqual(["notion.inbox_db", "drive.folder_id"]);
	});

	it("ignores non-dotted or malformed braces", () => {
		expect(extractRefs("{{plainword}} {{ }} {single}")).toEqual([]);
	});
});

describe("scoped resolution — same body, different scope", () => {
	const capability = {
		id: "cap-1",
		user_id: U,
		entity_type: "capability",
		archived: false,
		title: "capture",
		properties: { body: "Route captures to {{notion.inbox_db}}." },
	};

	function storeForScopes(): Store {
		return {
			entities: [...DOMAIN_ROWS, capability],
			bindings: [
				binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" }),
				binding(DOM_PERSONAL, { provider: "notion_personal", json_path: "tasks_database_id" }),
			],
			user_integrations: [
				{ user_id: U, provider: "notion_work", config: { tasks_database_id: "WORK-DB-ID" } },
				{ user_id: U, provider: "notion_personal", config: { tasks_database_id: "PERSONAL-DB-ID" } },
			],
		};
	}

	it("resolves {{notion.inbox_db}} to the Work id under scope=work", async () => {
		installStub(storeForScopes());
		const out = await resolveCapabilityHandler({ name: "capture", scope: "work" });
		expect(out.content[0].text).toBe("Route captures to WORK-DB-ID.");
	});

	it("resolves the SAME body to the personal id under scope=personal", async () => {
		installStub(storeForScopes());
		const out = await resolveCapabilityHandler({ name: "capture", scope: "personal" });
		expect(out.content[0].text).toBe("Route captures to PERSONAL-DB-ID.");
	});

	it("falls back to a domain-agnostic binding when no scoped one exists", async () => {
		const store = storeForScopes();
		store.bindings = [binding(null, { provider: "notion_work", json_path: "tasks_database_id" })];
		installStub(store);
		const out = await resolveCapabilityHandler({ name: "capture", scope: "personal" });
		expect(out.content[0].text).toBe("Route captures to WORK-DB-ID.");
	});

	it("fails loud on an unknown domain, naming the vocabulary", async () => {
		// #1062 put a vocabulary check in front of the lookup, so a typo is rejected
		// before any database round-trip and the message names the valid values rather
		// than whatever happens to be seeded.
		//
		// Asserted through `scope` rather than `domain`, and that is the point: `scope`
		// is a free string, so the runtime check is its ONLY guard. `domain` is a zod
		// enum, so 'acme' cannot reach the handler at all — from an MCP client the
		// schema rejects it, and in TypeScript it will not compile. Writing that case
		// here would be a test of the type system with a cast to defeat the type system.
		installStub(storeForScopes());
		await expect(resolveCapabilityHandler({ name: "capture", scope: "acme" })).rejects.toThrow(
			/Unknown domain 'acme'.*work.*angus/s,
		);
	});

	it("still fails loud when the domain is valid but no such domain row is seeded", async () => {
		// The other layer, which the check above now shadows for typos: the value is
		// spelled correctly and the `domain` entity simply is not there. Losing this
		// error would turn a missing seed into "resolved nothing", silently.
		const store = storeForScopes();
		store.entities = [];
		installStub(store);
		await expect(resolveCapabilityHandler({ name: "capture", domain: "work" })).rejects.toThrow(
			/Available domains/,
		);
	});
});

describe("secret invariant — a binding never resolves to a token", () => {
	it("integration_config reads user_integrations.config only; credential_ref is unreachable", async () => {
		// The row carries BOTH a non-secret id in config AND a secret in credential_ref.
		installStub({
			user_integrations: [
				{
					user_id: U,
					provider: "notion_work",
					config: { tasks_database_id: "SAFE-ID" },
					credential_ref: "NOTION_API_KEY",
				},
			],
		});

		// A binding pointing at the safe config key resolves to the id.
		const safe: BindingRow = {
			id: "b1",
			domain_entity_id: DOM_WORK,
			name: "notion.inbox_db",
			target_kind: "integration_config",
			target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
		};
		expect(await resolveBindingValue(safe)).toBe("SAFE-ID");

		// Even a binding that TRIES to name the secret column can only read inside
		// `config` (there is no credential_ref key there) -> unresolved, never the token.
		const attemptSecret: BindingRow = {
			...safe,
			target_ref: { provider: "notion_work", json_path: "credential_ref" },
		};
		expect(await resolveBindingValue(attemptSecret)).toBeNull();
	});

	it("only SELECTs the config column from user_integrations (never credential_ref/status/etc.)", async () => {
		const selected: string[] = [];
		(supabase as any).from = vi.fn((table: string) => {
			const filters: Record<string, unknown> = {};
			const builder: any = {
				select(cols: string) {
					selected.push(`${table}:${cols}`);
					return builder;
				},
				eq() {
					return builder;
				},
				maybeSingle() {
					return Promise.resolve({ data: { config: { tasks_database_id: "SAFE-ID" } }, error: null });
				},
			};
			return builder;
		});

		await resolveBindingValue({
			id: "b1",
			domain_entity_id: null,
			name: "notion.inbox_db",
			target_kind: "integration_config",
			target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
		});

		expect(selected).toContain("user_integrations:config");
		// Structural guarantee: the secret-bearing columns are never named in the query.
		expect(selected.join("|")).not.toMatch(/credential_ref|status|routing|expires_at/);
	});
});

describe("fail-loud manifest — no silent-empty substitution", () => {
	const capability = {
		id: "cap-2",
		user_id: U,
		entity_type: "capability",
		archived: false,
		title: "capture",
		properties: { body: "Inbox {{notion.inbox_db}}, folder {{drive.folder_id}}." },
	};

	it("reports EVERY unresolved name in one pass as a missing_bindings error", async () => {
		installStub({
			entities: [...DOMAIN_ROWS, capability],
			bindings: [], // nothing bound
			user_integrations: [],
		});

		let thrown: Error | undefined;
		try {
			await resolveCapabilityHandler({ name: "capture", scope: "work" });
		} catch (e) {
			thrown = e as Error;
		}
		expect(thrown).toBeDefined();
		const manifest = JSON.parse(thrown!.message);
		expect(manifest.error).toBe("missing_bindings");
		expect(manifest.capability).toBe("capture");
		expect(manifest.scope).toBe("work");
		expect(manifest.missing.sort()).toEqual(["drive.folder_id", "notion.inbox_db"]);
	});

	it("treats a dangling pointer (binding exists, value absent) as missing — never substitutes empty", async () => {
		const store: Store = {
			entities: [...DOMAIN_ROWS, capability],
			bindings: [
				binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" }),
				// drive binding exists but points at a config key that isn't present
				{
					id: "b-drive",
					user_id: U,
					domain_entity_id: DOM_WORK,
					name: "drive.folder_id",
					target_kind: "integration_config",
					target_ref: { provider: "google_drive", json_path: "default_folder_id" },
				},
			],
			user_integrations: [
				{ user_id: U, provider: "notion_work", config: { tasks_database_id: "WORK-DB-ID" } },
				{ user_id: U, provider: "google_drive", config: {} }, // no default_folder_id
			],
		};
		installStub(store);

		const { resolved, missing } = await resolveNames(["notion.inbox_db", "drive.folder_id"], DOM_WORK);
		expect(resolved).toEqual({ "notion.inbox_db": "WORK-DB-ID" });
		expect(missing).toEqual(["drive.folder_id"]);
	});
});

describe("entity + literal target kinds", () => {
	it("resolves an entity binding to a real column (title), then falls back to a properties key", async () => {
		installStub({
			entities: [
				{ id: "e1", user_id: U, entity_type: "project", title: "Project X", description: null, properties: { code: "PX-9" } },
			],
		});
		expect(
			await resolveBindingValue({
				id: "b",
				domain_entity_id: null,
				name: "project.name",
				target_kind: "entity",
				target_ref: { entity_id: "e1", property: "title" },
			}),
		).toBe("Project X");
		expect(
			await resolveBindingValue({
				id: "b",
				domain_entity_id: null,
				name: "project.code",
				target_kind: "entity",
				target_ref: { entity_id: "e1", property: "code" },
			}),
		).toBe("PX-9");
	});

	it("resolves a literal binding to its value", async () => {
		installStub({});
		expect(
			await resolveBindingValue({
				id: "b",
				domain_entity_id: null,
				name: "const.timezone",
				target_kind: "literal",
				target_ref: { value: "Europe/London" },
			}),
		).toBe("Europe/London");
	});
});

// --- CRUD handlers (create/list/update/binding_delete) ----------------------
// These are the write path into the table the resolver above trusts
// unconditionally, so cover the pre-insert uniqueness check, the target_ref
// shape validation per target_kind, scope->domain resolution, and the hard
// delete (QA round 1, #62 finding "Medium 1").

describe("createBindingHandler", () => {
	it("creates a domain-agnostic binding (scope omitted) with the given target_ref", async () => {
		const store: Store = { entities: [...DOMAIN_ROWS], bindings: [] };
		installStub(store);

		const out = await createBindingHandler({
			name: "const.timezone",
			target_kind: "literal",
			target_ref: { value: "Europe/London" },
		} as any);

		expect(out.content[0].text).toContain("Created binding 'const.timezone'");
		expect(out.content[0].text).toContain("domain-agnostic");
		expect(store.bindings).toHaveLength(1);
		expect(store.bindings![0]).toMatchObject({
			user_id: U,
			domain_entity_id: null,
			name: "const.timezone",
			target_kind: "literal",
			target_ref: { value: "Europe/London" },
		});
	});

	it("resolves scope to a domain_entity_id before inserting a scoped binding", async () => {
		const store: Store = { entities: [...DOMAIN_ROWS], bindings: [] };
		installStub(store);

		const out = await createBindingHandler({
			name: "notion.inbox_db",
			scope: "work",
			target_kind: "integration_config",
			target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
		} as any);

		expect(out.content[0].text).toContain("scope 'work'");
		expect(store.bindings).toHaveLength(1);
		expect(store.bindings![0].domain_entity_id).toBe(DOM_WORK);
	});

	it("rejects a target_ref that doesn't match target_kind's shape, without inserting", async () => {
		const store: Store = { entities: [...DOMAIN_ROWS], bindings: [] };
		installStub(store);

		await expect(
			createBindingHandler({
				name: "notion.inbox_db",
				target_kind: "integration_config",
				target_ref: { value: "not-the-right-shape" }, // missing provider/json_path
			} as any),
		).rejects.toThrow(/target_ref does not match target_kind/);
		expect(store.bindings).toHaveLength(0);
	});

	it("refuses to create a duplicate (name, scope) binding — points to binding_update instead", async () => {
		const store: Store = {
			entities: [...DOMAIN_ROWS],
			bindings: [binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" })],
		};
		installStub(store);

		await expect(
			createBindingHandler({
				name: "notion.inbox_db",
				scope: "work",
				target_kind: "literal",
				target_ref: { value: "should not insert" },
			} as any),
		).rejects.toThrow(/already exists.*binding_update/s);
		expect(store.bindings).toHaveLength(1); // unchanged
	});

	it("does not treat a domain-agnostic binding as a duplicate of a scoped one with the same name", async () => {
		const store: Store = {
			entities: [...DOMAIN_ROWS],
			bindings: [binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" })],
		};
		installStub(store);

		const out = await createBindingHandler({
			name: "notion.inbox_db",
			target_kind: "literal",
			target_ref: { value: "fallback" },
		} as any);

		expect(out.content[0].text).toContain("Created binding");
		expect(store.bindings).toHaveLength(2);
	});
});

describe("listBindingsHandler", () => {
	function storeWithBindings(): Store {
		return {
			entities: [...DOMAIN_ROWS],
			bindings: [
				binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" }),
				{ ...binding(DOM_PERSONAL, { provider: "notion_personal", json_path: "tasks_database_id" }), name: "notion.inbox_db" },
				{
					id: "b-drive",
					user_id: U,
					domain_entity_id: null,
					name: "drive.folder_id",
					target_kind: "literal",
					target_ref: { value: "root" },
				},
			],
		};
	}

	it("lists every binding for the user when no filter is given", async () => {
		installStub(storeWithBindings());
		const out = await listBindingsHandler({} as any);
		expect(out.content[0].text).toContain("Bindings (3):");
		expect(out.content[0].text).toContain("drive.folder_id");
	});

	it("filters to one scope via the scope argument", async () => {
		installStub(storeWithBindings());
		const out = await listBindingsHandler({ scope: "work" } as any);
		expect(out.content[0].text).toContain("Bindings (1):");
		expect(out.content[0].text).toContain("notion.inbox_db [work]");
	});

	it("filters to one binding name via the name argument", async () => {
		installStub(storeWithBindings());
		const out = await listBindingsHandler({ name: "drive.folder_id" } as any);
		expect(out.content[0].text).toContain("Bindings (1):");
		expect(out.content[0].text).toContain("drive.folder_id");
	});

	it("reports no bindings found when the table (for this user) is empty", async () => {
		installStub({ entities: [...DOMAIN_ROWS], bindings: [] });
		const out = await listBindingsHandler({} as any);
		expect(out.content[0].text).toBe("No bindings found.");
	});
});

describe("updateBindingHandler", () => {
	it("updates target_kind and target_ref on the exact (name, scope) binding", async () => {
		const store: Store = {
			entities: [...DOMAIN_ROWS],
			bindings: [binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" })],
		};
		installStub(store);

		const out = await updateBindingHandler({
			name: "notion.inbox_db",
			scope: "work",
			target_kind: "literal",
			target_ref: { value: "replaced" },
		} as any);

		expect(out.content[0].text).toContain("Updated binding 'notion.inbox_db'");
		expect(store.bindings![0]).toMatchObject({ target_kind: "literal", target_ref: { value: "replaced" } });
	});

	it("preserves the existing target_kind/target_ref when only scope is given (no-op patch)", async () => {
		const store: Store = {
			entities: [...DOMAIN_ROWS],
			bindings: [binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" })],
		};
		installStub(store);

		await updateBindingHandler({ name: "notion.inbox_db", scope: "work" } as any);

		expect(store.bindings![0]).toMatchObject({
			target_kind: "integration_config",
			target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
		});
	});

	it("validates a new target_ref against the (possibly new) target_kind before updating", async () => {
		const store: Store = {
			entities: [...DOMAIN_ROWS],
			bindings: [binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" })],
		};
		installStub(store);

		await expect(
			updateBindingHandler({
				name: "notion.inbox_db",
				scope: "work",
				target_kind: "literal",
				target_ref: { provider: "notion_work", json_path: "tasks_database_id" }, // wrong shape for literal
			} as any),
		).rejects.toThrow(/target_ref does not match target_kind/);
		// unchanged — still the original integration_config binding
		expect(store.bindings![0].target_kind).toBe("integration_config");
	});

	it("throws when no binding exists at the exact (name, scope) to update", async () => {
		installStub({ entities: [...DOMAIN_ROWS], bindings: [] });

		await expect(
			updateBindingHandler({
				name: "notion.inbox_db",
				scope: "work",
				target_kind: "literal",
				target_ref: { value: "x" },
			} as any),
		).rejects.toThrow(/No binding named 'notion.inbox_db'.*scope 'work'/s);
	});
});

describe("deleteBindingHandler", () => {
	it("hard-deletes the exact (name, scope) binding", async () => {
		const store: Store = {
			entities: [...DOMAIN_ROWS],
			bindings: [binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" })],
		};
		installStub(store);

		const out = await deleteBindingHandler({ name: "notion.inbox_db", scope: "work" } as any);

		expect(out.content[0].text).toContain("Deleted binding 'notion.inbox_db'");
		expect(store.bindings).toHaveLength(0);
	});

	it("only deletes the scoped binding, leaving a domain-agnostic binding of the same name intact", async () => {
		const store: Store = {
			entities: [...DOMAIN_ROWS],
			bindings: [
				binding(DOM_WORK, { provider: "notion_work", json_path: "tasks_database_id" }),
				{ ...binding(null, { value: "fallback" }, "literal") },
			],
		};
		installStub(store);

		await deleteBindingHandler({ name: "notion.inbox_db", scope: "work" } as any);

		expect(store.bindings).toHaveLength(1);
		expect(store.bindings![0].domain_entity_id).toBeNull();
	});

	it("throws when no binding exists at the exact (name, scope) to delete", async () => {
		installStub({ entities: [...DOMAIN_ROWS], bindings: [] });

		await expect(deleteBindingHandler({ name: "notion.inbox_db" } as any)).rejects.toThrow(
			/No binding named 'notion.inbox_db'.*domain-agnostic/s,
		);
	});
});
