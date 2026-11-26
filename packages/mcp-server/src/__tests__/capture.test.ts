import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import {
	CAPTURE_DEDUP_WINDOW_MS,
	captureAction,
	captureCore,
	captureHandler,
	captureInput,
	resolveCapturedAt,
	SOURCE_URL_MAX_LENGTH,
} from "../tools/capture.js";
import { executeAction, toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const artifactEntityLinkUpsertHandler = (args: unknown) =>
	toMcpTool(serverRegistry().get("link_upsert")!).handler(args);

// Isolate the handler from the DB-backed prefs loader and the OpenAI embed call.
vi.mock("../captureConfig.js", () => ({
	loadCapturePreferences: vi.fn(async () => ({
		default_tags: [],
		tag_rules: [],
		default_source_channel: "note",
		default_surface: null,
	})),
	applyCaptureRouting: vi.fn(() => ({ source_channel: "note", tags: [] })),
}));

vi.mock("../embeddings.js", () => ({
	embedAndStore: vi.fn(async () => {}),
}));

const origFrom = supabase.from;
const origStorageFrom = supabase.storage.from;
const origRpc = supabase.rpc;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase.storage as any).from = origStorageFrom;
	(supabase as any).rpc = origRpc;
	vi.restoreAllMocks();
});

/**
 * Stub the two writes `captureHandler` performs — storage upload (success) and the
 * `artifacts` insert — and return a handle that captures the exact row passed to
 * `.insert(...)` so tests can assert what capture persisted.
 */
function stubSupabaseWrites() {
	const captured: { row?: Record<string, unknown> } = {};

	(supabase.storage as any).from = vi.fn(() => ({
		upload: vi.fn(async () => ({ error: null })),
		remove: vi.fn(async () => ({ error: null })),
	}));

	(supabase as any).from = vi.fn((table: string) => {
		if (table !== "artifacts") {
			throw new Error(`unexpected table in capture test: ${table}`);
		}
		return {
			// #993's pre-insert dedup lookup (findDedupMatch) always runs before the
			// insert below; these tests don't exercise dedup, so it always reports "no
			// match" and every capture falls through to a plain insert, unchanged from
			// this suite's pre-#993 behaviour.
			select: () => {
				const builder = {
					eq: () => builder,
					gte: () => builder,
					order: () => builder,
					limit: async () => ({ data: [], error: null }),
				};
				return builder;
			},
			insert: (row: Record<string, unknown>) => {
				captured.row = row;
				return {
					select: () => ({
						single: async () => ({
							data: {
								id: row.id,
								title: row.title,
								created_at: "2026-07-13T00:00:00.000Z",
							},
							error: null,
						}),
					}),
				};
			},
		};
	});

	return captured;
}

/**
 * A row `findDedupMatch` (capture.ts) can match against: whatever a prior `captureCore`
 * call would have inserted (or however much of it the test cares to fill in).
 */
type StubArtifactRow = {
	id: string;
	title: string;
	tags: string[] | null;
	source_channel: string;
	storage_bucket: string;
	storage_path: string;
	captured_at: string;
	created_at: string;
	dedup_key?: string | null;
	content_fingerprint?: string | null;
	processing_metadata?: Record<string, unknown> | null;
};

/**
 * Stub `supabase.from("artifacts")` for the #993 dedup path: both the pre-insert
 * `.select(...).eq(...).gte(...).order(...).limit(...)` lookup `findDedupMatch` runs and
 * the ordinary `.insert(...).select().single()` write `captureCore` falls through to when
 * no match is found. `existing` seeds what the SELECT can match; a real partial-unique
 * conflict on `dedup_key` is simulated by returning a 23505 from `.insert(...)` when the
 * inserted row's `dedup_key` collides with a seeded row's, so the race-closer path
 * (capture.ts's catch block) is exercised the same way a real Postgres index would drive
 * it, not just the pre-check.
 */
function stubSupabaseWithExisting(seeded: StubArtifactRow[] = []) {
	// Every seeded row is implicitly this test run's owner — `findDedupMatch` always
	// filters on `user_id` first, so a row with no `user_id` at all would never match
	// anything and every test would silently fall through to "no duplicate found".
	const existing = seeded.map((row) => ({ user_id: getCurrentUserId(), ...row }));
	const insertedRows: Record<string, unknown>[] = [];
	const updatedRows: Record<string, unknown>[] = [];
	const storageUploads: Array<{ path: string; body: string; options: Record<string, unknown> }> = [];

	(supabase.storage as any).from = vi.fn(() => ({
		upload: vi.fn(async (path: string, body: string, options: Record<string, unknown>) => {
			storageUploads.push({ path, body, options });
			return { error: null };
		}),
		remove: vi.fn(async () => ({ error: null })),
	}));

	(supabase as any).from = vi.fn((table: string) => {
		if (table !== "artifacts") {
			throw new Error(`unexpected table in capture test: ${table}`);
		}
		return {
			select: () => {
				const filters: Record<string, unknown> = {};
				const gteFilters: Record<string, unknown> = {};
				const builder = {
					eq: (col: string, val: unknown) => {
						filters[col] = val;
						return builder;
					},
					gte: (col: string, val: unknown) => {
						gteFilters[col] = val;
						return builder;
					},
					order: () => builder,
					limit: async () => {
						const matches = existing
							.filter((row) =>
								Object.entries(filters).every(([k, v]: [string, unknown]) => (row as any)[k] === v),
							)
							.filter((row) =>
								Object.entries(gteFilters).every(
									([k, v]: [string, unknown]) => (row as any)[k] >= (v as string),
								),
							)
							.sort((a, b) => a.created_at.localeCompare(b.created_at));
						return { data: matches, error: null };
					},
				};
				return builder;
			},
			insert: (row: Record<string, unknown>) => {
				const conflict =
					row.dedup_key != null &&
					existing.some((r) => r.dedup_key === row.dedup_key);
				return {
					select: () => ({
						single: async () => {
							if (conflict) {
								return {
									data: null,
									error: {
										code: "23505",
										message: "duplicate key value violates unique constraint",
									},
								};
							}
							insertedRows.push(row);
							return {
								data: { id: row.id, title: row.title, created_at: "2026-09-24T00:00:00.000Z" },
								error: null,
							};
						},
					}),
				};
			},
			update: (patch: Record<string, unknown>) => {
				updatedRows.push(patch);
				const builder = {
					eq: () => builder,
					select: () => ({
						single: async () => ({
							data: { id: existing[0]?.id, ...patch },
							error: null,
						}),
					}),
					then: (resolve: (val: { error: null }) => void) => resolve({ error: null }),
				};
				return builder;
			},
		};
	});

	return { insertedRows, updatedRows, storageUploads };
}

describe("capture — urgency affordance (#297 slice 2b)", () => {
	it("writes a user-supplied urgency value onto the artifact row", async () => {
		const captured = stubSupabaseWrites();

		await captureHandler({ text: "ship the release", urgency: "file" });

		expect(captured.row?.urgency).toBe("file");
	});

	it("writes urgency: null when the caller omits it (never inferred)", async () => {
		const captured = stubSupabaseWrites();

		await captureHandler({ text: "just a passing thought" });

		expect(captured.row?.urgency).toBeNull();
	});

	it("passes an explicit content-type flag through as content_subtype, unchanged", async () => {
		const captured = stubSupabaseWrites();

		await captureHandler({ text: "call the plumber", content_subtype: "task" });

		expect(captured.row?.content_subtype).toBe("task");
	});
});

describe("capture — processing_metadata (#657)", () => {
	it("persists structured processing_metadata into the artifact row", async () => {
		const captured = stubSupabaseWrites();

		await captureHandler({
			text: "Log body",
			content_subtype: "daily_log",
			processing_metadata: { pillars: ["Pillar 1", "Pillar 2"] },
		});

		expect(captured.row?.processing_metadata).toEqual({
			pillars: ["Pillar 1", "Pillar 2"],
			derivation: { status: "pending" },
		});
	});

	it("defaults processing_metadata to derivation pending when omitted", async () => {
		const captured = stubSupabaseWrites();

		await captureHandler({ text: "Log body" });

		expect(captured.row?.processing_metadata).toEqual({
			derivation: { status: "pending" },
		});
	});
});

describe("capture input schema — urgency validation", () => {
	const schema = z.object(captureInput);

	it.each(["throw", "default", "file"])("accepts the ported level %s", (level) => {
		expect(schema.safeParse({ text: "x", urgency: level }).success).toBe(true);
	});

	it("rejects an urgency value outside the ported vocabulary", () => {
		expect(schema.safeParse({ text: "x", urgency: "later" }).success).toBe(false);
	});

	it("treats urgency as optional", () => {
		expect(schema.safeParse({ text: "x" }).success).toBe(true);
	});
});

// source_url is also written to artifacts.source, which migration 118's non-partial
// btree indexes on every row; an overlong key would fail the insert with an opaque
// index-row-size error, so the schema rejects it up front instead.
describe("capture input schema — source_url length cap", () => {
	const schema = z.object(captureInput);
	const urlOfLength = (n: number) => {
		const prefix = "https://example.com/";
		return prefix + "a".repeat(n - prefix.length);
	};

	it("accepts a URL at the cap", () => {
		expect(SOURCE_URL_MAX_LENGTH).toBe(2048);
		expect(schema.safeParse({ text: "x", source_url: urlOfLength(SOURCE_URL_MAX_LENGTH) }).success).toBe(true);
	});

	it("rejects a URL one character over the cap", () => {
		expect(schema.safeParse({ text: "x", source_url: urlOfLength(SOURCE_URL_MAX_LENGTH + 1) }).success).toBe(
			false,
		);
	});
});

// ---------------------------------------------------------------------------
// The `captured_at` declaration (#562, ADR-050 §7) — and its two bounds.
//
// Capture is dumb and stamps now. The Daily Log twin is the one atom whose write time is
// structurally the wrong day: the unattended sweep (#561) runs over `[today-7, today-2]`,
// so a twin stamped at wall-clock time is filed two to seven days after the day it
// narrates, and every day-bucketed read — coverage, the day window, "what did I decide on
// the 12th" — gets the wrong answer. Both bounds below are what keep a caller declaring
// the day its own artifact is about from becoming a general backdating dial (#414's date
// poisoning, with a wider blast radius).
// ---------------------------------------------------------------------------
describe("capture — captured_at declaration (#562)", () => {
	it("defaults captured_at to now when the caller declares nothing", async () => {
		const captured = stubSupabaseWrites();
		const before = Date.now();

		await captureHandler({ text: "an ordinary atom" });

		const written = Date.parse(captured.row?.captured_at as string);
		expect(written).toBeGreaterThanOrEqual(before);
		expect(written).toBeLessThanOrEqual(Date.now());
	});

	it("honours a declared past day for the allowlisted daily_log subtype", async () => {
		const captured = stubSupabaseWrites();

		await captureHandler({
			text: "## What I did\n- shipped the sweep",
			content_subtype: "daily_log",
			captured_at: "2026-08-17",
		});

		// Normalised to that day's UTC midnight, which is inside the
		// [D 00:00:00Z, D 23:59:59Z] window every day-bucketed read uses.
		expect(captured.row?.captured_at).toBe("2026-08-17T00:00:00.000Z");
	});

	it("echoes the declared filing day back to the caller", async () => {
		stubSupabaseWrites();

		const out = await captureHandler({
			text: "a swept day's log",
			content_subtype: "daily_log",
			captured_at: "2026-08-17T00:00:00Z",
		});

		expect(out.content[0].text).toContain(
			"Filed under: 2026-08-17T00:00:00.000Z (declared)",
		);
	});

	// BOUND 1 — the allowlist. Without it, `captured_at` is a general backdating dial and
	// any caller can misfile atoms into arbitrary day buckets.
	it("refuses a declared captured_at for a non-allowlisted content_subtype", async () => {
		stubSupabaseWrites();

		await expect(
			captureHandler({
				text: "buy milk",
				content_subtype: "note",
				captured_at: "2020-01-01",
			}),
		).rejects.toThrow(/only be declared for content_subtype/);
	});

	it("refuses a declared captured_at when no content_subtype is given at all", async () => {
		stubSupabaseWrites();

		await expect(
			captureHandler({ text: "buy milk", captured_at: "2020-01-01" }),
		).rejects.toThrow(/only be declared for content_subtype/);
	});

	// BOUND 2 — no future dates. A future-filed artifact is invisible to every day-window
	// read until that day arrives, and then arrives as history nobody wrote.
	it("refuses a future captured_at even on the allowlisted subtype", async () => {
		stubSupabaseWrites();
		const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

		await expect(
			captureHandler({
				text: "tomorrow's log, today",
				content_subtype: "daily_log",
				captured_at: tomorrow,
			}),
		).rejects.toThrow(/is in the future/);
	});

	it("refuses an unparseable captured_at rather than silently stamping now", async () => {
		stubSupabaseWrites();

		await expect(
			captureHandler({
				text: "x",
				content_subtype: "daily_log",
				captured_at: "last tuesday",
			}),
		).rejects.toThrow(/not a parseable date/);
	});

	// Every refusal happens before the storage upload, so a rejected call cannot leave an
	// orphaned object behind — the same shape as daily_log_create's pre-write checks.
	it("writes nothing at all when a bound is violated", async () => {
		const captured = stubSupabaseWrites();

		await expect(
			captureHandler({ text: "x", content_subtype: "note", captured_at: "2020-01-01" }),
		).rejects.toThrow();

		expect(captured.row).toBeUndefined();
		expect(supabase.storage.from).not.toHaveBeenCalled();
	});
});

describe("resolveCapturedAt — both bounds, clock-injected", () => {
	const now = new Date("2026-08-21T12:00:00.000Z");

	it("returns now when nothing is declared", () => {
		expect(resolveCapturedAt(undefined, "daily_log", now)).toBe("2026-08-21T12:00:00.000Z");
	});

	it("accepts a value exactly at now (the boundary is >, not >=)", () => {
		expect(resolveCapturedAt("2026-08-21T12:00:00.000Z", "daily_log", now)).toBe(
			"2026-08-21T12:00:00.000Z",
		);
	});

	it("rejects one millisecond into the future", () => {
		expect(() => resolveCapturedAt("2026-08-21T12:00:00.001Z", "daily_log", now)).toThrow(
			/is in the future/,
		);
	});

	it("names the allowlist in the refusal, so the caller can see what would work", () => {
		expect(() => resolveCapturedAt("2026-08-17", "transcript", now)).toThrow(/daily_log/);
	});
});

// ---------------------------------------------------------------------------
// #993 — capture-side double submission. Two independent dedup keys:
//   - `dedup_key`: caller-supplied, DB-enforced forever via a real unique index
//     (artifacts_user_dedup_key_unique, migration 106) — race-safe. Always available,
//     for every content_subtype including system-produced ones.
//   - content fingerprint: sha256(normalised title+body+content_subtype+resolved
//     surface+resolved source_channel+sorted tags), matched only within
//     CAPTURE_DEDUP_WINDOW_MS, and SKIPPED ENTIRELY for system-produced content_subtypes
//     (SYSTEM_PRODUCED_CONTENT_SUBTYPES) — a pre-insert SELECT, not DB-enforced (see
//     capture.ts). Widened on round-1 QA review of PR #1124 — see the High finding.
// ---------------------------------------------------------------------------
describe("capture — idempotency guard (#993)", () => {
	it("identical submit within the window returns the same id, with no second insert", async () => {
		const first = stubSupabaseWithExisting([]);
		const original = await captureCore({ text: "ship the release notes", title: "Release notes" });
		expect(first.insertedRows).toHaveLength(1);

		const existingRow: StubArtifactRow = {
			id: original.id,
			title: original.title,
			tags: original.tags,
			source_channel: original.source_channel,
			storage_bucket: original.storage_bucket,
			storage_path: original.storage_path,
			captured_at: original.captured_at,
			created_at: new Date().toISOString(), // well inside the window
			content_fingerprint: first.insertedRows[0].content_fingerprint as string,
		};
		const second = stubSupabaseWithExisting([existingRow]);

		const retry = await captureCore({ text: "ship the release notes", title: "Release notes" });

		expect(retry.id).toBe(original.id);
		expect(retry.deduplicated).toBe(true);
		expect(second.insertedRows).toHaveLength(0);
	});

	it("a different body is not deduplicated — a new row is inserted", async () => {
		const first = stubSupabaseWithExisting([]);
		const original = await captureCore({ text: "ship the release notes", title: "Release notes" });

		const existingRow: StubArtifactRow = {
			id: original.id,
			title: original.title,
			tags: original.tags,
			source_channel: original.source_channel,
			storage_bucket: original.storage_bucket,
			storage_path: original.storage_path,
			captured_at: original.captured_at,
			created_at: new Date().toISOString(),
			content_fingerprint: first.insertedRows[0].content_fingerprint as string,
		};
		const second = stubSupabaseWithExisting([existingRow]);

		const distinct = await captureCore({ text: "a completely different note", title: "Release notes" });

		expect(distinct.id).not.toBe(original.id);
		expect(distinct.deduplicated).toBe(false);
		expect(second.insertedRows).toHaveLength(1);
	});

	it("a fingerprint match outside the window is not deduplicated — a new row is inserted", async () => {
		const first = stubSupabaseWithExisting([]);
		const original = await captureCore({ text: "ship the release notes", title: "Release notes" });

		const longAgo = new Date(Date.now() - CAPTURE_DEDUP_WINDOW_MS - 60_000).toISOString();
		const existingRow: StubArtifactRow = {
			id: original.id,
			title: original.title,
			tags: original.tags,
			source_channel: original.source_channel,
			storage_bucket: original.storage_bucket,
			storage_path: original.storage_path,
			captured_at: original.captured_at,
			created_at: longAgo, // outside CAPTURE_DEDUP_WINDOW_MS
			content_fingerprint: first.insertedRows[0].content_fingerprint as string,
		};
		const second = stubSupabaseWithExisting([existingRow]);

		const later = await captureCore({ text: "ship the release notes", title: "Release notes" });

		expect(later.id).not.toBe(original.id);
		expect(later.deduplicated).toBe(false);
		expect(second.insertedRows).toHaveLength(1);
	});

	it("an explicit dedup_key match returns the same id regardless of body/age, with no second insert", async () => {
		const existingRow: StubArtifactRow = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Webhook payload",
			tags: ["memory"],
			source_channel: "note",
			storage_bucket: "artifacts",
			storage_path: "notes/u1/11111111-1111-4111-8111-111111111111.md",
			captured_at: "2026-01-01T00:00:00.000Z",
			created_at: "2020-01-01T00:00:00.000Z", // long outside any fingerprint window
			dedup_key: "webhook-evt-42",
		};
		const stub = stubSupabaseWithExisting([existingRow]);

		const result = await captureCore({
			text: "an entirely different body",
			title: "Something else",
			dedup_key: "webhook-evt-42",
		});

		expect(result.id).toBe(existingRow.id);
		expect(result.deduplicated).toBe(true);
		expect(stub.insertedRows).toHaveLength(0);
	});

	it("updates an existing artifact in-place when updateOnDedupKey is set and new whatsapp_message_ids arrive, clearing derivation status", async () => {
		const existingRow: StubArtifactRow = {
			id: "33333333-3333-4333-8333-333333333333",
			title: "WhatsApp (Alice · 2026-10-28): Hey",
			tags: ["whatsapp"],
			source_channel: "note",
			storage_bucket: "artifacts",
			storage_path: "notes/u1/33333333-3333-4333-8333-333333333333.md",
			captured_at: "2026-10-28T23:00:00.000Z",
			created_at: "2026-10-28T23:00:00.000Z",
			dedup_key: "whatsapp:447700900222@s.whatsapp.net:2026-10-28",
			content_fingerprint: "old-fp",
			processing_metadata: {
				whatsapp_chat_jid: "447700900222@s.whatsapp.net",
				whatsapp_day: "2026-10-28",
				whatsapp_message_ids: ["M1", "M2"],
				derivation: { status: "derived", derived_at: "2026-10-28T23:05:00.000Z" },
			},
		};
		const stub = stubSupabaseWithExisting([existingRow]);

		const updated = await captureCore(
			{
				title: "WhatsApp (Alice · 2026-10-28): Hey",
				text: "[21:00:00] **Alice**: Hey\n[22:15:00] **Me**: Sent!\n[23:40:00] **Alice**: Got it!",
				surface: "whatsapp_dm",
				content_subtype: "whatsapp_message",
				dedup_key: "whatsapp:447700900222@s.whatsapp.net:2026-10-28",
				processing_metadata: {
					whatsapp_chat_jid: "447700900222@s.whatsapp.net",
					whatsapp_day: "2026-10-28",
					whatsapp_message_ids: ["M1", "M2", "M3"],
				},
			},
			undefined,
			{ updateOnDedupKey: true },
		);

		expect(updated.id).toBe(existingRow.id);
		expect(updated.deduplicated).toBe(false);
		expect(updated.updated).toBe(true);
		expect(stub.insertedRows).toHaveLength(0);
		expect(stub.updatedRows).toHaveLength(1);
		expect(stub.storageUploads).toHaveLength(1);
		expect(stub.storageUploads[0]?.options.upsert).toBe(true);
		expect(stub.updatedRows[0]?.embedding).toBeNull();
		const nextMeta = stub.updatedRows[0]?.processing_metadata as Record<string, unknown>;
		expect(nextMeta.whatsapp_message_ids).toEqual(["M1", "M2", "M3"]);
		expect(nextMeta.derivation).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Round-1 QA review of #1124 — High finding: the original title+body-only fingerprint,
// applied unconditionally, collapsed two distinct legitimate captures into one artifact
// on two concrete downstream paths. Both scenarios below must now produce TWO rows.
// ---------------------------------------------------------------------------
describe("capture — system-produced content_subtypes are never fingerprint-deduplicated (round-1 QA, #1124)", () => {
	it("reviewer scenario (a): two meetings' identical boilerplate email body never collapse onto one artifact", async () => {
		// The exact shape meetingNotesIngest.ts's captureFromEmailBody uses: identical
		// title+body ("no notes taken"), content_subtype: 'meeting-note', submitted
		// within the dedup window (two meetings processed minutes apart).
		const first = stubSupabaseWithExisting([]);
		const meetingA = await captureCore({
			text: "No notes were taken for this meeting.",
			title: "Weekly sync",
			content_subtype: "meeting-note",
		});
		expect(first.insertedRows).toHaveLength(1);

		const existingRow: StubArtifactRow = {
			id: meetingA.id,
			title: meetingA.title,
			tags: meetingA.tags,
			source_channel: meetingA.source_channel,
			storage_bucket: meetingA.storage_bucket,
			storage_path: meetingA.storage_path,
			captured_at: meetingA.captured_at,
			created_at: new Date().toISOString(), // well inside the window
			content_fingerprint: first.insertedRows[0].content_fingerprint as string,
		};
		const second = stubSupabaseWithExisting([existingRow]);

		// A second, DIFFERENT meeting, same boilerplate body, same title shape, minutes
		// later — must NOT resolve to meetingA's artifact (that would then get linked
		// `primary` to both calendar events).
		const meetingB = await captureCore({
			text: "No notes were taken for this meeting.",
			title: "Weekly sync",
			content_subtype: "meeting-note",
		});

		expect(meetingB.id).not.toBe(meetingA.id);
		expect(meetingB.deduplicated).toBe(false);
		expect(second.insertedRows).toHaveLength(1);
	});

	it("reviewer scenario (b): two domains' coincident Daily Log twin narration never collapse onto one row", async () => {
		// The Daily Log twin write (ADR-050 §7): content_subtype: 'daily_log'. Two
		// domains (work/angus) whose EOD narration happens to both be "nothing
		// notable today" within the window must each get their own twin, or
		// dos_synthesis_coverage undercounts the second domain.
		const first = stubSupabaseWithExisting([]);
		const workTwin = await captureCore({
			text: "Nothing notable today.",
			title: "Daily Log — 2026-09-24",
			content_subtype: "daily_log",
		});
		expect(first.insertedRows).toHaveLength(1);

		const existingRow: StubArtifactRow = {
			id: workTwin.id,
			title: workTwin.title,
			tags: workTwin.tags,
			source_channel: workTwin.source_channel,
			storage_bucket: workTwin.storage_bucket,
			storage_path: workTwin.storage_path,
			captured_at: workTwin.captured_at,
			created_at: new Date().toISOString(),
			content_fingerprint: first.insertedRows[0].content_fingerprint as string,
		};
		const second = stubSupabaseWithExisting([existingRow]);

		const angusTwin = await captureCore({
			text: "Nothing notable today.",
			title: "Daily Log — 2026-09-24",
			content_subtype: "daily_log",
		});

		expect(angusTwin.id).not.toBe(workTwin.id);
		expect(angusTwin.deduplicated).toBe(false);
		expect(second.insertedRows).toHaveLength(1);
	});

	it.each(["task_request", "event_request", "daily_log", "meeting-note", "scaffold"])(
		"content_subtype '%s' is never matched by the content-fingerprint guard",
		async (contentSubtype) => {
			const first = stubSupabaseWithExisting([]);
			const original = await captureCore({
				text: "identical text",
				title: "identical title",
				content_subtype: contentSubtype,
			});

			const existingRow: StubArtifactRow = {
				id: original.id,
				title: original.title,
				tags: original.tags,
				source_channel: original.source_channel,
				storage_bucket: original.storage_bucket,
				storage_path: original.storage_path,
				captured_at: original.captured_at,
				created_at: new Date().toISOString(), // well inside the window
				content_fingerprint: first.insertedRows[0].content_fingerprint as string,
			};
			const second = stubSupabaseWithExisting([existingRow]);

			const retry = await captureCore({
				text: "identical text",
				title: "identical title",
				content_subtype: contentSubtype,
			});

			expect(retry.id).not.toBe(original.id);
			expect(retry.deduplicated).toBe(false);
			expect(second.insertedRows).toHaveLength(1);
		},
	);

	it("an explicit dedup_key still dedups a system-produced content_subtype (the opt-in path stays available)", async () => {
		const existingRow: StubArtifactRow = {
			id: "22222222-2222-4222-8222-222222222222",
			title: "Meeting X notes",
			tags: [],
			source_channel: "note",
			storage_bucket: "artifacts",
			storage_path: "notes/u1/22222222-2222-4222-8222-222222222222.md",
			captured_at: "2026-01-01T00:00:00.000Z",
			created_at: "2020-01-01T00:00:00.000Z",
			dedup_key: "meeting-notes-email-msg-42",
		};
		const stub = stubSupabaseWithExisting([existingRow]);

		const result = await captureCore({
			text: "No notes were taken for this meeting.",
			title: "Meeting X notes",
			content_subtype: "meeting-note",
			dedup_key: "meeting-notes-email-msg-42",
		});

		expect(result.id).toBe(existingRow.id);
		expect(result.deduplicated).toBe(true);
		expect(stub.insertedRows).toHaveLength(0);
	});
});

describe("captureAction (ADR-100)", () => {
	it("executes directly returning structured CaptureResult", async () => {
		stubSupabaseWrites();
		const result = await executeAction(captureAction, {
			text: "Direct execution atom",
			title: "Direct Note",
		});

		expect(result.id).toBeDefined();
		expect(result.title).toBe("Direct Note");
		expect(result.deduplicated).toBe(false);
		expect(result.source_channel).toBe("note");
	});
});

describe("capture & link_upsert — derivation status (#1978)", () => {
	it("captureCore defaults processing_metadata.derivation to { status: 'pending' } when omitted", async () => {
		const captured = stubSupabaseWrites();

		await captureCore({ text: "Anna is Lara's sister." });

		expect(captured.row?.processing_metadata).toEqual({
			derivation: { status: "pending" },
		});
	});

	it("captureCore preserves caller-supplied processing_metadata.derivation when explicitly passed", async () => {
		const captured = stubSupabaseWrites();

		await captureCore({
			text: "Already derived atom",
			processing_metadata: {
				derivation: { status: "skipped", reason: "manual" },
				custom_flag: true,
			},
		});

		expect(captured.row?.processing_metadata).toEqual({
			derivation: { status: "skipped", reason: "manual" },
			custom_flag: true,
		});
	});

	it("artifactEntityLinkUpsertHandler stamps set_artifact_derivation for each distinct artifact_id when mark_artifact_derived is true", async () => {
		const ART_1 = "61d7dc07-313c-4f41-abfe-17b73b4872e7";
		const ART_2 = "72e8ed18-424d-4a52-bc0f-28c84c5983f8";
		const ENT_1 = "a535fa35-9424-4ef6-8aa5-b5c9f01e2d31";
		const ENT_2 = "e5f237cd-6375-42d0-8e8f-1c4b2a9d0f12";

		const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
		(supabase as any).from = vi.fn((table: string) => {
			if (table !== "artifact_entity_links") {
				throw new Error(`Unexpected table: ${table}`);
			}
			return {
				upsert: (rows: unknown[]) => ({
					select: async () => ({ data: rows, error: null }),
				}),
			};
		});
		(supabase as any).rpc = vi.fn(
			async (fn: string, params: Record<string, unknown>) => {
				rpcCalls.push({ fn, params });
				return { data: null, error: null };
			},
		);

		const res = await artifactEntityLinkUpsertHandler({
			links: [
				{ artifact_id: ART_1, entity_id: ENT_1, link_type: "mentioned" },
				{ artifact_id: ART_1, entity_id: ENT_2, link_type: "mentioned" },
				{ artifact_id: ART_2, entity_id: ENT_1, link_type: "related" },
			],
			mark_artifact_derived: true,
		});

		expect(res.content[0].text).toBe("Upserted 3 artifact-entity link(s).");
		expect(rpcCalls).toHaveLength(2);
		expect(rpcCalls[0]).toEqual({
			fn: "set_artifact_derivation",
			params: {
				p_user_id: getCurrentUserId(),
				p_artifact_id: ART_1,
				p_derivation: {
					status: "completed",
					derived_at: expect.any(String),
					attempts: 1,
					provider: "interactive",
				},
			},
		});
		expect(rpcCalls[1]).toEqual({
			fn: "set_artifact_derivation",
			params: {
				p_user_id: getCurrentUserId(),
				p_artifact_id: ART_2,
				p_derivation: {
					status: "completed",
					derived_at: expect.any(String),
					attempts: 1,
					provider: "interactive",
				},
			},
		});
	});

	it("artifactEntityLinkUpsertHandler does not call set_artifact_derivation when mark_artifact_derived is omitted", async () => {
		const ART_1 = "61d7dc07-313c-4f41-abfe-17b73b4872e7";
		const ENT_1 = "a535fa35-9424-4ef6-8aa5-b5c9f01e2d31";

		const rpcSpy = vi.fn(async () => ({ data: null, error: null }));
		(supabase as any).from = vi.fn(() => ({
			upsert: (rows: unknown[]) => ({
				select: async () => ({ data: rows, error: null }),
			}),
		}));
		(supabase as any).rpc = rpcSpy;

		await artifactEntityLinkUpsertHandler({
			links: [{ artifact_id: ART_1, entity_id: ENT_1 }],
		});

		expect(rpcSpy).not.toHaveBeenCalled();
	});
});
