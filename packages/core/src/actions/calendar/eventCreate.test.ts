import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";
import { interruptedClaimMessage } from "../../adapters/supabase/externalLinks.js";
import {
	createEventCreateAction,
	createEventInput,
	type EventCreatePorts,
	resolveEventTimes,
} from "./eventCreate.js";

const createCalendarEvent = vi.fn(async () => ({
	id: "evt_1",
	htmlLink: "https://calendar.google.com/event?eid=evt_1",
}));

let activePorts: EventCreatePorts;

const createEventHandler = async (args: Record<string, unknown>) => {
	const action = createEventCreateAction(activePorts);
	const out = await action.run(args as any, {} as any);
	return { content: [{ text: action.formatMcp!(out) as string }] };
};

afterEach(() => {
	vi.clearAllMocks();
});

const CALENDAR_CONFIG = { calendar_id: "primary" };

function stubIntegrationsAndLinks(opts: {
	calendarConfig?: Record<string, unknown>;
	/** Finalized rows (real event ids) the dedup pre-check should see: a real duplicate. */
	existingLinkCount?: number;
	/** Rows still at `external_id='__pending__'`: an unfinished claim, NOT a duplicate (#653). */
	pendingLinkCount?: number;
	claimError?: { code: string; message?: string };
}) {
	const upsertCalls: Array<Record<string, unknown>> = [];
	const insertCalls: Array<Record<string, unknown>> = [];
	const updateCalls: Array<{ id: string; row: Record<string, unknown> }> = [];
	const deleteCalls: Array<Array<[string, unknown]>> = [];
	const artifactInserts: Array<Record<string, unknown>> = [];
	let claimedRowId = 0;

	activePorts = {
		calendar: {
			createEvent: createCalendarEvent,
		},
		artifacts: {
			insert: async (row) => {
				artifactInserts.push(row as unknown as Record<string, unknown>);
			},
		},
		storage: {
			upload: async () => {},
			remove: async () => {},
			publicUrl: (bucket, path) => `https://storage.test/${bucket}/${path}`,
		},
		externalLinks: {
			inspectDedupSlot: async () =>
				opts.existingLinkCount ? "linked" : opts.pendingLinkCount ? "pending" : "free",
			claimDedupSlot: async (artifactId, provider, kind, dedupKey) => {
				insertCalls.push({
					artifact_id: artifactId,
					provider,
					kind,
					dedup_key: dedupKey ?? "__single_event__",
					external_id: "__pending__",
				});
				if (opts.claimError) {
					return opts.claimError.code === "23505"
						? { claimed: false, reason: "conflict" }
						: {
								claimed: false,
								reason: "error",
								error: opts.claimError.message ?? "insert failed",
							};
				}
				claimedRowId += 1;
				return { claimed: true, linkId: `claim-${claimedRowId}` };
			},
			finalizeExternalLink: async (linkId, externalId, externalUrl) => {
				updateCalls.push({
					id: linkId,
					row: { external_id: externalId, external_url: externalUrl },
				});
				return { ok: true };
			},
			recordExternalLink: async (artifactId, link) => {
				upsertCalls.push({ artifact_id: artifactId, ...link });
				return { ok: true };
			},
			releaseClaimForFailedWrite: async (claimedLinkId, error) => {
				if (claimedLinkId) {
					deleteCalls.push([
						["id", claimedLinkId],
						["external_id", "__pending__"],
					]);
				}
				return error;
			},
			interruptedClaimMessage,
		},
		resolveTargetCalendar: async () =>
			opts.calendarConfig ? ((opts.calendarConfig.calendar_id as string) ?? "primary") : null,
	};

	return {
		upsertCalls,
		insertCalls,
		updateCalls,
		deleteCalls,
		artifactInserts,
	};
}

describe("createEventHandler", () => {
	it("creates a Calendar event and records lineage with kind='event'/provider='google_calendar'", async () => {
		const { upsertCalls } = stubIntegrationsAndLinks({
			calendarConfig: CALENDAR_CONFIG,
			existingLinkCount: 0,
		});

		const out = await createEventHandler({
			title: "Team sync",
			start: "2026-07-10T14:00:00Z",
			artifact_id: "11111111-1111-1111-1111-111111111111",
		});

		expect(out.content[0].text).toContain("Created Calendar event: Team sync");
		expect(out.content[0].text).toContain(
			"https://calendar.google.com/event?eid=evt_1",
		);
		expect(createCalendarEvent).toHaveBeenCalledWith(
			expect.objectContaining({ calendarId: "primary", summary: "Team sync" }),
		);
		expect(upsertCalls).toHaveLength(1);
		expect(upsertCalls[0]).toMatchObject({
			kind: "event",
			provider: "google_calendar",
			external_id: "evt_1",
			artifact_id: "11111111-1111-1111-1111-111111111111",
		});
	});

	it("single_event + no existing link: claims the dedup slot (single-event sentinel) BEFORE calling Calendar, then finalizes it with the real event id", async () => {
		const { insertCalls, updateCalls } = stubIntegrationsAndLinks({
			calendarConfig: CALENDAR_CONFIG,
			existingLinkCount: 0,
		});

		const out = await createEventHandler({
			title: "Dentist appointment",
			start: "2026-07-10T14:00:00Z",
			artifact_id: "11111111-1111-1111-1111-111111111111",
			single_event: true,
		});

		expect(out.content[0].text).toContain("Created Calendar event");
		expect(insertCalls).toHaveLength(1);
		expect(insertCalls[0]).toMatchObject({
			artifact_id: "11111111-1111-1111-1111-111111111111",
			provider: "google_calendar",
			kind: "event",
			dedup_key: "__single_event__",
			external_id: "__pending__",
		});
		expect(updateCalls).toHaveLength(1);
		expect(updateCalls[0].row).toMatchObject({
			external_id: "evt_1",
			external_url: "https://calendar.google.com/event?eid=evt_1",
		});
	});

	it("single_event + an existing kind='event' link: skips creation, reports skipped, never calls Calendar", async () => {
		stubIntegrationsAndLinks({ calendarConfig: CALENDAR_CONFIG, existingLinkCount: 1 });

		const out = await createEventHandler({
			title: "Dentist appointment",
			start: "2026-07-10T14:00:00Z",
			artifact_id: "11111111-1111-1111-1111-111111111111",
			single_event: true,
		});

		expect(out.content[0].text).toMatch(/^Skipped:/);
		expect(out.content[0].text).toContain("already linked");
		expect(out.content[0].text).toContain("skipped as duplicate (single_event)");
		expect(createCalendarEvent).not.toHaveBeenCalled();
	});

	it("dedup_key + no existing link with that key: claims the slot under that key, then finalizes", async () => {
		const { insertCalls, updateCalls } = stubIntegrationsAndLinks({
			calendarConfig: CALENDAR_CONFIG,
			existingLinkCount: 0,
		});

		const out = await createEventHandler({
			title: "Standup",
			start: "2026-07-10T09:00:00Z",
			artifact_id: "22222222-2222-2222-2222-222222222222",
			dedup_key: "standup-2026-07-10",
		});

		expect(out.content[0].text).toContain("Created Calendar event");
		expect(insertCalls[0]).toMatchObject({ dedup_key: "standup-2026-07-10" });
		expect(updateCalls).toHaveLength(1);
	});

	it("dedup_key + a link already exists with that exact key: skips creation, no single_event phrase", async () => {
		stubIntegrationsAndLinks({ calendarConfig: CALENDAR_CONFIG, existingLinkCount: 1 });

		const out = await createEventHandler({
			title: "Standup",
			start: "2026-07-10T09:00:00Z",
			artifact_id: "22222222-2222-2222-2222-222222222222",
			dedup_key: "standup-2026-07-10",
		});

		expect(out.content[0].text).toMatch(/^Skipped:/);
		expect(out.content[0].text).toContain("dedup_key 'standup-2026-07-10'");
		expect(out.content[0].text).not.toContain("single_event");
		expect(createCalendarEvent).not.toHaveBeenCalled();
	});

	describe("concurrent dedup races (claimDedupSlot conflict handling)", () => {
		it("single_event: a 23505 on the claim (lost the race) is reported as a skipped duplicate, Calendar never called", async () => {
			stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
				existingLinkCount: 0,
				claimError: {
					code: "23505",
					message: "duplicate key value violates unique constraint",
				},
			});

			const out = await createEventHandler({
				title: "Dentist appointment",
				start: "2026-07-10T14:00:00Z",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_event: true,
			});

			expect(out.content[0].text).toMatch(/^Skipped:/);
			expect(out.content[0].text).toContain("lost a concurrent dedup race");
			expect(out.content[0].text).toContain("skipped as duplicate (single_event)");
			expect(createCalendarEvent).not.toHaveBeenCalled();
		});

		it("a non-conflict claim error (e.g. migration 064 not applied) degrades to the best-effort upsert path instead of blocking creation", async () => {
			const { upsertCalls, updateCalls } = stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
				existingLinkCount: 0,
				claimError: { code: "42P01", message: "relation does not exist" },
			});

			const out = await createEventHandler({
				title: "Dentist appointment",
				start: "2026-07-10T14:00:00Z",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_event: true,
			});

			expect(out.content[0].text).toContain("Created Calendar event");
			expect(upsertCalls).toHaveLength(1);
			expect(updateCalls).toHaveLength(0);
		});
	});

	// Issue #653 was reported against task_create, but createEvent.ts drives the same
	// claim lifecycle from links.ts and had the same defect: a failed create left a
	// `__pending__` row that blocked every retry. Fixed in both; asserted in both, since
	// "it mirrors createTask" is a comment, not a guarantee.
	describe("a failed create must not leave a blocking claim (issue #653)", () => {
		it("releases the claim when the Calendar create throws", async () => {
			const { insertCalls, updateCalls, deleteCalls } = stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
				existingLinkCount: 0,
			});
			vi.mocked(createCalendarEvent).mockRejectedValueOnce(
				new Error("Calendar create failed (403): insufficient permissions"),
			);

			await expect(
				createEventHandler({
					title: "Dentist appointment",
					start: "2026-07-10T14:00:00Z",
					artifact_id: "11111111-1111-1111-1111-111111111111",
					single_event: true,
				}),
			).rejects.toThrow(/Calendar create failed \(403\)/);

			expect(insertCalls).toHaveLength(1);
			expect(updateCalls).toHaveLength(0);
			expect(deleteCalls).toEqual([
				[
					["id", "claim-1"],
					["external_id", "__pending__"],
				],
			]);
		});

		it("reports an unfinished claim as blocked, not as a duplicate, and never calls Calendar", async () => {
			stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
				existingLinkCount: 0,
				pendingLinkCount: 1,
			});

			const out = await createEventHandler({
				title: "Dentist appointment",
				start: "2026-07-10T14:00:00Z",
				artifact_id: "11111111-1111-1111-1111-111111111111",
				single_event: true,
			});

			expect(out.content[0].text).toMatch(/^Blocked:/);
			expect(out.content[0].text).toContain("NOT a duplicate skip");
			expect(out.content[0].text).toContain("kind = 'event'");
			expect(out.content[0].text).not.toContain("already linked");
			expect(createCalendarEvent).not.toHaveBeenCalled();
		});
	});

	describe("provenance auto-capture (mirrors #413)", () => {
		it("no artifact_id: auto-captures an event_request provenance artifact and links the event to it", async () => {
			const { artifactInserts, upsertCalls } = stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
			});

			const out = await createEventHandler({
				title: "Dentist appointment",
				start: "2026-07-10T14:00:00Z",
				source_text: "put dentist on the calendar for next week",
			});

			expect(artifactInserts).toHaveLength(1);
			expect(artifactInserts[0].content_subtype).toBe("event_request");
			expect(artifactInserts[0].plain_text).toBe(
				"put dentist on the calendar for next week",
			);

			expect(upsertCalls).toHaveLength(1);
			expect(upsertCalls[0].kind).toBe("event");
			expect(upsertCalls[0].artifact_id).toBe(artifactInserts[0].id);
			expect(upsertCalls[0].external_id).toBe("evt_1");

			expect(out.content[0].text).toContain("Created Calendar event");
			expect(out.content[0].text).toContain("Source captured as artifact");
			expect(out.content[0].text).toContain("content_subtype='event_request'");
		});

		it("falls back to the title as the captured source when source_text is omitted", async () => {
			const { artifactInserts } = stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
			});

			await createEventHandler({
				title: "Call the vet",
				start: "2026-07-10T14:00:00Z",
			});

			expect(artifactInserts).toHaveLength(1);
			expect(artifactInserts[0].plain_text).toBe("Call the vet");
			expect(artifactInserts[0].content_subtype).toBe("event_request");
		});

		it("stamps surface='act_receipt' on the receipt, never null (#584)", async () => {
			// The receipt has no EXTERNAL surface to copy — nobody sent this row in —
			// but "a receipt this system wrote" is itself an envelope fact, and a
			// nameable one. Left null, the whole class was unaddressable: ADR-046 §3
			// keys the role ladder on this column, so the owner could not demote
			// receipts out of narrative without also demoting every other unstamped
			// path. `act_receipt` is deliberately shared with task_create, whose twin
			// of this function carries the same stamp as of #736.
			const { artifactInserts } = stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
			});

			await createEventHandler({
				title: "Renew passport",
				start: "2026-07-10T14:00:00Z",
			});

			expect(artifactInserts[0].surface).toBe(ARTIFACT_SURFACES.actReceipt);
			expect(artifactInserts[0].surface).not.toBeNull();
		});

		it("stamps tags=['account:personal'] when account resolves to personal and never stamps a domain: tag (#2225)", async () => {
			const { artifactInserts } = stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
			});

			await createEventHandler({
				title: "Dentist appointment",
				start: "2026-07-10T14:00:00Z",
				domain: "angus",
			});

			expect(artifactInserts).toHaveLength(1);
			expect(artifactInserts[0].content_subtype).toBe("event_request");
			expect(artifactInserts[0].tags).toEqual(["account:personal"]);
			expect(
				(artifactInserts[0].tags as string[]).some((t) => t.startsWith("domain:")),
			).toBe(false);
		});

		it("stamps tags=['account:work'] when account resolves to work and never stamps a domain: tag (#2225)", async () => {
			const { artifactInserts } = stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
			});

			await createEventHandler({
				title: "Board prep",
				start: "2026-07-10T14:00:00Z",
				account: "work",
			});

			expect(artifactInserts).toHaveLength(1);
			expect(artifactInserts[0].content_subtype).toBe("event_request");
			expect(artifactInserts[0].tags).toEqual(["account:work"]);
			expect(
				(artifactInserts[0].tags as string[]).some((t) => t.startsWith("domain:")),
			).toBe(false);
		});

		it("with artifact_id: nothing auto-captured", async () => {
			const { artifactInserts, upsertCalls } = stubIntegrationsAndLinks({
				calendarConfig: CALENDAR_CONFIG,
			});

			const out = await createEventHandler({
				title: "Follow up",
				start: "2026-07-10T14:00:00Z",
				artifact_id: "11111111-1111-1111-1111-111111111111",
			});

			expect(artifactInserts).toHaveLength(0);
			expect(upsertCalls).toHaveLength(1);
			expect(upsertCalls[0].artifact_id).toBe(
				"11111111-1111-1111-1111-111111111111",
			);
			expect(out.content[0].text).not.toContain("Source captured as artifact");
		});
	});

	it("throws naming the provider and integration_set when google_calendar is unconfigured", async () => {
		stubIntegrationsAndLinks({ calendarConfig: undefined });

		await expect(
			createEventHandler({ title: "Dentist appointment", start: "2026-07-10T14:00:00Z" }),
		).rejects.toThrow(
			/No Google Calendar integration configured.*integration_set/s,
		);
		expect(createCalendarEvent).not.toHaveBeenCalled();
	});

	it("throws when the calendar resolver port is not wired", async () => {
		stubIntegrationsAndLinks({ calendarConfig: CALENDAR_CONFIG });
		activePorts = { ...activePorts, resolveTargetCalendar: undefined };

		await expect(
			createEventHandler({ title: "Dentist appointment", start: "2026-07-10T14:00:00Z" }),
		).rejects.toThrow(/Calendar resolver port is not wired/);
		expect(createCalendarEvent).not.toHaveBeenCalled();
	});
});

describe("createEventInput schema", () => {
	const schema = z.object(createEventInput);
	const base = { title: "Team sync", start: "2026-07-10T14:00:00Z" };

	it("rejects a malformed attendee email", () => {
		const result = schema.safeParse({ ...base, attendees: ["not-an-email"] });
		expect(result.success).toBe(false);
	});

	it("accepts well-formed attendee emails", () => {
		const result = schema.safeParse({ ...base, attendees: ["a@example.com"] });
		expect(result.success).toBe(true);
	});
});

describe("resolveEventTimes", () => {
	it("defaults a timed start (no end) to start + 1 hour", () => {
		expect(resolveEventTimes("2026-07-10T14:00:00.000Z", undefined)).toEqual({
			start: { dateTime: "2026-07-10T14:00:00.000Z" },
			end: { dateTime: "2026-07-10T15:00:00.000Z" },
		});
	});

	it("passes an explicit timed end through unchanged", () => {
		expect(
			resolveEventTimes("2026-07-10T14:00:00Z", "2026-07-10T16:30:00Z"),
		).toEqual({
			start: { dateTime: "2026-07-10T14:00:00Z" },
			end: { dateTime: "2026-07-10T16:30:00Z" },
		});
	});

	it("treats a bare 'YYYY-MM-DD' start as all-day, defaulting end to the next day", () => {
		expect(resolveEventTimes("2026-07-10", undefined)).toEqual({
			start: { date: "2026-07-10" },
			end: { date: "2026-07-11" },
		});
	});

	it("passes an explicit all-day end date through unchanged", () => {
		expect(resolveEventTimes("2026-07-10", "2026-07-14")).toEqual({
			start: { date: "2026-07-10" },
			end: { date: "2026-07-14" },
		});
	});
});
