import { describe, expect, it, vi } from "vitest";
import type {
	CleanStateArtifactSnapshot,
	CleanStateEvaluationData,
	CleanStatePort,
} from "../../ports/cleanState.js";
import { buildRegistry } from "../buildRegistry.js";
import {
	cleanStateCheckInputSchema,
	createCleanStateCheckAction,
} from "./cleanStateCheck.js";

const USER_ID = "00000000-0000-4000-8000-000000000099";
const INCOMPLETE_ARTIFACT_ID = "00000000-0000-4000-8000-000000000001";
const CLEAN_ARTIFACT_ID = "00000000-0000-4000-8000-000000000002";

function makeCleanSnapshot(
	overrides: Partial<CleanStateArtifactSnapshot> = {},
): CleanStateArtifactSnapshot {
	return {
		id: CLEAN_ARTIFACT_ID,
		title: "Weekly Product Sync Notes",
		content: "Confirmed meeting transcript covering Q4 launch milestones and owner actions.",
		summary: "Q4 launch milestones and actions",
		content_subtype: "meeting-note",
		surface: "gdrive_work",
		source_channel: "google_drive",
		source_url: "https://docs.google.com/document/d/drive-doc-123/edit",
		source_drive_file_id: "drive-doc-123",
		tags: ["work", "meeting"],
		captured_at: "2026-04-20T09:00:00.000Z",
		effective_at: "2026-04-20T09:00:00.000Z",
		has_embedding: true,
		derivation_status: "completed",
		processing_metadata: { domain: "work" },
		domain: "work",
		external_links: [
			{
				id: "ext-1",
				kind: "google_drive",
				url: "https://docs.google.com/document/d/drive-doc-123/edit",
				title: "Weekly Product Sync Notes",
			},
			{
				id: "ext-2",
				kind: "task",
				url: "https://www.notion.so/task-123",
				title: "Ship Q4 milestone checklist",
			},
			{
				id: "ext-3",
				kind: "synthesized",
				url: "https://www.notion.so/daily-log-2026-04-20",
				title: "Daily Log 2026-04-20",
			},
		],
		entity_links: [
			{
				entity_id: "00000000-0000-4000-8000-000000000010",
				relationship_type: "attended",
				entity_type: "people",
				entity_title: "Angus Hally",
			},
			{
				entity_id: "00000000-0000-4000-8000-000000000011",
				relationship_type: "about",
				entity_type: "project",
				entity_title: "Work Q4 Launch",
			},
		],
		structural_relationship_count: 2,
		...overrides,
	};
}

describe("clean_state_check (#1997, ADR-114)", () => {
	it("acceptance 1: calling clean_state_check on an artifact missing embedding, entity links, and synthesis marker returns clean: false with per-layer verdicts and remediation items", async () => {
		const incompleteSnapshot: CleanStateArtifactSnapshot = {
			id: INCOMPLETE_ARTIFACT_ID,
			title: "Raw Meeting Capture",
			content: "Notes from product sync with follow-up items.",
			content_subtype: "meeting-note",
			surface: "claude_code",
			source_channel: "mcp",
			source_url: null,
			source_drive_file_id: null,
			tags: ["work"],
			captured_at: "2026-04-20T10:00:00.000Z",
			effective_at: "2026-04-20T10:00:00.000Z",
			has_embedding: false,
			derivation_status: "pending",
			processing_metadata: {},
			domain: "work",
			external_links: [],
			entity_links: [],
			structural_relationship_count: 0,
		};

		const port: CleanStatePort = {
			loadEvaluationData: vi.fn(async (): Promise<CleanStateEvaluationData> => ({
				artifacts: [incompleteSnapshot],
				ledger: { error_count: 0, failed_actions: [] },
			})),
		};

		const action = createCleanStateCheckAction(port);
		expect(action.annotations?.readOnlyHint).toBe(true);

		const result = await action.run({
			input: { artifact_id: INCOMPLETE_ARTIFACT_ID },
			ctx: { surface: "mcp", userId: USER_ID },
		});

		expect(result.clean).toBe(false);
		expect(result.verdict).toBe("fail");
		expect(result.artifacts).toHaveLength(1);

		const [artifactResult] = result.artifacts;
		expect(artifactResult.id).toBe(INCOMPLETE_ARTIFACT_ID);
		expect(artifactResult.layers).toEqual({
			layer1_artifact_integrity: "fail",
			layer2_graph_hygiene: "fail",
			layer3_task_parity: "warn",
			layer4_synthesis_alignment: "fail",
			layer5_ledger_health: "ok",
		});
		expect(artifactResult.missing.length).toBeGreaterThanOrEqual(4);
		expect(artifactResult.missing.some((m) => m.includes("artifact_embed_backfill"))).toBe(true);
		expect(artifactResult.missing.some((m) => m.includes("entity_derive_next"))).toBe(true);
		expect(artifactResult.missing.some((m) => m.includes("task_create"))).toBe(true);
		expect(artifactResult.missing.some((m) => m.includes("synthesized"))).toBe(true);
		expect(result.text).toContain("verdict: FAIL");
	});

	it("acceptance 2: calling clean_state_check when all five layers are satisfied returns clean: true and verdict: 'ok'", async () => {
		const port: CleanStatePort = {
			loadEvaluationData: vi.fn(async (): Promise<CleanStateEvaluationData> => ({
				artifacts: [makeCleanSnapshot({ id: CLEAN_ARTIFACT_ID })],
				ledger: { error_count: 0, failed_actions: [] },
			})),
		};

		const action = createCleanStateCheckAction(port);
		const result = await action.run({
			input: { artifact_id: CLEAN_ARTIFACT_ID },
			ctx: { surface: "mcp", userId: USER_ID },
		});

		expect(result.clean).toBe(true);
		expect(result.verdict).toBe("ok");
		expect(result.artifacts).toHaveLength(1);
		expect(result.artifacts[0].layers).toEqual({
			layer1_artifact_integrity: "ok",
			layer2_graph_hygiene: "ok",
			layer3_task_parity: "ok",
			layer4_synthesis_alignment: "ok",
			layer5_ledger_health: "ok",
		});
		expect(result.artifacts[0].missing).toEqual([]);
		expect(result.text).toContain("verdict: OK");
	});

	it("evaluates a domain window with multiple artifacts and surfaces Layer 5 ledger failures", async () => {
		const cleanArt = makeCleanSnapshot({
			id: CLEAN_ARTIFACT_ID,
			title: "Clean Artifact",
		});
		const warnArt = makeCleanSnapshot({
			id: INCOMPLETE_ARTIFACT_ID,
			title: "Artifact Missing Structural Edge",
			structural_relationship_count: 0,
			external_links: [
				{ kind: "google_drive", url: "https://docs.google.com/document/d/drive-doc-123/edit" },
				{ kind: "synthesized_unattended", url: "https://www.notion.so/log" },
			],
			processing_metadata: { zero_commitments: true },
		});

		const port: CleanStatePort = {
			loadEvaluationData: vi.fn(async (query): Promise<CleanStateEvaluationData> => {
				expect(query.domain).toBe("work");
				expect(query.windowDays).toBe(14);
				expect(query.sessionId).toBe("sess-42");
				return {
					artifacts: [cleanArt, warnArt],
					ledger: {
						error_count: 1,
						failed_actions: [
							{
								id: "led-1",
								action_id: "notion_page_create",
								created_at: "2026-04-20T11:00:00.000Z",
								error_code: "validation_error",
							},
						],
					},
				};
			}),
		};

		const registry = buildRegistry({ cleanState: port });
		const action = registry.get("clean_state_check")!;
		expect(action).toBeDefined();

		const result = (await action.run({
			input: { domain: "work", window_days: 14, session_id: "sess-42" },
			ctx: { surface: "mcp", userId: USER_ID },
		})) as Awaited<ReturnType<ReturnType<typeof createCleanStateCheckAction>["run"]>>;

		expect(result.clean).toBe(false);
		expect(result.verdict).toBe("fail");
		expect(result.artifacts).toHaveLength(2);
		expect(result.artifacts[0].layers.layer5_ledger_health).toBe("fail");
		expect(result.artifacts[1].layers.layer2_graph_hygiene).toBe("warn");
		expect(result.artifacts[1].layers.layer3_task_parity).toBe("ok");
		expect(result.artifacts[1].layers.layer4_synthesis_alignment).toBe("ok");
		expect(result.artifacts[1].layers.layer5_ledger_health).toBe("fail");
		expect(result.artifacts[0].missing.some((m) => m.includes("notion_page_create"))).toBe(true);
	});

	it("validates that at least one of artifact_id or domain is supplied", () => {
		const emptyParse = cleanStateCheckInputSchema.safeParse({});
		expect(emptyParse.success).toBe(false);

		const byIdParse = cleanStateCheckInputSchema.safeParse({
			artifact_id: CLEAN_ARTIFACT_ID,
		});
		expect(byIdParse.success).toBe(true);

		const byDomainParse = cleanStateCheckInputSchema.safeParse({
			domain: "angus",
			window_days: 3,
		});
		expect(byDomainParse.success).toBe(true);
	});

	it("flags Layer 1 failure when Drive external link or confirmed non-stub text is missing", async () => {
		const stubDriveSnapshot = makeCleanSnapshot({
			content: "[stub] Placeholder awaiting transcript extraction",
			external_links: [
				{ kind: "task", url: "https://www.notion.so/task-1" },
				{ kind: "synthesized", url: "https://www.notion.so/log-1" },
			],
		});

		const port: CleanStatePort = {
			loadEvaluationData: vi.fn(async () => ({
				artifacts: [stubDriveSnapshot],
				ledger: { error_count: 0 },
			})),
		};

		const action = createCleanStateCheckAction(port);
		const result = await action.run({
			input: { artifact_id: CLEAN_ARTIFACT_ID },
			ctx: { surface: "mcp", userId: USER_ID },
		});

		expect(result.clean).toBe(false);
		expect(result.verdict).toBe("fail");
		expect(result.artifacts[0].layers.layer1_artifact_integrity).toBe("fail");
		expect(result.artifacts[0].missing.some((m) => m.includes("stub/unconfirmed"))).toBe(true);
		expect(result.artifacts[0].missing.some((m) => m.includes("google_drive"))).toBe(true);
	});
});
