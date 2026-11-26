import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverSchema } from "@ahkms/core";

/**
 * The per-account Drive discover sweep (#857, the remaining half of #338).
 *
 * Four properties are load-bearing, and each has a failure mode that is silent
 * rather than loud, which is why they are pinned here rather than left to review:
 *
 *   1. The sweep asks the CREDENTIAL SEAM which accounts are wired. It used to
 *      read one hard-coded env var, which made it single-account whatever the
 *      layer beneath supported.
 *   2. Each account sweeps under its OWN connector, so its pointers carry their
 *      own source_channel and its incremental watermark is its own. A shared
 *      watermark would let a successful personal run move Work's start time
 *      forward, and every file changed in between would never be seen again.
 *   3. One account failing does not cancel the other, and still records a run row.
 *   4. A credential failure that is NOT "not configured" (#977 — a future vault
 *      outage, an expired token, a network blip) must not read as "this account
 *      is simply unwired": it is recorded as a failed run row and the other
 *      account still sweeps, rather than being silently skipped or crashing the
 *      whole cadence.
 */

const getDrive = vi.fn();
const getCredential = vi.fn();
const runDiscover = vi.fn();
const recordRun = vi.fn();
const maybeSingle = vi.fn();
const softArchiveSourceTrashed = vi.fn();

class CredentialNotConfiguredError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CredentialNotConfiguredError";
	}
}

vi.mock("../google/drive.js", () => ({ getDrive: (...a: unknown[]) => getDrive(...a) }));
vi.mock("../credentials.js", () => ({
	getCredential: (...a: unknown[]) => getCredential(...a),
	CredentialNotConfiguredError,
}));
vi.mock("../tools/discover.js", () => ({
	ingestDiscoverAction: { id: "ingest_discover", schema: discoverSchema, run: (input: unknown) => runDiscover(input) },
	softArchiveSourceTrashed: (...a: unknown[]) => softArchiveSourceTrashed(...a),
}));
vi.mock("./runLog.js", () => ({ recordRun: (...a: unknown[]) => recordRun(...a) }));
vi.mock("../backoff.js", () => ({ withBackoff: (fn: () => unknown) => fn() }));

// A supabase stub whose chain ends at maybeSingle, matching the two watermark
// lookups (lastSuccessfulRunAt and lastPartialWatermark). It RECORDS its .eq()
// filters: the watermark query's connector filter is the whole point of test 3
// below, and a chain that swallowed its arguments would report success for a
// query it never inspected. Each from() gets its own filter record, handed to
// maybeSingle, so a test can answer the ok-run query and the partial-watermark
// query (#1207) differently.
const eqCalls: [string, unknown][] = [];
const updatePayloads: Record<string, unknown>[] = [];
vi.mock("../supabase.js", () => {
	return {
		supabase: {
			from: () => {
				const filters: Record<string, unknown> = {};
				const chain: Record<string, unknown> = {};
				for (const method of ["select", "order", "limit", "not"]) {
					chain[method] = () => chain;
				}
				chain.eq = (column: string, value: unknown) => {
					eqCalls.push([column, value]);
					filters[column] = value;
					return chain;
				};
				chain.maybeSingle = () => maybeSingle(filters);
				chain.update = (payload: Record<string, unknown>) => {
					updatePayloads.push(payload);
					const updateChain: Record<string, unknown> = {};
					updateChain.eq = () => ({
						eq: async () => ({ error: null }),
					});
					return updateChain;
				};
				chain.insert = async (payload: Record<string, unknown>) => {
					updatePayloads.push(payload);
					return { error: null };
				};
				return chain;
			},
		},
	};
});

const { runDriveDiscoverCadence, runDriveChannelChanges, partialWatermark } = await import("./driveDiscoverCadence.js");

/** A Drive client whose files.list returns one file and no next page. */
function driveReturning(fileId: string) {
	return driveListing([{ id: fileId, name: `${fileId}.txt`, modifiedTime: "2026-08-01T00:00:00Z" }]);
}

/** A Drive client whose files.list returns exactly `files` on one page. */
function driveListing(files: Record<string, unknown>[], trashedFiles: Record<string, unknown>[] = []) {
	return {
		files: {
			list: vi.fn(async (params?: Record<string, unknown>) => {
				const q = String(params?.q ?? "");
				if (q.includes("trashed = true")) {
					return { data: { files: trashedFiles } };
				}
				return { data: { files } };
			}),
		},
	};
}

/** google_personal -> "token-personal", google_work -> "token-work". */
function tokenFor(provider: string): string {
	return `token-${provider.replace("google_", "")}`;
}

beforeEach(() => {
	vi.clearAllMocks();
	eqCalls.length = 0;
	updatePayloads.length = 0;
	maybeSingle.mockResolvedValue({ data: null, error: null });
	runDiscover.mockResolvedValue({ inserted: 1, updated: 0, unchanged: 0, refreshed: 0 });
	softArchiveSourceTrashed.mockResolvedValue(0);
	recordRun.mockResolvedValue(undefined);
	getCredential.mockImplementation(async (provider: string) => tokenFor(provider));
	getDrive.mockImplementation(async (account: string) => driveReturning(`file-${account}`));
});

describe("runDriveDiscoverCadence - which accounts run", () => {
	it("sweeps only the accounts the credential seam reports as wired", async () => {
		getCredential.mockImplementation(async (provider: string) => {
			if (provider === "google_personal") return tokenFor(provider);
			throw new CredentialNotConfiguredError(`${provider} not configured`);
		});

		await runDriveDiscoverCadence();

		expect(getDrive.mock.calls.map((c) => c[0])).toEqual(["personal"]);
		expect(getCredential).toHaveBeenCalledWith("google_personal");
		expect(getCredential).toHaveBeenCalledWith("google_work");
	});

	it("sweeps both accounts when both are wired", async () => {
		await runDriveDiscoverCadence();

		expect(getDrive.mock.calls.map((c) => c[0])).toEqual(["personal", "work"]);
	});

	/**
	 * An unwired account is the normal state of a single-account install. A run row
	 * per night saying "the account you never configured is still not configured" is
	 * how a run log becomes unreadable.
	 */
	it("writes no run row at all when nothing is wired", async () => {
		getCredential.mockImplementation(async (provider: string) => {
			throw new CredentialNotConfiguredError(`${provider} not configured`);
		});

		await runDriveDiscoverCadence();

		expect(getDrive).not.toHaveBeenCalled();
		expect(recordRun).not.toHaveBeenCalled();
	});

	/**
	 * The credential is resolved exactly ONCE per wired account — not once via a
	 * wiring check and again inside getDrive (#977's "Also"). getDrive receives the
	 * resolved token directly instead of re-deriving it.
	 */
	it("resolves each wired account's credential exactly once", async () => {
		await runDriveDiscoverCadence();

		expect(getCredential).toHaveBeenCalledTimes(2);
		expect(getDrive).toHaveBeenCalledWith("personal", "token-personal");
		expect(getDrive).toHaveBeenCalledWith("work", "token-work");
	});
});

describe("runDriveDiscoverCadence - per-account bookkeeping", () => {
	it("writes each account's pointers under its own connector", async () => {
		await runDriveDiscoverCadence();

		expect(runDiscover.mock.calls.map((c) => (c[0] as { connector: string }).connector)).toEqual([
			"gdrive",
			"gdrive_work",
		]);
	});

	it("records a run row per account, under the same connector it discovered with", async () => {
		await runDriveDiscoverCadence();

		expect(recordRun.mock.calls.map((c) => (c[0] as { connector: string }).connector)).toEqual([
			"gdrive",
			"gdrive_work",
		]);
	});

	/**
	 * Each account's incremental window advances on its OWN successful runs.
	 * Sharing one watermark is the quiet version of this bug: a successful personal
	 * sweep moves Work's start time forward, and every Work file changed
	 * between the two runs is never seen again. Nothing fails; files just go
	 * missing.
	 */
	it("looks the watermark up per connector, never against a shared one", async () => {
		await runDriveDiscoverCadence();

		// Two lookups per account since #1207 — the last ok run and the last partial
		// watermark — and BOTH are filtered by that account's own connector.
		expect(eqCalls.filter(([column]) => column === "connector").map(([, value]) => value)).toEqual([
			"gdrive",
			"gdrive",
			"gdrive_work",
			"gdrive_work",
		]);
	});

	/**
	 * The personal account keeps the bare `gdrive` spelling. source_channel is
	 * written onto every pointer row and is what re-discovery matches on, so
	 * renaming it would orphan every pointer already swept: they would stop
	 * matching, be re-inserted as new, and the old rows would sit unreachable.
	 */
	it("keeps the personal connector as the bare 'gdrive' spelling", async () => {
		getCredential.mockImplementation(async (provider: string) => {
			if (provider === "google_personal") return tokenFor(provider);
			throw new CredentialNotConfiguredError(`${provider} not configured`);
		});

		await runDriveDiscoverCadence();

		expect((runDiscover.mock.calls[0][0] as { connector: string }).connector).toBe("gdrive");
	});
});

describe("runDriveDiscoverCadence - failure isolation", () => {
	it("a failure on one account still sweeps the other and records both outcomes", async () => {
		getDrive.mockImplementation(async (account: string) => {
			if (account === "personal") throw new Error("personal token revoked");
			return driveReturning("file-work");
		});

		await runDriveDiscoverCadence();

		const rows = recordRun.mock.calls.map((c) => c[0] as { connector: string; error?: string });
		expect(rows.map((r) => r.connector)).toEqual(["gdrive", "gdrive_work"]);
		expect(rows[0].error).toContain("personal token revoked");
		expect(rows[1].error).toBeUndefined();
	});

	/**
	 * #977: a `getCredential` failure that is NOT "not configured" (a vault outage,
	 * an expired token, a network blip) must not be mistaken for "account unwired".
	 * Before this fix it either read as unwired (a bare skip, no run row, no
	 * error — silence indistinguishable from a routine single-account install) or,
	 * once `hasCredential` stopped swallowing it, an uncaught throw that would
	 * cancel every account swept after it in the loop. Neither is acceptable: the
	 * account must show up as attempted-and-failed, and the other account must
	 * still be swept.
	 */
	it("a non-'not configured' credential failure records a failed run and does not stop the other account", async () => {
		getCredential.mockImplementation(async (provider: string) => {
			if (provider === "google_personal") throw new Error("vault timeout");
			return tokenFor(provider);
		});

		await runDriveDiscoverCadence();

		// The failed account was never handed to getDrive/runDiscover - it was
		// never attempted past credential resolution, not silently treated as fine.
		expect(getDrive).not.toHaveBeenCalledWith("personal", expect.anything());
		expect(getDrive).toHaveBeenCalledWith("work", "token-work");

		const rows = recordRun.mock.calls.map((c) => c[0] as { connector: string; error?: string });
		expect(rows).toContainEqual(
			expect.objectContaining({ connector: "gdrive", error: expect.stringContaining("vault timeout") }),
		);
		// The other account's own sweep still succeeded, uncancelled by the first.
		const workRow = rows.find((r) => r.connector === "gdrive_work");
		expect(workRow).toBeDefined();
		expect(workRow?.error).toBeUndefined();
	});
});

/** Only the personal account is wired, so each test reads one account's rows. */
function personalOnly() {
	getCredential.mockImplementation(async (provider: string) => {
		if (provider === "google_personal") return tokenFor(provider);
		throw new CredentialNotConfiguredError(`${provider} not configured`);
	});
}

/** `n` Drive files with strictly increasing, distinct modifiedTimes (one a minute). */
function driveFiles(n: number): Record<string, unknown>[] {
	const base = Date.parse("2019-01-01T00:00:00.000Z");
	return Array.from({ length: n }, (_, i) => ({
		id: `f${i}`,
		name: `f${i}.pdf`,
		modifiedTime: new Date(base + i * 60_000).toISOString(),
	}));
}

type RunRow = { connector: string; counts: Record<string, unknown>; error?: string };

/**
 * #1207. Before this, one timed-out existing-row lookup made the whole run an
 * error with `counts: {}`: every batch already written was forgotten, the ok
 * watermark never moved, and the next run relisted the whole personal Drive and
 * died on the SAME first batch — on every run since 2026-08-07. A failed batch
 * must still fail the run, but must not freeze it.
 */
describe("runDriveDiscoverCadence - per-batch progress (#1207)", () => {
	it("a lookup failure mid-run records a FAILED run carrying the earlier batches' progress", async () => {
		personalOnly();
		const files = driveFiles(450); // batches of 200, 200, 50
		getDrive.mockImplementation(async () => driveListing(files));
		runDiscover
			.mockResolvedValueOnce({ inserted: 150, updated: 0, unchanged: 50, refreshed: 50 })
			.mockRejectedValueOnce(
				new Error("Discovery lookup failed: canceling statement due to statement timeout"),
			);

		await runDriveDiscoverCadence();

		// It stops at the failed batch rather than writing past a gap it cannot record.
		expect(runDiscover).toHaveBeenCalledTimes(2);
		expect(recordRun).toHaveBeenCalledTimes(1);
		const row = recordRun.mock.calls[0][0] as RunRow;
		expect(row.connector).toBe("gdrive");
		expect(row.error).toContain("statement timeout");
		expect(row.counts).toEqual({
			scanned: 450,
			written: 200,
			new: 150,
			changed: 0,
			unchanged: 50,
			refreshed: 50,
			// Every listed file modified at or before this was written: the last file of
			// the first batch, since the next batch starts strictly later.
			watermark: files[199].modifiedTime,
		});
	});

	it("claims no watermark when the very first batch fails", async () => {
		personalOnly();
		getDrive.mockImplementation(async () => driveListing(driveFiles(250)));
		runDiscover.mockRejectedValueOnce(new Error("Discovery lookup failed: timeout"));

		await runDriveDiscoverCadence();

		const row = recordRun.mock.calls[0][0] as RunRow;
		expect(row.error).toContain("timeout");
		expect(row.counts.written).toBe(0);
		expect(row.counts).not.toHaveProperty("watermark");
	});

	it("a failure before the listing completes keeps the old empty counts", async () => {
		personalOnly();
		getDrive.mockImplementation(async () => ({
			files: { list: vi.fn(async () => Promise.reject(new Error("drive 500"))) },
		}));

		await runDriveDiscoverCadence();

		const row = recordRun.mock.calls[0][0] as RunRow;
		expect(row.error).toContain("drive 500");
		expect(row.counts).toEqual({});
	});

	it("a clean run is still recorded ok, with no watermark in its counts", async () => {
		personalOnly();
		getDrive.mockImplementation(async () => driveListing(driveFiles(3)));

		await runDriveDiscoverCadence();

		const row = recordRun.mock.calls[0][0] as RunRow;
		expect(row.error).toBeUndefined();
		expect(row.counts).toEqual({ scanned: 3, new: 1, changed: 0, unchanged: 0, refreshed: 0 });
	});

	/** Answer the ok-run lookup and the partial-watermark lookup separately. */
	function watermarks(okStartedAt: string | null, partial: string | null) {
		maybeSingle.mockImplementation(async (filters: Record<string, unknown>) => {
			if (filters.status === "ok") {
				return { data: okStartedAt ? { started_at: okStartedAt } : null, error: null };
			}
			return { data: partial ? { counts: { watermark: partial } } : null, error: null };
		});
	}

	async function listedQuery(): Promise<string> {
		const drive = driveListing([]);
		getDrive.mockImplementation(async () => drive);
		await runDriveDiscoverCadence();
		return (drive.files.list.mock.calls[0][0] as { q: string }).q;
	}

	it("resumes from a failed run's watermark when it is later than the last ok run", async () => {
		personalOnly();
		watermarks("2026-08-01T00:00:00.000+00:00", "2026-08-05T10:00:00.000Z");

		expect(await listedQuery()).toBe("trashed = false and modifiedTime > '2026-08-05T10:00:00.000Z'");
	});

	it("keeps the last ok run's start when it is later than any partial watermark", async () => {
		personalOnly();
		watermarks("2026-09-01T00:00:00.000+00:00", "2026-08-05T10:00:00.000Z");

		expect(await listedQuery()).toBe("trashed = false and modifiedTime > '2026-09-01T00:00:00.000+00:00'");
	});

	it("resumes from a partial watermark when no run has ever succeeded (the #1207 state)", async () => {
		personalOnly();
		watermarks(null, "2019-03-01T12:00:00.000Z");

		expect(await listedQuery()).toBe("trashed = false and modifiedTime > '2019-03-01T12:00:00.000Z'");
	});

	it("relists everything when there is neither", async () => {
		personalOnly();
		watermarks(null, null);

		expect(await listedQuery()).toBe("trashed = false");
	});
});

describe("partialWatermark (#1207)", () => {
	const startedAt = new Date("2026-09-28T12:30:58.000Z");
	const at = (iso: string | null) => ({ modifiedTime: iso });

	it("is the latest written time strictly before the earliest unwritten one", () => {
		const files = [at("2020-01-01T00:00:00.000Z"), at("2020-01-02T00:00:00.000Z"), at("2020-01-03T00:00:00.000Z")];
		expect(partialWatermark(files, 2, startedAt)).toBe("2020-01-02T00:00:00.000Z");
	});

	/**
	 * The next run lists `modifiedTime > W`. If W equalled a timestamp an unwritten
	 * file also carries, that file would be excluded forever.
	 */
	it("backs off past files that share a timestamp with the first unwritten file", () => {
		const files = [
			at("2020-01-01T00:00:00.000Z"),
			at("2020-01-02T00:00:00.000Z"), // written, but a sibling at the same instant was not
			at("2020-01-02T00:00:00.000Z"),
		];
		expect(partialWatermark(files, 2, startedAt)).toBe("2020-01-01T00:00:00.000Z");
	});

	it("does not trust the listing order: an out-of-order unwritten file lowers the boundary", () => {
		const files = [at("2020-01-01T00:00:00.000Z"), at("2020-01-05T00:00:00.000Z"), at("2020-01-03T00:00:00.000Z")];
		expect(partialWatermark(files, 2, startedAt)).toBe("2020-01-01T00:00:00.000Z");
	});

	it("is null when nothing was written, or when an unwritten file's time is unknown", () => {
		const files = [at("2020-01-01T00:00:00.000Z"), at(null)];
		expect(partialWatermark(files, 0, startedAt)).toBeNull();
		expect(partialWatermark(files, 1, startedAt)).toBeNull();
	});

	it("is never later than the run's own start", () => {
		const files = [at("2026-09-28T12:40:00.000Z"), at("2026-09-28T12:50:00.000Z")];
		expect(partialWatermark(files, 1, startedAt)).toBe(startedAt.toISOString());
	});
});

/**
 * #1228. The listing already returns the Drive envelope; the sweep now hands it
 * on instead of dropping it, so a folder can be told from a document and another
 * person's shared file from the owner's own.
 */
describe("runDriveDiscoverCadence - Drive envelope (#1228)", () => {
	it("asks files.list for mimeType, size, parents and the owner's email", async () => {
		personalOnly();
		const drive = driveListing([]);
		getDrive.mockImplementation(async () => drive);

		await runDriveDiscoverCadence();

		const { fields } = drive.files.list.mock.calls[0][0] as { fields: string };
		for (const field of ["mimeType", "size", "parents", "owners(displayName,emailAddress)"]) {
			expect(fields).toContain(field);
		}
	});

	it("maps the envelope onto the discover item, including a file owned by someone else", async () => {
		personalOnly();
		getDrive.mockImplementation(async () =>
			driveListing([
				{
					id: "cv-2026",
					name: "CV 2026",
					mimeType: "application/vnd.google-apps.document",
					parents: ["folder-a"],
					owners: [{ displayName: "L Sharp", emailAddress: "someone.else@example.com" }],
					modifiedTime: "2026-09-11T00:00:00.000Z",
					createdTime: "2026-01-01T00:00:00.000Z",
				},
				{
					id: "cv-pdf",
					name: "Angus Hally CV.pdf",
					mimeType: "application/pdf",
					size: "48213",
					parents: ["folder-b"],
					owners: [{ displayName: "Angus Hally", emailAddress: "owner@example.com" }],
					md5Checksum: "0123456789abcdef0123456789abcdef",
					modifiedTime: "2026-09-11T00:00:00.000Z",
				},
				{
					id: "cv-folder",
					name: "CV Curriculum vitae",
					mimeType: "application/vnd.google-apps.folder",
					parents: ["1GXunvXuLtKnZNBQO3fwZdwvZiL6Fep48"],
				},
			]),
		);

		await runDriveDiscoverCadence();

		const items = (runDiscover.mock.calls[0][0] as { items: Record<string, unknown>[] }).items;
		expect(items[0]).toMatchObject({
			external_id: "cv-2026",
			owner: "L Sharp",
			owner_email: "someone.else@example.com",
			mime_type: "application/vnd.google-apps.document",
			parents: ["folder-a"],
		});
		// Google-native files have no size; it is omitted, not zeroed.
		expect(items[0].size).toBeUndefined();
		expect(items[1]).toMatchObject({
			owner_email: "owner@example.com",
			mime_type: "application/pdf",
			size: 48213,
			parents: ["folder-b"],
			content_hash: "0123456789abcdef0123456789abcdef",
		});
		expect(items[2]).toMatchObject({
			mime_type: "application/vnd.google-apps.folder",
			parents: ["1GXunvXuLtKnZNBQO3fwZdwvZiL6Fep48"],
		});
	});
});

describe("runDriveDiscoverCadence - trashed source files (#1212)", () => {
	it("detects trashed files and calls softArchiveSourceTrashed", async () => {
		personalOnly();
		getDrive.mockImplementation(async () =>
			driveListing(
				[{ id: "file-active", modifiedTime: "2026-08-01T00:00:00Z" }],
				[{ id: "file-trashed", modifiedTime: "2026-08-02T00:00:00Z" }],
			),
		);
		softArchiveSourceTrashed.mockResolvedValue(1);

		await runDriveDiscoverCadence();

		expect(softArchiveSourceTrashed).toHaveBeenCalledWith("gdrive", ["file-trashed"]);
		expect(recordRun).toHaveBeenCalledWith(
			expect.objectContaining({
				cadence: "discover",
				connector: "gdrive",
				counts: expect.objectContaining({
					trashed: 1,
				}),
			}),
		);
	});
});

describe("runDriveDiscoverCadence - watch channel change feed (#1654)", () => {
	function mockStoredWatchChannels(watchChannels: Record<string, unknown>) {
		maybeSingle.mockImplementation(async (filters: Record<string, unknown>) => {
			if (filters.provider === "google_drive") {
				return {
					data: {
						config: {
							watch_channels: watchChannels,
						},
					},
					error: null,
				};
			}
			return { data: null, error: null };
		});
	}

	it("drops notification for an unknown channelId with one log line and no Drive call", async () => {
		mockStoredWatchChannels({
			personal: {
				id: "chan-personal-1",
				resourceId: "res-1",
				expiration: "1728345600000",
				address: "https://your-app.up.railway.app/webhooks/drive",
				account: "personal",
				updatedAt: "2026-10-11T00:00:00.000Z",
				pageToken: "tok-10",
			},
		});
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await runDriveDiscoverCadence({ channelId: "unknown-channel-id" });

		expect(getDrive).not.toHaveBeenCalled();
		expect(runDiscover).not.toHaveBeenCalled();
		expect(softArchiveSourceTrashed).not.toHaveBeenCalled();
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining("unknown-channel-id"),
		);
		logSpy.mockRestore();
	});

	it("routes by channelId, reads drive_changes_list to the end, soft-archives removed files, and saves new_start_page_token after writes succeed", async () => {
		mockStoredWatchChannels({
			personal: {
				id: "chan-personal-1",
				resourceId: "res-p",
				expiration: "1728345600000",
				address: "https://your-app.up.railway.app/webhooks/drive",
				account: "personal",
				updatedAt: "2026-10-11T00:00:00.000Z",
				pageToken: "tok-personal",
			},
			work: {
				id: "chan-work-1",
				resourceId: "res-h",
				expiration: "1728345600000",
				address: "https://your-app.up.railway.app/webhooks/drive",
				account: "work",
				updatedAt: "2026-10-11T00:00:00.000Z",
				pageToken: "tok-work-start",
			},
		});

		const changesListMock = vi
			.fn()
			.mockResolvedValueOnce({
				data: {
					changes: [
						{
							fileId: "changed-doc-1",
							removed: false,
							time: "2026-10-11T12:00:00.000Z",
							file: {
								id: "changed-doc-1",
								name: "Spec.pdf",
								mimeType: "application/pdf",
								modifiedTime: "2026-10-11T12:00:00.000Z",
								trashed: false,
							},
						},
					],
					nextPageToken: "tok-work-page-2",
				},
			})
			.mockResolvedValueOnce({
				data: {
					changes: [
						{
							fileId: "hard-deleted-file-99",
							removed: true,
							time: "2026-10-11T12:01:00.000Z",
						},
					],
					newStartPageToken: "tok-work-next-start",
				},
			});

		getDrive.mockResolvedValue({
			changes: {
				list: changesListMock,
				getStartPageToken: vi.fn(),
			},
			files: {
				list: vi.fn(),
			},
		});
		softArchiveSourceTrashed.mockResolvedValue(1);

		await runDriveChannelChanges("chan-work-1");

		expect(getDrive).toHaveBeenCalledTimes(1);
		expect(getDrive).toHaveBeenCalledWith("work", "token-work");
		expect(changesListMock).toHaveBeenCalledTimes(2);
		expect(runDiscover).toHaveBeenCalledTimes(1);
		expect(runDiscover).toHaveBeenCalledWith({
			connector: "gdrive_work",
			items: [
				expect.objectContaining({
					external_id: "changed-doc-1",
					title: "Spec.pdf",
					mime_type: "application/pdf",
				}),
			],
		});
		expect(softArchiveSourceTrashed).toHaveBeenCalledWith("gdrive_work", [
			"hard-deleted-file-99",
		]);
		expect(updatePayloads).toHaveLength(1);
		const savedChannels = (
			updatePayloads[0].config as { watch_channels: Record<string, { pageToken?: string }> }
		).watch_channels;
		expect(savedChannels.work.pageToken).toBe("tok-work-next-start");
	});

	it("does not save new_start_page_token when ingest_discover fails", async () => {
		mockStoredWatchChannels({
			personal: {
				id: "chan-personal-1",
				resourceId: "res-p",
				expiration: "1728345600000",
				address: "https://your-app.up.railway.app/webhooks/drive",
				account: "personal",
				updatedAt: "2026-10-11T00:00:00.000Z",
				pageToken: "tok-personal-start",
			},
		});

		getDrive.mockResolvedValue({
			changes: {
				list: vi.fn().mockResolvedValueOnce({
					data: {
						changes: [
							{
								fileId: "doc-1",
								removed: false,
								time: "2026-10-11T12:00:00.000Z",
								file: {
									id: "doc-1",
									name: "Doc.pdf",
									mimeType: "application/pdf",
									trashed: false,
								},
							},
						],
						newStartPageToken: "tok-should-not-save",
					},
				}),
			},
		});
		runDiscover.mockRejectedValueOnce(new Error("DB write failed"));

		await runDriveChannelChanges("chan-personal-1");

		expect(updatePayloads).toHaveLength(0);
	});

	it("falls back to re-seeding startPageToken and running modifiedTime sweep once on expired token (HTTP 400)", async () => {
		mockStoredWatchChannels({
			personal: {
				id: "chan-personal-1",
				resourceId: "res-p",
				expiration: "1728345600000",
				address: "https://your-app.up.railway.app/webhooks/drive",
				account: "personal",
				updatedAt: "2026-10-11T00:00:00.000Z",
				pageToken: "expired-tok-1",
			},
		});

		const baseDrive = driveListing([
			{ id: "swept-file-1", name: "Swept.txt", modifiedTime: "2026-10-11T12:00:00Z" },
		]);
		const getStartPageToken = vi.fn().mockResolvedValue({
			data: { startPageToken: "reseeded-tok-500" },
		});
		const changesList = vi.fn().mockRejectedValue(
			Object.assign(new Error("Invalid Value"), { status: 400 }),
		);

		getDrive.mockResolvedValue({
			...baseDrive,
			changes: {
				list: changesList,
				getStartPageToken,
			},
		});

		await runDriveChannelChanges("chan-personal-1");

		expect(changesList).toHaveBeenCalledTimes(1);
		expect(getStartPageToken).toHaveBeenCalledTimes(1);
		expect(baseDrive.files.list).toHaveBeenCalled();
		expect(runDiscover).toHaveBeenCalledWith(
			expect.objectContaining({
				connector: "gdrive",
				items: [expect.objectContaining({ external_id: "swept-file-1" })],
			}),
		);
		expect(updatePayloads).toHaveLength(1);
		const savedChannels = (
			updatePayloads[0].config as { watch_channels: Record<string, { pageToken?: string }> }
		).watch_channels;
		expect(savedChannels.personal.pageToken).toBe("reseeded-tok-500");
	});
});


