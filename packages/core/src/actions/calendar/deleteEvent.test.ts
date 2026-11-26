import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CalendarApiError,
	type CalendarPort,
	type ParsedEvent,
} from "../../ports/calendar.js";
import { executeAction } from "../adapters/direct.js";
import { actionResolver, executeApproved } from "../approvals.js";
import {
	PendingApprovalError,
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "../gate.js";
import { createCalendarDeleteEventAction } from "./deleteEvent.js";

function makeEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
	return {
		id: "e1",
		summary: "Standup",
		start: "2026-09-07T09:30:00Z",
		end: "2026-09-07T09:45:00Z",
		allDay: false,
		location: "",
		description: "",
		organizer: "owner@example.com",
		attendees: [],
		myResponse: "",
		status: "confirmed",
		htmlLink: "https://calendar.google.com/event?eid=e1",
		recurringEventId: "",
		account: "personal",
		...overrides,
	};
}

function makeCalendarPort(overrides: Partial<CalendarPort> = {}): CalendarPort {
	return {
		listEvents: vi.fn(),
		getEvent: vi.fn(async () => makeEvent()),
		createEvent: vi.fn(),
		updateEvent: vi.fn(),
		deleteEvent: vi.fn(async () => true),
		respondToEvent: vi.fn(),
		...overrides,
	};
}

function makeApprovalStore() {
	const parked: ApprovalRequest[] = [];
	const store: ActionApprovalLifecycleStore = {
		park: vi.fn(async (req: ApprovalRequest) => {
			parked.push(req);
			return { decisionId: `dec-${parked.length}` };
		}),
		claim: vi.fn(async (decisionId: string) => {
			const req = parked[Number(decisionId.replace("dec-", "")) - 1];
			return req
				? {
						decisionId,
						actionId: req.actionId,
						input: req.input,
						inputSha256: req.inputSha256,
						caller: req.caller,
						userId: req.userId ?? "u-1",
					}
				: null;
		}),
		finish: vi.fn(async () => {}),
		reject: vi.fn(async () => true),
	};
	return { store, parked };
}

describe("calendar_delete_event core action (#1585)", () => {
	const owners = async () => new Set(["owner@example.com", "owner@work.example.com"]);

	afterEach(() => {
		setActionApprovalStore(undefined);
		vi.restoreAllMocks();
	});

	it("allows solo, self-only, and owner-address events without parking and defaults calendar_id to 'primary'", async () => {
		const { store, parked } = makeApprovalStore();
		setActionApprovalStore(store);

		const order: string[] = [];
		const getEvent = vi.fn<CalendarPort["getEvent"]>(async () => {
			order.push("getEvent");
			return makeEvent({ summary: "Budget review" });
		});
		const deleteEvent = vi.fn<CalendarPort["deleteEvent"]>(async () => {
			order.push("deleteEvent");
			return true;
		});
		const ownerFn = vi.fn(owners);

		const action = createCalendarDeleteEventAction({
			calendar: makeCalendarPort({ getEvent, deleteEvent }),
			ownerAddresses: ownerFn,
		});

		const soloOut = await executeAction(
			action,
			{ account: "personal", event_id: "e1" },
			{ context: { caller: "mcp", userId: "u-1" } },
		);
		expect(parked).toHaveLength(0);
		expect(ownerFn).not.toHaveBeenCalled();
		expect(order).toEqual(["getEvent", "getEvent", "deleteEvent"]);
		expect(getEvent).toHaveBeenCalledWith({
			domain: "angus",
			calendarId: "primary",
			eventId: "e1",
		});
		expect(deleteEvent).toHaveBeenCalledWith({
			domain: "angus",
			calendarId: "primary",
			eventId: "e1",
			notify: "all",
		});
		expect(action.formatMcp!(soloOut)).toBe(
			"Deleted 'Budget review' [personal], which was 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z.",
		);

		getEvent.mockResolvedValue(
			makeEvent({
				attendees: [{ email: "owner@example.com", responseStatus: "accepted", self: true }],
			}),
		);
		await executeAction(
			action,
			{ account: "personal", calendar_id: "work", event_id: "e2" },
			{ context: { caller: "mcp", userId: "u-1" } },
		);
		expect(parked).toHaveLength(0);
		expect(getEvent).toHaveBeenCalledWith({
			domain: "angus",
			calendarId: "work",
			eventId: "e2",
		});

		getEvent.mockResolvedValue(
			makeEvent({
				account: "work",
				allDay: true,
				start: "2026-09-08",
				end: "2026-09-09",
				summary: "Focus block",
				attendees: [
					{ email: "owner@work.example.com", responseStatus: "accepted", self: true },
					{ email: "owner@example.com", responseStatus: "accepted", self: false },
				],
			}),
		);
		const ownerOtherOut = await executeAction(
			action,
			{ domain: "work", event_id: "e3", notify_attendees: "none" },
			{ context: { caller: "mcp", userId: "u-1" } },
		);
		expect(parked).toHaveLength(0);
		expect(ownerFn).toHaveBeenCalledTimes(1);
		expect(action.formatMcp!(ownerOtherOut)).toBe(
			[
				"Deleted 'Focus block' [work], which was on 2026-09-08.",
				"2 attendees, notified: none.",
			].join("\n"),
		);
	});

	it("parks external guests, missing ownerAddresses, missing domain, and throwing reads/ownerAddresses, then executes when approved", async () => {
		const { store, parked } = makeApprovalStore();
		setActionApprovalStore(store);

		const getEvent = vi.fn<CalendarPort["getEvent"]>();
		const deleteEvent = vi.fn<CalendarPort["deleteEvent"]>(async () => true);
		const ownerFn = vi.fn(owners);
		const calendar = makeCalendarPort({ getEvent, deleteEvent });
		const action = createCalendarDeleteEventAction({
			calendar,
			ownerAddresses: ownerFn,
		});

		getEvent.mockResolvedValueOnce(
			makeEvent({
				attendees: [{ email: "guest@example.com", responseStatus: "accepted", self: false }],
			}),
		);
		await expect(
			executeAction(
				action,
				{ account: "personal", event_id: "evt-1" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(PendingApprovalError);

		getEvent.mockRejectedValueOnce(
			new CalendarApiError("Calendar GET failed (404)", 404, "notFound", "NOT_FOUND"),
		);
		await expect(
			executeAction(
				action,
				{ account: "personal", event_id: "evt-missing" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(PendingApprovalError);

		getEvent.mockResolvedValueOnce(
			makeEvent({
				attendees: [{ email: "owner@work.example.com", responseStatus: "accepted", self: false }],
			}),
		);
		ownerFn.mockRejectedValueOnce(new Error("gmail profile down"));
		await expect(
			executeAction(
				action,
				{ account: "personal", event_id: "evt-1" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(PendingApprovalError);

		const noOwnerResolverAction = createCalendarDeleteEventAction({ calendar });
		getEvent.mockResolvedValueOnce(
			makeEvent({
				attendees: [{ email: "owner@work.example.com", responseStatus: "accepted", self: false }],
			}),
		);
		await expect(
			executeAction(
				noOwnerResolverAction,
				{ account: "personal", event_id: "evt-1" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(PendingApprovalError);

		await expect(
			executeAction(
				action,
				{ event_id: "evt-1" },
				{ context: { caller: "mcp", userId: "u-1" } },
			),
		).rejects.toThrow(PendingApprovalError);

		expect(deleteEvent).not.toHaveBeenCalled();
		expect(parked).toHaveLength(5);

		getEvent.mockResolvedValueOnce(
			makeEvent({
				summary: "Partner sync",
				attendees: [
					{ email: "owner@example.com", responseStatus: "accepted", self: true },
					{ email: "guest@example.com", responseStatus: "accepted", self: false },
				],
			}),
		);
		const replay = await executeApproved("dec-1", {
			store,
			resolve: actionResolver((id) => (id === "calendar_delete_event" ? action : undefined)),
			approvedBy: { userId: "u-1", via: "web_inbox" },
		});
		expect(replay.status).toBe("executed");
		expect(deleteEvent).toHaveBeenCalledWith({
			domain: "angus",
			calendarId: "primary",
			eventId: "evt-1",
			notify: "all",
		});
	});

	it("skips approval for caller 'ui', formats already-deleted and recurring series notes identically to dev, and preserves CalendarApiError", async () => {
		const getEvent = vi.fn<CalendarPort["getEvent"]>(async () =>
			makeEvent({
				summary: "Standup",
				recurringEventId: "series_1",
				attendees: [
					{ email: "owner@example.com", responseStatus: "accepted", self: true },
					{ email: "guest@example.com", responseStatus: "accepted", self: false },
				],
			}),
		);
		const deleteEvent = vi
			.fn<CalendarPort["deleteEvent"]>()
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);

		const action = createCalendarDeleteEventAction({
			calendar: makeCalendarPort({ getEvent, deleteEvent }),
			ownerAddresses: owners,
		});

		const recurringOut = await executeAction(
			action,
			{ account: "personal", event_id: "e1_20260907" },
			{ context: { caller: "ui", userId: "u-1" } },
		);
		expect(action.formatMcp!(recurringOut)).toBe(
			[
				"Deleted 'Standup' [personal], which was 2026-09-07T09:30:00Z to 2026-09-07T09:45:00Z.",
				"2 attendees, notified: all.",
				"NOTE: this deleted ONE occurrence of recurring series series_1. The rest of the series still exists; delete 'series_1' to cancel all of it.",
			].join("\n"),
		);

		const alreadyDeletedOut = await executeAction(
			action,
			{ account: "personal", event_id: "e1_20260907" },
			{ context: { caller: "ui", userId: "u-1" } },
		);
		expect(action.formatMcp!(alreadyDeletedOut)).toBe(
			"'Standup' was already deleted; nothing to do.",
		);

		await expect(
			executeAction(action, { event_id: "e1" }, { context: { caller: "ui" } }),
		).rejects.toThrow(
			"`domain` is required to send \u2014 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);

		getEvent.mockRejectedValueOnce(
			new CalendarApiError("Calendar GET failed (404)", 404, "notFound", "NOT_FOUND"),
		);
		deleteEvent.mockClear();
		await expect(
			executeAction(
				action,
				{ domain: "angus", event_id: "missing" },
				{ context: { caller: "ui" } },
			),
		).rejects.toMatchObject({
			name: "CalendarApiError",
			status: 404,
			reason: "notFound",
		});
		expect(deleteEvent).not.toHaveBeenCalled();
	});
});
