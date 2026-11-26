import { describe, expect, it } from "vitest";
import {
	buildDetectionQuery,
	DEFAULT_MEETING_NOTE_SOURCES,
	extractDocUrls,
	matchMeetingNoteEmail,
	type MeetingNoteSource,
} from "./meetingNoteEmails.js";

const meet = DEFAULT_MEETING_NOTE_SOURCES;

function source(over: Partial<MeetingNoteSource> = {}): MeetingNoteSource {
	return {
		id: "s",
		label: "S",
		from: ["notes@example.com"],
		subject_contains: "Notes:",
		enabled: true,
		...over,
	};
}

describe("buildDetectionQuery", () => {
	it("targets the observed Gemini sender, not a guessed one", () => {
		// The first version of this rule guessed meet-recordings-noreply@example.com and
		// matched nothing against the real mailbox. Pinning the observed address here
		// makes a future "tidy-up" of the sender list a failing test rather than a
		// silently empty sweep.
		const q = buildDetectionQuery(meet, {});
		expect(q).toContain("from:gemini-notes@example.com");
		expect(q).toContain('subject:"Notes:"');
	});

	it("ORs multiple senders inside one source with Gmail brace syntax", () => {
		const q = buildDetectionQuery(
			[source({ from: ["a@example.com", "b@example.com"], subject_contains: undefined })],
			{},
		);
		expect(q).toContain("{from:a@example.com from:b@example.com}");
	});

	it("applies newer_than, is:unread and the label exclusion", () => {
		const q = buildDetectionQuery(meet, {
			newerThan: "2d",
			unreadOnly: true,
			excludeLabel: "meeting_note",
		});
		expect(q).toContain("newer_than:2d");
		expect(q).toContain("is:unread");
		// The label exclusion is what makes a repeated sweep idempotent rather than
		// re-capturing everything it already processed.
		expect(q).toContain("-label:meeting_note");
	});

	it("skips disabled sources", () => {
		const q = buildDetectionQuery(
			[source({ id: "on" }), source({ id: "off", from: ["off@example.com"], enabled: false })],
			{},
		);
		expect(q).not.toContain("off@example.com");
	});

	it("throws rather than emitting a query that matches the whole mailbox", () => {
		// A rule with no sender and no subject term would produce an empty clause, and an
		// empty clause ANDed with newer_than returns every message from the last week.
		expect(() =>
			buildDetectionQuery([source({ from: [], subject_contains: undefined })], {}),
		).toThrow(/No usable meeting-note detection rules/);
	});
});

describe("extractDocUrls", () => {
	it("de-duplicates the same document linked several times in one mail", () => {
		// Gemini mail links the same doc from a heading, a button and a footer; without
		// de-duplication a caller sees three hits and infers three documents.
		const body = `
			Open the notes https://docs.google.com/document/d/1aAvc6TQF4L591MeQUWebugyIK0v/edit
			or here https://docs.google.com/document/d/1aAvc6TQF4L591MeQUWebugyIK0v/
		`;
		expect(extractDocUrls(body)).toEqual([
			"https://docs.google.com/document/d/1aAvc6TQF4L591MeQUWebugyIK0v/",
		]);
	});

	it("finds several distinct documents", () => {
		const body =
			"https://docs.google.com/document/d/AAAAAAAAAAAAAAAAAAAAAA/ and https://docs.google.com/document/d/BBBBBBBBBBBBBBBBBBBBBB/";
		expect(extractDocUrls(body)).toHaveLength(2);
	});

	it("returns nothing for a body with no document links", () => {
		expect(extractDocUrls("no links here")).toEqual([]);
	});
});

describe("matchMeetingNoteEmail", () => {
	const body = "Notes: https://docs.google.com/document/d/1aAvc6TQF4L591MeQUWebugyIK0v/";

	it("matches the real Gemini message, curly quotes and all", () => {
		// Verbatim from a live message. Gemini writes CURLY quotes, which the first
		// version of this pattern did not accept, so it matched nothing.
		const m = matchMeetingNoteEmail(
			{
				from: "Gemini <gemini-notes@example.com>",
				subject: "Notes: “Work Team Weekly” Aug 24, 2026",
				body,
			},
			meet,
		);

		expect(m?.source_id).toBe("google_meet");
		expect(m?.meeting_title).toBe("Work Team Weekly");
		expect(m?.doc_urls).toHaveLength(1);
	});

	it("still accepts straight quotes, so a format change does not break detection", () => {
		const m = matchMeetingNoteEmail(
			{
				from: "gemini-notes@example.com",
				subject: 'Notes: "Work Team Weekly" Aug 24, 2026',
				body,
			},
			meet,
		);
		expect(m?.meeting_title).toBe("Work Team Weekly");
	});

	it("finds the doc link in the HTML hrefs when the plain body has none", () => {
		// This is the real shape: Gemini's text/plain part reads "Open meeting notes"
		// with no URL at all, and collectBody rightly prefers plain for readability. If
		// links were read from the chosen body alone, every real message would report
		// zero documents — which is exactly what happened on the first live run.
		const m = matchMeetingNoteEmail(
			{
				from: "gemini-notes@example.com",
				subject: "Notes: “Team Weekly”",
				body: "Notes from Team Weekly\n\nOpen meeting notes\n",
				links: ["https://docs.google.com/document/d/1aAvc6TQF4L591MeQUWebugyIK0v/edit"],
			},
			meet,
		);
		expect(m?.doc_urls).toEqual([
			"https://docs.google.com/document/d/1aAvc6TQF4L591MeQUWebugyIK0v/",
		]);
	});

	it("recovers a doc id from a percent-encoded Google redirect wrapper", () => {
		const m = matchMeetingNoteEmail(
			{
				from: "gemini-notes@example.com",
				subject: "Notes: “Team Weekly”",
				body: "",
				links: [
					"https://www.google.com/url?q=https%3A%2F%2Fdocs.google.com%2Fdocument%2Fd%2F1aAvc6TQF4L591MeQUWebugyIK0v%2Fedit",
				],
			},
			meet,
		);
		expect(m?.doc_urls).toEqual([
			"https://docs.google.com/document/d/1aAvc6TQF4L591MeQUWebugyIK0v/",
		]);
	});

	it("rejects a lookalike from a different sender", () => {
		// Gmail's from: matches DISPLAY NAMES too, so a search can legitimately return a
		// message from a person called "Google". The address is re-checked here for that
		// reason, not as belt-and-braces.
		const m = matchMeetingNoteEmail(
			{
				from: "Google Fan <someone@spam.example>",
				subject: 'Notes: "Work Team Weekly" Aug 24, 2026',
				body,
			},
			meet,
		);
		expect(m).toBeNull();
	});

	it("rejects a matching sender whose subject is not a notes subject", () => {
		const m = matchMeetingNoteEmail(
			{
				from: "noreply@example.com",
				subject: "Your weekly security digest",
				body,
			},
			meet,
		);
		expect(m).toBeNull();
	});

	it("matches when the subject term is present but no title can be extracted", () => {
		// Better to surface the message with a null title than to drop it: a changed
		// subject format should degrade the metadata, not the detection.
		const m = matchMeetingNoteEmail(
			{
				from: "noreply@example.com",
				subject: "Notes: Work Team Weekly (no quotes)",
				body,
			},
			[source({ id: "loose", from: ["noreply@example.com"], subject_pattern: undefined })],
		);
		expect(m?.meeting_title).toBeNull();
		expect(m?.source_id).toBe("loose");
	});

	it("returns the first matching rule when several could match", () => {
		const m = matchMeetingNoteEmail(
			{ from: "notes@example.com", subject: "Notes: x", body: "" },
			[source({ id: "first" }), source({ id: "second" })],
		);
		expect(m?.source_id).toBe("first");
	});

	it("ignores disabled rules", () => {
		const m = matchMeetingNoteEmail(
			{ from: "notes@example.com", subject: "Notes: x", body: "" },
			[source({ enabled: false })],
		);
		expect(m).toBeNull();
	});
});
