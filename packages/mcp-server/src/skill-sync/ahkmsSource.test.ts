import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";

// Mock env + supabase so this needs no credentials and no network. The mocked
// lookup returns an existing capability registered as an AGENT of the same name.
vi.mock("../env.js", () => ({ env: { userId: "test-user" } }));
vi.mock("../supabase.js", () => ({
	supabase: {
		from: () => ({
			select: () => ({
				eq: () => ({
					eq: () =>
						Promise.resolve({
							data: [{ id: "1", title: "grill-me", properties: { kind: "agent" } }],
							error: null,
						}),
				}),
			}),
		}),
	},
}));

const { upsertSkillCapability, SkillKindConflictError, fetchSkillCapabilities, fetchAllCapabilities } =
	await import("./ahkmsSource.js");

describe("upsertSkillCapability cross-kind guard", () => {
	it("refuses to overwrite a same-named agent (the push footgun)", async () => {
		await expect(
			upsertSkillCapability({ name: "grill-me", description: null, body: "x", surface: ["claude-code"] }),
		).rejects.toBeInstanceOf(SkillKindConflictError);
	});
});

// Regression coverage for the round-1 QA finding (ahkmsSource.ts:140-146): a
// same-named row with a missing/malformed `kind` (e.g. legacy data predating this
// field) must be treated conservatively as a conflict, not silently overwritten.
describe("upsertSkillCapability cross-kind guard — missing kind", () => {
	const origFrom = supabase.from;
	afterEach(() => {
		(supabase as any).from = origFrom;
	});

	it("refuses to overwrite a same-named row whose kind is missing", async () => {
		(supabase as any).from = () => ({
			select: () => ({
				eq: () => ({
					eq: () =>
						Promise.resolve({
							data: [{ id: "1", title: "legacy-row", properties: {} }],
							error: null,
						}),
				}),
			}),
		});

		await expect(
			upsertSkillCapability({ name: "legacy-row", description: null, body: "x", surface: ["claude-code"] }),
		).rejects.toBeInstanceOf(SkillKindConflictError);
	});
});

// Migration 114 (#344) stores `kind` as an array and splits client names out of
// `surface`. A push must update such a row (it was refusing every one as
// "already registered as unknown"), keep a twin's other kinds, and keep the
// registry-owned `scope` / `clients` fields a full replace would erase.
describe("upsertSkillCapability on a migration-114 row", () => {
	const origFrom = supabase.from;
	afterEach(() => {
		(supabase as any).from = origFrom;
	});

	function stubExisting(properties: Record<string, unknown>) {
		const updates: Array<Record<string, unknown>> = [];
		(supabase as any).from = () => ({
			select: () => ({
				eq: () => ({
					eq: () => Promise.resolve({ data: [{ id: "1", title: "dos", properties }], error: null }),
				}),
			}),
			update: (row: Record<string, unknown>) => {
				updates.push(row);
				return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) };
			},
		});
		return updates;
	}

	it("updates an array-kind skill, writing migration 114's surface/clients split", async () => {
		const updates = stubExisting({ kind: ["skill"], surface: ["claude-code", "claude-synced"], clients: ["chat", "cowork"], scope: "personal" });

		const out = await upsertSkillCapability({ name: "dos", description: null, body: "b", surface: ["claude-code", "cowork", "chat"] });

		expect(out).toBe("updated");
		const props = updates[0].properties as Record<string, unknown>;
		expect(props.kind).toEqual(["skill"]);
		expect(props.surface).toEqual(["claude-code", "claude-synced"]);
		expect(props.clients).toEqual(["chat", "cowork"]);
		expect(props.scope).toBe("personal");
		expect(props.body).toBe("b");
	});

	it("keeps a skill+agent twin's kinds when pushing its body", async () => {
		const updates = stubExisting({ kind: ["agent", "skill"], surface: ["claude-code"] });

		await upsertSkillCapability({ name: "dos", description: null, body: "b", surface: ["claude-code"] });

		expect((updates[0].properties as Record<string, unknown>).kind).toEqual(["agent", "skill"]);
	});

	it("writes repo_mirror when passed and preserves prior repo_mirror on subsequent updates", async () => {
		const updates = stubExisting({
			kind: ["skill"],
			surface: ["claude-code"],
			repo_mirror: ".claude/skills/dos/SKILL.md",
		});

		await upsertSkillCapability({ name: "dos", description: null, body: "b", surface: ["claude-code"] });
		expect((updates[0].properties as Record<string, unknown>).repo_mirror).toBe(".claude/skills/dos/SKILL.md");

		await upsertSkillCapability({
			name: "dos",
			description: null,
			body: "b2",
			surface: ["claude-code"],
			repoMirror: ".claude/skills/dos-v2/SKILL.md",
		});
		expect((updates[1].properties as Record<string, unknown>).repo_mirror).toBe(".claude/skills/dos-v2/SKILL.md");
	});

	it("still refuses an array-kind row with no skill in it", async () => {
		stubExisting({ kind: ["agent"], surface: ["claude-code"] });

		await expect(
			upsertSkillCapability({ name: "dos", description: null, body: "b", surface: ["claude-code"] }),
		).rejects.toThrow(/already registered as 'agent'/);
	});
});

// Regression coverage for the round-1 QA finding (ahkmsSource.ts:48): rows must
// be filtered by surface, not just kind/archived, so a capability registered
// only for a non-claude-code surface (e.g. 'cowork') is never compared against
// the local ~/.claude/skills tree. Stub shape mirrors the pattern already used
// in __tests__/bindings.test.ts — a chainable, thenable builder backed by a
// canned row array. The hoisted supabase mock above is swapped per-test here and
// restored in afterEach.
const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
});

function installStub(rows: any[]) {
	const builder: any = {
		select() {
			return builder;
		},
		eq() {
			return builder;
		},
		then(onFulfilled: (v: any) => unknown, onRejected?: (e: any) => unknown) {
			return Promise.resolve({ data: rows, error: null }).then(onFulfilled, onRejected);
		},
	};
	(supabase as any).from = vi.fn(() => builder);
}

function row(overrides: Partial<{ title: string; kind: string; surface: string[]; archived: boolean; body: string | null }>) {
	return {
		title: overrides.title ?? "some-skill",
		archived: overrides.archived ?? false,
		properties: {
			kind: overrides.kind ?? "skill",
			surface: overrides.surface ?? ["claude-code"],
			storage_location: "kms-db",
			body: overrides.body ?? "body text",
		},
	};
}

describe("fetchSkillCapabilities", () => {
	it("includes a skill registered for the claude-code surface", async () => {
		installStub([row({ title: "qa-review", surface: ["claude-code"] })]);
		const caps = await fetchSkillCapabilities();
		expect(caps.has("qa-review")).toBe(true);
	});

	it("excludes a skill registered only for a non-claude-code surface", async () => {
		installStub([row({ title: "cowork-only-skill", surface: ["cowork"] })]);
		const caps = await fetchSkillCapabilities();
		expect(caps.has("cowork-only-skill")).toBe(false);
	});

	it("includes a skill registered for multiple surfaces including claude-code", async () => {
		installStub([row({ title: "multi-surface-skill", surface: ["cowork", "claude-code"] })]);
		const caps = await fetchSkillCapabilities();
		expect(caps.has("multi-surface-skill")).toBe(true);
	});

	it("still excludes non-skill kinds and archived rows regardless of surface", async () => {
		installStub([
			row({ title: "an-agent", kind: "agent", surface: ["claude-code"] }),
			row({ title: "archived-skill", archived: true, surface: ["claude-code"] }),
		]);
		const caps = await fetchSkillCapabilities();
		expect(caps.size).toBe(0);
	});
});

describe("fetchAllCapabilities row coercion", () => {
	it("returns an empty map when the query yields no rows (null data)", async () => {
		(supabase as any).from = () => ({
			select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: null }) }) }),
		});
		const caps = await fetchAllCapabilities();
		expect(caps.size).toBe(0);
	});

	it("throws a labelled error when the supabase query errors", async () => {
		(supabase as any).from = () => ({
			select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }),
		});
		await expect(fetchAllCapabilities()).rejects.toThrow(/skill-sync: capability fetch failed: boom/);
	});

	it("reads an array kind as its kinds and a joined label", async () => {
		installStub([{ title: "twin", archived: false, properties: { kind: ["skill", "agent"], surface: ["claude-code"] } }]);
		const cap = (await fetchAllCapabilities()).get("twin");
		expect(cap?.kinds).toEqual(["skill", "agent"]);
		expect(cap?.kind).toBe("skill+agent");
		expect((await fetchSkillCapabilities()).has("twin")).toBe(true);
	});

	it("keeps mixed kinds (agent/command/skill) — fetchAll does not kind-filter", async () => {
		installStub([
			row({ title: "a-skill", kind: "skill" }),
			row({ title: "an-agent", kind: "agent" }),
			row({ title: "a-command", kind: "command" }),
		]);
		const caps = await fetchAllCapabilities();
		expect(caps.size).toBe(3);
		expect(caps.get("an-agent")?.kind).toBe("agent");
		expect(caps.get("a-command")?.kind).toBe("command");
	});

	it("coerces null properties to placeholder fields rather than throwing", async () => {
		installStub([{ title: "bare", archived: false, properties: null }]);
		// A null-properties row has no surface array, so it is filtered out (nothing to
		// compare against) — the point is the coercion path does not throw.
		const caps = await fetchAllCapabilities();
		expect(caps.size).toBe(0);
	});

	it("coerces non-string kind/storage_location/body to their placeholders/null", async () => {
		installStub([
			{
				title: "malformed",
				archived: false,
				properties: { kind: 42, storage_location: { nested: true }, body: ["not", "a", "string"], surface: ["claude-code"] },
			},
		]);
		const caps = await fetchAllCapabilities();
		const cap = caps.get("malformed");
		expect(cap).toBeDefined();
		expect(cap?.kind).toBe("?");
		expect(cap?.storageLocation).toBe("?");
		expect(cap?.body).toBeNull();
		expect(cap?.bodySyncedAt).toBeNull();
	});

	it("maps a missing body to null while keeping the rest of the row", async () => {
		installStub([
			{
				title: "no-body",
				archived: false,
				properties: { kind: "skill", storage_location: "index-only", surface: ["claude-code"] },
			},
		]);
		const cap = (await fetchAllCapabilities()).get("no-body");
		expect(cap?.body).toBeNull();
		expect(cap?.storageLocation).toBe("index-only");
	});

	it("skips a row with no title (empty name is not indexable)", async () => {
		installStub([{ title: null, archived: false, properties: { kind: "skill", surface: ["claude-code"] } }]);
		expect((await fetchAllCapabilities()).size).toBe(0);
	});

	it("excludes a row whose surface is not an array", async () => {
		installStub([
			{ title: "weird-surface", archived: false, properties: { kind: "skill", surface: "claude-code" } },
		]);
		expect((await fetchAllCapabilities()).size).toBe(0);
	});
});
