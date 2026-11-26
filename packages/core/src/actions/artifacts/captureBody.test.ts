import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";
import { ArtifactWriteError, type DedupMatch } from "../../ports/artifacts.js";
import { formatCaptureMcp } from "./capture.js";
import {
	CAPTURE_DEDUP_WINDOW_MS,
	computeContentFingerprint,
	findDedupMatch,
	resolveCapturedAt,
	runCapture,
	type CaptureBodyDeps,
} from "./captureBody.js";

function devFingerprint(input: {
	title: string;
	text: string;
	contentSubtype: string | undefined;
	surface: string;
	sourceChannel: string;
	tags: string[];
}): string {
	const norm = (v: string) => v.trim().toLowerCase().replace(/\s+/g, " ");
	const payload = [
		norm(input.title),
		norm(input.text),
		input.contentSubtype ?? "",
		input.surface,
		input.sourceChannel,
		[...input.tags].sort().join(","),
	].join("\u0000");
	return createHash("sha256").update(payload, "utf8").digest("hex");
}

function makeDeps(overrides: Partial<CaptureBodyDeps> = {}) {
	const uploads: Array<{ bucket: string; path: string; body: string | Uint8Array }> = [];
	const removed: Array<{ bucket: string; paths: string[] }> = [];
	const inserted: unknown[] = [];
	const embedded: Array<{ table: string; id: string; vector: number[] }> = [];

	const base: CaptureBodyDeps = {
		storageBucket: "artifacts",
		ownerId: "user-1",
		now: () => new Date("2026-09-24T12:00:00.000Z"),
		config: {
			loadCapturePreferences: vi.fn(async () => ({
				create_derived_artifacts: true,
				default_tags: ["inbox"],
				default_source_channel: "note",
				tag_rules: [],
				default_surface: undefined,
				surface_trust_map: {},
				default_trust: "medium" as const,
				default_role: "narrative" as const,
				surface_role_map: {},
			})),
		},
		storage: {
			upload: vi.fn(async (bucket, path, body) => {
				uploads.push({ bucket, path, body });
			}),
			remove: vi.fn(async (bucket, paths) => {
				removed.push({ bucket, paths });
			}),
			publicUrl: (bucket, path) => `https://example.supabase.co/storage/v1/object/public/${bucket}/${path}`,
		},
		artifacts: {
			findOldestByDedupKey: vi.fn(async () => null),
			findOldestByFingerprint: vi.fn(async () => null),
			insert: vi.fn(async (row) => {
				inserted.push(row);
				return { id: row.id, title: row.title, created_at: "2026-09-24T12:00:00.000Z" };
			}),
			patch: vi.fn(async (id, patch) => ({
				id,
				title: (patch.title as string) ?? null,
				description: null,
				plain_text: (patch.plain_text as string) ?? null,
				storage_bucket: "artifacts",
				storage_path: `notes/user-1/${id}.md`,
				file_type: "text/markdown",
				routing_decision: null,
				drive_action: null,
				archived: false,
				updated_at: "2026-09-24T12:00:00.000Z",
			})),
		},
		embeddings: {
			embed: vi.fn(async () => [0.25, 0.5]),
			embedBatch: vi.fn(async () => [[0.25, 0.5]]),
		},
		embeddingStore: {
			setEmbedding: vi.fn(async (table, id, vector) => {
				embedded.push({ table, id, vector });
			}),
		},
		...overrides,
	};

	return { deps: base, uploads, removed, inserted, embedded };
}

describe("captureBody (#1658)", () => {
	it("1. Fingerprint parity: computeContentFingerprint matches createHash('sha256') across 6 fixtures", async () => {
		const fixtures = [
			{ title: "Simple Note", text: "Hello world", contentSubtype: undefined, surface: "api", sourceChannel: "note", tags: [] },
			{ title: "  Spaced   TITLE\n", text: "Line 1\n\n  Line 2\t", contentSubtype: "note", surface: "claude_code", sourceChannel: "mcp", tags: ["b", "a"] },
			{ title: "Daily Log", text: "Nothing notable.", contentSubtype: "daily_log", surface: "dos", sourceChannel: "note", tags: ["daily", "log", "work"] },
			{ title: "Unicode Title", text: "Cafe résumé naïve 🚀", contentSubtype: "transcript", surface: "web_app", sourceChannel: "web", tags: ["utf8"] },
			{ title: "Order check", text: "Same tags reversed", contentSubtype: "task", surface: "mobile_app", sourceChannel: "note", tags: ["z", "m", "a"] },
			{ title: "Empty tags", text: "x", contentSubtype: "meeting-note", surface: "gmail_ingest", sourceChannel: "email", tags: [] },
		];

		for (const fixture of fixtures) {
			await expect(computeContentFingerprint(fixture)).resolves.toBe(devFingerprint(fixture));
		}
	});

	it("2. Dedup order: dedup_key wins without writes; system subtype skips fingerprint; fingerprint inside 2m returns oldest; read error counts as no match", async () => {
		const existing: DedupMatch = {
			id: "11111111-1111-4111-8111-111111111111",
			title: "Existing",
			tags: ["a"],
			source_channel: "note",
			storage_bucket: "artifacts",
			storage_path: "notes/user-1/11111111-1111-4111-8111-111111111111.md",
			captured_at: "2026-09-24T11:59:00.000Z",
		};

		const { deps: keyDeps, uploads, inserted } = makeDeps({
			artifacts: {
				findOldestByDedupKey: vi.fn(async () => existing),
				findOldestByFingerprint: vi.fn(async () => null),
				insert: vi.fn(),
			},
		});
		const byKey = await runCapture(keyDeps, { text: "body", dedup_key: "k-1" });
		expect(byKey).toMatchObject({ id: existing.id, deduplicated: true });
		expect(uploads).toHaveLength(0);
		expect(inserted).toHaveLength(0);

		const byFingerprintSpy = vi.fn(async () => existing);
		const sysMatch = await findDedupMatch(
			{ findOldestByDedupKey: vi.fn(async () => null), findOldestByFingerprint: byFingerprintSpy },
			undefined,
			"fp-1",
			"meeting-note",
			new Date("2026-09-24T12:00:00.000Z"),
		);
		expect(sysMatch).toBeNull();
		expect(byFingerprintSpy).not.toHaveBeenCalled();

		const now = new Date("2026-09-24T12:00:00.000Z");
		const fpMatch = await findDedupMatch(
			{ findOldestByDedupKey: vi.fn(async () => null), findOldestByFingerprint: byFingerprintSpy },
			undefined,
			"fp-1",
			"note",
			now,
		);
		expect(fpMatch).toEqual(existing);
		expect(byFingerprintSpy).toHaveBeenCalledWith(
			"fp-1",
			new Date(now.getTime() - CAPTURE_DEDUP_WINDOW_MS).toISOString(),
		);

		const errMatch = await findDedupMatch(
			{
				findOldestByDedupKey: vi.fn(async () => {
					throw new Error("db offline");
				}),
				findOldestByFingerprint: vi.fn(async () => {
					throw new Error("db offline");
				}),
			},
			"k-err",
			"fp-1",
			"note",
			now,
		);
		expect(errMatch).toBeNull();
	});

	it("3. Race-closer: 23505 on dedup_key removes uploaded object and returns winner; other errors remove object and reject 'Insert failed: <message>'", async () => {
		const winner: DedupMatch = {
			id: "22222222-2222-4222-8222-222222222222",
			title: "Winner",
			tags: ["w"],
			source_channel: "note",
			storage_bucket: "artifacts",
			storage_path: "notes/user-1/22222222-2222-4222-8222-222222222222.md",
			captured_at: "2026-09-24T12:00:00.000Z",
		};
		const findByKey = vi
			.fn<() => Promise<DedupMatch | null>>()
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(winner);

		const { deps: raceDeps, removed: raceRemoved } = makeDeps({
			artifacts: {
				findOldestByDedupKey: findByKey,
				findOldestByFingerprint: vi.fn(async () => null),
				insert: vi.fn(async () => {
					throw new ArtifactWriteError("duplicate key value", "23505");
				}),
			},
		});

		const raceResult = await runCapture(raceDeps, { text: "race body", dedup_key: "race-key" });
		expect(raceResult).toMatchObject({ id: winner.id, title: "Winner", deduplicated: true });
		expect(raceRemoved).toHaveLength(1);

		const { deps: failDeps, removed: failRemoved } = makeDeps({
			artifacts: {
				findOldestByDedupKey: vi.fn(async () => null),
				findOldestByFingerprint: vi.fn(async () => null),
				insert: vi.fn(async () => {
					throw new ArtifactWriteError("disk full", "53100");
				}),
			},
		});

		await expect(runCapture(failDeps, { text: "boom" })).rejects.toThrow("Insert failed: disk full");
		expect(failRemoved).toHaveLength(1);
	});

	it("4. Refused captured_at rejects before any storage call; reflection accepts declared captured_at", async () => {
		const { deps, uploads } = makeDeps();
		await expect(
			runCapture(deps, { text: "not backdatable", content_subtype: "note", captured_at: "2026-08-01" }),
		).rejects.toThrow(/only be declared for content_subtype/);
		expect(uploads).toHaveLength(0);
		expect(() =>
			resolveCapturedAt("2026-09-25T00:00:00.000Z", "daily_log", new Date("2026-09-24T12:00:00.000Z")),
		).toThrow(/is in the future/);

		const { deps: refDeps, inserted: refInserted } = makeDeps();
		await runCapture(refDeps, {
			text: "Weekly reflection",
			content_subtype: "reflection",
			captured_at: "2026-08-01",
		});
		expect(refInserted).toHaveLength(1);
		expect((refInserted[0] as { content_subtype: string; captured_at: string })).toMatchObject({
			content_subtype: "reflection",
			captured_at: "2026-08-01T00:00:00.000Z",
		});
	});

	it("5. Success: uploads once, inserts dev columns with surface precedence (caller -> owner -> api), embeds on artifacts, and matches formatCaptureMcp", async () => {
		const { deps, uploads, inserted, embedded } = makeDeps();
		const res = await runCapture(deps, { text: "First line title\nBody text", tags: ["custom"] });

		expect(uploads).toHaveLength(1);
		expect(inserted).toHaveLength(1);
		const row = inserted[0] as Record<string, unknown>;
		expect(row).toMatchObject({
			user_id: "user-1",
			storage_bucket: "artifacts",
			storage_path: `notes/user-1/${res.id}.md`,
			storage_url: `https://example.supabase.co/storage/v1/object/public/artifacts/notes/user-1/${res.id}.md`,
			file_type: "text/markdown",
			content_type: "text/markdown",
			file_extension: "md",
			file_size: new TextEncoder().encode("First line title\nBody text").length,
			artifact_type: "original",
			surface: ARTIFACT_SURFACES.api,
			lifecycle_stage: "uploaded",
			processing_status: "pending",
			title: "First line title",
			plain_text: "First line title\nBody text",
			tags: ["inbox", "custom"],
			processing_metadata: { derivation: { status: "pending" } },
		});
		expect(embedded).toEqual([{ table: "artifacts", id: res.id, vector: [0.25, 0.5] }]);
		expect(formatCaptureMcp(res)).toBe(
			`Captured artifact ${res.id}\nTitle: First line title\nTags: inbox, custom\nChannel: note\nStored at: artifacts/notes/user-1/${res.id}.md`,
		);

		const { deps: ownerDeps, inserted: ownerInserted } = makeDeps({
			config: {
				loadCapturePreferences: async () => ({
					create_derived_artifacts: true,
					default_tags: [],
					default_source_channel: "note",
					tag_rules: [],
					default_surface: "web_app",
					surface_trust_map: {},
					default_trust: "medium",
					default_role: "narrative",
					surface_role_map: {},
				}),
			},
		});
		await runCapture(ownerDeps, { text: "note" });
		await runCapture(ownerDeps, { text: "note", surface: "claude_code" });
		expect((ownerInserted[0] as { surface: string }).surface).toBe("web_app");
		expect((ownerInserted[1] as { surface: string }).surface).toBe("claude_code");
	});
});
