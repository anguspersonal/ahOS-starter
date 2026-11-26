import { httpStatusOf, isRetryableHttpError, withBackoff } from "../backoff.js";
import { supabase } from "../supabase.js";
import { CredentialNotConfiguredError, getCredential } from "../credentials.js";
import {
	GOOGLE_ACCOUNTS,
	GOOGLE_ACCOUNT_PROVIDER,
	type GoogleAccount,
} from "../google/accounts.js";
import {
	getGmailAccessToken,
	getMessage,
	getProfile,
	listAttachmentParts,
	listMessageIds,
	messageHeader,
	parseAddress,
	type GmailAttachmentPart,
	type GmailMessage,
} from "../google/gmail.js";
import { executeAction } from "@ahkms/core";
import { getCurrentUserId } from "../identity.js";
import { ingestDiscoverAction, type DiscoverItem } from "../tools/discover.js";
import { GMAIL_ATTACHMENT_CONNECTOR_BY_ACCOUNT } from "../vocab.js";
import { env } from "./env.js";
import { chunk } from "./chunk.js";
import { recordRun } from "./runLog.js";

// Scheduled discover connector for Gmail attachments (#1210, ADR-046 §4 rows 1.5/1.6).
// Every file attached to a message in the mailbox becomes one L1 pointer, handed to
// `ingest_discover`'s write side in batches: the Gmail sibling of the Drive and Notion
// cadences, run inside the same shared "discover" cadence and lock.
//
// Scope, deliberately kept to the pointer layer:
//   - The whole mailbox, less spam, trash and drafts; not only INBOX and SENT. ADR-046
//     §4 schedules everything at the pointer layer and uses "INBOX + SENT only" as an
//     enrich-timing filter for evidence sources. A label-scoped listing would also miss
//     received mail that leaves the inbox before the next run, and ahOS's own
//     gmail_automations archives exactly the threads the owner has processed. If these
//     pointers are ever enriched, INBOX + SENT is where that filter belongs.
//   - Envelope only (ADR-046 §2). Each pointer carries what the API served about the
//     message and the part: from, to, subject, date, filename, MIME type, size and the
//     ids. No body text is stored and nothing is classified at write.
//   - One pointer per ATTACHMENT, keyed `<message_id>:<part_id>`. Not the attachment id:
//     Gmail does not keep that stable across `messages.get` calls, and a key that moves
//     would re-insert every attachment each time a window is re-listed. A delivered
//     message never changes, so its part ids never do. The attachment id is not stored
//     either: a reader re-fetches the message and takes a fresh one from the part.
//   - Not every file-bearing part is a document someone attached. Embedded images and
//     calendar invitations get no pointer and are counted as `excluded` (partExclusion),
//     and drafts are skipped and counted as `drafts`. All three are decided on envelope
//     facts, which ADR-046 §2 allows at write.
//   - Not enrichable. There is no Gmail read adapter in ingest_enrich_next, so these
//     pointers are written 'completed' (discover.ts pointerProcessingStatus) and stay at
//     stage 'discovered'. Reading the bytes is a later adapter (ADR-091: Gmail is store).
//   - Role `evidence` through DISCOVER_ROLE_SEED, so a mailbox's worth of attachments can
//     be searched and consulted but never floods the day's narrative (#567).
//   - Deletions are NOT detected: a message deleted after it was swept keeps its pointers.
//     The same known gap as Drive and Notion.
//
// Each run has two phases under one per-account budget of messages fetched
// (KMS_GMAIL_ATTACHMENT_DISCOVER_MAX_MESSAGES):
//   1. The HEAD: every message since the last run, oldest first. New mail is indexed on
//      the run after it arrives, however much history is still waiting.
//   2. The BACKFILL: whatever budget the head left, spent on the history below a cursor,
//      newest first, so recent history becomes searchable before old history does.
// A first run has no head, so it spends the whole budget on the backfill. At the
// default budget and the default daily discover interval, a mailbox holding N messages
// with attachments takes about N / 1000 days to backfill completely.

/**
 * Which messages are listed: every message with an attachment. messages.list leaves
 * spam and trash out by default, and drafts are dropped after the fetch (LABEL_DRAFT).
 * There is deliberately no label clause; see the scope note above.
 */
export const ATTACHMENT_QUERY = "has:attachment";

/**
 * Gmail's system label on an unsent draft. A draft is skipped: it is still being
 * written, Gmail gives it a new message id each time it is saved (so a pointer to it
 * goes stale), and once it is sent it comes back through the head as a sent message.
 */
const LABEL_DRAFT = "DRAFT";

// messages.list's own page ceiling; ids are cheap, so list in the largest pages allowed.
const LIST_PAGE_SIZE = 500;
// ingest_discover caps a single call at 200 items.
const BATCH_SIZE = 200;
/**
 * How far behind its watermark the head re-lists. Gmail's search index can lag
 * delivery, so a message that landed just before the previous run started may only have
 * become listable afterwards; re-listing the last hour catches it, and the re-fetched
 * messages are unchanged no-ops in ingest_discover. The one cost worth knowing: a capped
 * head cannot advance if more than a whole run's budget of attachment messages fall
 * inside a single hour, which no personal mailbox approaches.
 */
const WATERMARK_OVERLAP_S = 60 * 60;
// Google access tokens live an hour; re-mint well before that inside a long sweep.
const TOKEN_TTL_MS = 45 * 60 * 1000;

/**
 * Gmail answers a per-user rate limit as 429, but also as 403 with reason
 * `rateLimitExceeded` / `userRateLimitExceeded`. The default classifier (429 and 5xx)
 * would give up on the second shape. Any other 403 is a scope or permission problem
 * that no retry can fix.
 */
function isRetryableGmailError(err: unknown): boolean {
	if (isRetryableHttpError(err)) return true;
	return (
		httpStatusOf(err) === 403 &&
		err instanceof Error &&
		/rateLimitExceeded|userRateLimitExceeded/.test(err.message)
	);
}

/**
 * The message's own timestamp as ISO, or undefined. `internalDate` first: it is Gmail's
 * epoch-milliseconds send/receive time and always machine-readable, where the Date
 * header is whatever the sending client wrote. The header is the fallback, and a value
 * neither can parse is "we were not told", never a guess.
 */
export function messageDate(msg: GmailMessage, dateHeader: string): string | undefined {
	const ms = Number(msg.internalDate);
	if (msg.internalDate && Number.isFinite(ms)) return new Date(ms).toISOString();
	const parsed = Date.parse(dateHeader);
	return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

/**
 * A link that opens the message in the right mailbox. `authuser` rather than `/u/0/`:
 * the index is the order accounts happen to be signed in to the browser, so `/u/0/` opens
 * the Work message in the personal mailbox, which answers "conversation not found".
 */
export function messageUrl(mailbox: string, messageId: string): string {
	if (!mailbox.includes("@")) return `https://mail.google.com/mail/u/0/#all/${messageId}`;
	return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${messageId}`;
}

/** Why a file-bearing part gets no pointer. */
export type PartExclusion = "embedded_image" | "calendar_invite";

const CALENDAR_MIME_TYPES: ReadonlySet<string> = new Set(["text/calendar", "application/ics"]);

/**
 * Whether a file-bearing part is left out of the index, and why; null when it gets a
 * pointer. Decided on envelope facts only (ADR-046 §2): MIME type, filename extension,
 * Content-Disposition and the presence of a Content-ID.
 *
 *   - embedded_image: an image part with a Content-ID that is not marked `attachment`.
 *     That is what an HTML body embeds by `cid:`: signature logos, pasted screenshots.
 *     Quoted replies carry the same logo again on every message of a thread, so without
 *     this each reply adds another `image001.png` pointer, and those families would
 *     crowd real documents out of the duplicate report (#1217). Gmail also stamps a
 *     Content-ID on ordinary attachments, which is why the disposition is checked too:
 *     a photo sent as an attachment is kept.
 *   - calendar_invite: text/calendar, application/ics or a `.ics` filename, the
 *     invitation file every calendar event mail carries.
 */
export function partExclusion(part: GmailAttachmentPart): PartExclusion | null {
	const mime = part.mimeType.toLowerCase();
	if (CALENDAR_MIME_TYPES.has(mime) || /\.ics$/i.test(part.filename)) return "calendar_invite";
	if (mime.startsWith("image/") && part.hasContentId && part.disposition !== "attachment") {
		return "embedded_image";
	}
	return null;
}

/**
 * One discover item per attached file in a message, plus how many file-bearing parts
 * were left out (partExclusion). Pure: everything comes from the message as the API
 * served it plus the mailbox it was read from.
 *
 * `source_created_at` and `source_modified_at` are both the message date, because a
 * delivered message never changes; the same value is the content hash, so a re-listed
 * message is an unchanged no-op rather than a re-write (Drive's `md5 ?? modifiedTime`
 * convention, with no md5 to prefer).
 *
 * `owner` is the sender's display name (or their address when the From header has no
 * name) and `owner_email` their address, the same split the Drive envelope makes, so
 * "is this mine" reads the same way for both: a sent attachment's `owner_email` is the
 * mailbox's own address. The raw From header stays in `envelope.from`.
 */
export function attachmentItems(
	msg: GmailMessage,
	mailbox: string,
): { items: DiscoverItem[]; excluded: number } {
	const parts = listAttachmentParts(msg);
	const kept = parts.filter((part) => partExclusion(part) === null);
	const excluded = parts.length - kept.length;
	if (kept.length === 0) return { items: [], excluded };

	const from = messageHeader(msg, "From");
	const to = messageHeader(msg, "To");
	const subject = messageHeader(msg, "Subject");
	const date = messageHeader(msg, "Date");
	const sender = parseAddress(from);
	const sentAt = messageDate(msg, date);
	const items = kept.map((part) => ({
		// "root" for a single-part message whose whole body is the file (part id "").
		external_id: `${msg.id}:${part.partId || "root"}`,
		title: part.filename,
		url: messageUrl(mailbox, msg.id),
		owner: sender.name ?? sender.address ?? undefined,
		owner_email: sender.address ?? undefined,
		source_created_at: sentAt,
		source_modified_at: sentAt,
		content_hash: sentAt,
		mime_type: part.mimeType,
		size: part.size,
		envelope: {
			message_id: msg.id,
			thread_id: msg.threadId,
			part_id: part.partId,
			filename: part.filename,
			from,
			to,
			subject,
			date,
			inline: part.disposition === "inline",
			mailbox,
		},
	}));
	return { items, excluded };
}

/**
 * Where a connector's sweep has got to. Every run row records it once it is known, and
 * the next run reads it back from the newest row that carries one.
 */
type SweepState = {
	/**
	 * The head. Every message dated before this has been swept, bar any Gmail's search
	 * index had not yet made listable, which the next run's overlap re-lists.
	 */
	watermark: string;
	/**
	 * The backfill cursor. Every message dated from this up to the head has been swept;
	 * the history older than it has not been yet. null once the whole history is done.
	 */
	backfillBefore: string | null;
};

function isoOrNull(raw: unknown): string | null {
	if (typeof raw !== "string") return null;
	const ms = Date.parse(raw);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** The run-row keys a SweepState is recorded under. */
function stateCounts(state: SweepState): Record<string, string | boolean> {
	return {
		watermark: state.watermark,
		...(state.backfillBefore ? { backfill_before: state.backfillBefore } : { backfill_complete: true }),
	};
}

/**
 * The sweep state recorded by the newest scheduler_runs row for this connector that
 * carries one, or null when there is none (a first run).
 *
 * Read from error rows as well as ok ones, which is the one departure from the Drive
 * cadence's `status = 'ok'` lookup, and it is deliberate. A run records only progress it
 * has durably written (see sweepAccount), so a failed run's state is a safe place to
 * resume. Ignoring it would restart a failing backfill from the same message every run,
 * which is how the personal Drive sweep froze for weeks (#1207).
 */
async function readState(connector: string): Promise<SweepState | null> {
	const { data, error } = await supabase
		.from("scheduler_runs")
		.select("counts")
		.eq("cadence", "discover")
		.eq("connector", connector)
		.not("counts->>watermark", "is", null)
		.order("started_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (error) throw new Error(`gmail attachment watermark lookup failed: ${error.message}`);
	const counts = (data?.counts ?? null) as {
		watermark?: unknown;
		backfill_before?: unknown;
		backfill_complete?: unknown;
	} | null;
	const watermark = isoOrNull(counts?.watermark);
	if (!counts || !watermark) return null;
	if (counts.backfill_complete === true) return { watermark, backfillBefore: null };
	// Every row this sweep writes carries one of the two backfill keys. A row with
	// neither re-walks the history below the head: slower, never lossy.
	return { watermark, backfillBefore: isoOrNull(counts.backfill_before) ?? watermark };
}

/** One access token per sweep, re-minted before it expires rather than once per request. */
function sweepToken(account: GoogleAccount, refreshToken: string): () => Promise<string> {
	let token: string | null = null;
	let mintedAt = 0;
	return async () => {
		if (!token || Date.now() - mintedAt > TOKEN_TTL_MS) {
			token = await getGmailAccessToken(account, refreshToken);
			mintedAt = Date.now();
		}
		return token;
	};
}

const epochSeconds = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

async function listPage(
	account: GoogleAccount,
	query: string,
	pageToken: string | undefined,
	token: () => Promise<string>,
): Promise<{ ids: string[]; nextPageToken: string | null }> {
	return withBackoff(
		async () =>
			listMessageIds(account, query, {
				pageToken,
				maxResults: LIST_PAGE_SIZE,
				accessToken: await token(),
			}),
		{ label: "gmail messages.list", isRetryable: isRetryableGmailError },
	);
}

/**
 * The head window: every message id since the watermark (less the overlap), OLDEST
 * first. messages.list answers newest first (by internalDate, the date messageDate
 * reads first); a capped head has to work oldest first so that the watermark it leaves
 * behind means "everything before this has been swept".
 */
async function listHead(
	account: GoogleAccount,
	watermark: string,
	token: () => Promise<string>,
): Promise<string[]> {
	const query = `${ATTACHMENT_QUERY} after:${epochSeconds(watermark) - WATERMARK_OVERLAP_S}`;
	const ids: string[] = [];
	let pageToken: string | undefined;
	do {
		const page = await listPage(account, query, pageToken, token);
		ids.push(...page.ids);
		pageToken = page.nextPageToken ?? undefined;
	} while (pageToken);
	// A message arriving mid-listing can shift a page boundary and repeat an id.
	return [...new Set(ids)].reverse();
}

/**
 * Up to `want` message ids from below the backfill cursor, NEWEST first, and whether
 * that reached the bottom of the mailbox. Lists only as many pages as it needs, since
 * the history below the cursor can be most of the mailbox.
 *
 * `before:` is one second past the cursor, so a message sharing the cursor's second is
 * listed again rather than skipped; re-fetching a swept message is an unchanged no-op.
 */
async function listBackfill(
	account: GoogleAccount,
	before: string,
	want: number,
	token: () => Promise<string>,
): Promise<{ ids: string[]; exhausted: boolean }> {
	const query = `${ATTACHMENT_QUERY} before:${epochSeconds(before) + 1}`;
	const ids: string[] = [];
	const seen = new Set<string>();
	let pageToken: string | undefined;
	do {
		const page = await listPage(account, query, pageToken, token);
		for (const id of page.ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			ids.push(id);
		}
		pageToken = page.nextPageToken ?? undefined;
	} while (pageToken && ids.length < want);
	return { ids: ids.slice(0, want), exhausted: !pageToken && ids.length <= want };
}

type Tally = {
	scanned: number;
	drafts: number;
	attachments: number;
	excluded: number;
	inserted: number;
	updated: number;
	unchanged: number;
	skipped: number;
	vanished: number;
};

type SweepContext = {
	account: GoogleAccount;
	connector: string;
	mailbox: string;
	token: () => Promise<string>;
	tally: Tally;
};

/**
 * Fetch `ids` in the order given and write their attachments in batches. After each
 * batch has fully landed, `onWritten` gets the oldest and newest message date it
 * covered, so progress recorded from it is never progress that was not made. Every
 * fetched message counts, including a draft or one with nothing to point at: it has
 * been swept all the same.
 */
async function sweepMessages(
	ctx: SweepContext,
	ids: string[],
	onWritten: (oldest: string, newest: string) => void,
): Promise<void> {
	const { tally } = ctx;
	let pending: DiscoverItem[] = [];
	let oldest: string | null = null;
	let newest: string | null = null;

	const flush = async () => {
		for (const batch of chunk(pending, BATCH_SIZE)) {
			const counts = await executeAction(ingestDiscoverAction, { connector: ctx.connector, items: batch }, { context: { caller: "worker", userId: getCurrentUserId() } });
			tally.inserted += counts.inserted;
			tally.updated += counts.updated;
			tally.unchanged += counts.unchanged;
			tally.skipped += counts.skipped;
		}
		pending = [];
		if (oldest && newest) onWritten(oldest, newest);
		oldest = null;
		newest = null;
	};

	for (const id of ids) {
		let msg: GmailMessage;
		try {
			msg = await withBackoff(
				async () => getMessage(ctx.account, id, { accessToken: await ctx.token() }),
				{ label: "gmail messages.get", isRetryable: isRetryableGmailError },
			);
		} catch (err) {
			// Deleted between the list and the fetch: there is nothing left to point at.
			if (httpStatusOf(err) === 404) {
				tally.vanished += 1;
				continue;
			}
			throw err;
		}
		tally.scanned += 1;

		if (msg.labelIds?.includes(LABEL_DRAFT)) {
			tally.drafts += 1;
		} else {
			const { items, excluded } = attachmentItems(msg, ctx.mailbox);
			tally.attachments += items.length;
			tally.excluded += excluded;
			pending.push(...items);
		}

		const sentAt = messageDate(msg, messageHeader(msg, "Date"));
		if (sentAt) {
			if (!oldest || sentAt < oldest) oldest = sentAt;
			if (!newest || sentAt > newest) newest = sentAt;
		}
		if (pending.length >= BATCH_SIZE) await flush();
	}
	await flush();
}

/**
 * Sweep ONE account, with its own try/catch and its own run row, so a failure on one
 * account neither cancels the other's sweep nor leaves it unrecorded (the #857 shape).
 *
 * The state each run records (see SweepState):
 *   - the head watermark: the run's own start when the head window was swept to the
 *     end. When the budget stopped it, or it failed, the date of the newest message
 *     written, and never later than the run's start, so a message dated in the future
 *     cannot carry the watermark past mail that has not been swept yet.
 *   - the backfill cursor: the date of the oldest message the backfill wrote, or
 *     `backfill_complete` once the listing below the cursor ran out.
 * Both only move after the batch holding the message has landed, so a failed run
 * records the progress it made and no more, and the next run resumes from there.
 */
async function sweepAccount(account: GoogleAccount, refreshToken: string): Promise<void> {
	const connector = GMAIL_ATTACHMENT_CONNECTOR_BY_ACCOUNT[account];
	const startedAt = new Date();
	const start = startedAt.toISOString();
	const token = sweepToken(account, refreshToken);

	const tally: Tally = {
		scanned: 0,
		drafts: 0,
		attachments: 0,
		excluded: 0,
		inserted: 0,
		updated: 0,
		unchanged: 0,
		skipped: 0,
		vanished: 0,
	};
	let listed = 0;
	let capped = false;
	let backlog = 0;
	let backfilled = 0;
	// Null only until the prior state has been read, so a run that cannot even read it
	// records no state of its own and the next run reads the last good one.
	let state: SweepState | null = null;

	const counts = () => ({
		listed,
		scanned: tally.scanned,
		backfilled,
		drafts: tally.drafts,
		attachments: tally.attachments,
		excluded: tally.excluded,
		new: tally.inserted,
		changed: tally.updated,
		unchanged: tally.unchanged,
		skipped: tally.skipped,
		vanished: tally.vanished,
		capped,
		backlog,
		...(state ? stateCounts(state) : {}),
	});

	try {
		const prior = await readState(connector);
		// A first run has no head: it starts now, and everything older is backlog.
		const current: SweepState = prior ?? { watermark: start, backfillBefore: start };
		state = current;

		const { emailAddress: mailbox } = await withBackoff(
			async () => getProfile(account, { accessToken: await token() }),
			{ label: "gmail profile", isRetryable: isRetryableGmailError },
		);
		const ctx: SweepContext = { account, connector, mailbox, token, tally };
		let budget = env.gmailAttachmentDiscoverMaxMessages;

		// 1. The head: everything since the last run, oldest first, ahead of any history.
		if (prior) {
			const ids = await listHead(account, prior.watermark, token);
			listed = ids.length;
			const slice = ids.slice(0, budget);
			capped = slice.length < ids.length;
			backlog = ids.length - slice.length;
			budget -= slice.length;
			await sweepMessages(ctx, slice, (_oldest, newest) => {
				const reached = newest < start ? newest : start;
				if (reached > current.watermark) current.watermark = reached;
			});
			if (!capped) current.watermark = start;
		}

		// 2. The backfill: whatever budget the head left, spent on history, newest first.
		if (current.backfillBefore && budget > 0) {
			const { ids, exhausted } = await listBackfill(account, current.backfillBefore, budget, token);
			backfilled = ids.length;
			await sweepMessages(ctx, ids, (oldest) => {
				if (current.backfillBefore && oldest < current.backfillBefore) current.backfillBefore = oldest;
			});
			if (exhausted) current.backfillBefore = null;
		}

		await recordRun({ cadence: "discover", connector, startedAt, counts: counts() });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`gmail attachment discover cadence failed for account '${account}':`, message);
		await recordRun({ cadence: "discover", connector, startedAt, counts: counts(), error: message });
	}
}

/**
 * Sweep every WIRED Google account's mailbox, one at a time, when the owner has opted in
 * with KMS_GMAIL_ATTACHMENT_DISCOVER_ENABLED (see ./env.ts for why this connector has a
 * gate of its own when Drive and Notion do not).
 *
 * Account handling is the Drive cadence's (#857, #977), so the two cannot drift: wiring is
 * asked of the credential seam, an unwired account is skipped with no run row, any other
 * credential failure is recorded as a failed run and the loop moves on, and the resolved
 * refresh token is threaded through to the token mint instead of being resolved twice.
 * Sequential, not parallel: Gmail rate-limits per user and per project.
 */
export async function runGmailAttachmentDiscoverCadence(): Promise<void> {
	if (!env.gmailAttachmentDiscoverEnabled) return;

	for (const account of GOOGLE_ACCOUNTS) {
		const connector = GMAIL_ATTACHMENT_CONNECTOR_BY_ACCOUNT[account];
		let refreshToken: string;
		try {
			refreshToken = await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
		} catch (err) {
			if (err instanceof CredentialNotConfiguredError) continue;
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`gmail attachment discover cadence: credential resolution failed for account '${account}':`,
				message,
			);
			await recordRun({ cadence: "discover", connector, startedAt: new Date(), counts: {}, error: message });
			continue;
		}
		await sweepAccount(account, refreshToken);
	}
}
