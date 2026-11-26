import { describe, expect, it } from "vitest";
import { createCapabilityResolveAction, extractRefs } from "./resolve.js";
import type { ActionContext } from "../types.js";
import type { BindingRepository, BindingRow, DomainRow } from "../../ports/bindings.js";
import type { CapabilityEntityRow, CapabilityRepository } from "../../ports/capabilities.js";

const ctx: ActionContext = { userId: "u1", caller: "mcp", requestId: "req-1" };

const DOM_WORK = "dom-work";
const DOM_PERSONAL = "dom-personal";

const DOMAINS: DomainRow[] = [
	{ id: DOM_WORK, title: "work" },
	{ id: DOM_PERSONAL, title: "personal" },
];

function makeCapabilityRow(overrides: Partial<CapabilityEntityRow> = {}): CapabilityEntityRow {
	return {
		id: "cap-capture",
		title: "capture",
		description: null,
		properties: {
			kind: ["skill"],
			surface: ["claude-code"],
			storage_location: "kms-db",
			storage_url: null,
			body: "Route captures to {{notion.inbox_db}} and {{ drive.folder_id }}.",
		},
		archived: false,
		created_at: "2026-09-04T21:29:35.000Z",
		updated_at: "2026-09-04T21:29:36.000Z",
		...overrides,
	};
}

function makeCapabilityRepo(rows: CapabilityEntityRow[]): CapabilityRepository {
	return {
		list: async (opts) => (opts?.includeArchived ? rows : rows.filter((r) => !r.archived)),
		findByName: async (name) =>
			rows.find((r) => (r.title ?? "").toLowerCase() === name.toLowerCase()) ?? null,
		insert: async () => ({ id: "new-id" }),
		update: async () => {},
	};
}

function makeBindingRepo(
	bindings: BindingRow[],
	valuesById: Record<string, string | null>,
	domains: DomainRow[] = DOMAINS,
): BindingRepository {
	return {
		listDomains: async () => domains,
		listBindings: async () => bindings,
		findBinding: async (name, domainId) =>
			bindings.find((b) => b.name === name && b.domain_entity_id === domainId) ??
			bindings.find((b) => b.name === name && b.domain_entity_id === null) ??
			null,
		resolveBindingValue: async (row) => (row.id in valuesById ? valuesById[row.id] : null),
	};
}

describe("extractRefs (#1596)", () => {
	it("returns each distinct {{name}} once, trimmed, in first-seen order", () => {
		const body = "A {{notion.inbox_db}} B {{ drive.folder_id }} C {{notion.inbox_db}}";
		expect(extractRefs(body)).toEqual(["notion.inbox_db", "drive.folder_id"]);
	});

	it("ignores non-dotted or malformed braces", () => {
		expect(extractRefs("{{plainword}} {{ }} {single}")).toEqual([]);
	});
});

describe("createCapabilityResolveAction (#1596)", () => {
	it("resolves {{name}} bindings per scope and falls back to domain-agnostic bindings", async () => {
		const capRepo = makeCapabilityRepo([makeCapabilityRow()]);
		const bindingRepo = makeBindingRepo(
			[
				{
					id: "b-hl-notion",
					domain_entity_id: DOM_WORK,
					name: "notion.inbox_db",
					target_kind: "integration_config",
					target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
				},
				{
					id: "b-p-notion",
					domain_entity_id: DOM_PERSONAL,
					name: "notion.inbox_db",
					target_kind: "integration_config",
					target_ref: { provider: "notion_personal", json_path: "tasks_database_id" },
				},
				{
					id: "b-global-drive",
					domain_entity_id: null,
					name: "drive.folder_id",
					target_kind: "literal",
					target_ref: { value: "FOLDER-GLOBAL" },
				},
			],
			{
				"b-hl-notion": "WORK-DB",
				"b-p-notion": "PERSONAL-DB",
				"b-global-drive": "FOLDER-GLOBAL",
			},
		);

		const action = createCapabilityResolveAction({
			capabilities: capRepo,
			bindings: bindingRepo,
		});

		const hlOut = await action.run({ name: "capture", domain: "work" }, ctx);
		expect(hlOut.text).toBe("Route captures to WORK-DB and FOLDER-GLOBAL.");
		expect(action.formatMcp!(hlOut)).toBe(hlOut.text);

		const personalOut = await action.run({ name: "capture", scope: "personal" }, ctx);
		expect(personalOut.text).toBe("Route captures to PERSONAL-DB and FOLDER-GLOBAL.");
	});

	it("wraps external capabilities with snapshot notice and skips binding lookup when no refs exist", async () => {
		const capRepo = makeCapabilityRepo([
			makeCapabilityRow({
				id: "cap-dos",
				title: "dos",
				properties: {
					storage_location: "kms-repo",
					storage_url: ".claude/skills/dos/SKILL.md",
					body: "# DOS\nRun ritual.",
				},
			}),
		]);
		const bindingRepo = makeBindingRepo([], {});
		const action = createCapabilityResolveAction({
			capabilities: { repo: capRepo },
			bindings: bindingRepo,
		});

		const out = await action.run({ name: "ahOS/sync", domain: "angus" }, ctx);
		expect(out.text).toContain("⚠ SNAPSHOT. Canonical home: `kms-repo` at `.claude/skills/dos/SKILL.md`.");
		expect(out.text).toContain("# DOS\nRun ritual.");
	});

	it("fails loud with missing_bindings manifest when any ref is unbound or dangling", async () => {
		const capRepo = makeCapabilityRepo([makeCapabilityRow()]);
		const bindingRepo = makeBindingRepo(
			[
				{
					id: "b-hl-notion",
					domain_entity_id: DOM_WORK,
					name: "notion.inbox_db",
					target_kind: "integration_config",
					target_ref: { provider: "notion_work", json_path: "tasks_database_id" },
				},
			],
			{
				"b-hl-notion": "WORK-DB",
			},
		);
		const action = createCapabilityResolveAction({
			capabilities: capRepo,
			bindings: bindingRepo,
		});

		let thrown: Error | undefined;
		try {
			await action.run({ name: "capture", domain: "work" }, ctx);
		} catch (err) {
			thrown = err as Error;
		}
		expect(thrown).toBeDefined();
		expect(JSON.parse(thrown!.message)).toEqual({
			error: "missing_bindings",
			capability: "capture",
			scope: "work",
			missing: ["drive.folder_id"],
		});
	});

	it("fails loud on missing domain, unknown capability, or empty capability body", async () => {
		const capRepo = makeCapabilityRepo([
			makeCapabilityRow({
				id: "cap-empty",
				title: "external-only",
				properties: {
					storage_location: "claude",
					storage_url: "https://example.com",
					body: "   ",
				},
			}),
		]);
		const bindingRepo = makeBindingRepo([], {});
		const action = createCapabilityResolveAction({
			capabilities: capRepo,
			bindings: bindingRepo,
		});

		await expect(action.run({ name: "capture" }, ctx)).rejects.toThrow(/`domain` is required/);
		await expect(action.run({ name: "nonexistent", domain: "work" }, ctx)).rejects.toThrow(
			/capability_not_found: no capability named 'nonexistent'/,
		);
		await expect(action.run({ name: "external-only", domain: "work" }, ctx)).rejects.toThrow(
			/capability_has_no_body: 'external-only'/,
		);
	});
});
