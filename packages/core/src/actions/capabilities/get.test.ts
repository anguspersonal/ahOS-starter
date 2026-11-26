import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createCapabilityGetAction, getCapabilitiesSchema } from "./get.js";
import { normalizeCapabilityLookup } from "./shared.js";
import type { ActionContext } from "../types.js";
import type { CapabilityEntityRow, CapabilityRepository } from "../../ports/capabilities.js";

const ctx: ActionContext = { userId: "u1", caller: "mcp", requestId: "req-1" };

const BODY = "---\r\nname: dos\r\n---\r\nbody line\r\n";

function makeRow(overrides: Partial<CapabilityEntityRow> = {}): CapabilityEntityRow {
	return {
		id: "cap-dos",
		title: "dos",
		description: null,
		properties: {
			kind: "skill",
			surface: ["claude-code", "cowork", "chat"],
			storage_location: "kms-db",
			storage_url: null,
			body: BODY,
			body_synced_at: "2026-09-04T21:29:35.713Z",
		},
		archived: false,
		created_at: "2026-09-04T21:29:35.000Z",
		updated_at: "2026-09-04T21:29:36.000Z",
		...overrides,
	};
}

function makeRepo(rows: CapabilityEntityRow[]): CapabilityRepository {
	return {
		list: async (opts) => (opts?.includeArchived ? rows : rows.filter((r) => !r.archived)),
		findByName: async () => null,
		insert: async () => ({ id: "id-1" }),
		update: async () => {},
	};
}

describe("createCapabilityGetAction (#1593)", () => {
	it("returns freshness header with injected bodyHash and wrapped body on named lookup", async () => {
		const action = createCapabilityGetAction({
			repo: makeRepo([makeRow()]),
			bodyHash: (b) => `sha:${b.replace(/\r\n/g, "\n").length}`,
		});
		const out = await action.run({ name: "dos" }, ctx);
		expect(out.text).toContain("dos (skill)");
		expect(out.text).toContain("body_sha256: sha:28");
		expect(out.text).toContain("body line");
		expect(action.formatMcp!(out)).toBe(out.text);
	});

	it("defaults include_body to true in getCapabilitiesSchema and generated JSON Schema (#1995)", () => {
		expect(getCapabilitiesSchema.parse({ name: "dos" }).include_body).toBe(true);
		const jsonSchema = z.toJSONSchema(getCapabilitiesSchema, {
			target: "openapi-3.0",
			io: "input",
		}) as { properties?: Record<string, { default?: unknown }> };
		expect(jsonSchema.properties?.include_body?.default).toBe(true);
	});

	it("omits body from text and strips properties.body from rows when include_body: false while preserving body_sha256 (#1995)", async () => {
		const row = makeRow();
		const action = createCapabilityGetAction({
			repo: makeRepo([row]),
			bodyHash: () => "deadbeef",
		});
		const out = await action.run({ name: "dos", include_body: false }, ctx);
		expect(out.text).toContain("  body_sha256: deadbeef");
		expect(out.text).not.toContain("body line");
		expect(out.rows).toHaveLength(1);
		expect(out.rows[0].properties).not.toHaveProperty("body");
		expect(row.properties).toHaveProperty("body", BODY);
	});

	it("renders header and body for each matched row when multiple scoped rows match a named lookup (#1995)", async () => {
		const personalRow = makeRow({
			id: "cap-dos-personal",
			properties: {
				kind: ["skill"],
				surface: ["claude-code"],
				scope: "personal",
				storage_location: "kms-db",
				storage_url: null,
				body: "personal dos body",
				body_synced_at: "2026-09-04T21:29:35.713Z",
			},
		});
		const workRow = makeRow({
			id: "cap-dos-work",
			properties: {
				kind: ["skill"],
				surface: ["claude-code"],
				scope: "work",
				storage_location: "kms-db",
				storage_url: null,
				body: "work dos body",
				body_synced_at: "2026-09-04T21:29:35.713Z",
			},
		});
		const action = createCapabilityGetAction({
			repo: makeRepo([personalRow, workRow]),
			bodyHash: (b) => `hash:${b}`,
		});
		const out = await action.run({ name: "dos" }, ctx);
		expect(out.rows).toHaveLength(2);
		expect(out.text).not.toContain("Capabilities (2):");
		expect(out.text).toContain("  scope: personal");
		expect(out.text).toContain("  body_sha256: hash:personal dos body");
		expect(out.text).toContain("personal dos body");
		expect(out.text).toContain("  scope: work");
		expect(out.text).toContain("  body_sha256: hash:work dos body");
		expect(out.text).toContain("work dos body");
	});

	it("strips properties.body on unnamed list calls unless include_body: true is explicitly passed (#1995)", async () => {
		const action = createCapabilityGetAction({
			repo: makeRepo([makeRow({ title: "retro" })]),
			bodyHash: () => "h",
		});
		const defaultList = await action.run({}, ctx);
		expect(defaultList.rows[0].properties).not.toHaveProperty("body");

		const falseList = await action.run({ include_body: false }, ctx);
		expect(falseList.rows[0].properties).not.toHaveProperty("body");

		const trueList = await action.run({ include_body: true }, ctx);
		expect(trueList.rows[0].properties).toHaveProperty("body", BODY);
	});

	it("wraps non-kms-db body with snapshot notice while computing body_sha256 on raw body", async () => {
		const action = createCapabilityGetAction({
			repo: makeRepo([
				makeRow({
					properties: {
						kind: ["skill"],
						surface: ["claude-code"],
						storage_location: "kms-repo",
						storage_url: "skills/dos/SKILL.md",
						body: BODY,
						body_synced_at: "2026-09-04T21:29:35.713Z",
					},
				}),
			]),
			bodyHash: (b) => (b === BODY ? "raw-hash" : "wrapped-hash"),
		});
		const out = await action.run({ name: "dos" }, ctx);
		expect(out.text).toContain("  body_sha256: raw-hash");
		expect(out.text).toContain("> ⚠ SNAPSHOT. Canonical home: `kms-repo` at `skills/dos/SKILL.md`.");
	});

	it("lists capabilities and offers fuzzy suggestions on name miss", async () => {
		const action = createCapabilityGetAction({
			repo: makeRepo([makeRow({ title: "retro" })]),
			bodyHash: () => "h",
		});
		const listOut = await action.run({}, ctx);
		expect(listOut.text).toBe("Capabilities (1):\n• retro [skill] surface=claude-code+cowork+chat home=kms-db");

		const missOut = await action.run({ name: "rero" }, ctx);
		expect(missOut.text).toBe("No capabilities found matching 'rero'. Did you mean: 'retro'?");
	});

	it("surfaces repo_mirror in named header and list output when present", async () => {
		const action = createCapabilityGetAction({
			repo: makeRepo([
				makeRow({
					properties: {
						kind: ["skill"],
						surface: ["claude-code"],
						storage_location: "kms-db",
						storage_url: null,
						repo_mirror: ".claude/skills/dos/SKILL.md",
						body: BODY,
						body_synced_at: "2026-09-04T21:29:35.713Z",
					},
				}),
			]),
			bodyHash: () => "h",
		});
		const named = await action.run({ name: "dos", include_body: false }, ctx);
		expect(named.text).toContain("  repo_mirror: .claude/skills/dos/SKILL.md");

		const listed = await action.run({}, ctx);
		expect(listed.text).toContain("home=kms-db(repo-mirror)");
	});

	it("resolves unblock and ahos/unblock alias lookups to groom-issues", async () => {
		expect(normalizeCapabilityLookup("unblock")).toEqual({
			stripped: "unblock",
			candidates: ["groom-issues", "unblock"],
		});
		expect(normalizeCapabilityLookup("ahOS/unblock")).toEqual({
			stripped: "unblock",
			candidates: ["groom-issues", "unblock"],
		});
		expect(normalizeCapabilityLookup("groom-issues")).toEqual({
			stripped: "groom-issues",
			candidates: ["groom-issues", "unblock"],
		});

		const action = createCapabilityGetAction({
			repo: makeRepo([
				makeRow({
					id: "cap-groom-issues",
					title: "groom-issues",
					properties: {
						kind: ["skill"],
						surface: ["claude-code", "cowork", "chat"],
						storage_location: "kms-repo",
						storage_url: ".claude/skills/groom-issues/SKILL.md",
						body: "---\nname: groom-issues\n---\nunblock mode\n",
						body_synced_at: "2026-11-04T14:45:00.000Z",
					},
				}),
			]),
			bodyHash: () => "sha-groom",
		});

		const viaAlias = await action.run({ name: "unblock" }, ctx);
		expect(viaAlias.rows).toHaveLength(1);
		expect(viaAlias.rows[0].title).toBe("groom-issues");
		expect(viaAlias.text).toContain("groom-issues (skill)");

		const viaPrefixedAlias = await action.run({ name: "ahOS/unblock" }, ctx);
		expect(viaPrefixedAlias.rows).toHaveLength(1);
		expect(viaPrefixedAlias.rows[0].title).toBe("groom-issues");
	});
});
