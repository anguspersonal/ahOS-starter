/**
 * Temporal validity + soft-delete lifecycle on entity_relationships (issue #175).
 *
 * Migration 068 adds valid_from/valid_to/archived/updated_at to entity_relationships.
 * These tests pin the entity_relate behaviour built on top of those columns:
 *   1. valid_from/valid_to pass through on create and update;
 *   2. archive: true soft-deletes an existing edge instead of hard-deleting it;
 *   3. re-relating a previously archived (from, to, type) triple resurrects it
 *      (archived: false) rather than erroring or creating a duplicate — required
 *      because the unique constraint from migration 062 doesn't distinguish
 *      archived rows;
 *   4. archive: true on a non-existent edge is a no-op, not an error.
 *
 * Mirrors the supabase.from monkeypatch style used in artifactDelete.test.ts —
 * no vi.mock, just a thenable-at-terminal-method query builder stub.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeRelationshipConfidence } from "@ahkms/core";
import { supabase } from "../supabase.js";
import { toMcpTool } from "../actions/index.js";
import { serverRegistry } from "../actions/serverRegistry.js";

const relateEntitiesHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("entity_relate")!).handler(args);
const peopleMatchHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("person_match")!).handler(args);

const TEST_USER = "00000000-0000-0000-0000-000000000000"; // from vitest.config env
const FROM_ID = "11111111-1111-1111-1111-111111111111";
const TO_ID = "22222222-2222-2222-2222-222222222222";

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

/**
 * Routes calls by table name to per-table handlers, since relateEntitiesHandler
 * hits both "entities" (endpoint ownership check) and "entity_relationships"
 * (dedup lookup + insert/update) in a single call.
 */
function mockSupabaseFrom(handlers: {
	entities?: () => unknown;
	entity_relationships?: () => unknown;
}) {
	(supabase as any).from = vi.fn((table: string) => {
		if (table === "entities") return handlers.entities?.();
		if (table === "entity_relationships") return handlers.entity_relationships?.();
		throw new Error(`Unexpected table in test: ${table}`);
	});
}

/** Both endpoints exist and belong to the user — the ownership check entity_relate runs first. */
function endpointsOk() {
	return {
		select: () => ({
			eq: () => ({
				in: () =>
					Promise.resolve({
						data: [{ id: FROM_ID }, { id: TO_ID }],
						error: null,
					}),
			}),
		}),
	};
}

/**
 * Chainable dedup-lookup stub: .eq()…eq().limit().maybeSingle() resolves to
 * `result` regardless of how many .eq() filters entity_relate applies
 * (from/to/type + the user_id tenant scoping added for #270 §1). Use as
 * `select: () => dedupBuilder(result)`.
 */
function dedupBuilder(
	result: { data: unknown; error: unknown },
	eqCalls?: unknown[][],
) {
	const b: any = {
		eq: (...args: unknown[]) => {
			eqCalls?.push(args);
			return b;
		},
		limit: () => b,
		maybeSingle: () => Promise.resolve(result),
	};
	return b;
}

/**
 * Chainable update stub: captures the payload, then .eq()…eq() is awaitable and
 * resolves to { error: null } — tolerant of the number of .eq() scoping filters.
 */
function updateCapture(capture: (payload: Record<string, unknown>) => void) {
	return (payload: Record<string, unknown>) => {
		capture(payload);
		const b: any = {
			eq: () => b,
			then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
		};
		return b;
	};
}

/**
 * Shared fixture + helper for the "re-assert an existing edge" tests (#464's
 * window preservation and #501's confidence/metadata/notes preservation) —
 * lifted to module scope so both describe blocks reuse the same edge shape
 * and dedup/update wiring instead of each hand-rolling their own.
 */
const WINDOWED_EDGE = {
	id: "edge-464",
	archived: false,
	valid_from: "2018-01-01T00:00:00.000Z",
	valid_to: "2019-01-01T00:00:00.000Z",
	confidence_score: 0.7,
	metadata: { role: "Senior PM", team: "Platform" },
	notes: "Started as an IC, promoted in 2019",
};

/** Re-assert the existing windowed edge with `args`; returns the update payload. */
async function reassert(
	args: Record<string, unknown>,
	existing: Record<string, unknown> = WINDOWED_EDGE,
) {
	let updatePayload: Record<string, unknown> | undefined;
	mockSupabaseFrom({
		entities: endpointsOk,
		entity_relationships: () => ({
			select: () => dedupBuilder({ data: existing, error: null }),
			update: updateCapture((payload) => {
				updatePayload = payload;
			}),
		}),
	});
	await relateEntitiesHandler({
		from_entity_id: FROM_ID,
		to_entity_id: TO_ID,
		relationship_type: "employed_by",
		...args,
	} as any);
	return updatePayload;
}

describe("relateEntitiesHandler — temporal validity + soft-delete (issue #175)", () => {
	it("stores valid_from/valid_to on create, scoping the dedup lookup by user_id", async () => {
		let insertPayload: Record<string, unknown> | undefined;
		const dedupEqCalls: unknown[][] = [];
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: null, error: null }, dedupEqCalls),
				insert: (payload: Record<string, unknown>) => {
					insertPayload = payload;
					return {
						select: () => ({
							single: () => Promise.resolve({ data: { id: "edge-1" }, error: null }),
						}),
					};
				},
			}),
		});

		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "works_with",
			valid_from: "2019-01-01T00:00:00.000Z",
			valid_to: "2022-06-30T00:00:00.000Z",
		} as any);

		expect(insertPayload).toMatchObject({
			valid_from: "2019-01-01T00:00:00.000Z",
			valid_to: "2022-06-30T00:00:00.000Z",
		});
		// #270 §1: the dedup/resurrect lookup must carry the user_id tenant filter,
		// since mcp-server's service-role key bypasses RLS.
		expect(dedupEqCalls).toContainEqual(["user_id", TEST_USER]);
	});

	it("defaults valid_from/valid_to to null when omitted", async () => {
		let insertPayload: Record<string, unknown> | undefined;
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: null, error: null }),
				insert: (payload: Record<string, unknown>) => {
					insertPayload = payload;
					return {
						select: () => ({
							single: () => Promise.resolve({ data: { id: "edge-2" }, error: null }),
						}),
					};
				},
			}),
		});

		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "works_with",
		} as any);

		expect(insertPayload).toMatchObject({ valid_from: null, valid_to: null });
	});

	it("archives an existing edge instead of hard-deleting it when archive: true", async () => {
		let updatePayload: Record<string, unknown> | undefined;
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: { id: "edge-3", archived: false }, error: null }),
				update: updateCapture((payload) => {
					updatePayload = payload;
				}),
			}),
		});

		const result = await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "works_with",
			archive: true,
		} as any);

		expect(updatePayload).toEqual({ archived: true });
		expect(result.content[0].text).toContain("Archived edge edge-3");
	});

	it("is a no-op (not an error) archiving a triple that does not exist", async () => {
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: null, error: null }),
			}),
		});

		const result = await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "works_with",
			archive: true,
		} as any);

		expect(result.content[0].text).toContain("No edge to archive");
	});

	it("archives an edge stored under a pre-vocabulary legacy type by retrying on the raw type", async () => {
		// 'fiancee_of' predates ADR-021 and normalises to engagedTo, so the
		// normalised lookup misses; archive-only fallback must find the stored
		// legacy row on the caller's raw type instead of reporting no-op.
		const typeLookups: string[] = [];
		let updatePayload: Record<string, unknown> | undefined;
		let updatedId: unknown;
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => {
					let lookedUpType: string | undefined;
					const b: any = {
						eq: (col: string, val: unknown) => {
							if (col === "relationship_type") lookedUpType = String(val);
							return b;
						},
						limit: () => b,
						maybeSingle: () => {
							typeLookups.push(lookedUpType ?? "<none>");
							return Promise.resolve(
								lookedUpType === "fiancee_of"
									? { data: { id: "edge-legacy", archived: false }, error: null }
									: { data: null, error: null },
							);
						},
					};
					return b;
				},
				update: (payload: Record<string, unknown>) => {
					updatePayload = payload;
					const b: any = {
						eq: (col: string, val: unknown) => {
							if (col === "id") updatedId = val;
							return b;
						},
						then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
					};
					return b;
				},
			}),
		});

		const result = await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "fiancee_of",
			archive: true,
		} as any);

		expect(typeLookups).toEqual(["engagedTo", "fiancee_of"]);
		expect(updatePayload).toEqual({ archived: true });
		expect(updatedId).toBe("edge-legacy");
		expect(result.content[0].text).toContain("Archived edge edge-legacy");
		expect(result.content[0].text).toContain('stored legacy type "fiancee_of"');
	});

	it("does not retry on the raw type for a create/update — the write path never retypes", async () => {
		const typeLookups: string[] = [];
		let inserted: Record<string, unknown> | undefined;
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => {
					let lookedUpType: string | undefined;
					const b: any = {
						eq: (col: string, val: unknown) => {
							if (col === "relationship_type") lookedUpType = String(val);
							return b;
						},
						limit: () => b,
						maybeSingle: () => {
							typeLookups.push(lookedUpType ?? "<none>");
							return Promise.resolve({ data: null, error: null });
						},
					};
					return b;
				},
				insert: (payload: Record<string, unknown>) => {
					inserted = payload;
					return {
						select: () => ({
							single: () => Promise.resolve({ data: { id: "edge-new" }, error: null }),
						}),
					};
				},
			}),
		});

		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "fiancee_of",
		} as any);

		expect(typeLookups).toEqual(["engagedTo"]);
		expect(inserted).toMatchObject({ relationship_type: "engagedTo" });
	});

	it("resurrects (un-archives) a previously archived edge when re-related without archive: true", async () => {
		let updatePayload: Record<string, unknown> | undefined;
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: { id: "edge-4", archived: true }, error: null }),
				update: updateCapture((payload) => {
					updatePayload = payload;
				}),
			}),
		});

		const result = await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "works_with",
		} as any);

		expect(updatePayload).toMatchObject({ archived: false });
		expect(result.content[0].text).toContain("Updated edge edge-4");
		expect(result.content[0].text).toContain("(un-archived)");
	});
});

/**
 * #464: omit = leave unchanged, on the update branch only.
 *
 * The update used to write `valid_from: args.valid_from ?? null`, so any
 * re-assertion that didn't repeat the dates (an agent bumping confidence on an
 * employed_by edge, say) silently wiped the stored window. The ADR-035
 * collision guard from #327 doesn't catch it — a window-less write isn't a
 * collision — so nothing warned. These pin preserve-on-omit per bound, and the
 * explicit escape hatch that replaces the old accidental one.
 */
describe("relateEntitiesHandler — preserve temporal window on omit (#464)", () => {
	it("keeps both bounds when a re-assertion mentions no dates (the reported repro)", async () => {
		// Step 2 of the issue's repro: bump confidence, say nothing about dates.
		const updatePayload = await reassert({ confidence: 90 });

		expect(updatePayload).toMatchObject({
			confidence_score: 0.9,
			valid_from: "2018-01-01T00:00:00.000Z",
			valid_to: "2019-01-01T00:00:00.000Z",
		});
	});

	it("preserves each bound independently — supplying one does not null the other", async () => {
		// Only valid_to supplied, and it matches, so the collision guard stays
		// quiet; valid_from must survive rather than being reset to null.
		const updatePayload = await reassert({ valid_to: "2019-01-01T00:00:00.000Z" });

		expect(updatePayload).toMatchObject({
			valid_from: "2018-01-01T00:00:00.000Z",
			valid_to: "2019-01-01T00:00:00.000Z",
		});
	});

	it("still writes a supplied window when the caller opts into overwriting", async () => {
		// Preserve-on-omit must not neuter a deliberate date correction.
		const updatePayload = await reassert({
			valid_from: "2020-01-01T00:00:00.000Z",
			valid_to: "2021-01-01T00:00:00.000Z",
			overwrite: true,
		});

		expect(updatePayload).toMatchObject({
			valid_from: "2020-01-01T00:00:00.000Z",
			valid_to: "2021-01-01T00:00:00.000Z",
		});
	});

	it("clears both bounds only when clear_window: true is passed explicitly", async () => {
		const updatePayload = await reassert({ clear_window: true });

		expect(updatePayload).toMatchObject({ valid_from: null, valid_to: null });
	});

	it("rejects clear_window combined with a supplied date as contradictory", async () => {
		await expect(
			reassert({ clear_window: true, valid_from: "2020-01-01T00:00:00.000Z" }),
		).rejects.toThrow(/clear_window cannot be combined/);
	});

	it("leaves an edge with no stored window null (nothing to preserve)", async () => {
		const updatePayload = await reassert(
			{ confidence: 50 },
			{ id: "edge-464b", archived: false, valid_from: null, valid_to: null },
		);

		expect(updatePayload).toMatchObject({ valid_from: null, valid_to: null });
	});

	it("rejects a partial overwrite that would persist an inverted window (round-1 QA finding, #500)", async () => {
		// Repro from the round-1 review: edge already spans 2018-01-01..2019-01-01.
		// Caller opts into overwrite and supplies only a NEW valid_from that is
		// after the OLD (preserved) valid_to. Before the fix this silently wrote
		// valid_from=2020-01-01, valid_to=2019-01-01 (inverted, no error) because
		// overwrite: true skips the ADR-035 collision guard entirely.
		await expect(
			reassert({
				overwrite: true,
				valid_from: "2020-01-01T00:00:00.000Z",
				// valid_to omitted — preserved from WINDOWED_EDGE as 2019-01-01,
				// which is now before the new valid_from.
			}),
		).rejects.toThrow(/Invalid validity window/);
	});

	it("rejects an inverted window on overwrite even when only valid_to is supplied", async () => {
		// Mirror case: new valid_to is before the preserved (old) valid_from.
		await expect(
			reassert({
				overwrite: true,
				valid_to: "2017-01-01T00:00:00.000Z",
				// valid_from omitted — preserved from WINDOWED_EDGE as 2018-01-01.
			}),
		).rejects.toThrow(/Invalid validity window/);
	});

	it("still allows a partial overwrite that keeps the window ordered", async () => {
		// Sanity check that the new inverted-window guard doesn't over-trigger:
		// a partial overwrite whose effective window stays ordered must still work.
		const updatePayload = await reassert({
			overwrite: true,
			valid_from: "2018-06-01T00:00:00.000Z",
			// valid_to omitted — preserved from WINDOWED_EDGE as 2019-01-01, which
			// is still after the new valid_from, so the window stays valid.
		});

		expect(updatePayload).toMatchObject({
			valid_from: "2018-06-01T00:00:00.000Z",
			valid_to: "2019-01-01T00:00:00.000Z",
		});
	});

	it("archives an edge and leaves its window untouched when clear_window is also passed (Low finding, #500)", async () => {
		// Documented (not fixed) behaviour: archive: true returns before window
		// logic runs, so clear_window is silently a no-op alongside it. Pinning
		// this so the documented contract (see the `archive` field's .describe())
		// stays true.
		let updatePayload: Record<string, unknown> | undefined;
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: WINDOWED_EDGE, error: null }),
				update: updateCapture((payload) => {
					updatePayload = payload;
				}),
			}),
		});

		const result = await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "employed_by",
			archive: true,
			clear_window: true,
		} as any);

		expect(updatePayload).toEqual({ archived: true });
		expect(result.content[0].text).toContain("Archived edge edge-464");
	});

	it("does not preserve anything on create — a brand-new edge omitting dates is null/null", async () => {
		let insertPayload: Record<string, unknown> | undefined;
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: null, error: null }),
				insert: (payload: Record<string, unknown>) => {
					insertPayload = payload;
					return {
						select: () => ({
							single: () => Promise.resolve({ data: { id: "edge-464c" }, error: null }),
						}),
					};
				},
			}),
		});

		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "employed_by",
			confidence: 90,
		} as any);

		expect(insertPayload).toMatchObject({ valid_from: null, valid_to: null });
	});
});

/**
 * #501: sibling of #464, same "omit = leave unchanged" posture, for the three
 * fields #464 deliberately left clearing on the update branch:
 *   - confidence_score: direct analogue of #464 — falls back to what's stored.
 *   - metadata: preserve on omit; when supplied, RFC 7386 JSON Merge Patch
 *     (shallow) against the stored object — supplied keys overwrite, omitted
 *     keys survive, an explicit `null` value deletes.
 *   - notes: the caller's prose is preserve-on-omit; the ADR-021 vocab note is
 *     never caller-erasable — re-derived from the resolved vocabulary and
 *     re-appended on every write, whether or not `notes` is supplied.
 */
describe("relateEntitiesHandler — preserve confidence/metadata/notes on omit (#501)", () => {
	it("keeps confidence_score when confidence is omitted", async () => {
		const updatePayload = await reassert({ notes: "bumping something else" });

		expect(updatePayload).toMatchObject({ confidence_score: WINDOWED_EDGE.confidence_score });
	});

	it("overwrites confidence_score when confidence is supplied", async () => {
		const updatePayload = await reassert({ confidence: 95 });

		expect(updatePayload).toMatchObject({ confidence_score: 0.95 });
	});

	it("keeps metadata untouched when metadata is omitted", async () => {
		const updatePayload = await reassert({ confidence: 80 });

		expect(updatePayload).toMatchObject({ metadata: WINDOWED_EDGE.metadata });
	});

	it("merges supplied metadata keys into the stored object instead of replacing it (RFC 7386)", async () => {
		// team overwritten, role and the newly-added location both survive/land —
		// a REPLACE semantics would have dropped `role` entirely.
		const updatePayload = await reassert({
			metadata: { team: "Growth", location: "Remote" },
		});

		expect(updatePayload?.metadata).toEqual({
			role: "Senior PM",
			team: "Growth",
			location: "Remote",
		});
	});

	it("deletes a metadata key when the caller supplies it with value null (RFC 7386)", async () => {
		const updatePayload = await reassert({ metadata: { team: null } });

		expect(updatePayload?.metadata).toEqual({ role: "Senior PM" });
	});

	it("keeps the caller's prose when notes is omitted", async () => {
		const updatePayload = await reassert({ confidence: 50 });

		expect(updatePayload).toMatchObject({ notes: WINDOWED_EDGE.notes });
	});

	it("replaces the caller's prose when notes is supplied", async () => {
		const updatePayload = await reassert({ notes: "corrected account of what happened" });

		expect(updatePayload).toMatchObject({ notes: "corrected account of what happened" });
	});

	it("re-derives and re-appends the ADR-021 vocab note on a re-assertion that omits notes, without duplicating it", async () => {
		const VOCAB_NOTED_EDGE = {
			id: "edge-501-vocab",
			archived: false,
			valid_from: null,
			valid_to: null,
			confidence_score: null,
			metadata: {},
			notes: "We met at a conference | girlfriend",
		};

		// "girlfriend" is a synonym that normalises to romanticPartnerOf and carries
		// "girlfriend" itself as the ADR-021 vocab note (see normalizeRelationshipType).
		const updatePayload = await reassert(
			{ relationship_type: "girlfriend", confidence: 85 },
			VOCAB_NOTED_EDGE,
		);

		expect(updatePayload).toMatchObject({
			notes: "We met at a conference | girlfriend",
		});
	});

	it("re-appends the vocab note fresh even when the caller supplies new prose (never caller-erasable)", async () => {
		const VOCAB_NOTED_EDGE = {
			id: "edge-501-vocab-2",
			archived: false,
			valid_from: null,
			valid_to: null,
			confidence_score: null,
			metadata: {},
			notes: "We met at a conference | girlfriend",
		};

		const updatePayload = await reassert(
			{ relationship_type: "girlfriend", notes: "moved in together" },
			VOCAB_NOTED_EDGE,
		);

		expect(updatePayload).toMatchObject({
			notes: "moved in together | girlfriend",
		});
	});
});

/**
 * #501 QA round 1 findings — https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/772#pullrequestreview-5000451293
 *
 * 🟠 High: the original single-suffix-strip implementation only re-appended
 * `resolved.vocabNote` when THIS call produced one. A caller who re-asserts
 * with the CANONICAL term (no fresh note) while also supplying new `notes`
 * hit `nextCallerProse = args.notes`, discarding a previously-recorded vocab
 * note outright — reachable because "girlfriend" and "romanticPartnerOf"
 * resolve to the same `relationship_type`, and the tool's own
 * `normalisedSuffix` message actively teaches callers to switch to the
 * canonical term on a later call. Fixed by recognising a stored vocab-note
 * segment against `vocabNoteSynonymsForType` instead of assuming position.
 *
 * 🟡 Medium: the suffix-only strip accumulated duplicates once a differently
 * re-derived note was appended after it. For `type: 'other'` this is the
 * ORDINARY case — every unrecognised phrase gets its own verbatim note — so
 * re-using an earlier phrase re-appended a second copy of it. Fixed by
 * dropping any stored segment that exactly matches THIS call's fresh note
 * before rejoining (dedupes exact repeats; distinct phrases still
 * accumulate as separate segments — documented residual, not a regression).
 */
describe("relateEntitiesHandler — vocab note survives a note-less re-assertion (#501 QA round 1, High)", () => {
	const ROMANTIC_EDGE = {
		id: "edge-501-qa1-romantic",
		archived: false,
		valid_from: null,
		valid_to: null,
		confidence_score: null,
		metadata: {},
		notes: "We met at a conference | girlfriend",
	};

	it("preserves a stored vocab note when the caller switches to the canonical term AND supplies new notes (the reviewer's repro)", async () => {
		// relationship_type "romanticPartnerOf" is the canonical term itself —
		// isKnownRelationshipType short-circuits before normalizeRelationshipType
		// ever runs, so THIS call's resolved.vocabNote is undefined even though
		// the edge's stored notes carry one from an earlier "girlfriend" call.
		const updatePayload = await reassert(
			{ relationship_type: "romanticPartnerOf", notes: "moved in together" },
			ROMANTIC_EDGE,
		);

		expect(updatePayload).toMatchObject({ notes: "moved in together | girlfriend" });
	});

	it("preserves a stored vocab note when the caller switches to the canonical term and omits notes", async () => {
		const updatePayload = await reassert(
			{ relationship_type: "romanticPartnerOf", confidence: 60 },
			ROMANTIC_EDGE,
		);

		expect(updatePayload).toMatchObject({ notes: "We met at a conference | girlfriend" });
	});

	it("preserves a stored vocab note when the caller switches to a DIFFERENT romantic synonym", async () => {
		// "situationship" also resolves to romanticPartnerOf but carries its own,
		// different vocab note — the fresh note supersedes the stored one rather
		// than the two accumulating side by side.
		const updatePayload = await reassert(
			{ relationship_type: "situationship", notes: "it's complicated now" },
			ROMANTIC_EDGE,
		);

		expect(updatePayload).toMatchObject({ notes: "it's complicated now | situationship" });
	});
});

describe("relateEntitiesHandler — 'other'-bucket vocab note dedup (#501 QA round 1, Medium)", () => {
	it("does not duplicate a vocab note when the caller re-asserts with an EARLIER unrecognised phrase", async () => {
		// Reviewer's repro: "co-founded with" (call 1) → "started a company
		// together" (call 2) → "co-founded with" again (call 3). Before the fix,
		// call 3 re-appended "co-founded with" as a THIRD segment even though it
		// was already present from call 1.
		const afterCall2 = {
			id: "edge-501-qa1-other",
			archived: false,
			valid_from: null,
			valid_to: null,
			confidence_score: null,
			metadata: {},
			notes: "prose | co-founded with | started a company together",
		};

		const updatePayload = await reassert(
			{ relationship_type: "co-founded with" },
			afterCall2,
		);

		const notes = updatePayload?.notes as string;
		const segments = notes.split(" | ");
		expect(segments.filter((s) => s === "co-founded with")).toHaveLength(1);
		expect(new Set(segments).size).toBe(segments.length); // no segment repeats
		expect(segments).toEqual(
			expect.arrayContaining(["prose", "started a company together", "co-founded with"]),
		);
	});

	it("re-using the exact same unrecognised phrase twice in a row is a true no-op", async () => {
		const existing = {
			id: "edge-501-qa1-other-2",
			archived: false,
			valid_from: null,
			valid_to: null,
			confidence_score: null,
			metadata: {},
			notes: "prose | co-founded with",
		};

		const updatePayload = await reassert({ relationship_type: "co-founded with" }, existing);

		expect(updatePayload).toMatchObject({ notes: "prose | co-founded with" });
	});
});

describe("relateEntitiesHandler — metadata hardening (#501 QA round 1, Low)", () => {
	it("stores a __proto__ key like any other instead of silently dropping it", async () => {
		// A real args.metadata arrives already JSON-parsed (the MCP transport),
		// which is what actually creates a genuine OWN "__proto__" data property —
		// unlike the `{ __proto__: "evil" }` OBJECT-LITERAL form, which the JS
		// grammar itself intercepts as a prototype directive and never creates a
		// property at all (silently ignored here since "evil" isn't an object).
		// JSON.parse reproduces the real attack surface this finding is about.
		const patch = JSON.parse('{"__proto__":"evil"}');
		const updatePayload = await reassert({ metadata: patch });

		expect(Object.getOwnPropertyDescriptor(updatePayload?.metadata, "__proto__")).toMatchObject({
			value: "evil",
			enumerable: true,
		});
		// The object's real prototype must be untouched — this is a stored data
		// key, not a prototype reassignment.
		expect(Object.getPrototypeOf(updatePayload?.metadata)).toBe(Object.prototype);
	});

	it("treats a non-object stored metadata value as empty on both the omit and supplied branches", async () => {
		const stringMetadataEdge = { ...WINDOWED_EDGE, id: "edge-501-qa1-nonobj", metadata: "hello" };

		const omitted = await reassert({ confidence: 10 }, stringMetadataEdge);
		expect(omitted?.metadata).toEqual({});

		const supplied = await reassert({ metadata: { added: true } }, stringMetadataEdge);
		expect(supplied?.metadata).toEqual({ added: true });
	});

	it("clears the caller's prose with an explicit empty string, leaving any vocab note intact", async () => {
		const vocabEdge = {
			id: "edge-501-qa1-clear-notes",
			archived: false,
			valid_from: null,
			valid_to: null,
			confidence_score: null,
			metadata: {},
			notes: "We met at a conference | girlfriend",
		};

		const updatePayload = await reassert(
			{ relationship_type: "girlfriend", notes: "" },
			vocabEdge,
		);

		expect(updatePayload).toMatchObject({ notes: "girlfriend" });
	});
});

/**
 * #501 QA round 2 — https://github.com/anguspersonal/knowledgeMgmtSystemOct2025/pull/772#pullrequestreview-5000511482
 *
 * End-to-end regressions for the `vocabNoteSynonymsForType` bug (see the
 * dedicated unit tests in `relationshipType.test.ts`): before the fix, the
 * function returned every synonym key mapping to a type, not just the
 * note-carrying ones, so caller prose that happened to BE a synonym key for
 * the edge's own type (e.g. "mother" on a parentOf edge) was wrongly
 * reclassified as a carried vocab note.
 */
describe("relateEntitiesHandler — caller prose matching a synonym key is never misclassified (#501 QA round 2)", () => {
	it("clears caller prose that happens to be a relationship synonym ('mother' on a parentOf edge)", async () => {
		// Before the fix: vocabNoteSynonymsForType('parentOf') wrongly included
		// "mother", so it was carried forward as a "vocab note" instead of being
		// treated as prose — notes: "" failed to clear it.
		const parentEdge = {
			id: "edge-501-qa2-parent",
			archived: false,
			valid_from: null,
			valid_to: null,
			confidence_score: null,
			metadata: {},
			notes: "mother",
		};

		const updatePayload = await reassert(
			{ relationship_type: "parentOf", notes: "" },
			parentEdge,
		);

		expect(updatePayload).toMatchObject({ notes: null });
	});

	it("preserves caller prose order across an omitted re-assertion ('mate | from uni' on a friendOf edge)", async () => {
		// Before the fix: "mate" (a friendOf synonym key) was wrongly split out
		// as a carried vocab note and re-appended LAST, reordering the caller's
		// own prose to "from uni | mate".
		const friendEdge = {
			id: "edge-501-qa2-friend",
			archived: false,
			valid_from: null,
			valid_to: null,
			confidence_score: null,
			metadata: {},
			notes: "mate | from uni",
		};

		const updatePayload = await reassert(
			{ relationship_type: "friendOf", confidence: 70 },
			friendEdge,
		);

		expect(updatePayload).toMatchObject({ notes: "mate | from uni" });
	});
});

describe("relateEntitiesHandler - supersedes_relationship_id (#2053)", () => {
	const OLD_EDGE_ID = "33333333-3333-3333-3333-333333333333";
	const NEW_EDGE_ID = "44444444-4444-4444-4444-444444444444";

	it("closes open valid_to on the superseded edge to the new edge valid_from and cross-links metadata on create", async () => {
		let insertPayload: Record<string, unknown> | undefined;
		let supersededUpdatePayload: Record<string, unknown> | undefined;
		const supersededUpdateEqs: unknown[][] = [];

		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => {
					const eqs: Record<string, unknown> = {};
					const b: any = {
						eq: (col: string, val: unknown) => {
							eqs[col] = val;
							return b;
						},
						limit: () => b,
						maybeSingle: () => {
							if (eqs.id === OLD_EDGE_ID) {
								return Promise.resolve({
									data: {
										id: OLD_EDGE_ID,
										user_id: TEST_USER,
										valid_from: "2020-01-01T00:00:00.000Z",
										valid_to: null,
										metadata: { role: "IC" },
									},
									error: null,
								});
							}
							return Promise.resolve({ data: null, error: null });
						},
					};
					return b;
				},
				insert: (payload: Record<string, unknown>) => {
					insertPayload = payload;
					return {
						select: () => ({
							single: () => Promise.resolve({ data: { id: NEW_EDGE_ID }, error: null }),
						}),
					};
				},
				update: (payload: Record<string, unknown>) => {
					supersededUpdatePayload = payload;
					const b: any = {
						eq: (...args: unknown[]) => {
							supersededUpdateEqs.push(args);
							return b;
						},
						then: (resolve: (v: { error: null }) => void) => resolve({ error: null }),
					};
					return b;
				},
			}),
		});

		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "employed_by",
			valid_from: "2024-03-01T00:00:00.000Z",
			metadata: { role: "Lead" },
			supersedes_relationship_id: OLD_EDGE_ID,
		} as any);

		expect(insertPayload).toMatchObject({
			valid_from: "2024-03-01T00:00:00.000Z",
			metadata: {
				role: "Lead",
				supersedes_relationship_id: OLD_EDGE_ID,
			},
		});
		expect(supersededUpdatePayload).toEqual({
			valid_to: "2024-03-01T00:00:00.000Z",
			metadata: {
				role: "IC",
				superseded_by_relationship_id: NEW_EDGE_ID,
			},
		});
		expect(supersededUpdateEqs).toContainEqual(["id", OLD_EDGE_ID]);
		expect(supersededUpdateEqs).toContainEqual(["user_id", TEST_USER]);
	});

	it("defaults superseded valid_to to current ISO timestamp when new edge valid_from is omitted", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-05-15T12:00:00.000Z"));
		let supersededUpdatePayload: Record<string, unknown> | undefined;

		try {
			mockSupabaseFrom({
				entities: endpointsOk,
				entity_relationships: () => ({
					select: () => {
						const eqs: Record<string, unknown> = {};
						const b: any = {
							eq: (col: string, val: unknown) => {
								eqs[col] = val;
								return b;
							},
							limit: () => b,
							maybeSingle: () => {
								if (eqs.id === OLD_EDGE_ID) {
									return Promise.resolve({
										data: {
											id: OLD_EDGE_ID,
											user_id: TEST_USER,
											valid_from: "2020-01-01T00:00:00.000Z",
											valid_to: null,
											metadata: {},
										},
										error: null,
									});
								}
								return Promise.resolve({ data: null, error: null });
							},
						};
						return b;
					},
					insert: () => ({
						select: () => ({
							single: () => Promise.resolve({ data: { id: NEW_EDGE_ID }, error: null }),
						}),
					}),
					update: updateCapture((payload) => {
						supersededUpdatePayload = payload;
					}),
				}),
			});

			await relateEntitiesHandler({
				from_entity_id: FROM_ID,
				to_entity_id: TO_ID,
				relationship_type: "employed_by",
				supersedes_relationship_id: OLD_EDGE_ID,
			} as any);

			expect(supersededUpdatePayload).toEqual({
				valid_to: "2025-05-15T12:00:00.000Z",
				metadata: {
					superseded_by_relationship_id: NEW_EDGE_ID,
				},
			});
		} finally {
			vi.useRealTimers();
		}
	});

	it("preserves existing non-null valid_to on superseded edge while still cross-linking metadata", async () => {
		let supersededUpdatePayload: Record<string, unknown> | undefined;

		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => {
					const eqs: Record<string, unknown> = {};
					const b: any = {
						eq: (col: string, val: unknown) => {
							eqs[col] = val;
							return b;
						},
						limit: () => b,
						maybeSingle: () => {
							if (eqs.id === OLD_EDGE_ID) {
								return Promise.resolve({
									data: {
										id: OLD_EDGE_ID,
										user_id: TEST_USER,
										valid_from: "2020-01-01T00:00:00.000Z",
										valid_to: "2023-12-31T00:00:00.000Z",
										metadata: { note: "already closed" },
									},
									error: null,
								});
							}
							return Promise.resolve({ data: null, error: null });
						},
					};
					return b;
				},
				insert: () => ({
					select: () => ({
						single: () => Promise.resolve({ data: { id: NEW_EDGE_ID }, error: null }),
					}),
				}),
				update: updateCapture((payload) => {
					supersededUpdatePayload = payload;
				}),
			}),
		});

		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "employed_by",
			valid_from: "2024-03-01T00:00:00.000Z",
			supersedes_relationship_id: OLD_EDGE_ID,
		} as any);

		expect(supersededUpdatePayload).toEqual({
			valid_to: "2023-12-31T00:00:00.000Z",
			metadata: {
				note: "already closed",
				superseded_by_relationship_id: NEW_EDGE_ID,
			},
		});
	});

	it("rejects before mutating either edge when supersedes_relationship_id does not exist or belongs to another user", async () => {
		let mutated = false;

		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: null, error: null }),
				insert: () => {
					mutated = true;
					return {
						select: () => ({
							single: () => Promise.resolve({ data: { id: NEW_EDGE_ID }, error: null }),
						}),
					};
				},
				update: updateCapture(() => {
					mutated = true;
				}),
			}),
		});

		await expect(
			relateEntitiesHandler({
				from_entity_id: FROM_ID,
				to_entity_id: TO_ID,
				relationship_type: "employed_by",
				valid_from: "2024-03-01T00:00:00.000Z",
				supersedes_relationship_id: OLD_EDGE_ID,
			} as any),
		).rejects.toThrow(/Superseded edge .* not found or does not belong to you/);

		expect(mutated).toBe(false);
	});
});

describe("batch person_match and entity_relate (#1978)", () => {
	const THIRD_ID = "33333333-3333-3333-3333-333333333333";

	it("peopleMatchHandler evaluates a batch of candidates with a single people scan and returns per-candidate ranked sections", async () => {
		const peopleRows = [
			{
				id: FROM_ID,
				name: "Anna Sharp",
				bio: null,
				role: "Designer",
				organization: "Studio",
				email: "anna@example.com",
				phone: null,
				relationship: "friend",
				last_contact: null,
				tags: [],
				archived: false,
				archived_at: null,
				properties: {},
				source_url: null,
				user_id: TEST_USER,
				team_id: null,
				created_at: null,
				updated_at: null,
				aliases: ["Anna"],
				hot: false,
			},
			{
				id: TO_ID,
				name: "Laura Sharp",
				bio: null,
				role: null,
				organization: null,
				email: null,
				phone: null,
				relationship: "partner",
				last_contact: null,
				tags: ["personal"],
				archived: false,
				archived_at: null,
				properties: {},
				source_url: null,
				user_id: TEST_USER,
				team_id: null,
				created_at: null,
				updated_at: null,
				aliases: ["Lara"],
				hot: true,
			},
		];

		let peopleScanCalls = 0;
		(supabase as any).from = vi.fn((table: string) => {
			if (table !== "people") throw new Error(`Unexpected table: ${table}`);
			peopleScanCalls += 1;
			const builder: any = {
				select: () => builder,
				order: () => builder,
				eq: () => builder,
				limit: () => Promise.resolve({ data: peopleRows, error: null }),
			};
			return builder;
		});

		const res = await peopleMatchHandler({
			candidates: [
				{ name: "Anna", email: "anna@example.com" },
				"Lara",
				{ name: "Unmatched Person" },
			],
		});

		expect(peopleScanCalls).toBe(1);
		const text = res.content[0].text;
		expect(text).toContain("### Anna\nMatch result: exact or near-exact match");
		expect(text).toContain(`Best candidate: [${FROM_ID}] Anna Sharp`);
		expect(text).toContain("### Lara\nMatch result: probable match");
		expect(text).toContain(`Best candidate: [${TO_ID}] Laura Sharp`);
		expect(text).toContain("### Unmatched Person\nNo candidates found.");
	});

	it("peopleMatchHandler throws when neither name nor candidates is provided", async () => {
		await expect(peopleMatchHandler({})).rejects.toThrow(
			/provide `name` or `candidates`/,
		);
	});

	it("relateEntitiesHandler processes a batch of relationships through single-edge validation/dedup and returns a consolidated summary", async () => {
		const insertedRows: Array<Record<string, unknown>> = [];
		const updatedRows: Array<Record<string, unknown>> = [];
		let dedupCall = 0;

		mockSupabaseFrom({
			entities: () => ({
				select: () => ({
					eq: () => ({
						in: () =>
							Promise.resolve({
								data: [{ id: FROM_ID }, { id: TO_ID }, { id: THIRD_ID }],
								error: null,
							}),
					}),
				}),
			}),
			entity_relationships: () => ({
				select: () => {
					dedupCall += 1;
					if (dedupCall === 1) {
						return dedupBuilder({ data: null, error: null });
					}
					return dedupBuilder({
						data: {
							id: "edge-existing-batch",
							archived: false,
							valid_from: null,
							valid_to: null,
							confidence_score: 60,
							metadata: { source: "prior" },
							notes: null,
						},
						error: null,
					});
				},
				insert: (row: Record<string, unknown>) => {
					insertedRows.push(row);
					return {
						select: () => ({
							single: () =>
								Promise.resolve({
									data: { id: "edge-created-batch" },
									error: null,
								}),
						}),
					};
				},
				update: updateCapture((payload) => updatedRows.push(payload)),
			}),
		});

		const res = await relateEntitiesHandler({
			relationships: [
				{
					from_entity_id: FROM_ID,
					to_entity_id: TO_ID,
					relationship_type: "spouseOf",
					confidence: 95,
				},
				{
					from_entity_id: FROM_ID,
					to_entity_id: THIRD_ID,
					relationship_type: "sister",
					confidence: 85,
					metadata: { artifact_id: "art-1" },
				},
			],
		});

		expect(insertedRows).toHaveLength(1);
		expect(insertedRows[0]).toMatchObject({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "spouseOf",
			confidence_score: 0.95,
		});

		expect(updatedRows).toHaveLength(1);
		expect(updatedRows[0]).toMatchObject({
			confidence_score: 0.85,
			metadata: { source: "prior", artifact_id: "art-1" },
		});

		const text = res.content[0].text;
		expect(text).toContain("Processed 2 relationship(s):");
		expect(text).toContain(
			`• Created edge edge-created-batch: ${FROM_ID} -[spouseOf]-> ${TO_ID}.`,
		);
		expect(text).toContain(
			`• Updated edge edge-existing-batch: ${FROM_ID} -[siblingOf]-> ${THIRD_ID}. (normalised from "sister")`,
		);
	});

	it("relateEntitiesHandler throws when neither single-edge fields nor relationships are provided", async () => {
		await expect(relateEntitiesHandler({})).rejects.toThrow(
			/provide from_entity_id, to_entity_id, and relationship_type, or a non-empty relationships array/,
		);
	});
});

describe("relateEntitiesHandler — confidence_score 0.0-1.0 scale unification (#1979)", () => {
	it("normalizeRelationshipConfidence preserves 0.0–1.0 values and divides legacy 1 < value <= 100 by 100", () => {
		expect(normalizeRelationshipConfidence(null)).toBeNull();
		expect(normalizeRelationshipConfidence(undefined)).toBeNull();
		expect(normalizeRelationshipConfidence(0)).toBe(0);
		expect(normalizeRelationshipConfidence(0.85)).toBe(0.85);
		expect(normalizeRelationshipConfidence(1)).toBe(1);
		expect(normalizeRelationshipConfidence(85)).toBe(0.85);
		expect(normalizeRelationshipConfidence(100)).toBe(1);
	});

	it("persists 0.0–1.0 confidence as-is on create (confidence: 0.85 -> confidence_score: 0.85)", async () => {
		let insertPayload: Record<string, unknown> | undefined;
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: null, error: null }),
				insert: (payload: Record<string, unknown>) => {
					insertPayload = payload;
					return {
						select: () => ({
							single: () => Promise.resolve({ data: { id: "edge-1979-1" }, error: null }),
						}),
					};
				},
			}),
		});

		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "friendOf",
			confidence: 0.85,
		} as any);

		expect(insertPayload).toMatchObject({
			confidence_score: 0.85,
		});
	});

	it("normalizes legacy 1 < confidence <= 100 inputs on create (confidence: 85 -> confidence_score: 0.85)", async () => {
		let insertPayload: Record<string, unknown> | undefined;
		mockSupabaseFrom({
			entities: endpointsOk,
			entity_relationships: () => ({
				select: () => dedupBuilder({ data: null, error: null }),
				insert: (payload: Record<string, unknown>) => {
					insertPayload = payload;
					return {
						select: () => ({
							single: () => Promise.resolve({ data: { id: "edge-1979-2" }, error: null }),
						}),
					};
				},
			}),
		});

		await relateEntitiesHandler({
			from_entity_id: FROM_ID,
			to_entity_id: TO_ID,
			relationship_type: "friendOf",
			confidence: 85,
		} as any);

		expect(insertPayload).toMatchObject({
			confidence_score: 0.85,
		});
	});

	it("normalizes a legacy stored confidence_score > 1 when preserving confidence on update", async () => {
		const updatePayload = await reassert(
			{ notes: "re-asserting without confidence" },
			{ ...WINDOWED_EDGE, confidence_score: 70 },
		);

		expect(updatePayload).toMatchObject({
			confidence_score: 0.7,
		});
	});
});
