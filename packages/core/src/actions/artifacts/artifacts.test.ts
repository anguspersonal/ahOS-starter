import { describe, expect, it, vi } from "vitest";
import { buildRegistry, AdapterUnavailableError } from "../buildRegistry.js";
import { captureInput } from "../domain/capture.js";
import { formatCaptureMcp } from "./capture.js";
import type {
	ArtifactsPort,
	CaptureResult,
	DocumentDuplicatesResult,
} from "../../ports/artifacts.js";
import { createActionContext } from "../defineAction.js";

const fakeCaptureResult: CaptureResult = {
	id: "12345678-1234-1234-1234-123456789abc",
	title: "Test Note",
	tags: ["tag1", "tag2"],
	source_channel: "api",
	storage_bucket: "artifacts",
	storage_path: "user/note.md",
	captured_at: "2026-10-12T12:00:00.000Z",
	captured_at_declared: false,
	deduplicated: false,
};

const fakeDuplicatesResult: DocumentDuplicatesResult = {
	rows: [],
	clusters: [],
	args: { limit: 20 },
};

describe("Artifacts actions in core (issue #1528)", () => {
	it("acceptance 1: buildRegistry({ artifacts: fakePort }) holds capture and document_duplicates, each running its port with parsed input and userId", async () => {
		const captureFn = vi.fn().mockResolvedValue(fakeCaptureResult);
		const documentDuplicatesFn = vi.fn().mockResolvedValue(fakeDuplicatesResult);

		const fakePort: ArtifactsPort = {
			capture: captureFn,
			documentDuplicates: documentDuplicatesFn,
		};

		const registry = buildRegistry({ artifacts: fakePort });

		const captureAction = registry.get("capture");
		const documentDuplicatesAction = registry.get("document_duplicates");

		expect(captureAction).toBeDefined();
		expect(documentDuplicatesAction).toBeDefined();

		const ctx = createActionContext({ userId: "user-123" });

		const captureInputData = { text: "Hello world" };
		const captureRes = await captureAction!.run(captureInputData, ctx);
		expect(captureRes).toEqual(fakeCaptureResult);
		expect(captureFn).toHaveBeenCalledTimes(1);
		expect(captureFn).toHaveBeenCalledWith(captureInputData, "user-123");

		const duplicatesInputData = { limit: 10 };
		const duplicatesRes = await documentDuplicatesAction!.run(duplicatesInputData, ctx);
		expect(duplicatesRes).toEqual(fakeDuplicatesResult);
		expect(documentDuplicatesFn).toHaveBeenCalledTimes(1);
		expect(documentDuplicatesFn).toHaveBeenCalledWith(duplicatesInputData, "user-123");
		expect(documentDuplicatesAction!.formatMcp?.(fakeDuplicatesResult)).toBe(
			"No duplicate clusters found (clusters of 2+). Only discovered pointers are scanned. exact = byte-identical copies (same Drive md5) of a listed family's members; a renamed copy of a document with no version family shows up when you pass its title as `query`.",
		);
	});

	it("acceptance 2: contracts unchanged (descriptions match dev and captureInput keys/descriptions match dev)", () => {
		const registry = buildRegistry({});
		const captureAction = registry.get("capture");
		const documentDuplicatesAction = registry.get("document_duplicates");

		expect(captureAction?.description).toBe(
			"Dump a note/content into the knowledge store. Stores the body and creates an artifact. captured_at defaults to now; a caller may declare a different day for its OWN artifact via the optional captured_at, but only for an allowlisted content_subtype ('daily_log' today - the Daily Log twin, #562) and never in the future. Both bounds are refusals, not silent fallbacks (#414).",
		);

		expect(documentDuplicatesAction?.description).toBe(
			"Find duplicated documents among discovered pointers: exact copies (same Drive md5) and version " +
				"families (same normalised title), largest first, each with a suggested canonical and why. " +
				"Derived at read; changes nothing. At most 10 members per cluster, with a '+N more' count. " +
				"Full notes: docs/guides/tools/document_duplicates.md",
		);

		// Verify every captureInput key and describe text
		const expectedDescriptions: Record<string, string> = {
			text: "The note / content body to store.",
			title: "Optional title. Derived from the first line of text if omitted.",
			source_url: "Optional URL this note came from (at most 2048 characters).",
			tags: "Optional tags.",
			content_subtype:
				"Optional kind of content, e.g. 'transcript', 'conversation', 'note'. Also carries an explicit user-supplied content-type flag ('task' | 'note' | 'reference' | 'quote' | 'person' | 'meeting-note') when the user typed one — pass it through as given, never inferred from the content (capture is dumb; auto-detection is dropped per docs/design/capture-skill-consolidation.md §b). Used downstream to scope what feeds the SOD/EOD state doc (ADR-013).",
			surface:
				"The app/agent/ingest path this capture came through, e.g. 'claude_code', 'gmail_ingest' (open vocab, see vocab.ts SURFACES). Finer than source_channel; used to derive trust and synthesis role at read time (ADR-026, ADR-046 §3). Falls back to the user's default_surface, then to 'api' — never null, since a null surface is a row no role/trust map entry can address (#584). Declare it whenever you know it: the floor is honest, not informative.",
			trust_override:
				"Optional explicit trust tier for THIS capture, overriding the value normally derived from its surface (e.g. a low-trust forward arriving on a trusted surface). One of: perfect|high|medium|low|unverified (ADR-026).",
			captured_by:
				"The actor that captured this (e.g. 'user', or an automation name). Not the surface.",
			urgency:
				"Optional user-supplied urgency dial for THIS capture: 'throw' (fire-and-forget), 'default', or 'file' (the user flagged it as needing fuller downstream handling). Written faithfully and NEVER acted on at capture time — the enrich consumer (#52) reads it to decide how much to do (ADR-018). Set only from an explicit user signal (e.g. a '-throw'/'-file' flag), never inferred from content.",
			captured_at:
				"Optional ISO timestamp (or 'YYYY-MM-DD') declaring the day this content is ABOUT, when that differs from now. Defaults to now. Two hard bounds, both refusals rather than silent fallbacks: a future value is rejected, and it is honoured only for content_subtype in [daily_log] — today just the Daily Log twin (#562), whose day is fixed by the entry it mirrors and is up to seven days before write time when the unattended sweep (#561) writes it. This is a caller DECLARATION about its own artifact, not capture inferring a date; an unbounded dial would let any caller misfile atoms into arbitrary day buckets (#414). See #571 for whether a general originated_at should exist instead.",
			dedup_key:
				"Optional caller-supplied idempotency key (#993), scoped to the caller's user_id, same shape as create_external_link's dedup_key. A second capture with the same dedup_key returns the FIRST artifact's id with deduplicated: true instead of inserting a new row — enforced race-safely by a real unique index, unlike the default content-fingerprint dedup below. Use this when the caller already has a stable identity for what it's submitting (e.g. re-posting the same webhook payload); leave it unset to fall back on the default fingerprint+window guard.",
			processing_metadata:
				"Optional structured processing metadata stored in the processing_metadata column (e.g. { pillars: [...] } on a Daily Log twin, #657).",
		};

		const keys = Object.keys(expectedDescriptions);
		expect(Object.keys(captureInput).sort()).toEqual(keys.sort());

		for (const key of keys) {
			const schema = (captureInput as Record<string, { description?: string }>)[key];
			expect(schema.description).toBe(expectedDescriptions[key]);
		}
	});

	it("acceptance 3: formatMcp on fixture results matches dev", () => {
		const standardResult: CaptureResult = {
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			title: "Meeting notes with Sarah",
			tags: ["work", "meeting"],
			source_channel: "slack",
			storage_bucket: "artifacts",
			storage_path: "user123/a1b2c3d4-e5f6-7890-abcd-ef1234567890.md",
			captured_at: "2026-10-12T10:00:00.000Z",
			captured_at_declared: false,
			deduplicated: false,
		};

		const expectedStandard =
			"Captured artifact a1b2c3d4-e5f6-7890-abcd-ef1234567890\n" +
			"Title: Meeting notes with Sarah\n" +
			"Tags: work, meeting\n" +
			"Channel: slack\n" +
			"Stored at: artifacts/user123/a1b2c3d4-e5f6-7890-abcd-ef1234567890.md";

		expect(formatCaptureMcp(standardResult)).toBe(expectedStandard);

		const declaredDedupResult: CaptureResult = {
			id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
			title: "2026-10-10 Daily Log",
			tags: [],
			source_channel: "api",
			storage_bucket: "artifacts",
			storage_path: "user123/b2c3d4e5-f6a7-8901-bcde-f12345678901.md",
			captured_at: "2026-10-10T00:00:00.000Z",
			captured_at_declared: true,
			deduplicated: true,
		};

		const expectedDeclaredDedup =
			"Captured artifact b2c3d4e5-f6a7-8901-bcde-f12345678901\n" +
			"Title: 2026-10-10 Daily Log\n" +
			"Tags: (none)\n" +
			"Channel: api\n" +
			"Stored at: artifacts/user123/b2c3d4e5-f6a7-8901-bcde-f12345678901.md\n" +
			"Filed under: 2026-10-10T00:00:00.000Z (declared)\n" +
			"Deduplicated: true (matched an existing artifact, nothing new was written)";

		expect(formatCaptureMcp(declaredDedupResult)).toBe(expectedDeclaredDedup);
	});

	it("throws AdapterUnavailableError naming artifacts when adapter is omitted", async () => {
		const registry = buildRegistry({});
		const captureAction = registry.get("capture")!;
		const documentDuplicatesAction = registry.get("document_duplicates")!;

		const ctx = createActionContext({ userId: "user-123" });

		await expect(captureAction.run({ text: "test" }, ctx)).rejects.toThrow(
			AdapterUnavailableError,
		);
		await expect(captureAction.run({ text: "test" }, ctx)).rejects.toThrow(
			/artifacts adapter is not wired in this process/,
		);

		await expect(documentDuplicatesAction.run({}, ctx)).rejects.toThrow(
			AdapterUnavailableError,
		);
		await expect(documentDuplicatesAction.run({}, ctx)).rejects.toThrow(
			/artifacts adapter is not wired in this process/,
		);
	});
});
