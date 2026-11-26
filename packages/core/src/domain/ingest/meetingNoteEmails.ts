import { z } from "zod";
import type { ParsedMessage } from "../../ports/gmail.js";

// Detection rules for meeting-note emails: which senders and subjects mark a message as
// "a meeting tool has produced notes", and how to pull the meeting title and document
// link back out of it.
//
// Rules are DATA, not code paths. Each note-taker (Google Meet / Gemini today; Granola,
// Notion and Plaud once their patterns are observed) is one entry in a list, so adding a
// source is an edit to config rather than a new branch in a matcher. The seed below is
// the shipped default; an override stored on the owner's user_preferences row wins over
// it entirely.
//
// Not to be confused with meetingsSources.ts, which routes Notion meeting DATABASES.
// This module is about the arrival signal in a mailbox.

export const meetingNoteSourceSchema = z.object({
	/** Stable key, used in output and in issues. e.g. "google_meet". */
	id: z.string().min(1),
	/** Human label for reporting. */
	label: z.string().min(1),
	/**
	 * Sender addresses or domains, matched with Gmail's `from:` operator. Several are
	 * allowed because one product can send from more than one address.
	 */
	from: z.array(z.string()).default([]),
	/**
	 * Gmail `subject:` term used to NARROW THE SEARCH. Gmail subject matching is
	 * word-based and cannot express structure, so this is a coarse filter that the
	 * regex below then confirms.
	 */
	subject_contains: z.string().optional(),
	/**
	 * Case-insensitive regex confirming a hit and, via its first capture group,
	 * extracting the meeting title. Applied to the subject.
	 */
	subject_pattern: z.string().optional(),
	enabled: z.boolean().default(true),
});

export type MeetingNoteSource = z.infer<typeof meetingNoteSourceSchema>;

export const meetingNoteSourcesSchema = z.array(meetingNoteSourceSchema);

/**
 * Shipped defaults. Google Meet only, deliberately.
 *
 * The other note-takers are named in the plan but their real sender addresses and
 * subject shapes have not been observed yet, and a guessed pattern is worse than a
 * missing one: it matches nothing, and its silence is indistinguishable from "no
 * meeting happened". Each gets added once a real message has been seen.
 */
export const DEFAULT_MEETING_NOTE_SOURCES: MeetingNoteSource[] = [
	{
		id: "google_meet",
		label: "Google Meet (Gemini notes)",
		// Observed on a real message, not guessed. The first attempt used
		// meet-recordings-noreply@example.com and matched nothing.
		from: ["gemini-notes@example.com"],
		subject_contains: "Notes:",
		// Gemini writes CURLY quotes: `Notes: “Work Team Weekly” Aug 24, 2026`. A
		// pattern demanding straight quotes matches nothing, and matches nothing
		// silently, so both forms are accepted. The unicode escapes keep this source
		// file ASCII, where a pasted curly quote is easy to "correct" by accident.
		subject_pattern: 'Notes:\\s*["\\u201C]([^"\\u201D]+)["\\u201D]',
		enabled: true,
	},
];

/**
 * Build one Gmail query covering every enabled source.
 *
 * One query rather than one per source: Gmail bills per request, the OR form is a
 * single round trip, and results come back in one date-ordered list instead of needing
 * a merge. Sources with neither a sender nor a subject term are skipped — such a rule
 * would match the entire mailbox.
 */
export function buildDetectionQuery(
	sources: MeetingNoteSource[],
	opts: { newerThan?: string; unreadOnly?: boolean; excludeLabel?: string } = {},
): string {
	const clauses: string[] = [];

	for (const s of sources) {
		if (!s.enabled) continue;
		const parts: string[] = [];
		if (s.from.length) {
			parts.push(
				s.from.length === 1
					? `from:${s.from[0]}`
					: `{${s.from.map((f) => `from:${f}`).join(" ")}}`,
			);
		}
		if (s.subject_contains) parts.push(`subject:"${s.subject_contains}"`);
		if (parts.length === 0) continue;
		clauses.push(parts.length === 1 ? parts[0] : `(${parts.join(" ")})`);
	}

	if (clauses.length === 0) {
		throw new Error(
			"No usable meeting-note detection rules — every source is disabled or has neither a sender nor a subject term.",
		);
	}

	const query = [clauses.length === 1 ? clauses[0] : `{${clauses.join(" ")}}`];
	if (opts.newerThan) query.push(`newer_than:${opts.newerThan}`);
	if (opts.unreadOnly) query.push("is:unread");
	// Excluding the processed label is what makes a repeated sweep idempotent: an email
	// already captured is skipped rather than captured a second time.
	if (opts.excludeLabel) query.push(`-label:${opts.excludeLabel}`);
	return query.join(" ");
}

export type MeetingNoteMatch = {
	source_id: string;
	source_label: string;
	meeting_title: string | null;
	doc_urls: string[];
};

/** Google Docs URLs, from which the document id is the part that matters. */
const DOC_URL = /https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,})/g;

/**
 * Pull every Google Doc link out of a message body, de-duplicated in first-seen order.
 *
 * De-duplication matters because the same document is usually linked two or three times
 * in one mail (a heading link, a button, a footer), and without it a caller looks at
 * three hits and reasonably concludes there are three documents.
 */
export function extractDocUrls(text: string): string[] {
	const seen = new Set<string>();
	// Scanned twice, once percent-decoded, because Google frequently wraps outbound
	// links as https://www.google.com/url?q=https%3A%2F%2Fdocs.google.com%2F... — the
	// document id is present but unmatchable until the wrapper is decoded.
	for (const haystack of [text, safeDecode(text)]) {
		for (const m of haystack.matchAll(DOC_URL)) seen.add(m[1]);
	}
	return [...seen].map((id) => `https://docs.google.com/document/d/${id}/`);
}

function safeDecode(text: string): string {
	try {
		return decodeURIComponent(text);
	} catch {
		// A stray % in a body is enough to make decodeURIComponent throw on the whole
		// string. Returning the original keeps the undecoded pass working.
		return text;
	}
}

/**
 * Decide whether one message is a meeting note, and if so pull out its title and links.
 *
 * The sender is re-checked here rather than trusted from the search: Gmail's `from:`
 * matches display names as well as addresses, so a query can return a message from
 * someone merely called "Google". Returns null when nothing matches.
 */
export function matchMeetingNoteEmail(
	message: Pick<ParsedMessage, "from" | "subject" | "body"> & { links?: string[] },
	sources: MeetingNoteSource[],
): MeetingNoteMatch | null {
	const from = message.from.toLowerCase();

	for (const s of sources) {
		if (!s.enabled) continue;
		if (s.from.length && !s.from.some((f) => from.includes(f.toLowerCase()))) continue;

		let title: string | null = null;
		if (s.subject_pattern) {
			const m = new RegExp(s.subject_pattern, "i").exec(message.subject);
			if (!m) continue;
			title = m[1] ?? null;
		} else if (s.subject_contains) {
			if (!message.subject.toLowerCase().includes(s.subject_contains.toLowerCase())) {
				continue;
			}
		}

		return {
			source_id: s.id,
			source_label: s.label,
			meeting_title: title,
			doc_urls: extractDocUrls([message.body, ...(message.links ?? [])].join("\n")),
		};
	}
	return null;
}
