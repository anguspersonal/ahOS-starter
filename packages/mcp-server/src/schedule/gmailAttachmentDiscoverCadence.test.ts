import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { discoverSchema } from "@ahkms/core";
import type { GmailMessage } from "../google/gmail.js";

/**
 * The Gmail attachment discover connector (#1210).
 *
 * The properties pinned here each fail silently rather than loudly, which is why they
 * are tests and not review notes:
 *
 *   1. The key is `<message_id>:<part_id>`, never the attachment id. Gmail's attachment
 *      id moves between fetches; a key built on it would re-insert every attachment each
 *      time a window is re-listed, and nothing would error.
 *   2. The pointer carries the envelope and nothing read out of the body (ADR-046 §2),
 *      and only for parts that are attached documents: embedded images and calendar
 *      invitations are counted, not pointed at.
 *   3. The whole mailbox is listed, not a label. A label-scoped listing loses received
 *      mail that is archived before the next run, silently.
 *   4. Each run sweeps the head (mail since the last run, oldest first) before the
 *      backfill (history, newest first), and each phase records only progress it has
 *      durably written. Get the order or the bookkeeping wrong and a run leaves a hole
 *      in the mailbox forever, or new mail waits weeks behind the history.
 *   5. Account handling is the Drive cadence's: wired accounts only, one credential
 *      resolution each, one account's failure never cancels the other.
 */

const mocks = vi.hoisted(() => ({
	env: { gmailAttachmentDiscoverEnabled: true, gmailAttachmentDiscoverMaxMessages: 1000 },
	getGmailAccessToken: vi.fn(),
	getMessage: vi.fn(),
	getProfile: vi.fn(),
	listMessageIds: vi.fn(),
	getCredential: vi.fn(),
	runDiscover: vi.fn(),
	recordRun: vi.fn(),
	maybeSingle: vi.fn(),
	backoffOptions: [] as { label?: string; isRetryable?: (err: unknown) => boolean }[],
}));

class CredentialNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialNotConfiguredError";
	}
}

vi.mock("./env.js", () => ({ env: mocks.env }));
vi.mock("../credentials.js", () => ({
	getCredential: (...a: unknown[]) => mocks.getCredential(...a),
	CredentialNotConfiguredError,
}));
// Keep the real pure helpers (listAttachmentParts, messageHeader, parseAddress) so the
// mapping is tested against the actual part walker; stub only what talks to Gmail.
vi.mock("../google/gmail.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../google/gmail.js")>();
	return {
		...actual,
		getGmailAccessToken: (...a: unknown[]) => mocks.getGmailAccessToken(...a),
		getMessage: (...a: unknown[]) => mocks.getMessage(...a),
		getProfile: (...a: unknown[]) => mocks.getProfile(...a),
		listMessageIds: (...a: unknown[]) => mocks.listMessageIds(...a),
	};
});
vi.mock("../tools/discover.js", () => ({
	ingestDiscoverAction: { id: "ingest_discover", schema: discoverSchema, run: (input: unknown) => mocks.runDiscover(input) },
}));
vi.mock("./runLog.js", () => ({ recordRun: (...a: unknown[]) => mocks.recordRun(...a) }));
// Pass-through backoff that records its options, so the Gmail-specific retry classifier
// can be asserted without sleeping through real retries.
vi.mock("../backoff.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../backoff.js")>();
	return {
		...actual,
		withBackoff: (fn: () => unknown, options: { label?: string; isRetryable?: (e: unknown) => boolean }) => {
			mocks.backoffOptions.push(options);
			return fn();
		},
	};
});

// A supabase stub whose chain ends at maybeSingle, matching readState. It RECORDS its
// filters: the per-connector lookup and the "has a watermark" filter are the whole
// point of the state tests, and a chain that swallowed its arguments would pass for a
// query it never inspected.
const eqCalls: [string, unknown][] = [];
const notCalls: [string, string, unknown][] = [];
vi.mock("../supabase.js", () => {
	const chain: Record<string, unknown> = {};
	for (const method of ["select", "order", "limit"]) chain[method] = () => chain;
	chain.eq = (column: string, value: unknown) => {
		eqCalls.push([column, value]);
		return chain;
	};
	chain.not = (column: string, op: string, value: unknown) => {
		notCalls.push([column, op, value]);
		return chain;
	};
	chain.maybeSingle = () => mocks.maybeSingle();
	return { supabase: { from: () => chain } };
});

const {
	runGmailAttachmentDiscoverCadence,
	attachmentItems,
	partExclusion,
	messageDate,
	messageUrl,
	ATTACHMENT_QUERY,
} = await import("./gmailAttachmentDiscoverCadence.js");

// ---- fixtures ------------------------------------------------------------------

type Part = NonNullable<GmailMessage["payload"]>;

function b64url(s: string): string {
	return Buffer.from(s, "utf-8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

const HEADERS = [
	{ name: "From", value: "Owner <owner@example.com>" },
	{ name: "To", value: "Recruiter <recruiter@example.com>" },
	{ name: "Subject", value: "Updated CV" },
	{ name: "Date", value: "Fri, 3 Nov 2023 10:17:52 +0000" },
];

function filePart(partId: string, filename: string, extra: Partial<Part> = {}): Part {
	return {
		partId,
		mimeType: "application/pdf",
		filename,
		headers: [{ name: "Content-Disposition", value: `attachment; filename="${filename}"` }],
		body: { size: 1000 + Number(partId.replace(/\D/g, "") || 0), attachmentId: `ephemeral-${partId}` },
		...extra,
	};
}

/** A multipart/mixed message: a text body the sweep must ignore, then the given files. */
function message(
	id: string,
	isoDate: string,
	files: Part[],
	over: { headers?: Part["headers"]; labelIds?: string[] } = {},
): GmailMessage {
	return {
		id,
		threadId: `thread-${id}`,
		labelIds: over.labelIds ?? ["INBOX"],
		internalDate: String(Date.parse(isoDate)),
		payload: {
			partId: "",
			mimeType: "multipart/mixed",
			filename: "",
			headers: over.headers ?? HEADERS,
			parts: [
				{ partId: "0", mimeType: "text/plain", filename: "", body: { size: 30, data: b64url("BODY TEXT never stored") } },
				...files,
			],
		},
	};
}

/** getMessage stub serving from a map of id -> message (a 404-shaped error when absent). */
function mailbox(messages: GmailMessage[]) {
	const byId = new Map(messages.map((m) => [m.id, m]));
	mocks.getMessage.mockImplementation(async (_account: string, id: string) => {
		const m = byId.get(id);
		if (!m) throw Object.assign(new Error(`Gmail API GET /messages/${id} failed (404): gone`), { status: 404 });
		return m;
	});
}

/**
 * messages.list, answering newest first as the API does, routed by query: the head
 * lists `after:`, the backfill `before:`. One page each.
 */
function listings({ head = [] as string[], backfill = [] as string[] }) {
	mocks.listMessageIds.mockImplementation(async (_account: string, query: string) => ({
		ids: query.includes(" after:") ? head : query.includes(" before:") ? backfill : [],
		nextPageToken: null,
	}));
}

const listQueries = () => mocks.listMessageIds.mock.calls.map((c) => c[1] as string);
const fetched = () => mocks.getMessage.mock.calls.map((c) => c[1] as string);

/** The state the previous run recorded, as readState finds it. */
function priorRun(counts: Record<string, unknown>) {
	mocks.maybeSingle.mockResolvedValue({ data: { counts }, error: null });
}

type RunRow = { connector: string; counts: Record<string, unknown>; error?: string };
const runRows = () => mocks.recordRun.mock.calls.map((c) => c[0] as RunRow);

/** google_personal -> "refresh-personal", google_work -> "refresh-work". */
const refreshFor = (provider: string) => `refresh-${provider.replace("google_", "")}`;

function onlyPersonalWired() {
	mocks.getCredential.mockImplementation(async (provider: string) => {
		if (provider === "google_personal") return refreshFor(provider);
		throw new CredentialNotConfiguredError(`${provider} not configured`);
	});
}

const NOW = new Date("2026-09-29T12:00:00.000Z");
const NOW_S = NOW.getTime() / 1000;
const LAST_RUN = "2026-09-28T12:00:00.000Z";
const CURSOR = "2023-06-01T00:00:00.000Z";
const epoch = (iso: string) => Date.parse(iso) / 1000;

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	eqCalls.length = 0;
	notCalls.length = 0;
	mocks.backoffOptions.length = 0;
	mocks.env.gmailAttachmentDiscoverEnabled = true;
	mocks.env.gmailAttachmentDiscoverMaxMessages = 1000;
	mocks.maybeSingle.mockResolvedValue({ data: null, error: null });
	mocks.getCredential.mockImplementation(async (provider: string) => refreshFor(provider));
	mocks.getGmailAccessToken.mockImplementation(async (account: string) => `access-${account}`);
	mocks.getProfile.mockImplementation(async (account: string) => ({
		emailAddress: `${account}@example.com`,
		messagesTotal: 10,
	}));
	mocks.runDiscover.mockImplementation(async (args: { items: unknown[] }) => ({
		inserted: args.items.length,
		updated: 0,
		unchanged: 0,
		skipped: 0,
		embedded: 0,
		embeddable: 0,
	}));
	mocks.recordRun.mockResolvedValue(undefined);
	listings({});
	mailbox([]);
});

afterEach(() => {
	vi.useRealTimers();
});

// ---- the gate ------------------------------------------------------------------

describe("runGmailAttachmentDiscoverCadence - the opt-in gate", () => {
	it("does nothing at all unless KMS_GMAIL_ATTACHMENT_DISCOVER_ENABLED is on", async () => {
		mocks.env.gmailAttachmentDiscoverEnabled = false;

		await runGmailAttachmentDiscoverCadence();

		expect(mocks.getCredential).not.toHaveBeenCalled();
		expect(mocks.listMessageIds).not.toHaveBeenCalled();
		expect(mocks.recordRun).not.toHaveBeenCalled();
	});
});

// ---- field mapping ---------------------------------------------------------------

describe("attachmentItems - envelope-only field mapping", () => {
	it("maps one attachment to one pointer carrying the envelope and nothing from the body", () => {
		const msg = message("m1", "2023-11-03T10:17:52.000Z", [filePart("1", "Owner CV.pdf")]);

		const { items, excluded } = attachmentItems(msg, "owner@example.com");

		expect(excluded).toBe(0);
		expect(items).toEqual([
			{
				external_id: "m1:1",
				title: "Owner CV.pdf",
				url: "https://mail.google.com/mail/?authuser=owner%40example.com#all/m1",
				owner: "Owner",
				owner_email: "owner@example.com",
				source_created_at: "2023-11-03T10:17:52.000Z",
				source_modified_at: "2023-11-03T10:17:52.000Z",
				content_hash: "2023-11-03T10:17:52.000Z",
				mime_type: "application/pdf",
				size: 1001,
				envelope: {
					message_id: "m1",
					thread_id: "thread-m1",
					part_id: "1",
					filename: "Owner CV.pdf",
					from: "Owner <owner@example.com>",
					to: "Recruiter <recruiter@example.com>",
					subject: "Updated CV",
					date: "Fri, 3 Nov 2023 10:17:52 +0000",
					inline: false,
					mailbox: "owner@example.com",
				},
			},
		]);
		// Envelope only (ADR-046 §2): the body is never copied onto the pointer.
		expect(JSON.stringify(items)).not.toContain("BODY TEXT");
		// The attachment handle changes on every fetch, so it is not stored at all.
		expect(JSON.stringify(items)).not.toContain("ephemeral-");
	});

	/**
	 * The duplicate report's owned-by-self tie-break (#1217) matches `owner_email`
	 * against the owner's identity emails and `owner` against their display name. The
	 * raw From header matches neither, so a sent attachment has to carry the bare
	 * address and name, the same split the Drive envelope makes.
	 */
	it("gives a SENT attachment the mailbox's own address as owner_email", () => {
		const msg = message("m1", "2023-11-03T10:17:52.000Z", [filePart("1", "cv.pdf")], {
			labelIds: ["SENT"],
			headers: [{ name: "From", value: '"Angus Hally" <owner@example.com>' }],
		});

		const [item] = attachmentItems(msg, "owner@example.com").items;

		expect(item.owner_email).toBe("owner@example.com");
		expect(item.owner).toBe("Angus Hally");
		expect(item.envelope?.from).toBe('"Angus Hally" <owner@example.com>');
	});

	it("uses the address as the owner when the From header carries no display name", () => {
		const msg = message("m1", "2023-11-03T10:17:52.000Z", [filePart("1", "cv.pdf")], {
			headers: [{ name: "From", value: "sender@example.com" }],
		});

		const [item] = attachmentItems(msg, "owner@example.com").items;

		expect(item.owner).toBe("sender@example.com");
		expect(item.owner_email).toBe("sender@example.com");
	});

	it("gives a message with several attachments one pointer each, keyed by part id", () => {
		const msg = message("m2", "2024-07-05T09:00:00.000Z", [
			filePart("1", "cv.pdf"),
			filePart("2", "cv.docx", {
				mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
			}),
			// A document shown inline (Apple Mail does this) is still a document.
			filePart("3", "terms.pdf", {
				headers: [{ name: "Content-Disposition", value: 'inline; filename="terms.pdf"' }],
			}),
		]);

		const { items } = attachmentItems(msg, "owner@example.com");

		expect(items.map((i) => i.external_id)).toEqual(["m2:1", "m2:2", "m2:3"]);
		expect(items.map((i) => i.title)).toEqual(["cv.pdf", "cv.docx", "terms.pdf"]);
		expect(items.map((i) => i.envelope?.inline)).toEqual([false, false, true]);
		// Every pointer points back at the same message.
		expect(new Set(items.map((i) => i.url)).size).toBe(1);
	});

	it("keys on the part id, so a re-fetch that mints a new attachment id is the same pointer", () => {
		const first = attachmentItems(
			message("m1", "2023-11-03T10:17:52.000Z", [filePart("1", "cv.pdf")]),
			"owner@example.com",
		).items;
		const refetched = attachmentItems(
			message("m1", "2023-11-03T10:17:52.000Z", [
				filePart("1", "cv.pdf", { body: { size: 1001, attachmentId: "a-different-handle" } }),
			]),
			"owner@example.com",
		).items;

		expect(refetched).toEqual(first);
	});

	it("keys a single-part message whose whole body is the file as 'root'", () => {
		const msg: GmailMessage = {
			id: "m3",
			threadId: "t3",
			internalDate: String(Date.parse("2022-09-05T08:00:00.000Z")),
			payload: {
				partId: "",
				mimeType: "application/pdf",
				filename: "scan.pdf",
				headers: HEADERS,
				body: { size: 5, attachmentId: "x" },
			},
		};

		expect(attachmentItems(msg, "owner@example.com").items.map((i) => i.external_id)).toEqual(["m3:root"]);
	});

	it("returns nothing for a message with no file-bearing part", () => {
		expect(attachmentItems(message("m4", "2024-01-01T00:00:00.000Z", []), "owner@example.com")).toEqual({
			items: [],
			excluded: 0,
		});
	});
});

describe("attachmentItems - parts that are not attached documents", () => {
	const image = (partId: string, filename: string, headers: { name: string; value: string }[]) =>
		filePart(partId, filename, { mimeType: "image/png", headers });

	/**
	 * A signature logo rides on every message of a thread that quotes it. Pointed at,
	 * each would be one more `image001.png` embedded vector, and those families would
	 * crowd the real document families out of the duplicate report (#1217).
	 */
	it("counts embedded images (an image with a Content-ID not marked attachment) and points at none", () => {
		const msg = message("m1", "2024-01-01T00:00:00.000Z", [
			filePart("1", "cv.pdf"),
			{
				partId: "2",
				mimeType: "multipart/related",
				filename: "",
				parts: [
					image("2.1", "image001.png", [
						{ name: "Content-Disposition", value: 'inline; filename="image001.png"' },
						{ name: "Content-ID", value: "<image001.png@01DA>" },
					]),
					// Some clients declare no disposition at all on an embedded image.
					image("2.2", "logo.png", [{ name: "Content-ID", value: "<logo@example>" }]),
				],
			},
		]);

		const { items, excluded } = attachmentItems(msg, "owner@example.com");

		expect(items.map((i) => i.title)).toEqual(["cv.pdf"]);
		expect(excluded).toBe(2);
	});

	it("keeps an image the sender attached, even though Gmail gives it a Content-ID too", () => {
		const msg = message("m1", "2024-01-01T00:00:00.000Z", [
			image("1", "passport.png", [
				{ name: "Content-Disposition", value: 'attachment; filename="passport.png"' },
				{ name: "Content-ID", value: "<f_lx1>" },
			]),
			// Inline but with no Content-ID: nothing in the body can embed it.
			image("2", "photo.png", [{ name: "Content-Disposition", value: "inline" }]),
		]);

		const { items, excluded } = attachmentItems(msg, "owner@example.com");

		expect(items.map((i) => i.title)).toEqual(["passport.png", "photo.png"]);
		expect(excluded).toBe(0);
	});

	it("counts calendar invitations and points at none", () => {
		const msg = message("m1", "2024-01-01T00:00:00.000Z", [
			filePart("1", "invite.ics", { mimeType: "application/ics" }),
			filePart("2", "meeting", { mimeType: "text/calendar" }),
			filePart("3", "event.ICS", { mimeType: "application/octet-stream" }),
			filePart("4", "agenda.pdf"),
		]);

		const { items, excluded } = attachmentItems(msg, "owner@example.com");

		expect(items.map((i) => i.title)).toEqual(["agenda.pdf"]);
		expect(excluded).toBe(3);
	});

	it("names the reason for each exclusion, and none for a document", () => {
		const part = {
			partId: "1",
			filename: "x",
			mimeType: "application/pdf",
			size: 1,
			attachmentId: null,
			disposition: "attachment",
			hasContentId: false,
		};
		expect(partExclusion(part)).toBeNull();
		expect(partExclusion({ ...part, mimeType: "image/jpeg", disposition: null, hasContentId: true })).toBe(
			"embedded_image",
		);
		expect(partExclusion({ ...part, mimeType: "Text/Calendar" })).toBe("calendar_invite");
	});
});

describe("messageDate / messageUrl", () => {
	it("prefers Gmail's internalDate, falls back to the Date header, and never guesses", () => {
		const withInternal: GmailMessage = { id: "a", threadId: "t", internalDate: "1699006672000" };
		expect(messageDate(withInternal, "garbage")).toBe("2023-11-03T10:17:52.000Z");

		const headerOnly: GmailMessage = { id: "a", threadId: "t" };
		expect(messageDate(headerOnly, "Fri, 3 Nov 2023 10:17:52 +0000")).toBe("2023-11-03T10:17:52.000Z");
		expect(messageDate(headerOnly, "not a date")).toBeUndefined();
	});

	it("opens the message in the mailbox it came from, not whichever is signed in first", () => {
		expect(messageUrl("work@example.com", "m1")).toBe(
			"https://mail.google.com/mail/?authuser=work%40example.com#all/m1",
		);
		// getProfile's "(unknown)" fallback cannot address a mailbox; degrade to the default.
		expect(messageUrl("(unknown)", "m1")).toBe("https://mail.google.com/mail/u/0/#all/m1");
	});
});

// ---- the sweep -------------------------------------------------------------------

describe("runGmailAttachmentDiscoverCadence - which accounts run", () => {
	it("sweeps only the accounts the credential seam reports as wired, under their own connectors", async () => {
		onlyPersonalWired();
		listings({ backfill: ["m1"] });
		mailbox([message("m1", "2023-11-03T10:17:52.000Z", [filePart("1", "cv.pdf")])]);

		await runGmailAttachmentDiscoverCadence();

		expect(mocks.listMessageIds.mock.calls.map((c) => c[0])).toEqual(["personal"]);
		expect(runRows().map((r) => r.connector)).toEqual(["gmail_attachment"]);
	});

	it("sweeps both accounts when both are wired, each under its own connector", async () => {
		listings({ backfill: ["m1"] });
		mailbox([message("m1", "2023-11-03T10:17:52.000Z", [filePart("1", "cv.pdf")])]);

		await runGmailAttachmentDiscoverCadence();

		expect(mocks.runDiscover.mock.calls.map((c) => (c[0] as { connector: string }).connector)).toEqual([
			"gmail_attachment",
			"gmail_attachment_work",
		]);
		expect(runRows().map((r) => r.connector)).toEqual(["gmail_attachment", "gmail_attachment_work"]);
	});

	it("writes no run row at all when nothing is wired", async () => {
		mocks.getCredential.mockImplementation(async (provider: string) => {
			throw new CredentialNotConfiguredError(`${provider} not configured`);
		});

		await runGmailAttachmentDiscoverCadence();

		expect(mocks.listMessageIds).not.toHaveBeenCalled();
		expect(mocks.recordRun).not.toHaveBeenCalled();
	});

	/**
	 * One credential resolution per account (#977), threaded to the token mint, and one
	 * token per sweep rather than one OAuth round-trip per message fetched.
	 */
	it("resolves each credential once and mints one access token per sweep, not per message", async () => {
		onlyPersonalWired();
		listings({ backfill: ["m3", "m2", "m1"] });
		mailbox([
			message("m1", "2023-01-01T00:00:00.000Z", [filePart("1", "a.pdf")]),
			message("m2", "2023-01-02T00:00:00.000Z", [filePart("1", "b.pdf")]),
			message("m3", "2023-01-03T00:00:00.000Z", [filePart("1", "c.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(mocks.getCredential).toHaveBeenCalledTimes(2);
		expect(mocks.getGmailAccessToken).toHaveBeenCalledTimes(1);
		expect(mocks.getGmailAccessToken).toHaveBeenCalledWith("personal", "refresh-personal");
		expect(mocks.getMessage).toHaveBeenCalledTimes(3);
		for (const call of mocks.getMessage.mock.calls) {
			expect(call[2]).toEqual({ accessToken: "access-personal" });
		}
	});
});

describe("runGmailAttachmentDiscoverCadence - what is swept", () => {
	/**
	 * The whole mailbox, not INBOX + SENT. ahOS's own gmail_automations archives the
	 * threads the owner has processed; an `in:inbox` listing would never see a received
	 * attachment whose thread was archived before the next daily run.
	 */
	it("lists every message with an attachment, with no label clause", async () => {
		onlyPersonalWired();

		await runGmailAttachmentDiscoverCadence();

		expect(ATTACHMENT_QUERY).toBe("has:attachment");
		expect(listQueries()).toEqual([`has:attachment before:${NOW_S + 1}`]);
	});

	it("skips a draft, counting it, since it gets a new message id each time it is saved", async () => {
		onlyPersonalWired();
		listings({ backfill: ["d1", "m1"] });
		mailbox([
			message("m1", "2023-01-01T00:00:00.000Z", [filePart("1", "a.pdf")]),
			message("d1", "2023-01-02T00:00:00.000Z", [filePart("1", "draft.pdf")], { labelIds: ["DRAFT"] }),
		]);

		await runGmailAttachmentDiscoverCadence();

		const written = mocks.runDiscover.mock.calls.flatMap((c) =>
			(c[0] as { items: { title: string }[] }).items.map((i) => i.title),
		);
		expect(written).toEqual(["a.pdf"]);
		expect(runRows()[0].counts).toMatchObject({ scanned: 2, drafts: 1, attachments: 1 });
	});

	it("records how many parts were left out as not attached documents", async () => {
		onlyPersonalWired();
		listings({ backfill: ["m1"] });
		mailbox([
			message("m1", "2023-01-01T00:00:00.000Z", [
				filePart("1", "a.pdf"),
				filePart("2", "invite.ics", { mimeType: "application/ics" }),
			]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(runRows()[0].counts).toMatchObject({ attachments: 1, excluded: 1 });
	});
});

describe("runGmailAttachmentDiscoverCadence - head and backfill", () => {
	it("a first run has no head: it backfills from now, newest first, and records both positions", async () => {
		onlyPersonalWired();
		listings({ backfill: ["m2", "m1"] });
		mailbox([
			message("m1", "2023-11-03T10:17:52.000Z", [filePart("1", "cv.pdf")]),
			message("m2", "2024-07-05T09:00:00.000Z", [filePart("1", "cv2.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(listQueries()).toEqual([`has:attachment before:${NOW_S + 1}`]);
		expect(fetched()).toEqual(["m2", "m1"]);
		expect(runRows()[0].counts).toMatchObject({
			listed: 0,
			backfilled: 2,
			scanned: 2,
			attachments: 2,
			new: 2,
			capped: false,
			watermark: NOW.toISOString(),
			// The listing ran out below the budget: the whole history is swept.
			backfill_complete: true,
		});
		expect(runRows()[0].counts).not.toHaveProperty("backfill_before");
		expect(runRows()[0].error).toBeUndefined();
	});

	/**
	 * The bounded first run. The backfill takes the NEWEST history first, so a CV sent
	 * last month is searchable after the first run, and it records the oldest date it
	 * wrote so the next run carries on below it.
	 */
	it("a first run over its budget sweeps the newest history and leaves a cursor at the oldest it wrote", async () => {
		onlyPersonalWired();
		mocks.env.gmailAttachmentDiscoverMaxMessages = 2;
		listings({ backfill: ["m3", "m2", "m1"] });
		mailbox([
			message("m1", "2023-01-01T00:00:00.000Z", [filePart("1", "a.pdf")]),
			message("m2", "2023-01-02T00:00:00.000Z", [filePart("1", "b.pdf")]),
			message("m3", "2023-01-03T00:00:00.000Z", [filePart("1", "c.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(fetched()).toEqual(["m3", "m2"]);
		expect(runRows()[0].counts).toMatchObject({
			backfilled: 2,
			watermark: NOW.toISOString(),
			backfill_before: "2023-01-02T00:00:00.000Z",
		});
		expect(runRows()[0].counts).not.toHaveProperty("backfill_complete");
	});

	it("a later run sweeps the head since the watermark (less an hour) first, then carries the backfill on", async () => {
		onlyPersonalWired();
		priorRun({ watermark: LAST_RUN, backfill_before: CURSOR });
		listings({ head: ["h2", "h1"], backfill: ["b1"] });
		mailbox([
			message("h1", "2026-09-28T15:00:00.000Z", [filePart("1", "h1.pdf")]),
			message("h2", "2026-09-29T09:00:00.000Z", [filePart("1", "h2.pdf")]),
			message("b1", "2023-05-01T00:00:00.000Z", [filePart("1", "b1.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(listQueries()).toEqual([
			`has:attachment after:${epoch(LAST_RUN) - 3600}`,
			`has:attachment before:${epoch(CURSOR) + 1}`,
		]);
		// Head oldest first, then history.
		expect(fetched()).toEqual(["h1", "h2", "b1"]);
		expect(runRows()[0].counts).toMatchObject({
			listed: 2,
			backfilled: 1,
			capped: false,
			watermark: NOW.toISOString(),
			backfill_complete: true,
		});
	});

	it("gives the backfill only the budget the head left", async () => {
		onlyPersonalWired();
		mocks.env.gmailAttachmentDiscoverMaxMessages = 3;
		priorRun({ watermark: LAST_RUN, backfill_before: CURSOR });
		listings({ head: ["h2", "h1"], backfill: ["b3", "b2", "b1"] });
		mailbox([
			message("h1", "2026-09-28T15:00:00.000Z", [filePart("1", "h1.pdf")]),
			message("h2", "2026-09-29T09:00:00.000Z", [filePart("1", "h2.pdf")]),
			message("b1", "2023-03-01T00:00:00.000Z", [filePart("1", "b1.pdf")]),
			message("b2", "2023-04-01T00:00:00.000Z", [filePart("1", "b2.pdf")]),
			message("b3", "2023-05-01T00:00:00.000Z", [filePart("1", "b3.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(fetched()).toEqual(["h1", "h2", "b3"]);
		expect(runRows()[0].counts).toMatchObject({
			watermark: NOW.toISOString(),
			backfill_before: "2023-05-01T00:00:00.000Z",
		});
	});

	/**
	 * A head over its budget works oldest first and records the newest date it wrote.
	 * Taking the newest instead would record a watermark past every message it skipped:
	 * a silent hole in the mailbox. The backfill waits; its cursor is carried unchanged.
	 */
	it("a head over its budget sweeps its oldest messages, resumes after the last one written, and defers the backfill", async () => {
		onlyPersonalWired();
		mocks.env.gmailAttachmentDiscoverMaxMessages = 2;
		priorRun({ watermark: LAST_RUN, backfill_before: CURSOR });
		listings({ head: ["h3", "h2", "h1"], backfill: ["b1"] });
		mailbox([
			message("h1", "2026-09-28T13:00:00.000Z", [filePart("1", "a.pdf")]),
			message("h2", "2026-09-28T14:00:00.000Z", [filePart("1", "b.pdf")]),
			message("h3", "2026-09-28T15:00:00.000Z", [filePart("1", "c.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(fetched()).toEqual(["h1", "h2"]);
		expect(listQueries()).toHaveLength(1);
		expect(runRows()[0].counts).toMatchObject({
			listed: 3,
			scanned: 2,
			backfilled: 0,
			capped: true,
			backlog: 1,
			watermark: "2026-09-28T14:00:00.000Z",
			backfill_before: CURSOR,
		});
		expect(runRows()[0].error).toBeUndefined();
	});

	/**
	 * Imported mail can carry a future internalDate. A capped head that wrote one must
	 * not record it as the watermark: every later run would list only after it, past
	 * mail that has not been swept yet.
	 */
	it("never records a head watermark later than the run's own start", async () => {
		onlyPersonalWired();
		mocks.env.gmailAttachmentDiscoverMaxMessages = 2;
		priorRun({ watermark: LAST_RUN, backfill_before: CURSOR });
		listings({ head: ["f2", "f1", "h1"] });
		mailbox([
			message("h1", "2026-09-28T13:00:00.000Z", [filePart("1", "a.pdf")]),
			message("f1", "2031-01-01T00:00:00.000Z", [filePart("1", "b.pdf")]),
			message("f2", "2031-01-02T00:00:00.000Z", [filePart("1", "c.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(fetched()).toEqual(["h1", "f1"]);
		expect(runRows()[0].counts).toMatchObject({ capped: true, watermark: NOW.toISOString() });
	});

	it("lists no history once the backfill is complete", async () => {
		onlyPersonalWired();
		priorRun({ watermark: LAST_RUN, backfill_complete: true });

		await runGmailAttachmentDiscoverCadence();

		expect(listQueries()).toEqual([`has:attachment after:${epoch(LAST_RUN) - 3600}`]);
		expect(runRows()[0].counts).toMatchObject({ watermark: NOW.toISOString(), backfill_complete: true });
	});

	it("re-walks the history below the head when a row carries a watermark but no backfill state", async () => {
		onlyPersonalWired();
		priorRun({ watermark: LAST_RUN });

		await runGmailAttachmentDiscoverCadence();

		expect(listQueries()).toEqual([
			`has:attachment after:${epoch(LAST_RUN) - 3600}`,
			`has:attachment before:${epoch(LAST_RUN) + 1}`,
		]);
	});

	/**
	 * Per connector: a successful personal sweep must never move Work's position, or
	 * every Work message in between is never seen. And only rows that carry a
	 * watermark count, so a credential-failure row (no counts) cannot reset it.
	 */
	it("reads the state per connector, from the newest run row that carries a watermark", async () => {
		await runGmailAttachmentDiscoverCadence();

		expect(eqCalls.filter(([c]) => c === "connector").map(([, v]) => v)).toEqual([
			"gmail_attachment",
			"gmail_attachment_work",
		]);
		expect(eqCalls).toContainEqual(["cadence", "discover"]);
		expect(notCalls).toEqual([
			["counts->>watermark", "is", null],
			["counts->>watermark", "is", null],
		]);
	});

	it("pages through the whole head listing before fetching anything", async () => {
		onlyPersonalWired();
		priorRun({ watermark: LAST_RUN, backfill_complete: true });
		mocks.listMessageIds
			.mockResolvedValueOnce({ ids: ["h3", "h2"], nextPageToken: "page-2" })
			.mockResolvedValueOnce({ ids: ["h1"], nextPageToken: null });
		mailbox([
			message("h1", "2026-09-28T13:00:00.000Z", [filePart("1", "a.pdf")]),
			message("h2", "2026-09-28T14:00:00.000Z", [filePart("1", "b.pdf")]),
			message("h3", "2026-09-28T15:00:00.000Z", [filePart("1", "c.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(mocks.listMessageIds.mock.calls[1][2]).toMatchObject({ pageToken: "page-2" });
		expect(fetched()).toEqual(["h1", "h2", "h3"]);
	});

	it("lists only as many history pages as the budget needs", async () => {
		onlyPersonalWired();
		mocks.env.gmailAttachmentDiscoverMaxMessages = 2;
		mocks.listMessageIds
			.mockResolvedValueOnce({ ids: ["m4"], nextPageToken: "page-2" })
			.mockResolvedValueOnce({ ids: ["m3", "m2"], nextPageToken: "page-3" });
		mailbox([
			message("m3", "2023-01-03T00:00:00.000Z", [filePart("1", "c.pdf")]),
			message("m4", "2023-01-04T00:00:00.000Z", [filePart("1", "d.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(mocks.listMessageIds).toHaveBeenCalledTimes(2);
		expect(fetched()).toEqual(["m4", "m3"]);
		expect(runRows()[0].counts).toMatchObject({ backfill_before: "2023-01-03T00:00:00.000Z" });
	});
});

describe("runGmailAttachmentDiscoverCadence - batching and failure", () => {
	it("hands runDiscover at most 200 items per call", async () => {
		onlyPersonalWired();
		const many = Array.from({ length: 250 }, (_, i) => filePart(String(i + 1), `f${i + 1}.pdf`));
		listings({ backfill: ["m1"] });
		mailbox([message("m1", "2023-01-01T00:00:00.000Z", many)]);

		await runGmailAttachmentDiscoverCadence();

		expect(mocks.runDiscover.mock.calls.map((c) => (c[0] as { items: unknown[] }).items.length)).toEqual([
			200, 50,
		]);
		expect(runRows()[0].counts).toMatchObject({ attachments: 250, new: 250 });
	});

	it("skips a message deleted between the list and the fetch, and still succeeds", async () => {
		onlyPersonalWired();
		listings({ backfill: ["m2", "gone", "m1"] });
		mailbox([
			message("m1", "2023-01-01T00:00:00.000Z", [filePart("1", "a.pdf")]),
			message("m2", "2023-01-03T00:00:00.000Z", [filePart("1", "c.pdf")]),
		]);

		await runGmailAttachmentDiscoverCadence();

		expect(runRows()[0].error).toBeUndefined();
		expect(runRows()[0].counts).toMatchObject({ scanned: 2, vanished: 1, attachments: 2 });
	});

	/**
	 * #1207's lesson applied here: a failure records the progress already written, so the
	 * next run resumes after it. Here the first head message fills a whole batch
	 * (written), then the second fetch fails for good. The backfill cursor is untouched.
	 */
	it("a run failing in the head records the head progress it durably wrote, and no further", async () => {
		onlyPersonalWired();
		priorRun({ watermark: LAST_RUN, backfill_before: CURSOR });
		const full = Array.from({ length: 200 }, (_, i) => filePart(String(i + 1), `f${i + 1}.pdf`));
		listings({ head: ["h3", "h2", "h1"] });
		mocks.getMessage.mockImplementation(async (_a: string, id: string) => {
			if (id === "h1") return message("h1", "2026-09-28T13:00:00.000Z", full);
			throw Object.assign(new Error("Gmail API GET failed (500): backend error"), { status: 500 });
		});

		await runGmailAttachmentDiscoverCadence();

		const row = runRows()[0];
		expect(row.error).toContain("backend error");
		expect(row.counts).toMatchObject({
			new: 200,
			watermark: "2026-09-28T13:00:00.000Z",
			backfill_before: CURSOR,
		});
	});

	it("a run failing in the backfill keeps the finished head and the history it durably wrote", async () => {
		onlyPersonalWired();
		priorRun({ watermark: LAST_RUN, backfill_before: CURSOR });
		const full = Array.from({ length: 200 }, (_, i) => filePart(String(i + 1), `f${i + 1}.pdf`));
		listings({ head: [], backfill: ["b2", "b1"] });
		mocks.getMessage.mockImplementation(async (_a: string, id: string) => {
			if (id === "b2") return message("b2", "2023-05-01T00:00:00.000Z", full);
			throw Object.assign(new Error("Gmail API GET failed (500): backend error"), { status: 500 });
		});

		await runGmailAttachmentDiscoverCadence();

		const row = runRows()[0];
		expect(row.error).toContain("backend error");
		expect(row.counts).toMatchObject({
			watermark: NOW.toISOString(),
			backfill_before: "2023-05-01T00:00:00.000Z",
		});
	});

	it("a run that fails before writing anything records its starting position unchanged", async () => {
		onlyPersonalWired();
		priorRun({ watermark: LAST_RUN, backfill_before: CURSOR });
		listings({ head: ["h1"] });
		mocks.getMessage.mockRejectedValue(Object.assign(new Error("insufficient scope"), { status: 403 }));

		await runGmailAttachmentDiscoverCadence();

		expect(runRows()[0].error).toContain("insufficient scope");
		expect(runRows()[0].counts).toMatchObject({ watermark: LAST_RUN, backfill_before: CURSOR });
	});

	it("a run that cannot read its prior state records none, so the last good one still stands", async () => {
		onlyPersonalWired();
		mocks.maybeSingle.mockResolvedValue({ data: null, error: { message: "statement timeout" } });

		await runGmailAttachmentDiscoverCadence();

		expect(runRows()[0].error).toContain("statement timeout");
		expect(runRows()[0].counts).not.toHaveProperty("watermark");
		expect(runRows()[0].counts).not.toHaveProperty("backfill_before");
		expect(mocks.listMessageIds).not.toHaveBeenCalled();
	});

	it("a failure on one account still sweeps the other and records both outcomes", async () => {
		mocks.listMessageIds.mockImplementation(async (account: string) => {
			if (account === "personal") throw new Error("personal token revoked");
			return { ids: [], nextPageToken: null };
		});

		await runGmailAttachmentDiscoverCadence();

		const rows = runRows();
		expect(rows.map((r) => r.connector)).toEqual(["gmail_attachment", "gmail_attachment_work"]);
		expect(rows[0].error).toContain("personal token revoked");
		expect(rows[1].error).toBeUndefined();
	});

	it("a non-'not configured' credential failure records a failed run and does not stop the other account", async () => {
		mocks.getCredential.mockImplementation(async (provider: string) => {
			if (provider === "google_personal") throw new Error("vault timeout");
			return refreshFor(provider);
		});

		await runGmailAttachmentDiscoverCadence();

		expect(mocks.listMessageIds.mock.calls.map((c) => c[0])).toEqual(["work"]);
		const rows = runRows();
		expect(rows).toContainEqual(
			expect.objectContaining({ connector: "gmail_attachment", error: expect.stringContaining("vault timeout") }),
		);
		expect(rows.find((r) => r.connector === "gmail_attachment_work")?.error).toBeUndefined();
	});

	/**
	 * Gmail throttles as 429 and ALSO as 403 rateLimitExceeded; the default classifier
	 * retries only the first. Any other 403 (a missing scope) must not be retried.
	 */
	it("retries Gmail's 403 rate-limit shape as well as 429/5xx, and nothing else", async () => {
		onlyPersonalWired();
		listings({ backfill: ["m1"] });
		mailbox([message("m1", "2023-01-01T00:00:00.000Z", [filePart("1", "a.pdf")])]);

		await runGmailAttachmentDiscoverCadence();

		const isRetryable = mocks.backoffOptions.find((o) => o.label === "gmail messages.get")?.isRetryable;
		expect(isRetryable).toBeDefined();
		const err = (status: number, text: string) => Object.assign(new Error(text), { status });
		expect(isRetryable!(err(429, "too many"))).toBe(true);
		expect(isRetryable!(err(503, "backend"))).toBe(true);
		expect(isRetryable!(err(403, '{"reason": "userRateLimitExceeded"}'))).toBe(true);
		expect(isRetryable!(err(403, '{"reason": "insufficientPermissions"}'))).toBe(false);
		expect(isRetryable!(err(404, "gone"))).toBe(false);
	});
});
