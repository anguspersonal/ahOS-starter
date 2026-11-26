import { describe, expect, it, vi } from "vitest";
import { createGoogleCalendarAdapter } from "../../adapters/google/calendar/index.js";
import { createCalendarDeleteEventAction } from "./deleteEvent.js";
import { createCalendarGetEventAction } from "./getEvent.js";
import { createCalendarListEventsAction } from "./listEvents.js";
import { createCalendarRespondToEventAction } from "./respondToEvent.js";
import { createCalendarUpdateEventAction } from "./updateEvent.js";

const ctx = { caller: "test" as const, requestId: "r-align" };

function makeAdapter(
	handler: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
	return createGoogleCalendarAdapter({
		clientId: "cid",
		clientSecret: "csecret",
		refreshToken: async (d) => (d === "work" ? "rt-work" : "rt-angus"),
		fetchFn: vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			if (url.href === "https://oauth2.googleapis.com/token") {
				const token = String(init?.body ?? "").includes("rt-work")
					? "at-work"
					: "at-angus";
				return new Response(JSON.stringify({ access_token: token }), { status: 200 });
			}
			return handler(url, init);
		}),
	});
}

function wireEvent(id: string, start: string, end: string, etag = `"etag-${id}"`) {
	return {
		id,
		etag,
		summary: `Event ${id}`,
		description: "Private description with email@example.com",
		start: { dateTime: start },
		end: { dateTime: end },
		organizer: { email: "org@example.com" },
		attendees: [
			{ email: "me@work.example.com", self: true, responseStatus: "accepted" },
			{ email: "guest@example.com", self: false, responseStatus: "needsAction" },
		],
	};
}

describe("calendar alignment (#1652)", () => {
	it("1. reports truncated_accounts and last start time when nextPageToken is present", async () => {
		const port = makeAdapter((_url, init) => {
			const isWork = new Headers(init?.headers).get("Authorization") === "Bearer at-work";
			if (isWork) {
				const items = [1, 2, 3].map((i) =>
					wireEvent(`h${i}`, `2026-09-07T0${i}:00:00Z`, `2026-09-07T0${i}:30:00Z`),
				);
				return new Response(JSON.stringify({ items }), { status: 200 });
			}
			const items = Array.from({ length: 25 }, (_, idx) => {
				const hh = String(idx).padStart(2, "0");
				return wireEvent(`p${idx}`, `2026-09-07T${hh}:00:00Z`, `2026-09-07T${hh}:30:00Z`);
			});
			return new Response(JSON.stringify({ items, nextPageToken: "tok-2" }), { status: 200 });
		});

		const action = createCalendarListEventsAction(port);
		const out = await action.run(
			{ time_min: "2026-09-07T00:00:00Z", time_max: "2026-09-08T00:00:00Z" },
			ctx,
		);

		expect(out.truncated_accounts).toEqual(["personal"]);
		const text = action.formatMcp!(out);
		expect(text).toContain(
			"more events in personal after 2026-09-07T24:00:00Z; narrow the window or raise max_results",
		);
		expect(JSON.stringify(out.receipt)).not.toContain("@");
	});

	it("2 & 3. sends If-Match when etag is passed, omits it when absent, and maps 412", async () => {
		const seenIfMatch: Array<string | null> = [];
		let nextStatus = 200;
		const port = makeAdapter((_url, init) => {
			seenIfMatch.push(new Headers(init?.headers).get("If-Match"));
			if (nextStatus === 412) {
				return new Response(JSON.stringify({ error: { code: 412 } }), { status: 412 });
			}
			return new Response(JSON.stringify(wireEvent("e1", "2026-09-07T09:00:00Z", "2026-09-07T10:00:00Z")), {
				status: 200,
			});
		});

		const update = createCalendarUpdateEventAction(port);
		await update.run({ domain: "angus", event_id: "e1", summary: "New", etag: '"abc"' }, ctx);
		await update.run({ domain: "angus", event_id: "e1", summary: "New2" }, ctx);
		expect(seenIfMatch).toEqual(['"abc"', null]);

		nextStatus = 412;
		await expect(
			update.run({ domain: "angus", event_id: "e1", summary: "Stale", etag: '"abc"' }, ctx),
		).rejects.toThrow("the event changed since you read it; re-read with calendar_get_event");
	});

	it("4. retries 429 on list read and never retries 429 on delete write", async () => {
		let listCalls = 0;
		let deleteCalls = 0;
		const port = makeAdapter((url, init) => {
			const method = init?.method ?? "GET";
			if (method === "DELETE") {
				deleteCalls++;
				return new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 });
			}
			if (url.pathname.endsWith("/events")) {
				listCalls++;
				if (listCalls === 1) {
					return new Response(JSON.stringify({ error: { code: 429 } }), { status: 429 });
				}
				return new Response(
					JSON.stringify({ items: [wireEvent("e1", "2026-09-07T09:00:00Z", "2026-09-07T10:00:00Z")] }),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify(wireEvent("e1", "2026-09-07T09:00:00Z", "2026-09-07T10:00:00Z")), {
				status: 200,
			});
		});

		const listAction = createCalendarListEventsAction(port);
		const listOut = await listAction.run({ domain: "angus" }, ctx);
		expect(listCalls).toBe(2);
		expect(listOut.events).toHaveLength(1);

		const deleteAction = createCalendarDeleteEventAction(port);
		await expect(deleteAction.run({ domain: "angus", event_id: "e1" }, { ...ctx, caller: "ui" })).rejects.toMatchObject({
			status: 429,
		});
		expect(deleteCalls).toBe(1);
	});

	it("5. returns structured receipts without '@' across get, update, respond, and delete", async () => {
		const port = makeAdapter((_url, init) => {
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			return new Response(JSON.stringify(wireEvent("e1", "2026-09-07T09:00:00Z", "2026-09-07T10:00:00Z")), {
				status: 200,
			});
		});

		const getOut = await createCalendarGetEventAction(port).run({ domain: "work", event_id: "e1" }, ctx);
		const updOut = await createCalendarUpdateEventAction(port).run(
			{ domain: "work", event_id: "e1", summary: "Updated" },
			ctx,
		);
		const rsvpOut = await createCalendarRespondToEventAction(port).run(
			{ domain: "work", event_id: "e1", response: "accepted" },
			ctx,
		);
		const delOut = await createCalendarDeleteEventAction(port).run(
			{ domain: "work", event_id: "e1" },
			{ ...ctx, caller: "ui" },
		);

		for (const receipt of [getOut.receipt, updOut.receipt, rsvpOut.receipt, delOut.receipt]) {
			expect(receipt.account).toBe("work");
			expect(receipt.event_ids).toEqual(["e1"]);
			expect(receipt.count).toBe(1);
			expect(JSON.stringify(receipt)).not.toContain("@");
		}
	});
});
