import { afterEach, describe, expect, it, vi } from "vitest";
import {
	documentResolveInput,
	matchTrackedDocument,
	titleSearchTerms,
} from "@ahkms/core";
import { supabase } from "../supabase.js";
import { documentResolveHandler } from "../tools/documentResolve.js";
import { z } from "zod";

// #1230: document_resolve answers "get my X" from a tracked document (#1216): one
// `resource` entity with properties.tracked, its canonical pointer, renditions, and
// every artifact linked to it `primary`. With nothing tracked it lists untracked
// title matches instead of guessing. It never writes.

const origFrom = supabase.from;
const origRpc = supabase.rpc;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase as any).rpc = origRpc;
	vi.restoreAllMocks();
});

type Args = z.infer<z.ZodObject<typeof documentResolveInput>>;
type Call = { method: string; args: unknown[] };
type Result = { data: unknown; error: unknown };

/**
 * A chainable fake of `supabase.from(table)` and `supabase.rpc(name, params)`:
 * every builder method is recorded and returns the builder; awaiting it (or
 * `.maybeSingle()`) asks `handlers[table]` -- or `handlers["rpc:<name>"]`, whose
 * first recorded call is `rpc` with the params -- for the result, given the calls
 * made, so a handler can honour `.in(...)` and `.eq(...)` the way PostgREST would.
 */
function fakeDb(handlers: Record<string, (calls: Call[]) => Result>) {
	const log: { table: string; calls: Call[] }[] = [];
	const open = (table: string, first?: Call) => {
		const calls: Call[] = first ? [first] : [];
		log.push({ table, calls });
		const resolve = () => Promise.resolve(handlers[table]?.(calls) ?? { data: [], error: null });
		const builder: any = new Proxy(
			{},
			{
				get(_target, prop) {
					if (prop === "then") {
						return (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => resolve().then(res, rej);
					}
					if (prop === "maybeSingle") return () => resolve();
					return (...args: unknown[]) => {
						calls.push({ method: String(prop), args });
						return builder;
					};
				},
			},
		);
		return builder;
	};
	(supabase as any).from = vi.fn((table: string) => open(table));
	(supabase as any).rpc = vi.fn((name: string, params: unknown) =>
		open(`rpc:${name}`, { method: "rpc", args: [name, params] }),
	);
	return log;
}

/** The params the candidate search RPC was called with, from the fake's log. */
function candidateParams(log: ReturnType<typeof fakeDb>) {
	const entry = log.find((l) => l.table === "rpc:document_title_candidates");
	return entry?.calls[0]?.args[1] as { p_user_id: string; p_terms: string[]; p_limit: number } | undefined;
}

const argsOf = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => c.args);

const ENTITY_ID = "aaaaaaaa-0000-4000-8000-000000000001";
// Artifact ids must be uuid-shaped: document_resolve drops anything else before querying.
const D6 = "00000000-0000-4000-8000-0000000000d6";
const D1 = "00000000-0000-4000-8000-0000000000d1";
const D2 = "00000000-0000-4000-8000-0000000000d2";
const R1 = "00000000-0000-4000-8000-0000000000e1";

function doc(id: string, overrides: Record<string, unknown> = {}, disc: Record<string, unknown> = {}) {
	return {
		id,
		title: `Doc ${id}`,
		storage_bucket: "external",
		storage_url: `https://drive.google.com/file/d/${id}/view`,
		source_url: null,
		source: id,
		source_channel: "discovered_gdrive",
		surface: "discovered_gdrive",
		file_type: null,
		archived: false,
		archived_reason: null,
		lifecycle_stage: "discovered",
		processing_metadata: {
			discovery: {
				connector: "gdrive",
				url: `https://drive.google.com/file/d/${id}/view`,
				source_modified_at: "2025-01-01T00:00:00.000Z",
				...disc,
			},
		},
		...overrides,
	};
}

const DOCS = [
	doc(D6, { title: "Angus Hally CV Jun 24.pdf" }, { source_modified_at: "2026-09-11T09:00:00.000Z", mime_type: "application/pdf" }),
	doc(D1, { title: "Angus Hally CV.pdf" }, { source_modified_at: "2025-05-13T10:00:00.000Z" }),
	doc(D2, { title: "Angus Hally CV Feb 23.docx", archived: true, archived_reason: "superseded:d6" }),
	doc(R1, { title: "Angus Hally CV Jun 24.docx" }, { source_modified_at: "2026-09-11T09:05:00.000Z" }),
];

const CV_ENTITY = {
	id: ENTITY_ID,
	title: "CV — Angus Hally",
	aliases: ["CV", "curriculum vitae", "résumé"],
	archived: false,
	properties: {
		tracked: true,
		doc_kind: "cv",
		canonical_artifact_id: D6,
		canonical_url: `https://drive.google.com/file/d/${D6}/view?usp=sharing`,
		canonical_set_at: "2026-09-29T10:00:00.000Z",
		canonical_set_by: "owner",
		renditions: [{ format: "docx", artifact_id: R1, url: `https://drive.google.com/file/d/${R1}/view` }],
	},
};

const PASSPORT_ENTITY = {
	id: "aaaaaaaa-0000-4000-8000-000000000002",
	title: "Passport scan",
	aliases: [],
	archived: false,
	properties: { tracked: true, doc_kind: "passport_scan" },
};

function trackedDb(entities: unknown[] = [CV_ENTITY, PASSPORT_ENTITY], candidates: unknown[] = []) {
	return fakeDb({
		entities: (calls) => {
			const idFilter = argsOf(calls, "eq").find(([col]) => col === "id")?.[1];
			const rows = (entities as { id: string }[]).filter((e) => !idFilter || e.id === idFilter);
			return { data: rows, error: null };
		},
		artifact_entity_links: (calls) => {
			const ids = (argsOf(calls, "in")[0]?.[1] as string[]) ?? [];
			const links = ids.includes(ENTITY_ID)
				? [D6, D1, D2, R1].map((artifact_id) => ({ artifact_id, entity_id: ENTITY_ID }))
				: [];
			return { data: links, error: null };
		},
		artifacts: (calls) => {
			const ids = (argsOf(calls, "in")[0]?.[1] as string[]) ?? [];
			return { data: DOCS.filter((d) => ids.includes(d.id)), error: null };
		},
		"rpc:document_title_candidates": () => ({ data: candidates, error: null }),
	});
}

async function resolve(args: Args): Promise<string> {
	return (await documentResolveHandler(args)).content[0].text;
}

describe("document_resolve — a tracked match (#1230)", () => {
	it("returns the canonical pointer, renditions and the other versions", async () => {
		const log = trackedDb();
		const out = await resolve({ query: "CV" });

		expect(out).toContain("1 tracked document(s) match.");
		expect(out).toContain("## CV — Angus Hally");
		expect(out).toContain(`Entity: ${ENTITY_ID} · doc_kind: cv · aliases: CV, curriculum vitae, résumé`);
		expect(out).toContain(`Canonical: [${D6}] Angus Hally CV Jun 24.pdf`);
		// The entity's canonical_url wins over the artifact's own link.
		expect(out).toContain(`  Link: https://drive.google.com/file/d/${D6}/view?usp=sharing`);
		expect(out).toContain("  Surface: discovered_gdrive");
		expect(out).toContain("  Format: application/pdf");
		expect(out).toContain("  Modified at source: 2026-09-11T09:00:00.000Z");
		expect(out).toContain("  Canonical set: 2026-09-29T10:00:00.000Z by owner");
		expect(out).toContain(`Renditions (1):\n  - docx: https://drive.google.com/file/d/${R1}/view [${R1}]`);
		expect(out).toContain("Other versions (2):");
		// Newest first; a rendition that is also linked is labelled, not hidden.
		expect(out.indexOf(`[${R1}] Angus Hally CV Jun 24.docx (rendition: docx)`)).toBeGreaterThan(-1);
		expect(out.indexOf(`[${R1}] Angus Hally CV Jun 24.docx (rendition: docx)`)).toBeLessThan(
			out.indexOf(`[${D1}] Angus Hally CV.pdf`),
		);
		expect(out).toContain(
			`[${D1}] Angus Hally CV.pdf · https://drive.google.com/file/d/${D1}/view · discovered_gdrive · modified 2025-05-13T10:00:00.000Z`,
		);
		// The canonical is not repeated as an "other" version.
		expect(out.split(`[${D6}]`)).toHaveLength(2);
		// Archived versions are counted, never silently dropped.
		expect(out).not.toContain(`[${D2}]`);
		expect(out).toContain("(1 archived version(s) hidden; pass include_archived: true to list them)");

		const entityCalls = log.find((l) => l.table === "entities")!.calls;
		expect(argsOf(entityCalls, "eq")).toContainEqual(["entity_type", "resource"]);
		expect(argsOf(entityCalls, "contains")).toContainEqual(["properties", { tracked: true }]);
		expect(argsOf(entityCalls, "eq")).toContainEqual(["archived", false]);
		const linkCalls = log.find((l) => l.table === "artifact_entity_links")!.calls;
		expect(argsOf(linkCalls, "eq")).toContainEqual(["link_type", "primary"]);
	});

	it("lists archived versions with their reason when include_archived is set", async () => {
		const log = trackedDb();
		const out = await resolve({ query: "CV", include_archived: true });

		expect(out).toContain("Other versions (3):");
		expect(out).toContain(`[${D2}] Angus Hally CV Feb 23.docx`);
		expect(out).toContain("archived (superseded:d6)");
		expect(out).not.toContain("archived version(s) hidden");
		// ...and archived tracked documents are no longer filtered out.
		const entityCalls = log.find((l) => l.table === "entities")!.calls;
		expect(argsOf(entityCalls, "eq")).not.toContainEqual(["archived", false]);
	});

	it("matches on an alias, including one the query names as a word", async () => {
		trackedDb();
		expect(await resolve({ query: "curriculum vitae" })).toContain("## CV — Angus Hally");
		expect(await resolve({ query: "get my CV" })).toContain("## CV — Angus Hally");
		expect(await resolve({ query: "passport" })).toContain("## Passport scan");
	});

	it("matches on doc_kind alone, case-insensitively, and on entity_id", async () => {
		trackedDb();
		const byKind = await resolve({ doc_kind: "CV" });
		expect(byKind).toContain("## CV — Angus Hally");
		expect(byKind).not.toContain("Passport scan");

		const byId = await resolve({ entity_id: ENTITY_ID });
		expect(byId).toContain("## CV — Angus Hally");
		expect(byId).not.toContain("Passport scan");
	});

	it("says so when no canonical has been set yet", async () => {
		trackedDb([{ ...CV_ENTITY, properties: { tracked: true, doc_kind: "cv" } }]);
		const out = await resolve({ doc_kind: "cv" });
		expect(out).toContain("Canonical: (none set; the golden-doc skill's set-canonical mode sets one)");
		expect(out).toContain("Renditions: none");
		expect(out).toContain("Other versions (3):");
	});

	it("reports a malformed canonical id as not found instead of failing the lookup", async () => {
		const log = trackedDb([
			{ ...CV_ENTITY, properties: { ...CV_ENTITY.properties, canonical_artifact_id: "d6-by-hand" } },
		]);
		const out = await resolve({ doc_kind: "cv" });
		expect(out).toContain("Canonical: [d6-by-hand] (artifact not found: deleted, or not this owner's)");
		expect(out).toContain(`  Link: https://drive.google.com/file/d/${D6}/view?usp=sharing`);
		// The canonical is then an ordinary linked version.
		expect(out).toContain(`[${D6}] Angus Hally CV Jun 24.pdf`);
		const idLists = log
			.filter((l) => l.table === "artifacts")
			.flatMap((l) => argsOf(l.calls, "in").map((a) => a[1] as string[]));
		expect(idLists.flat()).not.toContain("d6-by-hand");
	});

	it("counts matches past the limit instead of dropping them silently", async () => {
		trackedDb([
			CV_ENTITY,
			{ ...CV_ENTITY, id: "aaaaaaaa-0000-4000-8000-000000000003", title: "CV (short)" },
		]);
		const out = await resolve({ doc_kind: "cv", limit: 1 });
		expect(out).toContain("2 tracked document(s) match.");
		expect(out).toContain("⚠️ 1 more not shown");
	});

	it("falls back to the pre-migration-110 columns when entities.aliases does not exist", async () => {
		let attempts = 0;
		fakeDb({
			entities: (calls) => {
				attempts += 1;
				const cols = argsOf(calls, "select")[0]?.[0] as string;
				if (cols.includes("aliases")) {
					return { data: null, error: { code: "42703", message: 'column entities.aliases does not exist' } };
				}
				return { data: [{ ...CV_ENTITY, aliases: undefined, properties: { ...CV_ENTITY.properties, aliases: ["CV"] } }], error: null };
			},
		});
		const out = await resolve({ query: "CV" });
		expect(attempts).toBe(2);
		expect(out).toContain("## CV — Angus Hally");
	});
});

describe("document_resolve — nothing tracked (#1230)", () => {
	it("says so, lists up to ten untracked title matches, and points at golden-doc", async () => {
		const candidates = Array.from({ length: 11 }, (_, i) =>
			doc(`c${i}`, { title: `Driving licence ${i}.pdf` }, { source_modified_at: `2024-0${(i % 9) + 1}-01T00:00:00.000Z` }),
		);
		const log = trackedDb([CV_ENTITY], candidates);
		const out = await resolve({ query: "licence" });

		expect(out.startsWith('No tracked document matches "licence".')).toBe(true);
		expect(out).toContain(
			'Untracked candidates (discovered documents whose title contains "licence", archived excluded):',
		);
		expect(out.match(/^ {2}- \[c\d+\]/gm)).toHaveLength(10);
		expect(out).toContain("(more than 10 titles match; narrow the query to see others)");
		expect(out.trimEnd().endsWith("Run the golden-doc skill to track one.")).toBe(true);

		// The index-backed RPC (migration 119), never a title scan of the artifacts table.
		expect(candidateParams(log)).toEqual({ p_user_id: expect.any(String), p_terms: ["licence"], p_limit: 11 });
		const rpcCalls = log.find((l) => l.table === "rpc:document_title_candidates")!.calls;
		expect(argsOf(rpcCalls, "select")[0]?.[0]).toContain("processing_metadata");
		const artifactReads = log.filter((l) => l.table === "artifacts");
		expect(artifactReads.flatMap((l) => argsOf(l.calls, "ilike"))).toEqual([]);
	});

	it("finds 'Angus Hally CV …' for the natural phrasing 'my CV' (the review's case)", async () => {
		// The whole phrase is in no title; the word that names the document is.
		const candidates = [
			doc(D1, { title: "Angus Hally CV.pdf" }, { source_modified_at: "2025-05-13T10:00:00.000Z" }),
			doc(D6, { title: "Angus Hally CV Jun 24.pdf" }, { source_modified_at: "2026-09-11T09:00:00.000Z" }),
		];
		const log = trackedDb([], candidates);
		const out = await resolve({ query: "my CV" });

		expect(out.startsWith('No tracked document matches "my CV".')).toBe(true);
		expect(candidateParams(log)?.p_terms).toEqual(["cv"]);
		expect(out).toContain('Untracked candidates (discovered documents whose title contains "cv", archived excluded):');
		// Newest first.
		expect(out.indexOf(`[${D6}] Angus Hally CV Jun 24.pdf`)).toBeGreaterThan(-1);
		expect(out.indexOf(`[${D6}]`)).toBeLessThan(out.indexOf(`[${D1}] Angus Hally CV.pdf`));
		expect(out).not.toContain("No untracked candidates");
	});

	it("names every word it looked for when none is found", async () => {
		const log = trackedDb([], []);
		const out = await resolve({ query: "get my driving licence" });
		expect(candidateParams(log)?.p_terms).toEqual(["driving", "licence"]);
		expect(out).toContain(
			'No untracked candidates either: no discovered document\'s title contains any of "driving", "licence".',
		);
	});

	it("drops LIKE metacharacters and punctuation instead of passing them through", async () => {
		const log = trackedDb([], []);
		await resolve({ query: "100%_done" });
		expect(candidateParams(log)?.p_terms).toEqual(["100", "done"]);
	});

	it("points a missing RPC at migration 119", async () => {
		fakeDb({
			"rpc:document_title_candidates": () => ({
				data: null,
				error: { code: "PGRST202", message: "Could not find the function public.document_title_candidates" },
			}),
		});
		await expect(resolve({ query: "licence" })).rejects.toThrow(/apply migration 119/);
	});

	it("searches by an untracked entity's own title when only entity_id was given", async () => {
		const log = fakeDb({
			entities: (calls) =>
				argsOf(calls, "select")[0]?.[0] === "title"
					? { data: { title: "Tenancy agreement" }, error: null }
					: { data: [], error: null },
			"rpc:document_title_candidates": () => ({
				data: [doc("t1", { title: "Tenancy agreement 2024.pdf" })],
				error: null,
			}),
		});
		const out = await resolve({ entity_id: ENTITY_ID });
		expect(out).toContain(`No tracked document matches "${ENTITY_ID}".`);
		expect(out).toContain("[t1] Tenancy agreement 2024.pdf");
		expect(candidateParams(log)?.p_terms).toEqual(["tenancy", "agreement"]);
	});
});

describe("titleSearchTerms", () => {
	it.each([
		["my CV", ["cv"]],
		["get my latest CV", ["cv"]],
		["Driving licence 2024", ["driving", "licence", "2024"]],
		["cv_master", ["cv", "master"]],
		["résumé", ["résumé"]],
		["CV cv Cv", ["cv"]],
	])("%j -> %j", (text, terms) => {
		expect(titleSearchTerms(text)).toEqual(terms);
	});

	it("keeps every word rather than searching for nothing", () => {
		expect(titleSearchTerms("my")).toEqual(["my"]);
		expect(titleSearchTerms("--")).toEqual([]);
	});

	it("caps the number of words", () => {
		expect(titleSearchTerms("one two three four five six seven eight nine ten")).toHaveLength(8);
	});
});

describe("document_resolve — contract", () => {
	it("refuses a call with none of query, entity_id, doc_kind", async () => {
		await expect(documentResolveHandler({})).rejects.toThrow(/at least one of query, entity_id, doc_kind/);
	});

	it("never writes, on the match path or the fallback path", async () => {
		const writes = new Set(["insert", "update", "upsert", "delete"]);
		const log = trackedDb([CV_ENTITY], [doc("c1")]);
		await resolve({ query: "CV", include_archived: true });
		await resolve({ query: "nothing tracked like this" });
		const used = log.flatMap((l) => l.calls.map((c) => c.method));
		expect(used.filter((m) => writes.has(m))).toEqual([]);
		// The only RPC is the read-only candidate search, and only on the fallback path.
		expect(vi.mocked(supabase.rpc).mock.calls.map((c) => c[0])).toEqual(["document_title_candidates"]);
	});
});

describe("matchTrackedDocument", () => {
	const entity = { title: "CV — Angus Hally", aliases: ["CV", "resume"], properties: { doc_kind: "cv" } };

	it("ranks an equal title, alias or doc_kind as exact", () => {
		expect(matchTrackedDocument(entity, { query: "cv" })).toEqual({ match: true, exact: true });
		expect(matchTrackedDocument(entity, { query: "Resume" })).toEqual({ match: true, exact: true });
	});

	it("matches a substring of the title without calling it exact", () => {
		expect(matchTrackedDocument(entity, { query: "angus hally" })).toEqual({ match: true, exact: false });
	});

	it("does not match a word that merely contains an alias", () => {
		expect(matchTrackedDocument(entity, { query: "cvs pharmacy" }).match).toBe(false);
	});

	it("requires every criterion given", () => {
		expect(matchTrackedDocument(entity, { query: "cv", doc_kind: "passport_scan" }).match).toBe(false);
		expect(matchTrackedDocument(entity, { doc_kind: "CV" })).toEqual({ match: true, exact: true });
	});
});
