import { afterEach, describe, expect, it, vi } from "vitest";

// ADR-088 / #571. Two halves, and the second is the one that matters: a write side
// that copies the source's own timestamp into `originated_at`, and a read side where
// every day window keys on `effective_at` instead of `captured_at`.
//
// The incident these exist for (#567): a bulk Drive backfill on 2026-08-05 landed a
// decade of 2015–2022 files stamped with that day, and every day-scoped consumer read
// them as things that happened that day. #567's stage filter caught the unenriched
// ones. Once such a file IS enriched it is legitimately synthesis-eligible, and nothing
// before this change distinguished it from something that happened today.

vi.mock("../env.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../env.js")>();
	return { ...actual, env: { ...actual.env, openaiApiKey: undefined as string | undefined } };
});
vi.mock("../embeddings.js", () => ({ embed: vi.fn(async () => [0.1, 0.2, 0.3]) }));

import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import {
	GMAIL_ATTACHMENT_CONNECTOR_BY_ACCOUNT,
	ORIGINATION_FIELD_BY_CONNECTOR,
	originationFor,
} from "../vocab.js";

const searchHandler = (args: any) =>
	toMcpTool(serverRegistry().get("knowledge_search")!).handler(args);

const origFrom = supabase.from;
const origRpc = supabase.rpc;
afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase as any).rpc = origRpc;
	vi.restoreAllMocks();
});

describe("originationFor — which envelope timestamp is origination (#571 (a))", () => {
	const envelope = {
		source_created_at: "2016-03-12T09:41:00.000Z",
		source_modified_at: "2026-09-10T11:00:00.000Z",
	};

	it("takes Drive's created time, not its modified time", () => {
		// The whole bug in one assertion. The Drive discover cadence is INCREMENTAL on
		// modifiedTime, so the rows arriving today are precisely the recently-touched
		// ones — keying on modified would put a 2016 contract re-saved last week back
		// into last week's window, which is the failure, not the fix.
		expect(originationFor("gdrive", envelope)).toBe("2016-03-12T09:41:00.000Z");
		expect(originationFor("gdrive_work", envelope)).toBe("2016-03-12T09:41:00.000Z");
	});

	it("takes Notion's last-edited time instead, because a page is a living document", () => {
		expect(originationFor("notion", envelope)).toBe("2026-09-10T11:00:00.000Z");
	});

	it("returns undefined for a connector with no policy entry, rather than guessing", () => {
		// Absence must be additive-safe: an unmapped connector keeps originated_at NULL,
		// effective_at falls back to captured_at, and the window behaves exactly as it
		// did before ADR-088. A default of "created" here would silently refile every
		// future source the day it was wired up.
		expect(originationFor("slack", envelope)).toBeUndefined();
		expect(originationFor("", envelope)).toBeUndefined();
	});

	it("returns undefined when the source served nothing for its own field", () => {
		expect(originationFor("gdrive", { source_modified_at: "2026-09-10T11:00:00Z" })).toBeUndefined();
		expect(originationFor("gdrive", { source_created_at: null })).toBeUndefined();
		expect(originationFor("notion", {})).toBeUndefined();
	});

	it("never lets a malformed third-party timestamp reach the insert", () => {
		// These strings are copied verbatim out of someone else's API response. Without
		// the parse guard, `new Date("last Tuesday").toISOString()` throws and
		// `String(new Date(...))` yields "Invalid Date" — either way one bad row from one
		// connector fails an entire discover sweep on the Postgres cast.
		for (const bad of ["last Tuesday", "", "0000-00-00", "not-a-date"]) {
			expect(originationFor("gdrive", { source_created_at: bad })).toBeUndefined();
		}
	});

	it("normalises to ISO so the column never depends on a source's formatting", () => {
		// A source serving an offset rather than UTC is the case that makes string
		// comparison (what deriving from jsonb would have done) quietly wrong.
		expect(originationFor("gdrive", { source_created_at: "2016-03-12T10:41:00+01:00" })).toBe(
			"2016-03-12T09:41:00.000Z",
		);
	});

	it("maps every Drive connector spelling ingest_enrich_next recognises", () => {
		// The aliases exist because ingest_discover is forgiving about spelling. One
		// missing from this map is a Drive source silently falling back to ingest time.
		for (const c of ["gdrive", "google_drive", "drive", "gdrive_work"]) {
			expect(ORIGINATION_FIELD_BY_CONNECTOR[c], c).toBe("source_created_at");
		}
	});

	it("files a Gmail attachment under its message date, for every account's connector (#1210)", () => {
		// The sweep serves the message date as source_created_at. An attachment swept
		// today from a 2023 email is from 2023; without an entry it would fall back to
		// ingest time, which is exactly the refiling ADR-088 removed.
		for (const c of Object.values(GMAIL_ATTACHMENT_CONNECTOR_BY_ACCOUNT)) {
			expect(ORIGINATION_FIELD_BY_CONNECTOR[c], c).toBe("source_created_at");
			expect(originationFor(c, { source_created_at: "2023-11-03T10:17:52.000Z" })).toBe(
				"2023-11-03T10:17:52.000Z",
			);
		}
	});

	it("files a local file under source_created_at (#1211)", () => {
		expect(ORIGINATION_FIELD_BY_CONNECTOR.local).toBe("source_created_at");
		expect(originationFor("local", { source_created_at: "2026-09-11T12:26:00.000Z" })).toBe(
			"2026-09-11T12:26:00.000Z",
		);
	});
});

const CAPTURED_TODAY = "2026-09-14T10:00:00Z";

/** An enriched historic document: ingested today, originating 2016. The exact row
 *  #567's stage filter cannot help with, because it has a body and is eligible. */
const HISTORIC = {
	id: "artifact-2016-contract",
	title: "Employment contract 2016",
	plain_text: "Full extracted text of a real contract.",
	created_at: CAPTURED_TODAY,
	captured_at: CAPTURED_TODAY,
	effective_at: "2016-03-12T09:41:00Z",
	lifecycle_stage: "enriched",
	tags: [],
	content_subtype: null,
};

/** An ordinary atom: no origination, so the database's generated column makes the
 *  two dates equal. */
const TODAYS = {
	...HISTORIC,
	id: "artifact-today",
	title: "A thing that happened today",
	effective_at: CAPTURED_TODAY,
};

function stubRpc(name: string, rows: unknown[]) {
	(supabase as any).rpc = vi.fn((called: string) => ({
		select: () => Promise.resolve({ data: called === name ? rows : [], error: null }),
	}));
}

describe("the day window reads effective_at, not captured_at (#571)", () => {
	it("keeps a historic document out of today's window even though it arrived today", async () => {
		stubRpc("fts_search_artifacts", [HISTORIC, TODAYS]);

		const out = await searchHandler({
			query: "contract",
			captured_after: "2026-09-14T00:00:00Z",
			captured_before: "2026-09-14T23:59:59Z",
		} as any);

		expect(out.content[0].text).toContain("A thing that happened today");
		expect(out.content[0].text).not.toContain("Employment contract 2016");
	});

	it("returns it for a window over the year it is actually from", async () => {
		// The other half: filtering on origination must not make historic material
		// unreachable, only un-narratable as today. "What do I have from 2016" still works.
		stubRpc("fts_search_artifacts", [HISTORIC, TODAYS]);

		const out = await searchHandler({
			query: "contract",
			captured_after: "2016-01-01T00:00:00Z",
			captured_before: "2016-12-31T23:59:59Z",
		} as any);

		expect(out.content[0].text).toContain("Employment contract 2016");
		expect(out.content[0].text).not.toContain("A thing that happened today");
	});

	it("shows the origination date alongside the capture date, and keeps the capture date verbatim", async () => {
		// The dos ritual's Step 2 display contract reads the `(captured YYYY-MM-DD)`
		// substring (SKILL.md), so the origination note must be ADDITIVE — if it replaced
		// the capture note this would be a skill change, and it is deliberately not one.
		stubRpc("fts_search_artifacts", [HISTORIC]);

		const out = await searchHandler({ query: "contract" } as any);

		expect(out.content[0].text).toContain("(captured 2026-09-14)");
		expect(out.content[0].text).toContain("(from 2016-03-12)");
	});

	it("says nothing extra for an ordinary atom whose dates agree", async () => {
		stubRpc("fts_search_artifacts", [TODAYS]);

		const out = await searchHandler({ query: "thing" } as any);

		expect(out.content[0].text).toContain("(captured 2026-09-14)");
		expect(out.content[0].text).not.toContain("(from ");
	});
});

describe("the filter-only path filters and orders in SQL on effective_at", () => {
	/** Records the column each PostgREST predicate was applied to. This is the path
	 *  `dos` uses — a day window carries no query text — and the only one where the
	 *  filter runs in Postgres rather than in JS, so the column name is the whole
	 *  behaviour and a JS-side assertion would not see it. */
	function recordingQuery(rows: unknown[]) {
		const calls = { gte: [] as string[], lte: [] as string[], order: [] as string[] };
		const b: any = {
			select: () => b,
			eq: () => b,
			in: () => b,
			not: () => b,
			or: () => b,
			gte: (col: string) => (calls.gte.push(col), b),
			lte: (col: string) => (calls.lte.push(col), b),
			order: (col: string) => (calls.order.push(col), b),
			limit: () => Promise.resolve({ data: rows, error: null, count: rows.length }),
		};
		(supabase as any).from = vi.fn(() => b);
		return calls;
	}

	it("applies both window bounds to effective_at", async () => {
		const calls = recordingQuery([TODAYS]);

		await searchHandler({
			captured_after: "2026-09-14T00:00:00Z",
			captured_before: "2026-09-14T23:59:59Z",
		} as any);

		expect(calls.gte).toEqual(["effective_at"]);
		expect(calls.lte).toEqual(["effective_at"]);
		expect(calls.gte).not.toContain("captured_at");
		expect(calls.lte).not.toContain("captured_at");
	});

	it("orders by the same column it selected on", async () => {
		// #571 (c) depends on this: the backlog slice is newest-first and bounded to 50,
		// so ordering by effective_at is what makes correctly-dated archive material sink
		// to the back of the queue instead of sitting at the front under its ingest date.
		// Ordering by a date the query did not filter on is incoherent regardless.
		const calls = recordingQuery([TODAYS]);

		await searchHandler({ captured_before: "2026-09-14T00:00:00Z", not_consumed: false } as any);

		expect(calls.order).toEqual(["effective_at"]);
	});
});
