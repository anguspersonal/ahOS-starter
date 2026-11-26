/**
 * `artifacts.surface` is never written NULL (#584; ADR-026, ADR-046 §2/§3).
 *
 * WHAT IS ACTUALLY BEING PROVED. A null surface still *resolves* — `resolveTrust`
 * and `resolveSynthesisRole` both fall through to `source_channel` and then to a
 * bare default — so no read blows up and no test can catch this by asserting on a
 * resolved role. The defect is that the row becomes UNADDRESSABLE: ADR-046 §3 keys
 * the role ladder on this column, so with no value there is no key an owner's
 * `surface_role_map` entry can match, and a flooding path can never be demoted
 * (#567). These tests therefore assert on the WRITTEN ROW, which is where the fact
 * is either recorded or lost forever.
 *
 * The two mcp-server paths #584 closed and could reach are covered here
 * (capture.ts, drive_import_file). createEvent.ts's Act-path receipt is asserted in
 * createEvent.test.ts beside its sibling provenance assertions; createTask.ts — the
 * twin of that receipt, closed by #736 after being left open under #584's concurrent
 * work under #653 — is asserted the same way in createTask.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_SURFACES } from "@ahkms/shared";
import { supabase } from "../supabase.js";
import { SURFACES } from "../vocab.js";

// Mutable so each test can pick the preferences rung under test. `vi.hoisted` because
// the `vi.mock` factory below is hoisted above ordinary module-scope declarations.
const prefsBox = vi.hoisted(() => ({
	current: { default_surface: undefined as string | undefined },
}));

vi.mock("../captureConfig.js", () => ({
	loadCapturePreferences: vi.fn(async () => prefsBox.current),
	applyCaptureRouting: vi.fn(() => ({ source_channel: "mcp", tags: [] })),
}));

vi.mock("../embeddings.js", () => ({
	embedAndStore: vi.fn(async () => {}),
}));

// The Drive client, stubbed to one small textual file with no parent folder (so the
// parent-path walk is skipped). `../google/drive.js` from here resolves to the same
// module `tools/drive/shared.ts` imports as `../../google/drive.js`.
vi.mock("../google/drive.js", () => ({
	getDrive: vi.fn(() => ({
		files: {
			get: vi.fn(async () => ({
				data: {
					id: "drive-file-1",
					name: "Lease.txt",
					mimeType: "text/plain",
					webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
					parents: [],
				},
			})),
		},
	})),
	downloadFileBytes: vi.fn(async () => ({
		buffer: Buffer.from("lease terms"),
		mimeType: "text/plain",
		extension: "txt",
	})),
	isFolder: vi.fn(() => false),
}));

const { captureHandler } = await import("../tools/capture.js");
const { importDriveFileArtifact } = await import("../tools/drive/shared.js");
const { createDriveImportFileAction } = await import("@ahkms/core/actions");
const { createSupabaseArtifactRepository, createSupabaseStorageAdapter } = await import(
	"@ahkms/core/adapters"
);

const origFrom = supabase.from;
const origStorageFrom = supabase.storage.from;

/**
 * Stub the storage upload and the `artifacts` insert, returning a handle onto the
 * exact row the writer passed to `.insert(...)`.
 */
function stubArtifactWrite() {
	const captured: { row?: Record<string, unknown> } = {};

	(supabase.storage as any).from = vi.fn(() => ({
		upload: vi.fn(async () => ({ error: null })),
		remove: vi.fn(async () => ({ error: null })),
	}));

	(supabase as any).from = vi.fn((table: string) => {
		if (table !== "artifacts") throw new Error(`unexpected table: ${table}`);
		return {
			// #993's pre-insert dedup lookup (findDedupMatch) always runs first; this
			// suite doesn't exercise dedup, so it always reports "no match".
			select: () => {
				const builder = {
					eq: () => builder,
					gte: () => builder,
					order: () => builder,
					limit: async () => ({ data: [], error: null }),
				};
				return builder;
			},
			insert: (row: Record<string, unknown>) => {
				captured.row = row;
				return {
					select: () => ({
						single: async () => ({ data: { ...row, created_at: "2026-08-22T00:00:00Z" }, error: null }),
					}),
				};
			},
		};
	});

	return captured;
}

beforeEach(() => {
	prefsBox.current = { default_surface: undefined };
});

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase.storage as any).from = origStorageFrom;
	vi.restoreAllMocks();
});

describe("shared surface vocabulary", () => {
	it("every value a writer stamps is listed in the human-facing SURFACES vocab", () => {
		// The lists have different jobs — ARTIFACT_SURFACES is what code writes,
		// SURFACES is what a human reads when deciding what to put in
		// `surface_role_map` — but a value that resolves in production and is absent
		// from the vocabulary is exactly how a surface becomes un-configurable in
		// practice, which is the #584 defect wearing a different hat.
		for (const value of Object.values(ARTIFACT_SURFACES)) {
			expect(SURFACES as readonly string[], `SURFACES is missing '${value}'`).toContain(value);
		}
	});

	it("no two names map to the same surface value", () => {
		const values = Object.values(ARTIFACT_SURFACES);
		expect(new Set(values).size).toBe(values.length);
	});

	it("lists the surfaces migration 091 mints, which no writer produces", () => {
		// These two exist only because the backfill creates them, so nothing in the
		// type system or the guard keeps them alive — a future tidy-up would read
		// them as dead entries. They must stay: 091's promise for these 18 rows is
		// that the owner can finally address them, and `surface_role_map` is keyed
		// on exactly this string. A row with a key nobody can discover is the #584
		// defect in its subtler form. Deliberately NOT in ARTIFACT_SURFACES, which
		// is scoped to values this repo's writers stamp.
		for (const value of ["n8n_upload", "legacy_unrecorded"]) {
			expect(SURFACES as readonly string[], `SURFACES is missing '${value}'`).toContain(value);
			expect(Object.values(ARTIFACT_SURFACES) as readonly string[]).not.toContain(value);
		}
	});
	it("lists caller-supplied Claude surfaces including claude_mobile", () => {
		for (const value of ["claude_code", "claude_chat", "claude_mobile"]) {
			expect(SURFACES as readonly string[], `SURFACES is missing '${value}'`).toContain(value);
		}
	});
});

describe("capture — surface resolution (#584)", () => {
	it("uses the caller's surface when one is passed", async () => {
		prefsBox.current = { default_surface: "web_app" };
		const captured = stubArtifactWrite();

		await captureHandler({ text: "a note", surface: "claude_code" });

		expect(captured.row?.surface).toBe("claude_code");
	});

	it("falls back to the owner's configured default_surface", async () => {
		prefsBox.current = { default_surface: "browser_extension" };
		const captured = stubArtifactWrite();

		await captureHandler({ text: "a note" });

		expect(captured.row?.surface).toBe("browser_extension");
	});

	it("falls back to the api floor when neither rung supplies one — never null", async () => {
		// This is production's actual state: the live capture_preferences blob is
		// `{"create_derived_artifacts": true}`, so default_surface parses to
		// undefined. Before #584 this wrote NULL, and 84 rows in the store prove it.
		prefsBox.current = { default_surface: undefined };
		const captured = stubArtifactWrite();

		await captureHandler({ text: "a note" });

		expect(captured.row?.surface).toBe(ARTIFACT_SURFACES.api);
		expect(captured.row?.surface).not.toBeNull();
	});

	it("prefers the caller over the owner default over the floor, in that order", async () => {
		// One assertion for the precedence itself, so re-ordering the `??` chain
		// fails here rather than only showing up as a wrong value months later.
		prefsBox.current = { default_surface: "web_app" };
		const withCaller = stubArtifactWrite();
		await captureHandler({ text: "n", surface: "mobile_app" });

		prefsBox.current = { default_surface: "web_app" };
		const withPref = stubArtifactWrite();
		await captureHandler({ text: "n" });

		prefsBox.current = { default_surface: undefined };
		const withFloor = stubArtifactWrite();
		await captureHandler({ text: "n" });

		expect([withCaller.row?.surface, withPref.row?.surface, withFloor.row?.surface]).toEqual([
			"mobile_app",
			"web_app",
			ARTIFACT_SURFACES.api,
		]);
	});
});

describe("drive_import_file — surface stamp (#584)", () => {
	it("stamps drive_import on the imported artifact", async () => {
		const captured = stubArtifactWrite();

		await importDriveFileArtifact({ file_id: "drive-file-1" });

		expect(captured.row?.surface).toBe(ARTIFACT_SURFACES.driveImport);
	});

	it("keeps surface distinct from source_channel, so the two Drive paths stay separable", async () => {
		// `google_drive` names the SYSTEM the bytes came from; `discovered_gdrive` (the
		// bulk discover path, seeded to the `evidence` role) already claims that space.
		// Copying the channel here would pool "the owner asked for this one file" with
		// "a whole-account inventory" under one role key — the exact distinction the
		// #567 flood turned on.
		const captured = stubArtifactWrite();

		await importDriveFileArtifact({ file_id: "drive-file-1" });

		expect(captured.row?.source_channel).toBe("google_drive");
		expect(captured.row?.surface).not.toBe(captured.row?.source_channel);
	});

	it("stamps drive_import and google_drive on the core createDriveImportFileAction insert (#1613)", async () => {
		const captured = stubArtifactWrite();
		const action = createDriveImportFileAction({
			drive: {
				getFile: vi.fn(async () => ({
					id: "drive-file-1",
					name: "Lease.txt",
					mimeType: "text/plain",
					webViewLink: "https://drive.google.com/file/d/drive-file-1/view",
					parents: [],
				})),
				downloadFile: vi.fn(async () => ({
					bytes: new TextEncoder().encode("lease terms"),
					mimeType: "text/plain",
					extension: "txt",
				})) as any,
				listFiles: vi.fn() as any,
				createFile: vi.fn() as any,
				updateFile: vi.fn() as any,
				deleteFile: vi.fn() as any,
			},
			artifacts: createSupabaseArtifactRepository({
				client: supabase as any,
				ownerId: "00000000-0000-0000-0000-000000000000",
			}),
			storage: createSupabaseStorageAdapter({
				client: supabase as any,
				supabaseUrl: "https://example.supabase.co",
			}),
			ownerId: "00000000-0000-0000-0000-000000000000",
			storageBucket: "user-uploads",
		});

		await action.run(
			{ file_id: "drive-file-1" },
			{ caller: "ui", requestId: "req-1", userId: "00000000-0000-0000-0000-000000000000" },
		);

		expect(captured.row?.surface).toBe(ARTIFACT_SURFACES.driveImport);
		expect(captured.row?.source_channel).toBe("google_drive");
		expect(captured.row?.surface).not.toBe(captured.row?.source_channel);
	});
});
