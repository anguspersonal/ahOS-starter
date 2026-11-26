import { z } from "zod";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain, type Domain } from "../../domain/domains.js";
import {
	buildDetectionQuery,
	matchMeetingNoteEmail,
	type MeetingNoteMatch,
	type MeetingNoteSource,
} from "../../domain/ingest/meetingNoteEmails.js";
import type {
	ConfigRepository,
	MeetingNoteSourcesOrigin,
} from "../../ports/config.js";
import type {
	GmailAccount,
	GmailPort,
	ParsedMessage,
} from "../../ports/gmail.js";
import { defineAction } from "../defineAction.js";

export const meetingNotesDetectInput = {
	newer_than: z
		.string()
		.regex(/^\d+[dhmy]$/)
		.optional()
		.describe(
			"Gmail relative age bound, e.g. '2d', '7d', '1m'. Defaults to '7d'. Keeps a sweep from walking the whole mailbox.",
		),
	unread_only: z
		.boolean()
		.optional()
		.describe("Only consider unread messages (default false)."),
	exclude_label: z
		.string()
		.optional()
		.describe(
			"Skip messages already carrying this label name, e.g. 'meeting_note'. This is what makes a repeated sweep idempotent.",
		),
	max_results: z
		.number()
		.int()
		.min(1)
		.max(50)
		.optional()
		.describe("Max messages to examine (default 10)."),
	account: z
		.enum(["personal", "work"])
		.optional()
		.describe(
			"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		),
	domain: optionalDomainInput,
};

export const meetingNotesDetectInputSchema = z.object(meetingNotesDetectInput);
export const meetingNotesDetectSchema = meetingNotesDetectInputSchema;

export type MeetingNotesDetectInput = z.infer<typeof meetingNotesDetectInputSchema>;

export const INGEST_MEETING_NOTES_DETECT_DESCRIPTION =
	"Find meeting-note emails in a mailbox using the configured sender/subject detection rules (Google Meet / Gemini today), and report the meeting title and Google Doc links recovered from each. Read-only: label and capture are separate calls. Use domain='work' for the work.example.com mailbox.";

export interface IngestMeetingNotesDetectMatchItem {
	message: ParsedMessage;
	match: MeetingNoteMatch;
}

export interface IngestMeetingNotesDetectOutput {
	domain: Domain;
	account: GmailAccount;
	sources: MeetingNoteSource[];
	origin: MeetingNoteSourcesOrigin;
	query: string;
	examined: number;
	matched: IngestMeetingNotesDetectMatchItem[];
}

export interface IngestMeetingNotesDetectDeps {
	gmail: Pick<GmailPort, "searchMessages">;
	config: Pick<ConfigRepository, "meetingNoteSources">;
}

export function formatIngestMeetingNotesDetectMcp(
	out: IngestMeetingNotesDetectOutput,
): string {
	const header = [
		`Mailbox: ${out.account}`,
		`Rules: ${out.sources
			.filter((s) => s.enabled)
			.map((s) => s.id)
			.join(", ")} (${
			out.origin === "stored"
				? "from user_preferences"
				: out.origin === "invalid-stored"
					? "stored rules failed validation — using shipped defaults"
					: "shipped defaults"
		})`,
		`Query: ${out.query}`,
		`Examined ${out.examined}, matched ${out.matched.length}.`,
	].join("\n");

	if (out.matched.length === 0) {
		return `${header}\n\nNo meeting-note emails matched. If one was expected, check the mailbox is the right one and that the sender matches a configured rule.`;
	}

	const body = out.matched
		.map(({ message, match }) =>
			[
				`• [${message.id}] ${match.source_label}`,
				`  thread: ${message.threadId}`,
				`  subject: ${message.subject}`,
				`  meeting: ${match.meeting_title ?? "(title not extracted)"}`,
				`  date: ${message.date}`,
				`  labels: ${message.labelIds.join(", ") || "(none)"}`,
				match.doc_urls.length
					? `  docs: ${match.doc_urls.join(", ")}`
					: "  docs: (none found in body — the notes may be inline, or the link may sit behind a redirect)",
			].join("\n"),
		)
		.join("\n\n");

	return `${header}\n\n${body}\n\nNext: drive_read_file (or ingest_drive) on the doc id with the same account, then gmail_modify to label the message.`;
}

export function createIngestMeetingNotesDetectAction(
	deps: IngestMeetingNotesDetectDeps,
) {
	return defineAction<
		typeof meetingNotesDetectInputSchema,
		IngestMeetingNotesDetectOutput
	>({
		id: "ingest_meeting_notes_detect",
		domain: "integrations",
		description: INGEST_MEETING_NOTES_DETECT_DESCRIPTION,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		schema: meetingNotesDetectInputSchema,
		formatMcp: formatIngestMeetingNotesDetectMcp,
		async run(args, ctx) {
			const domain: Domain =
				reconcileDomain(args.domain, args.account, "account") ?? "angus";
			const account = DOMAIN_LEGACY_SCOPE[domain] as GmailAccount;

			if (!deps.config.meetingNoteSources) {
				throw new Error("ConfigRepository.meetingNoteSources is not wired");
			}
			const { sources, origin } = await deps.config.meetingNoteSources(
				ctx.userId,
			);

			const query = buildDetectionQuery(sources, {
				newerThan: args.newer_than ?? "7d",
				unreadOnly: args.unread_only,
				excludeLabel: args.exclude_label,
			});

			const messages = await deps.gmail.searchMessages({
				domain,
				query,
				maxResults: args.max_results ?? 10,
			});

			const matched = messages
				.map((m) => ({
					message: m,
					match: matchMeetingNoteEmail(m, sources),
				}))
				.filter(
					(
						r,
					): r is { message: ParsedMessage; match: MeetingNoteMatch } =>
						r.match !== null,
				);

			return {
				domain,
				account,
				sources,
				origin,
				query,
				examined: messages.length,
				matched,
			};
		},
	});
}
