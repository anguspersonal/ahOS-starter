import { z } from "zod";
import { ARTIFACT_SURFACES, deriveArtifactTitle, slugify } from "../../domain/artifacts.js";
import { optionalDomainInput } from "../../domain/domainInput.js";
import { reconcileDomain } from "../../domain/domains.js";
import { EVENT_REQUEST_CONTENT_SUBTYPE } from "../../domain/vocab.js";
import type { ArtifactRepository } from "../../ports/artifacts.js";
import type { CalendarEventTime, CalendarPort, CreatedCalendarEvent } from "../../ports/calendar.js";
import type { ExternalLinkRepository } from "../../ports/externalLinks.js";
import type { StoragePort } from "../../ports/storage.js";
import {
	DEFAULT_GOOGLE_ACCOUNT,
	type GoogleAccount,
	googleAccountInput,
	resolveGoogleAccount,
} from "../appsscript/account.js";
import { defineAction } from "../defineAction.js";

export interface EventCreatePorts {
	calendar: Pick<CalendarPort, "createEvent">;
	artifacts: Pick<ArtifactRepository, "insert">;
	storage: Pick<StoragePort, "upload" | "remove" | "publicUrl">;
	externalLinks: Pick<
		ExternalLinkRepository,
		| "inspectDedupSlot"
		| "claimDedupSlot"
		| "finalizeExternalLink"
		| "recordExternalLink"
		| "releaseClaimForFailedWrite"
		| "interruptedClaimMessage"
	>;
	resolveTargetCalendar?: () => Promise<string | null | undefined> | string | null | undefined;
	ownerId?: string | (() => string | undefined);
	storageBucket?: string | (() => string);
}

// The provider/kind this tool always writes under — unlike task_create (which is
// workspace-selectable across two Notion providers), there is exactly one Calendar
// provider today, so both are fixed constants rather than caller-selectable (issue #126,
// option (a): a native event_create tool, mirroring task_create).
const PROVIDER = "google_calendar";
const KIND = "event";

export const createEventInput = {
	title: z.string().min(1).describe("The event title (Calendar's 'summary' field)."),
	account: googleAccountInput,
	domain: optionalDomainInput,
	start: z
		.string()
		.min(1)
		.describe(
			"Event start. Either a full ISO 8601 datetime (e.g. '2026-07-10T14:00:00-07:00' or with a trailing 'Z') for a timed event, or a bare 'YYYY-MM-DD' date for an all-day event.",
		),
	end: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Event end. Same format as `start`. If omitted: a timed event defaults to `start` + 1 hour; an all-day event (bare date `start`) defaults to the next calendar day (Calendar's convention for a single-day all-day event — the end date is exclusive).",
		),
	description: z.string().optional().describe("Optional event description/notes."),
	location: z.string().optional().describe("Optional event location (free text)."),
	attendees: z
		.array(z.string().email())
		.optional()
		.describe("Optional attendee email addresses to invite."),
	artifact_id: z
		.string()
		.uuid()
		.optional()
		.describe(
			"Optional id of the artifact this event came from (e.g. a meeting transcript). Records cross-store lineage so the event is traceable from the knowledge side. When omitted, the event's source is auto-captured from `source_text` (or the title) instead — see `source_text`.",
		),
	source_text: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The message that requested this event, used ONLY when no `artifact_id` is given. It is captured as the event's source artifact so every event is traceable back to the thought that produced it (mirrors task_create's #413 treatment) — the request itself IS the source. Pass the user's actual request verbatim (e.g. 'put dentist on the calendar for next Tuesday at 2pm'); if omitted, the title stands in as a thin fallback. The captured artifact carries distinct provenance (content_subtype='event_request') and is excluded from knowledge_search by default (opt in with `include_event_requests`). Ignored when `artifact_id` is supplied (the event already has a source).",
		),
	single_event: z
		.boolean()
		.optional()
		.describe(
			"Set true when this atom declares exactly ONE event (the common 1:1 case). " +
				"When true and artifact_id is given, skips creation if ANY kind='event' link already exists for that artifact — prevents eager-Act-at-capture plus a later Act pass from double-creating. " +
				"Leave false/omitted for the 1:N case (an atom that spawns several distinct events); use dedup_key instead to dedup those individually. " +
				"WARNING: this is a caller-asserted contract, not a structural one — nothing stops you from passing single_event=true on an atom that actually has several distinct events. Doing so SILENTLY SKIPS every event after the first (only the response text says so; there is no error). If an atom might spawn more than one event, use dedup_key instead, per-event.",
		),
	dedup_key: z
		.string()
		.min(1)
		.optional()
		.describe(
			"Stable per-event idempotency key for the 1:N case (e.g. a slug of this specific event's title, when one atom spawns several events). " +
				"When given with artifact_id, skips creation if a kind='event' link with this exact dedup_key already exists for that artifact; otherwise creates and records it under this key. " +
				"Mutually exclusive in practice with single_event (single_event is for the 1:1 case; dedup_key is for 1:N). No multi-event orchestration is provided beyond this per-key dedup — the caller still issues one event_create call per event.",
		),
};

export const createEventSchema = z.object(createEventInput);
export type CreateEventInput = z.infer<typeof createEventSchema>;
export type EventCreateOutput = { text: string };

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnly(value: string): boolean {
	return DATE_ONLY_RE.test(value);
}

function addHoursIso(iso: string, hours: number): string {
	const d = new Date(iso);
	d.setTime(d.getTime() + hours * 60 * 60 * 1000);
	return d.toISOString();
}

function addDaysDateOnly(dateStr: string, days: number): string {
	const d = new Date(`${dateStr}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

/**
 * Resolve the caller's `start`/`end` ISO strings into the Calendar API's timed-vs-all-day
 * wire shape, applying the default duration when `end` is omitted (see createEventInput's
 * `end` description). An all-day event is detected by `start` being a bare date
 * (`YYYY-MM-DD`, no time component) — mirrors `end` the same way if it, too, looks
 * date-only; otherwise `end` is trusted as given.
 */
export function resolveEventTimes(
	start: string,
	end: string | undefined,
): { start: CalendarEventTime; end: CalendarEventTime } {
	if (isDateOnly(start)) {
		const endDate = end && isDateOnly(end) ? end : addDaysDateOnly(start, 1);
		return { start: { date: start }, end: { date: endDate } };
	}
	const endDateTime = end && !isDateOnly(end) ? end : addHoursIso(start, 1);
	return { start: { dateTime: start }, end: { dateTime: endDateTime } };
}

/**
 * Build the "Skipped: ..." response text for a dedup hit — mirrors createTask.ts's
 * `skippedDuplicateText` with kind='event'/single_event vocabulary. See that function's
 * doc comment for why the "skipped as duplicate (single_event)" phrase is exact and not
 * to be reworded (round-1 review precedent on task_create: callers may grep for it).
 */
function skippedDuplicateText(opts: {
	artifactId: string;
	dedupKey?: string;
	singleEvent?: boolean;
	raceLost?: boolean;
}): string {
	const reason = opts.dedupKey
		? `an event with dedup_key '${opts.dedupKey}'`
		: "an event";
	const raceNote = opts.raceLost ? " — lost a concurrent dedup race" : "";
	const singleEventNote = opts.singleEvent
		? " This atom was skipped as duplicate (single_event) — if it actually has more than one distinct event, re-run the missed ones with dedup_key instead."
		: "";
	return (
		`Skipped: ${reason} is already linked to artifact ${opts.artifactId} (kind='event')${raceNote}. ` +
		`No new Calendar event created.${singleEventNote}`
	);
}

/**
 * Auto-capture the message that requested an event as its source artifact — mirrors
 * createTask.ts's `captureTaskRequestArtifact` (same NOT NULL storage_* fields, same
 * best-effort-with-cleanup contract, same `surface: ARTIFACT_SURFACES.actReceipt`
 * stamp as of #736), stamped `content_subtype='event_request'` instead of
 * `'task_request'`. Called ONLY when `event_create` is invoked without an
 * `artifact_id`. Line-for-line identical to that function apart from vocabulary
 * (event vs. task) — keep the two in sync when either changes.
 */
async function captureEventRequestArtifact(
	ports: Pick<EventCreatePorts, "artifacts" | "storage">,
	userId: string,
	bucket: string,
	text: string,
	titleHint: string,
	account: GoogleAccount,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	const id = globalThis.crypto.randomUUID();
	const title = deriveArtifactTitle({ explicitTitle: titleHint, text })!;
	const filename = `${slugify(title)}-${id.slice(0, 8)}.md`;
	const storagePath = `notes/${userId}/${id}.md`;

	const uploadError = await ports.storage
		.upload(bucket, storagePath, text, { contentType: "text/markdown" })
		.then(
			() => null,
			(err) => (err instanceof Error ? err.message : String(err)),
		);
	if (uploadError) {
		return { ok: false, error: `storage upload failed: ${uploadError}` };
	}

	const error = await ports.artifacts
		.insert({
		id,
		user_id: userId,
		storage_bucket: bucket,
		storage_path: storagePath,
		storage_url: ports.storage.publicUrl(bucket, storagePath),
		filename,
		original_file_name: filename,
		file_type: "text/markdown",
		content_type: "text/markdown",
		file_extension: "md",
		file_size: new TextEncoder().encode(text).length,
		artifact_type: "original",
		captured_at: new Date().toISOString(),
		// Provenance (ADR-026; ADR-046 §2/§3, #584). Act-path receipts have no
		// EXTERNAL surface to copy — nobody sent this row in, the system wrote it
		// from a request it was handed — but "system-written receipt" is itself an
		// envelope fact, and a nameable one. Leaving it null made the class
		// unaddressable: the owner could not demote receipts out of narrative
		// without also demoting every other unstamped path.
		surface: ARTIFACT_SURFACES.actReceipt,
		lifecycle_stage: "uploaded",
		processing_status: "pending",
		title,
		plain_text: text,
		tags: [`account:${account}`],
		content_subtype: EVENT_REQUEST_CONTENT_SUBTYPE,
	})
		.then(
			() => null,
			(err) => (err instanceof Error ? err.message : String(err)),
		);

	if (error) {
		await ports.storage.remove(bucket, [storagePath]).catch(() => {});
		return { ok: false, error: `artifact insert failed: ${error}` };
	}

	return { ok: true, id };
}

/**
 * Create an event on the user's Google Calendar (issue #126, ADR-038 §6 — the Event/Act
 * facet mirroring task_create's Task/Act facet). Native `event_create` tool (option (a) —
 * see the issue's decision record): no DB migration, since `external_links.kind`/
 * `provider` are free-text and migration 064's dedup index already keys on them, so
 * `kind='event'`/`provider='google_calendar'` need nothing new.
 *
 * Provenance, dedup, and concurrency handling below are a line-for-line mirror of
 * createTask.ts's createTaskHandler — see that file's doc comments for the full
 * rationale (issue #413 provenance, issue #141 dedup, the round-1-review concurrency
 * fix, and issue #653's claim-release semantics); only the vocabulary (task -> event)
 * and the external system (Notion -> Calendar) differ. The mirroring is why #653 is
 * fixed in both: the claim lifecycle lives in links.ts and both handlers drive it.
 */
export async function runEventCreate(
	ports: EventCreatePorts,
	args: CreateEventInput,
	ctx?: { userId?: string },
): Promise<EventCreateOutput> {
	const dedupOn = Boolean(args.artifact_id) && (args.single_event || Boolean(args.dedup_key));
	let claimedLinkId: string | null = null;

	if (dedupOn && args.artifact_id) {
		const slot = await ports.externalLinks.inspectDedupSlot(
			args.artifact_id,
			PROVIDER,
			KIND,
			args.dedup_key,
		);
		if (slot === "linked") {
			return {
				text: skippedDuplicateText({
					artifactId: args.artifact_id,
					dedupKey: args.dedup_key,
					singleEvent: args.single_event,
				}),
			};
		}
		if (slot === "pending") {
			// An unfinished claim, not an event (issue #653) — see createTask.ts's handler
			// doc comment for why this refuses rather than reclaims.
			return {
				text: ports.externalLinks.interruptedClaimMessage({
					artifactId: args.artifact_id,
					provider: PROVIDER,
					kind: KIND,
					dedupKey: args.dedup_key,
				}),
			};
		}

		const claim = await ports.externalLinks.claimDedupSlot(
			args.artifact_id,
			PROVIDER,
			KIND,
			args.dedup_key ?? null,
		);
		if (!claim.claimed) {
			if (claim.reason === "conflict") {
				return {
					text: skippedDuplicateText({
						artifactId: args.artifact_id,
						dedupKey: args.dedup_key,
						singleEvent: args.single_event,
						raceLost: true,
					}),
				};
			}
			// Claim failed for an infra reason (e.g. migration 064 not applied) rather than a
			// real conflict — degrade to the best-effort recordExternalLink path instead of
			// blocking event creation on schema that isn't there yet.
			claimedLinkId = null;
		} else {
			claimedLinkId = claim.linkId;
		}
	}

	// Claim -> outward write, guarded (issue #653). Every throw in this block happens with
	// no Calendar event created — unconfigured integration, unparseable times, a failed
	// Calendar call — so the claim is released and a retry finds a free slot instead of a
	// permanent block. The one throw that does NOT mean that — Calendar accepting the
	// create and then failing to deliver a readable response — arrives as
	// `ExternalItemCreatedButUnreadable`, which `releaseClaimForFailedWrite` declines to
	// release on. The window closes the instant `createCalendarEvent` returns: everything
	// below is best-effort and must never release, or a lost finalize would strip the slot
	// for an event that really is on the calendar. See createTask.ts's handler doc comment
	// for the full failure semantics.
	let event: CreatedCalendarEvent;
	let account: GoogleAccount;
	try {
		if (!ports.resolveTargetCalendar) {
			throw new Error("Calendar resolver port is not wired.");
		}
		const targetCalendarId = await ports.resolveTargetCalendar();
		if (!targetCalendarId) {
			throw new Error(
				"No Google Calendar integration configured. Add a 'google_calendar' row via integration_set with { calendar_id }.",
			);
		}

		const domain =
			reconcileDomain(args.domain, args.account, "account") ?? "angus";
		account = resolveGoogleAccount(args) ?? DEFAULT_GOOGLE_ACCOUNT;
		const { start, end } = resolveEventTimes(args.start, args.end);

		event = await ports.calendar.createEvent({
			domain,
			// 'primary' resolves per-account to that account's own default calendar, so
			// the configured id (which names ONE calendar in ONE account) must not be
			// applied to the other. Without this, account='work' would post to the
			// personal calendar's id using the work token and 404, or worse, hit a
			// calendar id that happens to be shared and write to the wrong place.
			calendarId: account === DEFAULT_GOOGLE_ACCOUNT ? targetCalendarId : "primary",
			summary: args.title,
			description: args.description,
			location: args.location,
			start,
			end,
			attendees: args.attendees,
		});
	} catch (error) {
		throw await ports.externalLinks.releaseClaimForFailedWrite(claimedLinkId, error);
	}

	// Resolve the artifact this event links back to (mirrors createTask.ts's #413
	// treatment). Done AFTER the Calendar event exists so a failed create never leaves an
	// orphan provenance artifact behind.
	const userId =
		ctx?.userId ??
		(typeof ports.ownerId === "function" ? ports.ownerId() : ports.ownerId) ??
		"";
	const bucket =
		(typeof ports.storageBucket === "function"
			? ports.storageBucket()
			: ports.storageBucket) ?? "user-uploads";
	let effectiveArtifactId = args.artifact_id;
	let provenanceNote = "";
	if (!effectiveArtifactId) {
		const captured = await captureEventRequestArtifact(
			ports,
			userId,
			bucket,
			args.source_text ?? args.title,
			args.title,
			account,
		);
		if (captured.ok) {
			effectiveArtifactId = captured.id;
			provenanceNote = `\nSource captured as artifact ${captured.id} (content_subtype='${EVENT_REQUEST_CONTENT_SUBTYPE}')`;
		} else {
			provenanceNote = `\n(could not capture event-request provenance: ${captured.error})`;
		}
	}

	// Record cross-store lineage (ADR-013 §5). Best-effort: the event already exists in
	// Calendar, so a failed link shouldn't fail the call — surface it as a note instead.
	let lineageNote = "";
	if (effectiveArtifactId) {
		const linked = claimedLinkId
			? await ports.externalLinks.finalizeExternalLink(
					claimedLinkId,
					event.id,
					event.htmlLink || null,
				)
			: await ports.externalLinks.recordExternalLink(effectiveArtifactId, {
					provider: PROVIDER,
					kind: KIND,
					external_id: event.id,
					external_url: event.htmlLink || null,
					dedup_key: args.dedup_key ?? null,
				});
		lineageNote = linked.ok
			? `\nLinked to artifact ${effectiveArtifactId}`
			: `\n(could not record lineage link: ${linked.error}; is migration 047 applied?)`;
	}

	return {
		text: `Created Calendar event: ${args.title}\nEvent: ${event.htmlLink || event.id}${provenanceNote}${lineageNote}`,
	};
}

export function createEventCreateAction(ports: EventCreatePorts) {
	return defineAction<typeof createEventSchema, EventCreateOutput>({
		id: "event_create",
		domain: "integrations",
		description:
			"Create a Google Calendar event. `title` is required. `start` is a full ISO datetime for a timed " +
			"event or a bare YYYY-MM-DD for an all-day one; `end` is optional and defaults to one hour later, " +
			"or the next day for all-day. Full notes: docs/guides/tools/event_create.md",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		schema: createEventSchema,
		formatMcp: (out) => out.text,
		run: (args, ctx) => runEventCreate(ports, args, ctx),
	});
}
