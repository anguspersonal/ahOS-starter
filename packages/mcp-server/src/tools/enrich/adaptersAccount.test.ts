import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reading a pointer back with the account it was DISCOVERED under (#857).
 *
 * This is the half of the account dimension that fails silently. A pointer swept
 * from the Work Drive is invisible to a personal client, and Drive answers that
 * as a 404 on the file id rather than as a permissions error — so enriching with
 * the wrong account reads as "the file is gone", not as "wrong credential". The
 * pointer would be marked unreachable and the content never indexed.
 */

const getDrive = vi.fn();
const downloadFileBytes = vi.fn();

vi.mock("../../google/drive.js", () => ({
	getDrive: (...a: unknown[]) => getDrive(...a),
	downloadFileBytes: (...a: unknown[]) => downloadFileBytes(...a),
}));

const { getReadAdapter } = await import("./adapters.js");
const {
	DRIVE_CONNECTOR_ACCOUNT,
	DRIVE_CONNECTOR_BY_ACCOUNT,
	ENRICHABLE_CONNECTORS,
	isDriveConnector,
} = await import("@ahkms/core");

beforeEach(() => {
	vi.clearAllMocks();
	getDrive.mockResolvedValue({
		files: {
			get: vi.fn(async () => ({
				data: { id: "f1", name: "notes.txt", mimeType: "text/plain", md5Checksum: "abc" },
			})),
		},
	});
	downloadFileBytes.mockResolvedValue({
		buffer: Buffer.from("hi"),
		mimeType: "text/plain",
		extension: "txt",
	});
});

async function fetchWith(connector: string) {
	const adapter = getReadAdapter(connector);
	if (!adapter) throw new Error(`no adapter for ${connector}`);
	return adapter.fetch({ connector, externalId: "f1", url: null });
}

describe("drive read adapter - account routing", () => {
	it("reads a Work pointer with the Work account", async () => {
		await fetchWith("gdrive_work");
		expect(getDrive).toHaveBeenCalledWith("work");
		expect(downloadFileBytes).toHaveBeenCalledWith("f1", "text/plain", "work");
	});

	it("reads a personal pointer with the personal account", async () => {
		await fetchWith("gdrive");
		expect(getDrive).toHaveBeenCalledWith("personal");
		expect(downloadFileBytes).toHaveBeenCalledWith("f1", "text/plain", "personal");
	});

	/**
	 * Pointers discovered before the account dimension existed carry the alias
	 * spellings and were all swept from the personal account. They must keep
	 * resolving to it, or a live backlog of already-discovered pointers breaks on
	 * deploy.
	 */
	it("resolves the pre-account alias spellings to personal", async () => {
		for (const alias of ["google_drive", "drive"]) {
			getDrive.mockClear();
			await fetchWith(alias);
			expect(getDrive).toHaveBeenCalledWith("personal");
		}
	});

	/**
	 * An unmapped connector must not throw and must not guess a non-default
	 * account. Defaulting to personal matches what every pointer predating the map
	 * was discovered with.
	 */
	it("falls back to personal for a connector the map does not know", async () => {
		const adapter = getReadAdapter("gdrive");
		await adapter!.fetch({ connector: "some_future_spelling", externalId: "f1", url: null });
		expect(getDrive).toHaveBeenCalledWith("personal");
	});
});

describe("drive connector map - internal consistency", () => {
	it("every Drive enrichable connector has an account and every enrichable connector has a read adapter", () => {
		for (const connector of ENRICHABLE_CONNECTORS) {
			expect(getReadAdapter(connector)).toBeDefined();
			if (isDriveConnector(connector)) {
				expect(DRIVE_CONNECTOR_ACCOUNT[connector]).toBeDefined();
			}
		}
	});

	/**
	 * The sweep picks a connector by account and the adapter maps it back. If those
	 * two disagree, a sweep writes pointers under a name that reads back as the
	 * other account — the cross-account leak, one layer up from the client cache.
	 */
	it("round-trips account to connector and back", () => {
		for (const [account, connector] of Object.entries(DRIVE_CONNECTOR_BY_ACCOUNT)) {
			expect(DRIVE_CONNECTOR_ACCOUNT[connector]).toBe(account);
		}
	});

	it("every connector a sweep writes under is one enrich can read", () => {
		for (const connector of Object.values(DRIVE_CONNECTOR_BY_ACCOUNT)) {
			expect(getReadAdapter(connector)).toBeDefined();
		}
	});
});
