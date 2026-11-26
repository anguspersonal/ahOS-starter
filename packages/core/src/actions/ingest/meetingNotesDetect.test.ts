import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
	DEFAULT_MEETING_NOTE_SOURCES,
	type MeetingNoteSource,
} from "../../domain/ingest/meetingNoteEmails.js";
import type {
	ConfigRepository,
	MeetingNoteSourcesOrigin,
} from "../../ports/config.js";
import type { GmailPort, ParsedMessage } from "../../ports/gmail.js";
import {
	createIngestMeetingNotesDetectAction,
	INGEST_MEETING_NOTES_DETECT_DESCRIPTION,
} from "./meetingNotesDetect.js";

const ctx = { caller: "test", requestId: "r1", userId: "user-1" };

const LEGACY_JSON_SCHEMA_SNAPSHOT = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	properties: {
		newer_than: {
			description:
				"Gmail relative age bound, e.g. '2d', '7d', '1m'. Defaults to '7d'. Keeps a sweep from walking the whole mailbox.",
			type: "string",
			pattern: "^\\d+[dhmy]$",
		},
		unread_only: {
			description: "Only consider unread messages (default false).",
			type: "boolean",
		},
		exclude_label: {
			description:
				"Skip messages already carrying this label name, e.g. 'meeting_note'. This is what makes a repeated sweep idempotent.",
			type: "string",
		},
		max_results: {
			description: "Max messages to examine (default 10).",
			type: "integer",
			minimum: 1,
			maximum: 50,
		},
		account: {
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
			type: "string",
			enum: ["personal", "work"],
		},
		domain: {
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
			type: "string",
			enum: ["work", "angus"],
		},
	},
	additionalProperties: false,
};

function makeMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
	return {
		id: "msg-1",
		threadId: "thread-1",
		from: "Gemini <gemini-notes@example.com>",
		to: "owner@example.com",
		subject: "Notes: “Work Team Weekly” Aug 24, 2026",
		date: "Mon, 24 Aug 2026 10:00:00 +0000",
		labelIds: ["INBOX", "UNREAD"],
		snippet: "Meeting notes",
		body: "Open notes: https://docs.google.com/document/d/1aAvc6TQF4L591MeQUWebugyIK0v/edit",
		links: [],
		attachments: [],
		...overrides,
	};
}

function makeDeps(opts: {
	messages?: ParsedMessage[];
	sources?: MeetingNoteSource[];
	origin?: MeetingNoteSourcesOrigin;
} = {}) {
	const gmail: Pick<GmailPort, "searchMessages"> = {
		searchMessages: vi.fn(async () => opts.messages ?? []),
	};
	const config: Pick<ConfigRepository, "meetingNoteSources"> = {
		meetingNoteSources: vi.fn(async () => ({
			sources: opts.sources ?? DEFAULT_MEETING_NOTE_SOURCES,
			origin: opts.origin ?? "default",
		})),
	};
	return { gmail, config };
}

describe("createIngestMeetingNotesDetectAction (#1538)", () => {
	it("1. Contract parity: id, JSON schema snapshot, description, annotations, and default surface exposure", () => {
		const { gmail, config } = makeDeps();
		const action = createIngestMeetingNotesDetectAction({ gmail, config });

		expect(action.id).toBe("ingest_meeting_notes_detect");
		expect(z.toJSONSchema(action.schema)).toEqual(LEGACY_JSON_SCHEMA_SNAPSHOT);
		expect(action.description).toBe(
			"Find meeting-note emails in a mailbox using the configured sender/subject detection rules (Google Meet / Gemini today), and report the meeting title and Google Doc links recovered from each. Read-only: label and capture are separate calls. Use domain='work' for the work.example.com mailbox.",
		);
		expect(action.description).toBe(INGEST_MEETING_NOTES_DETECT_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(action.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("2. Search query uses buildDetectionQuery with newer_than='7d' and max_results=10 defaults, and forwards unread_only and exclude_label", async () => {
		const { gmail, config } = makeDeps();
		const action = createIngestMeetingNotesDetectAction({ gmail, config });

		await action.run({}, ctx);
		expect(config.meetingNoteSources).toHaveBeenCalledWith("user-1");
		expect(gmail.searchMessages).toHaveBeenCalledWith({
			domain: "angus",
			query: '(from:gemini-notes@example.com subject:"Notes:") newer_than:7d',
			maxResults: 10,
		});

		await action.run(
			{
				newer_than: "2d",
				unread_only: true,
				exclude_label: "meeting_note",
				max_results: 25,
			},
			ctx,
		);
		expect(gmail.searchMessages).toHaveBeenLastCalledWith({
			domain: "angus",
			query:
				'(from:gemini-notes@example.com subject:"Notes:") newer_than:2d is:unread -label:meeting_note',
			maxResults: 25,
		});
	});

	it("3. domain and deprecated account select the mailbox identically to resolveGoogleAccount, defaulting to personal", async () => {
		const { gmail, config } = makeDeps();
		const action = createIngestMeetingNotesDetectAction({ gmail, config });

		const defaultOut = await action.run({}, ctx);
		expect(defaultOut.domain).toBe("angus");
		expect(defaultOut.account).toBe("personal");

		const workDomainOut = await action.run({ domain: "work" }, ctx);
		expect(workDomainOut.domain).toBe("work");
		expect(workDomainOut.account).toBe("work");
		expect(gmail.searchMessages).toHaveBeenLastCalledWith(
			expect.objectContaining({ domain: "work" }),
		);

		const workAccountOut = await action.run({ account: "work" }, ctx);
		expect(workAccountOut.domain).toBe("work");
		expect(workAccountOut.account).toBe("work");

		const personalAccountOut = await action.run({ account: "personal" }, ctx);
		expect(personalAccountOut.domain).toBe("angus");
		expect(personalAccountOut.account).toBe("personal");

		await expect(
			action.run({ domain: "work", account: "personal" }, ctx),
		).rejects.toThrow(/different domains/);
	});

	it("4. Names the rules origin for default, stored, and invalid-stored configurations", async () => {
		const defaultDeps = makeDeps({ origin: "default" });
		const defaultAction = createIngestMeetingNotesDetectAction(defaultDeps);
		const defaultOut = await defaultAction.run({}, ctx);
		expect(defaultAction.formatMcp!(defaultOut)).toContain(
			"Rules: google_meet (shipped defaults)",
		);

		const storedDeps = makeDeps({
			origin: "stored",
			sources: [
				...DEFAULT_MEETING_NOTE_SOURCES,
				{
					id: "granola",
					label: "Granola",
					from: ["notes@example.com"],
					subject_contains: "Notes:",
					enabled: true,
				},
			],
		});
		const storedAction = createIngestMeetingNotesDetectAction(storedDeps);
		const storedOut = await storedAction.run({}, ctx);
		expect(storedAction.formatMcp!(storedOut)).toContain(
			"Rules: google_meet, granola (from user_preferences)",
		);

		const invalidDeps = makeDeps({ origin: "invalid-stored" });
		const invalidAction = createIngestMeetingNotesDetectAction(invalidDeps);
		const invalidOut = await invalidAction.run({}, ctx);
		expect(invalidAction.formatMcp!(invalidOut)).toContain(
			"Rules: google_meet (stored rules failed validation — using shipped defaults)",
		);
	});

	it("5. formatMcp equals legacy listing for both matched messages and zero matches", async () => {
		const hitWithDoc = makeMessage();
		const hitWithoutDoc = makeMessage({
			id: "msg-2",
			threadId: "thread-2",
			subject: "Notes: “Product Sync” Aug 25, 2026",
			date: "Tue, 25 Aug 2026 14:00:00 +0000",
			labelIds: [],
			body: "Inline notes without a doc URL",
		});
		const nonHit = makeMessage({
			id: "msg-3",
			from: "someone@example.com",
			subject: "Weekly digest",
		});

		const { gmail, config } = makeDeps({
			messages: [hitWithDoc, hitWithoutDoc, nonHit],
		});
		const action = createIngestMeetingNotesDetectAction({ gmail, config });
		const out = await action.run({ domain: "work" }, ctx);

		expect(out.examined).toBe(3);
		expect(out.matched).toHaveLength(2);
		expect(action.formatMcp!(out)).toBe(
			[
				"Mailbox: work",
				"Rules: google_meet (shipped defaults)",
				'Query: (from:gemini-notes@example.com subject:"Notes:") newer_than:7d',
				"Examined 3, matched 2.",
				"",
				"• [msg-1] Google Meet (Gemini notes)",
				"  thread: thread-1",
				"  subject: Notes: “Work Team Weekly” Aug 24, 2026",
				"  meeting: Work Team Weekly",
				"  date: Mon, 24 Aug 2026 10:00:00 +0000",
				"  labels: INBOX, UNREAD",
				"  docs: https://docs.google.com/document/d/1aAvc6TQF4L591MeQUWebugyIK0v/",
				"",
				"• [msg-2] Google Meet (Gemini notes)",
				"  thread: thread-2",
				"  subject: Notes: “Product Sync” Aug 25, 2026",
				"  meeting: Product Sync",
				"  date: Tue, 25 Aug 2026 14:00:00 +0000",
				"  labels: (none)",
				"  docs: (none found in body — the notes may be inline, or the link may sit behind a redirect)",
				"",
				"Next: drive_read_file (or ingest_drive) on the doc id with the same account, then gmail_modify to label the message.",
			].join("\n"),
		);

		const emptyDeps = makeDeps({ messages: [nonHit] });
		const emptyAction = createIngestMeetingNotesDetectAction(emptyDeps);
		const emptyOut = await emptyAction.run({}, ctx);
		expect(emptyAction.formatMcp!(emptyOut)).toBe(
			[
				"Mailbox: personal",
				"Rules: google_meet (shipped defaults)",
				'Query: (from:gemini-notes@example.com subject:"Notes:") newer_than:7d',
				"Examined 1, matched 0.",
				"",
				"No meeting-note emails matched. If one was expected, check the mailbox is the right one and that the sender matches a configured rule.",
			].join("\n"),
		);
	});
});
