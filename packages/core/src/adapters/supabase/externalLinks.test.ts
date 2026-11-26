import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	computeStreak,
	COVERAGE_MAX_EFFECTIVE_LAG_DAYS,
	coverageDateForArtifact,
	createSupabaseExternalLinkRepository,
	interruptedClaimMessage,
	isSynthesizableMaterial,
	isUncoveredDay,
	PENDING_EXTERNAL_ID,
} from "./externalLinks.js";
import type { Domain } from "../../domain/domains.js";

const DOMAIN_PROVIDER: Record<Domain, string> = {
	work: "notion_work",
	angus: "notion_personal",
};

class ExternalItemCreatedButUnreadable extends Error {
	constructor(what: string, cause: unknown) {
		super(`${what} was created, or may have been created, in the provider, but the response body could not be read`, { cause });
		this.name = "ExternalItemCreatedButUnreadable";
	}
}

const TEST_USER = "00000000-0000-0000-0000-000000000000";
let currentOwnerId = TEST_USER;
const supabase: { from: ReturnType<typeof vi.fn> } = {
	from: vi.fn(),
};

const {
	recordExternalLink,
	getArtifactContentSubtype,
	getExternalLinks,
	getSynthesizedArtifactIds,
	inspectDedupSlot,
	claimDedupSlot,
	finalizeExternalLink,
	releaseClaimForFailedWrite,
} = createSupabaseExternalLinkRepository({
	client: supabase as any,
	ownerId: () => currentOwnerId,
	domainProvider: DOMAIN_PROVIDER,
});

afterEach(() => {
	currentOwnerId = TEST_USER;
	supabase.from = vi.fn();
	vi.restoreAllMocks();
});

/** A thenable query builder whose chained methods all return itself. */
function builder(result: unknown) {
	const b: any = {
		select: () => b,
		eq: () => b,
		in: () => b,
		then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
	};
	return b;
}

/**
 * `builder`, plus a spy on every `.eq()` — the assertion surface for "which predicates
 * did this read actually apply". The absence of an `.eq("provider", …)` is as load-bearing
 * as its presence (#677), and only a spy can show an absence.
 */
function spyingBuilder(result: unknown) {
	const eq = vi.fn();
	const b: any = {
		select: () => b,
		eq: (...args: unknown[]) => {
			eq(...args);
			return b;
		},
		in: () => b,
		then: (res: any, rej: any) => Promise.resolve(result).then(res, rej),
	};
	return { from: vi.fn(() => b), eq };
}

describe("recordExternalLink", () => {
	it("upserts the link with the dedup onConflict key and reports ok", async () => {
		const upsert = vi.fn().mockResolvedValue({ error: null });
		(supabase as any).from = vi.fn(() => ({ upsert }));

		const res = await recordExternalLink("art-1", {
			provider: "notion",
			kind: "task",
			external_id: "page-1",
			external_url: "https://notion.so/page-1",
		});

		expect(res).toEqual({ ok: true });
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({
				user_id: TEST_USER,
				artifact_id: "art-1",
				provider: "notion",
				kind: "task",
				external_id: "page-1",
				external_url: "https://notion.so/page-1",
				dedup_key: null,
			}),
			{ onConflict: "artifact_id,provider,kind,external_id" },
		);
	});

	it("passes dedup_key through to the upserted row when given", async () => {
		const upsert = vi.fn().mockResolvedValue({ error: null });
		(supabase as any).from = vi.fn(() => ({ upsert }));

		await recordExternalLink("art-1", {
			provider: "notion_work",
			kind: "task",
			external_id: "page-2",
			dedup_key: "fill-marriage-form",
		});

		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({ dedup_key: "fill-marriage-form" }),
			{ onConflict: "artifact_id,provider,kind,external_id" },
		);
	});

	it("surfaces the error message when the upsert fails", async () => {
		(supabase as any).from = vi.fn(() => ({
			upsert: vi.fn().mockResolvedValue({ error: { message: "boom" } }),
		}));
		expect(
			await recordExternalLink("art-1", {
				provider: "notion",
				kind: "task",
				external_id: "p",
			}),
		).toEqual({ ok: false, error: "boom" });
	});
});

describe("getSynthesizedArtifactIds", () => {
	it("returns the set of consumed artifact ids", async () => {
		(supabase as any).from = vi.fn(() =>
			builder({ data: [{ artifact_id: "a1" }, { artifact_id: "a2" }], error: null }),
		);
		const set = await getSynthesizedArtifactIds();
		expect([...set].sort()).toEqual(["a1", "a2"]);
	});

	it("degrades to an empty set on error", async () => {
		(supabase as any).from = vi.fn(() =>
			builder({ data: null, error: { message: "x" } }),
		);
		expect((await getSynthesizedArtifactIds()).size).toBe(0);
	});

	// #677: the ledger is keyed on (artifact, provider, kind, external_id); reading it on
	// `kind` alone throws the provider away and makes consumption a global fact.
	it("applies NO provider predicate when no domain is given (the pre-#677 read, unchanged)", async () => {
		const { from, eq } = spyingBuilder({ data: [{ artifact_id: "a1" }], error: null });
		(supabase as any).from = from;

		expect([...(await getSynthesizedArtifactIds())]).toEqual(["a1"]);
		expect(eq).toHaveBeenCalledWith("user_id", TEST_USER);
		expect(eq).not.toHaveBeenCalledWith("provider", expect.anything());
	});

	it("scopes to the domain's provider, resolved through DOMAIN_PROVIDER, when a domain is given", async () => {
		const { from, eq } = spyingBuilder({ data: [], error: null });
		(supabase as any).from = from;

		await getSynthesizedArtifactIds("angus");

		expect(eq).toHaveBeenCalledWith("provider", DOMAIN_PROVIDER.angus);
	});

	it("resolves the OTHER domain to a different provider — the two never collapse", async () => {
		const { from, eq } = spyingBuilder({ data: [], error: null });
		(supabase as any).from = from;

		await getSynthesizedArtifactIds("work");

		expect(eq).toHaveBeenCalledWith("provider", DOMAIN_PROVIDER.work);
		expect(DOMAIN_PROVIDER.work).not.toBe(DOMAIN_PROVIDER.angus);
	});
});

describe("getExternalLinks", () => {
	it("returns [] on error rather than throwing", async () => {
		(supabase as any).from = vi.fn(() =>
			builder({ data: null, error: { message: "x" } }),
		);
		expect(await getExternalLinks("art-1")).toEqual([]);
	});
});

describe("getArtifactContentSubtype", () => {
	it("reads content_subtype scoped by id and ownerId", async () => {
		const eq = vi.fn();
		const b: any = {
			select: () => b,
			eq: (...args: unknown[]) => {
				eq(...args);
				return b;
			},
			maybeSingle: async () => ({
				data: { content_subtype: "daily_log" },
				error: null,
			}),
		};
		(supabase as any).from = vi.fn(() => b);

		const res = await getArtifactContentSubtype("art-1");
		expect(res).toEqual({ data: { content_subtype: "daily_log" } });
		expect(eq).toHaveBeenCalledWith("id", "art-1");
		expect(eq).toHaveBeenCalledWith("user_id", TEST_USER);
	});

	it("returns { data: null, error } when the query fails", async () => {
		const b: any = {
			select: () => b,
			eq: () => b,
			maybeSingle: async () => ({
				data: null,
				error: { message: "timeout" },
			}),
		};
		(supabase as any).from = vi.fn(() => b);

		expect(await getArtifactContentSubtype("art-1")).toEqual({
			data: null,
			error: "timeout",
		});
	});
});

describe("inspectDedupSlot", () => {
	/** Rows as PostgREST hands them back from `.select("external_id")`. */
	const rows = (...externalIds: string[]) => ({
		data: externalIds.map((external_id) => ({ external_id })),
		error: null,
	});

	it("reports 'linked' when a real link of the given kind exists (no dedupKey — the 1:1 case)", async () => {
		const eq = vi.fn();
		const b: any = {
			select: () => b,
			eq: (...args: unknown[]) => {
				eq(...args);
				return b;
			},
			then: (res: any) => Promise.resolve(rows("page_1")).then(res),
		};
		(supabase as any).from = vi.fn(() => b);

		expect(await inspectDedupSlot("art-1", "notion_work", "task")).toBe("linked");
		// Scoped by user, artifact, provider, and kind — but NOT by dedup_key when none
		// is given.
		expect(eq).toHaveBeenCalledWith("user_id", TEST_USER);
		expect(eq).toHaveBeenCalledWith("artifact_id", "art-1");
		expect(eq).toHaveBeenCalledWith("provider", "notion_work");
		expect(eq).toHaveBeenCalledWith("kind", "task");
		expect(eq).not.toHaveBeenCalledWith("dedup_key", expect.anything());
	});

	it("reports 'free' when no link of the given kind exists", async () => {
		(supabase as any).from = vi.fn(() => builder(rows()));
		expect(await inspectDedupSlot("art-1", "notion_work", "task")).toBe("free");
	});

	// Issue #653: the row a failed create leaves behind carries no external item. Calling
	// it a duplicate is what turned one failed create into a permanent block.
	it("reports 'pending' — NOT 'linked' — when only an unfinished claim occupies the slot", async () => {
		(supabase as any).from = vi.fn(() => builder(rows(PENDING_EXTERNAL_ID)));
		expect(await inspectDedupSlot("art-1", "notion_work", "task")).toBe("pending");
	});

	it("a real link wins over a leftover claim: the task genuinely exists", async () => {
		(supabase as any).from = vi.fn(() =>
			builder(rows(PENDING_EXTERNAL_ID, "page_1")),
		);
		expect(await inspectDedupSlot("art-1", "notion_work", "task")).toBe("linked");
	});

	it("scopes by provider so the same artifact can hold tasks in two workspaces", async () => {
		const eq = vi.fn();
		const b: any = {
			select: () => b,
			eq: (...args: unknown[]) => {
				eq(...args);
				return b;
			},
			then: (res: any) => Promise.resolve(rows()).then(res),
		};
		(supabase as any).from = vi.fn(() => b);

		expect(await inspectDedupSlot("art-1", "notion_personal", "task")).toBe("free");
		expect(eq).toHaveBeenCalledWith("provider", "notion_personal");
	});

	it("scopes by dedup_key when given (the 1:N case) — a different key is not a match", async () => {
		const eq = vi.fn();
		const b: any = {
			select: () => b,
			eq: (...args: unknown[]) => {
				eq(...args);
				return b;
			},
			then: (res: any) => Promise.resolve(rows()).then(res),
		};
		(supabase as any).from = vi.fn(() => b);

		expect(await inspectDedupSlot("art-1", "notion_work", "task", "other-task-slug")).toBe(
			"free",
		);
		expect(eq).toHaveBeenCalledWith("dedup_key", "other-task-slug");
	});

	it("reports 'linked' only when the exact dedup_key already has a link", async () => {
		(supabase as any).from = vi.fn(() => builder(rows("page_1")));
		expect(
			await inspectDedupSlot("art-1", "notion_work", "task", "fill-marriage-form"),
		).toBe("linked");
	});

	it("degrades to 'free' on any read error (best-effort, never blocks creation)", async () => {
		(supabase as any).from = vi.fn(() =>
			builder({ data: null, error: { message: "relation does not exist" } }),
		);
		expect(await inspectDedupSlot("art-1", "notion_work", "task")).toBe("free");
	});
});

// Round-1 review finding #1: hasExistingLink alone is a check-then-act race — two
// concurrent callers can both see count=0 before either writes. claimDedupSlot closes
// that gap with a raw INSERT (not an upsert) against migration 064's partial unique
// index `(artifact_id, provider, kind, dedup_key) WHERE dedup_key IS NOT NULL`: Postgres
// enforces that index on a plain INSERT with no ON CONFLICT clause needed, so the loser
// of a race gets a real 23505 back instead of silently overwriting or being ignored.
describe("claimDedupSlot", () => {
	it("claims the slot with the given dedup_key and a pending placeholder external_id", async () => {
		const insert = vi.fn(() => ({
			select: () => ({
				single: () => Promise.resolve({ data: { id: "link-1" }, error: null }),
			}),
		}));
		(supabase as any).from = vi.fn(() => ({ insert }));

		const result = await claimDedupSlot(
			"art-1",
			"notion_work",
			"task",
			"fill-marriage-form",
		);

		expect(result).toEqual({ claimed: true, linkId: "link-1" });
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				user_id: TEST_USER,
				artifact_id: "art-1",
				provider: "notion_work",
				kind: "task",
				dedup_key: "fill-marriage-form",
				external_id: "__pending__",
			}),
		);
	});

	it("claims under the given provider so a notion_personal slot is distinct from work's", async () => {
		const insert = vi.fn(() => ({
			select: () => ({
				single: () => Promise.resolve({ data: { id: "link-p" }, error: null }),
			}),
		}));
		(supabase as any).from = vi.fn(() => ({ insert }));

		await claimDedupSlot("art-1", "notion_personal", "task", "fill-marriage-form");

		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({ provider: "notion_personal" }),
		);
	});

	it("falls back to a fixed sentinel dedup_key when no dedup_key is given (the single_task case)", async () => {
		const insert = vi.fn(() => ({
			select: () => ({
				single: () => Promise.resolve({ data: { id: "link-2" }, error: null }),
			}),
		}));
		(supabase as any).from = vi.fn(() => ({ insert }));

		await claimDedupSlot("art-1", "notion_work", "task", null);

		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({ dedup_key: "__single_task__" }),
		);
	});

	it("reports a 'conflict' when the insert fails with a 23505 unique-violation (lost the race)", async () => {
		const insert = vi.fn(() => ({
			select: () => ({
				single: () =>
					Promise.resolve({
						data: null,
						error: { code: "23505", message: "duplicate key value violates unique constraint" },
					}),
			}),
		}));
		(supabase as any).from = vi.fn(() => ({ insert }));

		const result = await claimDedupSlot(
			"art-1",
			"notion_work",
			"task",
			"fill-marriage-form",
		);

		expect(result).toEqual({ claimed: false, reason: "conflict" });
	});

	it("reports 'error' (not 'conflict') for a non-23505 failure, e.g. migration 064 not applied", async () => {
		const insert = vi.fn(() => ({
			select: () => ({
				single: () =>
					Promise.resolve({
						data: null,
						error: { code: "42P01", message: "relation does not exist" },
					}),
			}),
		}));
		(supabase as any).from = vi.fn(() => ({ insert }));

		const result = await claimDedupSlot(
			"art-1",
			"notion_work",
			"task",
			"fill-marriage-form",
		);

		expect(result).toEqual({
			claimed: false,
			reason: "error",
			error: "relation does not exist",
		});
	});
});

describe("finalizeExternalLink", () => {
	it("updates the claimed row (matched by id) with the real external_id/url", async () => {
		const eq = vi.fn().mockResolvedValue({ error: null });
		const update = vi.fn(() => ({ eq }));
		(supabase as any).from = vi.fn(() => ({ update }));

		const result = await finalizeExternalLink("link-1", "page-123", "https://notion.so/page-123");

		expect(result).toEqual({ ok: true });
		expect(update).toHaveBeenCalledWith({
			external_id: "page-123",
			external_url: "https://notion.so/page-123",
		});
		expect(eq).toHaveBeenCalledWith("id", "link-1");
	});

	it("surfaces the error message when the update fails", async () => {
		const eq = vi.fn().mockResolvedValue({ error: { message: "boom" } });
		(supabase as any).from = vi.fn(() => ({ update: () => ({ eq }) }));

		const result = await finalizeExternalLink("link-1", "page-123", null);

		expect(result).toEqual({ ok: false, error: "boom" });
	});
});

// Issue #653: the other terminal state a claim can reach. Without it, a create that
// threw between claiming and writing left a row that read as a duplicate forever.
describe("releaseClaimForFailedWrite", () => {
	/** A delete chain that records its `.eq()` predicates and resolves to `result`. */
	function deleteBuilder(result: { error: { message: string } | null }) {
		const eqs: Array<[string, unknown]> = [];
		const d: any = {
			eq: (col: string, value: unknown) => {
				eqs.push([col, value]);
				return d;
			},
			then: (res: any) => Promise.resolve(result).then(res),
		};
		return { d, eqs };
	}

	it("deletes the claimed row, scoped to its id AND its still-pending state", async () => {
		const { d, eqs } = deleteBuilder({ error: null });
		(supabase as any).from = vi.fn(() => ({ delete: () => d }));
		const original = new Error("Notion create page failed (400)");

		const thrown = await releaseClaimForFailedWrite("link-1", original);

		// Both predicates matter: `id` keeps the release off sibling claims, and the
		// pending check makes it structurally unable to delete a finalized link.
		expect(eqs).toEqual([
			["id", "link-1"],
			["external_id", PENDING_EXTERNAL_ID],
		]);
		// Nothing to add — the caller rethrows exactly what it caught.
		expect(thrown).toBe(original);
	});

	it("wraps the original error when the release itself fails, keeping both facts", async () => {
		const { d } = deleteBuilder({ error: { message: "permission denied" } });
		(supabase as any).from = vi.fn(() => ({ delete: () => d }));
		const original = new Error("Notion create page failed (400)");

		const thrown = (await releaseClaimForFailedWrite("link-1", original)) as Error;

		expect(thrown).not.toBe(original);
		expect(thrown.message).toContain("Notion create page failed (400)");
		expect(thrown.message).toContain("could not be released");
		expect(thrown.message).toContain("permission denied");
		// The stuck row is named, because clearing it is the operator's next move.
		expect(thrown.message).toContain("link-1");
		expect(thrown.cause).toBe(original);
	});

	it("is a no-op without a claim (no guard active, or the claim itself failed)", async () => {
		const from = vi.fn();
		(supabase as any).from = from;
		const original = new Error("boom");

		expect(await releaseClaimForFailedWrite(null, original)).toBe(original);
		expect(from).not.toHaveBeenCalled();
	});

	// The one throw on the write path that does NOT mean "nothing was created". Releasing
	// on it frees the slot for an item that really exists, so the retry creates a second —
	// a silent double-create, strictly worse than the stuck slot #653 set out to fix.
	it("refuses to release when the provider already created the item", async () => {
		const from = vi.fn();
		(supabase as any).from = from;
		const original = new ExternalItemCreatedButUnreadable(
			"A Notion page",
			new Error("terminated"),
		);

		const thrown = (await releaseClaimForFailedWrite("link-1", original)) as Error;

		// No DELETE was even attempted — the claim is the only thing standing between the
		// created item and a duplicate.
		expect(from).not.toHaveBeenCalled();
		expect(thrown.message).toContain("could not be read");
		expect(thrown.message).toContain("deliberately NOT released");
		expect(thrown.message).toContain("link-1");
		expect(thrown.message).toContain("system of record");
		expect(thrown.cause).toBe(original);
	});

	it("still releases on an ordinary failure of the same outward call", async () => {
		// The guard above must key on the created-but-unreadable error specifically, not on
		// "the outward client threw" — otherwise it would swallow the whole #653 fix.
		const { d, eqs } = deleteBuilder({ error: null });
		(supabase as any).from = vi.fn(() => ({ delete: () => d }));
		const original = new Error("Notion create page failed (500)");

		expect(await releaseClaimForFailedWrite("link-1", original)).toBe(original);
		expect(eqs).toEqual([
			["id", "link-1"],
			["external_id", PENDING_EXTERNAL_ID],
		]);
	});
});

describe("interruptedClaimMessage", () => {
	it("says it is not a duplicate, cites the system-of-record rule, and hands over the remedy", () => {
		const text = interruptedClaimMessage({
			artifactId: "3143ac75-e696-4d2d-8680-1f0abb484116",
			provider: "notion_work",
			kind: "task",
		});

		// The #653 complaint was that a stuck claim read exactly like a legitimate dedup.
		expect(text).toMatch(/^Blocked:/);
		expect(text).toContain("NOT a duplicate skip");
		expect(text).not.toContain("already linked");
		// ADR-040's erratum: the ledger is not the guard, the Tasks DB is.
		expect(text).toContain("ADR-040 erratum");
		expect(text).toContain("system of record");
		expect(text).toContain(
			"DELETE FROM public.artifact_external_links WHERE artifact_id = " +
				"'3143ac75-e696-4d2d-8680-1f0abb484116' AND provider = 'notion_work' " +
				"AND kind = 'task' AND external_id = '__pending__';",
		);
	});

	it("names the dedup_key when the blocked slot has one (the 1:N case)", () => {
		const text = interruptedClaimMessage({
			artifactId: "art-1",
			provider: "notion_work",
			kind: "task",
			dedupKey: "return-form-to-shelly",
		});

		expect(text).toContain("dedup_key='return-form-to-shelly'");
	});

	// The remedy has to clear exactly the rows the inspection matched. Handing over a
	// broader statement than the refusal describes would have the operator clear sibling
	// claims for the same artifact — including ones an in-flight create still owns.
	it("scopes the remedy to the dedup_key it is refusing on", () => {
		const text = interruptedClaimMessage({
			artifactId: "art-1",
			provider: "notion_work",
			kind: "task",
			dedupKey: "return-form-to-shelly",
		});

		expect(text).toContain(
			"AND external_id = '__pending__' AND dedup_key = 'return-form-to-shelly';",
		);
		// A narrow refusal must not carry the whole-artifact warning.
		expect(text).not.toContain("EVERY unfinished claim");
	});

	it("escapes a quote in the dedup_key so the statement stays pasteable", () => {
		const text = interruptedClaimMessage({
			artifactId: "art-1",
			provider: "notion_work",
			kind: "task",
			dedupKey: "angus's form",
		});

		expect(text).toContain("AND dedup_key = 'angus''s form';");
	});

	it("says so when the remedy is artifact-wide (the single_task case)", () => {
		// Without a dedup_key the inspection matched every claim for this artifact+kind, so
		// the DELETE must too — and the breadth has to be stated, not discovered.
		const text = interruptedClaimMessage({
			artifactId: "art-1",
			provider: "notion_work",
			kind: "task",
		});

		expect(text).toContain("AND external_id = '__pending__';");
		expect(text).not.toContain("dedup_key =");
		expect(text).toContain("EVERY unfinished claim");
	});
});

describe("createSupabaseExternalLinkRepository adapter boundaries (#1604)", () => {
	it("reads ownerId only from the injected ownerId() callback on each operation", async () => {
		const upsert = vi.fn().mockResolvedValue({ error: null });
		(supabase as any).from = vi.fn(() => ({ upsert }));

		currentOwnerId = "11111111-1111-1111-1111-111111111111";
		await recordExternalLink("art-1", {
			provider: "notion",
			kind: "task",
			external_id: "page-1",
		});
		expect(upsert).toHaveBeenCalledWith(
			expect.objectContaining({ user_id: "11111111-1111-1111-1111-111111111111" }),
			expect.anything(),
		);

		const { from, eq } = spyingBuilder({ data: [], error: null });
		(supabase as any).from = from;
		currentOwnerId = "22222222-2222-2222-2222-222222222222";
		await getSynthesizedArtifactIds();
		expect(eq).toHaveBeenCalledWith("user_id", "22222222-2222-2222-2222-222222222222");
	});

	it("imports no node: built-in in the adapter or port modules", () => {
		const adapterSource = fs.readFileSync(
			path.resolve(import.meta.dirname, "./externalLinks.ts"),
			"utf8",
		);
		const portSource = fs.readFileSync(
			path.resolve(import.meta.dirname, "../../ports/externalLinks.ts"),
			"utf8",
		);
		const vocabSource = fs.readFileSync(
			path.resolve(import.meta.dirname, "../../domain/vocab.ts"),
			"utf8",
		);
		expect(adapterSource).not.toMatch(/['"]node:/);
		expect(portSource).not.toMatch(/['"]node:/);
		expect(vocabSource).not.toMatch(/['"]node:/);
	});

	it("uses the injected domainProvider mapping when scoping domain queries", async () => {
		const { from, eq } = spyingBuilder({ data: [], error: null });
		const customRepo = createSupabaseExternalLinkRepository({
			client: { from } as any,
			ownerId: () => TEST_USER,
			domainProvider: {
				work: "custom_work_provider",
				angus: "custom_angus_provider",
			},
		});

		await customRepo.getSynthesizedArtifactIds("work");
		expect(eq).toHaveBeenCalledWith("provider", "custom_work_provider");
	});
});

describe("isUncoveredDay and computeStreak with evidence-closing kinds (#2226)", () => {
	const day = (
		date: string,
		overrides: Partial<{
			synthesized: number;
			synthesized_unattended: number;
			evidence_aggregated: number;
			evidence_aggregated_unattended: number;
			captured_atoms: number;
			no_material: boolean;
		}> = {},
	) => ({
		date,
		synthesized: overrides.synthesized ?? 0,
		synthesized_unattended: overrides.synthesized_unattended ?? 0,
		synthesized_external_ids: [],
		synthesized_unattended_external_ids: [],
		evidence_aggregated: overrides.evidence_aggregated ?? 0,
		evidence_aggregated_unattended: overrides.evidence_aggregated_unattended ?? 0,
		evidence_aggregated_external_ids: [],
		evidence_aggregated_unattended_external_ids: [],
		captured_atoms: overrides.captured_atoms ?? (overrides.no_material ? 0 : 1),
		no_material: overrides.no_material ?? false,
	});

	it("isUncoveredDay returns true only when !no_material and all four closing marker counts are 0", () => {
		expect(isUncoveredDay(day("2026-08-01"))).toBe(true);
		expect(isUncoveredDay(day("2026-08-01", { no_material: true }))).toBe(false);
		expect(isUncoveredDay(day("2026-08-01", { synthesized: 1 }))).toBe(false);
		expect(isUncoveredDay(day("2026-08-01", { synthesized_unattended: 1 }))).toBe(false);
		expect(isUncoveredDay(day("2026-08-01", { evidence_aggregated: 1 }))).toBe(false);
		expect(isUncoveredDay(day("2026-08-01", { evidence_aggregated_unattended: 1 }))).toBe(false);
	});

	it("extends streak on evidence_aggregated even when synthesized is 0", () => {
		const days = [
			day("2026-08-01", { evidence_aggregated: 1 }),
			day("2026-08-02", { evidence_aggregated: 1 }),
		];
		expect(computeStreak(days, { asOfToday: "2026-08-03" })).toEqual({
			current: 2,
			best: 2,
			formatted: "day 2 · best 2",
		});
	});

	it("pauses streak on evidence_aggregated_unattended without resetting", () => {
		const days = [
			day("2026-08-01", { evidence_aggregated: 1 }),
			day("2026-08-02", { evidence_aggregated_unattended: 1 }),
			day("2026-08-03", { evidence_aggregated: 1 }),
		];
		expect(computeStreak(days, { asOfToday: "2026-08-04" })).toEqual({
			current: 2,
			best: 2,
			formatted: "day 2 · best 2",
		});
	});

	it("lets attended kind of either family win when both families appear on the same day", () => {
		const days = [
			day("2026-08-01", { synthesized_unattended: 1, evidence_aggregated: 1 }),
			day("2026-08-02", { synthesized: 1, evidence_aggregated_unattended: 1 }),
		];
		expect(computeStreak(days, { asOfToday: "2026-08-03" })).toEqual({
			current: 2,
			best: 2,
			formatted: "day 2 · best 2",
		});
	});

	it("resets current to 0 on an uncovered day (isUncoveredDay === true)", () => {
		const days = [
			day("2026-08-01", { evidence_aggregated: 1 }),
			day("2026-08-02", { evidence_aggregated: 1 }),
			day("2026-08-03"), // uncovered
		];
		expect(computeStreak(days, { asOfToday: "2026-08-04" })).toEqual({
			current: 0,
			best: 2,
			formatted: "day 0 · best 2",
		});
	});
});




describe("coverage parity oracle (ADR-119, migration 158, #2264)", () => {
	// These two functions are the oracle `public.get_dos_coverage_days` is checked against
	// (packages/mcp-server/src/dosCoverageParity.ts). A change here is a change to the SQL.
	const captured = "2026-11-10T09:00:00+00:00";
	const effectiveLagging = (days: number) =>
		new Date(Date.parse("2026-11-10T23:30:00Z") - days * 86_400_000).toISOString();

	it("pins the lag ceiling at 7 calendar days", () => {
		expect(COVERAGE_MAX_EFFECTIVE_LAG_DAYS).toBe(7);
	});

	it.each([
		[0, "2026-11-10"],
		[1, "2026-11-09"],
		[7, "2026-11-03"],
	])("attributes to the effective_at date at a lag of %i day(s)", (lag, expected) => {
		expect(
			coverageDateForArtifact({ captured_at: captured, effective_at: effectiveLagging(lag) }),
		).toBe(expected);
	});

	it("attributes to the captured_at date at a lag of 8 days", () => {
		expect(
			coverageDateForArtifact({ captured_at: captured, effective_at: effectiveLagging(8) }),
		).toBe("2026-11-10");
	});

	it("attributes to the captured_at date when effective_at is after captured_at (lag -1)", () => {
		expect(
			coverageDateForArtifact({ captured_at: captured, effective_at: "2026-11-11T00:30:00+00:00" }),
		).toBe("2026-11-10");
	});

	it("counts the lag in calendar days, not elapsed hours", () => {
		// 23:59 on the 3rd to 00:01 on the 10th is under 7 x 24 hours but 7 calendar days;
		// 00:01 on the 2nd to 23:59 on the 10th is 8 calendar days.
		expect(
			coverageDateForArtifact({
				captured_at: "2026-11-10T00:01:00+00:00",
				effective_at: "2026-11-03T23:59:00+00:00",
			}),
		).toBe("2026-11-03");
		expect(
			coverageDateForArtifact({
				captured_at: "2026-11-10T23:59:00+00:00",
				effective_at: "2026-11-02T00:01:00+00:00",
			}),
		).toBe("2026-11-10");
	});

	it("uses the other date when one is null, and has no day when both are", () => {
		expect(coverageDateForArtifact({ captured_at: captured, effective_at: null })).toBe("2026-11-10");
		expect(coverageDateForArtifact({ captured_at: captured })).toBe("2026-11-10");
		expect(
			coverageDateForArtifact({ captured_at: null, effective_at: "2026-11-04T12:00:00+00:00" }),
		).toBe("2026-11-04");
		expect(coverageDateForArtifact({ captured_at: null, effective_at: null })).toBeNull();
	});

	it.each([
		[{ content_subtype: "daily_log" }],
		[{ content_subtype: "scaffold" }],
		[{ lifecycle_stage: "discovered" }],
		[{ lifecycle_stage: "failed" }],
	])("is not material: %o", (row) => {
		expect(isSynthesizableMaterial(row)).toBe(false);
	});

	it("is material with a null stage and a null subtype, and at any other stage", () => {
		expect(isSynthesizableMaterial({ content_subtype: null, lifecycle_stage: null })).toBe(true);
		expect(isSynthesizableMaterial({})).toBe(true);
		expect(isSynthesizableMaterial({ content_subtype: "note", lifecycle_stage: "enriched" })).toBe(true);
	});
});
