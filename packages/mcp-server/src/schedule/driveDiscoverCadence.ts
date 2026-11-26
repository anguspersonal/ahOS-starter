import { getDrive } from "../google/drive.js";
import { withBackoff } from "../backoff.js";
import { supabase } from "../supabase.js";
import { CredentialNotConfiguredError, getCredential } from "../credentials.js";
import {
	GOOGLE_ACCOUNTS,
	GOOGLE_ACCOUNT_PROVIDER,
	type GoogleAccount,
} from "../google/accounts.js";
import {
	createDriveChangesListAction,
	DRIVE_CONNECTOR_BY_ACCOUNT,
	executeAction,
	LEGACY_DOMAIN_VALUE,
	type DriveChangeEntry,
	type DriveChangesListOutput,
	type DriveChangesPageResult,
	type DriveDiscoverSweepOptions,
	type RawDriveChange,
	type StoredDriveWatchChannel,
} from "@ahkms/core";
import {
	createSupabaseDriveWatchPersistence,
	type DriveWatchSupabaseClient,
} from "@ahkms/core/adapters";
import { getCurrentUserId } from "../identity.js";
import { ingestDiscoverAction, softArchiveSourceTrashed } from "../tools/discover.js";
import { recordRun } from "./runLog.js";
import { chunk } from "./chunk.js";

// Re-exported for callers/tests that already import chunk from this module.
export { chunk } from "./chunk.js";

// Scheduled discover cadence for Google Drive (ADR-016 Slice 3, #53). Lists
// changed-or-new files across the whole account (My Drive + shared drives, not
// just default_folder_id — the goal is inventorying the estate, not one folder)
// and hands them to `ingest_discover`'s write side in batches.
//
// Scope, deliberately kept minimal per #53's grill:
//   - Incremental via `modifiedTime > <last successful run>`, not Drive's
//     changes.list API. Deletions are NOT detected (a removed file's pointer is
//     never cleaned up) — tracked as a known gap, not this issue's job.
//   - content_hash = md5Checksum ?? modifiedTime, matching the enrich read
//     adapter's convention (packages/mcp-server/src/tools/enrich/adapters.ts)
//     so re-discovery diffing stays aligned with what ingest_enrich_next expects.
//   - mimeType, size and parents ride along (#1228): envelope field-copies from the
//     same listing response (ADR-046 §2), no extra request. They are what tells a
//     folder from a document and another person's shared file from the owner's own.

const DISCOVER_FIELDS =
	"nextPageToken, files(id, name, mimeType, size, parents, modifiedTime, createdTime, owners(displayName,emailAddress), webViewLink, md5Checksum, trashed)";
// ingest_discover caps a single call at 200 items.
const BATCH_SIZE = 200;

type DriveFile = {
	id: string;
	name: string;
	mimeType?: string | null;
	/** int64 serialised as a decimal string by the Drive API; absent on Google-native files. */
	size?: string | null;
	parents?: string[] | null;
	modifiedTime?: string | null;
	createdTime?: string | null;
	owners?: Array<{ displayName?: string | null; emailAddress?: string | null }> | null;
	webViewLink?: string | null;
	md5Checksum?: string | null;
};

/** Drive's decimal-string size as a byte count, or undefined when absent or malformed. */
function parseSize(size: string | null | undefined): number | undefined {
	if (!size || !/^\d+$/.test(size)) return undefined;
	const n = Number(size);
	return Number.isSafeInteger(n) ? n : undefined;
}

function toDiscoverItem(f: DriveFile) {
	const owner = f.owners?.[0];
	return {
		external_id: f.id,
		title: f.name,
		url: f.webViewLink ?? undefined,
		owner: owner?.displayName ?? undefined,
		owner_email: owner?.emailAddress ?? undefined,
		mime_type: f.mimeType ?? undefined,
		size: parseSize(f.size),
		parents: f.parents ?? undefined,
		source_created_at: f.createdTime ?? undefined,
		source_modified_at: f.modifiedTime ?? undefined,
		content_hash: f.md5Checksum ?? f.modifiedTime ?? undefined,
	};
}

async function lastSuccessfulRunAt(connector: string): Promise<string | null> {
	const { data, error } = await supabase
		.from("scheduler_runs")
		.select("started_at")
		.eq("cadence", "discover")
		.eq("connector", connector)
		.eq("status", "ok")
		.order("started_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (error) throw new Error(`lastSuccessfulRunAt lookup failed: ${error.message}`);
	return data?.started_at ?? null;
}

/**
 * The newest partial-progress watermark a FAILED run recorded for this connector
 * (#1207), or null. Only error rows carry `counts.watermark`: an ok run's
 * watermark is its own `started_at`, read by lastSuccessfulRunAt above.
 */
async function lastPartialWatermark(connector: string): Promise<string | null> {
	const { data, error } = await supabase
		.from("scheduler_runs")
		.select("counts")
		.eq("cadence", "discover")
		.eq("connector", connector)
		.eq("status", "error")
		.not("counts->>watermark", "is", null)
		.order("started_at", { ascending: false })
		.limit(1)
		.maybeSingle();
	if (error) throw new Error(`partial watermark lookup failed: ${error.message}`);
	const watermark = (data?.counts as { watermark?: unknown } | undefined)?.watermark;
	return typeof watermark === "string" && !Number.isNaN(Date.parse(watermark)) ? watermark : null;
}

/**
 * Where this connector's incremental listing resumes (`modifiedTime > since`):
 * the LATER of the last fully successful run's start and the last failed run's
 * partial watermark, or null (a full relist) when there is neither.
 *
 * lastSuccessfulRunAt keeps its meaning — an ok run still means "every file
 * modified before I started was written". What #1207 adds is the second source:
 * before it, one timed-out batch made the whole run an error, the ok watermark
 * never moved, and every run relisted the estate from scratch and failed on the
 * same first batch, forever. Taking the later of the two is safe either way,
 * because each value is a point every file modified at or before it has been
 * written.
 */
async function resumeWatermark(connector: string): Promise<string | null> {
	const okAt = await lastSuccessfulRunAt(connector);
	const partial = await lastPartialWatermark(connector);
	if (!okAt) return partial;
	if (!partial) return okAt;
	return Date.parse(partial) > Date.parse(okAt) ? partial : okAt;
}

/**
 * The partial-progress watermark for a run that wrote `files[0, written)` and then
 * failed (#1207): the latest modifiedTime W such that EVERY listed file modified
 * at or before W was written, capped at the run's own start. Null when no such
 * point exists (nothing written, or an unwritten file whose time is unknown).
 *
 * Not simply "the last written file's time". Drive lists in modifiedTime order,
 * but files sharing a timestamp can straddle a batch boundary, and the next run
 * lists `modifiedTime > W` — so W must sit strictly below the earliest UNWRITTEN
 * file, or its same-second siblings would be skipped for good. Computed from the
 * data rather than trusting the order, so a listing that shifted while it was
 * paged cannot make it overclaim. The cap at `startedAt` keeps it never later
 * than what a successful run of the same listing would have recorded.
 */
export function partialWatermark(
	files: Array<{ modifiedTime?: string | null }>,
	written: number,
	startedAt: Date,
): string | null {
	if (written <= 0) return null;

	let boundary = Number.POSITIVE_INFINITY;
	for (const f of files.slice(written)) {
		const t = Date.parse(f.modifiedTime ?? "");
		if (Number.isNaN(t)) return null;
		boundary = Math.min(boundary, t);
	}

	let best: { t: number; raw: string } | null = null;
	for (const f of files.slice(0, written)) {
		const raw = f.modifiedTime;
		const t = Date.parse(raw ?? "");
		if (!raw || Number.isNaN(t) || t >= boundary) continue;
		if (!best || t > best.t) best = { t, raw };
	}
	if (!best) return null;
	return best.t > startedAt.getTime() ? startedAt.toISOString() : best.raw;
}

type DriveClient = Awaited<ReturnType<typeof getDrive>>;

async function listChangedFiles(
	since: string | null,
	drive: DriveClient,
): Promise<DriveFile[]> {
	const clauses = ["trashed = false"];
	if (since) clauses.push(`modifiedTime > '${since}'`);

	const files: DriveFile[] = [];

	let pageToken: string | undefined;
	do {
		// Drive throttles bursty clients (429 rate-limit errors, transient 5xx).
		// Retrying each page with backoff (#472) turns a throttled page into a slower
		// scan instead of a failed run; gaxios errors carry response.status/headers,
		// which withBackoff's default classifier and Retry-After extractor understand.
		const res = await withBackoff(
			() =>
				drive.files.list({
					q: clauses.join(" and "),
					pageSize: 1000,
					orderBy: "modifiedTime",
					fields: DISCOVER_FIELDS,
					includeItemsFromAllDrives: true,
					supportsAllDrives: true,
					pageToken,
				}),
			{ label: "drive files.list" },
		);
		files.push(...((res.data.files ?? []) as typeof files));
		pageToken = res.data.nextPageToken ?? undefined;
	} while (pageToken);

	return files;
}

async function listTrashedFiles(
	since: string | null,
	drive: DriveClient,
): Promise<DriveFile[]> {
	const clauses = ["trashed = true"];
	if (since) clauses.push(`modifiedTime > '${since}'`);

	const files: DriveFile[] = [];

	let pageToken: string | undefined;
	do {
		const res = await withBackoff(
			() =>
				drive.files.list({
					q: clauses.join(" and "),
					pageSize: 1000,
					orderBy: "modifiedTime",
					fields: DISCOVER_FIELDS,
					includeItemsFromAllDrives: true,
					supportsAllDrives: true,
					pageToken,
				}),
			{ label: "drive trashed files.list" },
		);
		files.push(...((res.data.files ?? []) as typeof files));
		pageToken = res.data.nextPageToken ?? undefined;
	} while (pageToken);

	return files;
}

/**
 * Sweep ONE account. Its own try/catch and its own run row, so a failure on one
 * account cannot cancel the other's sweep or leave it unrecorded — before #857
 * there was one account and the distinction did not exist.
 *
 * `refreshToken` is resolved once by the caller (`runDriveDiscoverCadence`, which
 * already has to resolve it to decide whether the account is wired at all) and
 * threaded through to `getDrive` here rather than re-resolved — see #977: reading
 * the same credential twice per sweep is a free duplicate today (a sync env read)
 * and an extra vault round-trip once `getCredential` is vault-backed.
 */
async function sweepAccount(account: GoogleAccount, refreshToken: string): Promise<void> {
	const connector = DRIVE_CONNECTOR_BY_ACCOUNT[account];
	const startedAt = new Date();

	// Hoisted out of the try so a failure part-way through the batches can still
	// report how far it got (#1207).
	let files: DriveFile[] = [];
	let written = 0;
	let inserted = 0;
	let updated = 0;
	let unchanged = 0;
	let refreshed = 0;
	let trashedArchived = 0;

	try {
		// Per connector, not global: each account's incremental window advances on
		// its own runs. Sharing one watermark would let a successful personal sweep
		// silently move Work's start time forward, and every file changed in
		// between would never be seen again.
		const since = await resumeWatermark(connector);
		const drive = await getDrive(account, refreshToken);

		files = await listChangedFiles(since, drive);

		for (const batch of chunk(files, BATCH_SIZE)) {
			const counts = await executeAction(ingestDiscoverAction, { connector, items: batch.map(toDiscoverItem) }, { context: { caller: "worker", userId: getCurrentUserId() } });
			inserted += counts.inserted;
			updated += counts.updated;
			unchanged += counts.unchanged;
			refreshed += counts.refreshed;
			written += batch.length;
		}

		// Sweep trashed source files (#1212)
		const trashedFiles = await listTrashedFiles(since, drive);
		if (trashedFiles.length > 0) {
			trashedArchived = await softArchiveSourceTrashed(
				connector,
				trashedFiles.map((f) => f.id),
			);
		}

		await recordRun({
			cadence: "discover",
			connector,
			startedAt,
			counts: {
				scanned: files.length,
				new: inserted,
				changed: updated,
				unchanged,
				refreshed,
				...(trashedArchived > 0 ? { trashed: trashedArchived } : {}),
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`drive discover cadence failed for account '${account}':`, message);
		// Still an ERROR row — a run with a failed batch is a failed run, and the ok
		// watermark must not move for it. What changes (#1207) is that the batches
		// that DID land are no longer thrown away: the row carries how far the run
		// got, and `watermark` when there is a safe point to resume from, so the
		// next run starts after it instead of relisting everything and dying on the
		// same batch again. A failure before or during the listing has no progress
		// to report and keeps the old empty counts.
		const watermark = partialWatermark(files, written, startedAt);
		const counts =
			files.length > 0
				? {
						scanned: files.length,
						written,
						new: inserted,
						changed: updated,
						unchanged,
						refreshed,
						...(trashedArchived > 0 ? { trashed: trashedArchived } : {}),
						...(watermark ? { watermark } : {}),
					}
				: {};
		await recordRun({ cadence: "discover", connector, startedAt, counts, error: message });
	}
}

/**
 * Sweep every WIRED Google account, one at a time (#857, the remaining half of
 * #338's acceptance criteria).
 *
 * Wiring is asked of the credential seam rather than read out of env: this was the
 * last direct `env.googleRefreshToken` reader outside credentials.ts, and a check
 * against one hard-coded variable is exactly what made the cadence single-account
 * whatever the rest of the layer supported.
 *
 * Resolves `getCredential` directly instead of going through `hasCredential` (#977).
 * The two questions this loop actually has — "is this account wired" and "give me
 * its token" — are the same call, so they cannot disagree, and it costs one
 * `getCredential` per account instead of two (`hasCredential` internally, then
 * `getDrive` again inside the sweep).
 *
 * The two failure shapes this distinguishes:
 *   - `CredentialNotConfiguredError`: the account is simply not wired. Skipped
 *     silently, no run row — the normal state of a single-account install. A run
 *     row per night saying "the account you never configured is still not
 *     configured" is how a run log becomes unreadable.
 *   - anything else (a future vault outage, an expired token, a network blip):
 *     a real failure, not "not configured". It must not read as either of the two
 *     silent outcomes above — a bare `continue` (misreported as unwired) or an
 *     uncaught throw (which would also cancel every account swept after this one
 *     in the loop). Recorded as a failed run row instead, so the account shows up
 *     as attempted-and-failed rather than simply absent, and the loop moves on.
 *
 * Sequential, not parallel. Drive throttles bursty clients (the per-page backoff
 * above exists for that), and two full-estate scans at once is the shape most
 * likely to trigger it.
 */
const CHANGES_DISCOVER_FIELDS =
	"nextPageToken, newStartPageToken, changes(fileId, removed, time, file(id, name, mimeType, size, parents, modifiedTime, createdTime, owners(displayName,emailAddress), webViewLink, md5Checksum, trashed))";

function isDriveChangesExpiredError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	const anyErr = err as {
		status?: number;
		code?: number;
		response?: { status?: number };
	};
	const status = anyErr.status ?? anyErr.code ?? anyErr.response?.status;
	if (status === 400 || status === 404) return true;
	const msg = err instanceof Error ? err.message : String(err);
	return /\b(400|404)\b/.test(msg) && /Invalid Value|pageToken|changes/i.test(msg);
}

function toDiscoverItemFromChange(
	change: DriveChangeEntry,
	rawFile: DriveFile | undefined,
) {
	if (rawFile) {
		return toDiscoverItem({
			...rawFile,
			id: change.file_id,
			name: change.name ?? rawFile.name ?? change.file_id,
			mimeType: change.mime_type ?? rawFile.mimeType,
			modifiedTime: rawFile.modifiedTime ?? change.time,
		});
	}
	return {
		external_id: change.file_id,
		title: change.name ?? change.file_id,
		mime_type: change.mime_type ?? undefined,
		source_modified_at: change.time ?? undefined,
		content_hash: change.time ?? undefined,
	};
}

/**
 * Consume the Drive change feed for the account matching `channelId` (#1654).
 *
 * - Unknown `channelId`: acknowledged and dropped with one log line.
 * - Valid stored `pageToken`: pages `drive_changes_list` to the end, hands
 *   changed files to `ingest_discover`, soft-archives `removed` and `trashed`
 *   files with `softArchiveSourceTrashed`, and saves `new_start_page_token`
 *   only after those writes succeed.
 * - Missing or `{ expired: true }` token: re-seeds the token via
 *   `changes.getStartPageToken` and runs the `modifiedTime` sweep once.
 */
export async function runDriveChannelChanges(channelId: string): Promise<void> {
	const persistence = createSupabaseDriveWatchPersistence(
		supabase as unknown as DriveWatchSupabaseClient,
		getCurrentUserId(),
	);

	let matchedAccount: GoogleAccount | null = null;
	let storedChannel: StoredDriveWatchChannel | null = null;
	for (const account of GOOGLE_ACCOUNTS) {
		const ch = await persistence.getStoredChannel(account);
		if (ch && ch.id === channelId) {
			matchedAccount = account;
			storedChannel = ch;
			break;
		}
	}

	if (!matchedAccount || !storedChannel) {
		console.log(
			`drive discover: ignoring notification for unknown watch channel '${channelId}'`,
		);
		return;
	}

	const account = matchedAccount;
	const connector = DRIVE_CONNECTOR_BY_ACCOUNT[account];
	const startedAt = new Date();

	let refreshToken: string;
	try {
		refreshToken = await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
	} catch (err) {
		if (err instanceof CredentialNotConfiguredError) return;
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			`drive discover cadence: credential resolution failed for account '${account}':`,
			message,
		);
		await recordRun({
			cadence: "discover",
			connector,
			startedAt,
			counts: {},
			error: message,
		});
		return;
	}

	const drive = await getDrive(account, refreshToken);

	const reseedAndFallbackSweep = async (): Promise<void> => {
		const startRes = await withBackoff(
			() =>
				drive.changes.getStartPageToken({
					supportsAllDrives: true,
				}),
			{ label: "drive changes.getStartPageToken" },
		);
		const freshToken = startRes.data.startPageToken ?? undefined;
		await sweepAccount(account, refreshToken);
		if (freshToken) {
			await persistence.saveChannel({
				...storedChannel,
				pageToken: freshToken,
				updatedAt: new Date().toISOString(),
			});
		}
	};

	if (!storedChannel.pageToken) {
		await reseedAndFallbackSweep();
		return;
	}

	const rawFilesById = new Map<string, DriveFile>();
	const changesListAction = createDriveChangesListAction({
		async listChanges(params): Promise<DriveChangesPageResult> {
			try {
				const res = await withBackoff(
					() =>
						drive.changes.list({
							pageToken: params.pageToken,
							pageSize: params.pageSize ?? 200,
							includeRemoved: params.includeRemoved ?? true,
							includeItemsFromAllDrives:
								params.includeItemsFromAllDrives ?? true,
							supportsAllDrives: true,
							fields: CHANGES_DISCOVER_FIELDS,
						}),
					{ label: "drive changes.list" },
				);
				const rawChanges = (res.data.changes ?? []) as RawDriveChange[];
				for (const rc of rawChanges) {
					const fid = rc.fileId ?? rc.file?.id;
					if (fid && rc.file && !rc.removed) {
						rawFilesById.set(fid, {
							id: fid,
							name: rc.file.name ?? fid,
							mimeType: rc.file.mimeType,
							size: rc.file.size,
							parents: rc.file.parents,
							modifiedTime: rc.file.modifiedTime,
							createdTime: rc.file.createdTime,
							owners: rc.file.owners,
							webViewLink: rc.file.webViewLink,
							md5Checksum: rc.file.md5Checksum,
						});
					}
				}
				return {
					changes: rawChanges,
					nextPageToken: res.data.nextPageToken ?? null,
					newStartPageToken: res.data.newStartPageToken ?? null,
				};
			} catch (err) {
				if (isDriveChangesExpiredError(err)) {
					return { expired: true };
				}
				throw err;
			}
		},
	});

	const domain = LEGACY_DOMAIN_VALUE[account];
	const allChanges: DriveChangeEntry[] = [];
	let cursor: string | null = storedChannel.pageToken;
	let newStartPageToken: string | null = null;

	try {
		while (cursor) {
			const page: DriveChangesListOutput = await executeAction(
				changesListAction,
				{ domain, cursor },
				{ context: { caller: "worker", userId: getCurrentUserId() } },
			);
			if ("expired" in page) {
				await reseedAndFallbackSweep();
				return;
			}
			allChanges.push(...page.changes);
			if (page.new_start_page_token) {
				newStartPageToken = page.new_start_page_token;
			}
			cursor = page.next_cursor;
		}

		const activeChanges: DriveChangeEntry[] = [];
		const removedOrTrashedIds: string[] = [];
		for (const change of allChanges) {
			if (!change.file_id) continue;
			if (change.removed || change.trashed) {
				removedOrTrashedIds.push(change.file_id);
			} else {
				activeChanges.push(change);
			}
		}

		let inserted = 0;
		let updated = 0;
		let unchanged = 0;
		let refreshed = 0;
		let trashedArchived = 0;

		for (const batch of chunk(activeChanges, BATCH_SIZE)) {
			const counts = await executeAction(
				ingestDiscoverAction,
				{
					connector,
					items: batch.map((c) =>
						toDiscoverItemFromChange(c, rawFilesById.get(c.file_id)),
					),
				},
				{ context: { caller: "worker", userId: getCurrentUserId() } },
			);
			inserted += counts.inserted;
			updated += counts.updated;
			unchanged += counts.unchanged;
			refreshed += counts.refreshed;
		}

		if (removedOrTrashedIds.length > 0) {
			trashedArchived = await softArchiveSourceTrashed(
				connector,
				removedOrTrashedIds,
			);
		}

		if (newStartPageToken) {
			await persistence.saveChannel({
				...storedChannel,
				pageToken: newStartPageToken,
				updatedAt: new Date().toISOString(),
			});
		}

		await recordRun({
			cadence: "discover",
			connector,
			startedAt,
			counts: {
				scanned: activeChanges.length,
				new: inserted,
				changed: updated,
				unchanged,
				refreshed,
				...(trashedArchived > 0 ? { trashed: trashedArchived } : {}),
			},
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(
			`drive discover change-feed failed for account '${account}':`,
			message,
		);
		await recordRun({
			cadence: "discover",
			connector,
			startedAt,
			counts: {},
			error: message,
		});
	}
}

export async function runDriveDiscoverCadence(
	options?: DriveDiscoverSweepOptions,
): Promise<void> {
	if (options?.channelId) {
		await runDriveChannelChanges(options.channelId);
		return;
	}
	for (const account of GOOGLE_ACCOUNTS) {
		const connector = DRIVE_CONNECTOR_BY_ACCOUNT[account];
		let refreshToken: string;
		try {
			refreshToken = await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
		} catch (err) {
			if (err instanceof CredentialNotConfiguredError) continue;
			const message = err instanceof Error ? err.message : String(err);
			console.error(
				`drive discover cadence: credential resolution failed for account '${account}':`,
				message,
			);
			await recordRun({ cadence: "discover", connector, startedAt: new Date(), counts: {}, error: message });
			continue;
		}
		await sweepAccount(account, refreshToken);
	}
}
