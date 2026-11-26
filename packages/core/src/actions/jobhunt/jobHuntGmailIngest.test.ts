import { describe, expect, it, vi } from "vitest";
import { JOB_APPLICATION_ENTITY_KIND } from "../../domain/jobApplications.js";
import type { CapturePort } from "../../ports/artifacts.js";
import type { ConfigPreferencesRepository } from "../../ports/config.js";
import type { DecisionRepository, JobApplicationWatermarkRecord } from "../../ports/decisions.js";
import type { EntityRow } from "../../ports/entities.js";
import type { GmailPort, ParsedMessage } from "../../ports/gmail.js";
import { executeAction } from "../adapters/direct.js";
import { resolveCapturedAt, runCapture } from "../artifacts/captureBody.js";
import { captureSchema } from "../domain/capture.js";
import {
	PendingApprovalError,
	type ActionApprovalStore,
} from "../gate.js";
import { createJobApplicationUpsertAction } from "./jobApplicationUpsert.js";
import { createJobPipelineReadAction } from "./jobPipelineRead.js";
import {
	createJobHuntGmailIngestAction,
	type JobHuntGmailIngestDeps,
} from "./jobHuntGmailIngest.js";

const VALID_USER_TASKS_COLUMNS = new Set([
	"id",
	"title",
	"description",
	"status",
	"priority",
	"priority_level",
	"task_type",
	"recurrence_rule",
	"effort",
	"energy_mode",
	"source",
	"due_date",
	"completed_at",
	"assigned_to",
	"created_by",
	"created_via",
	"confidence_score",
	"tags",
	"notes",
	"entity_id",
	"source_artifact_id",
	"due_time",
	"duration_minutes",
	"team_id",
	"created_at",
	"updated_at",
	"user_id",
]);

function makeMessage(overrides: Partial<ParsedMessage>): ParsedMessage {
	return {
		id: "msg-1",
		threadId: "thr-1",
		from: "no-reply@example.com",
		to: "owner@personal.example",
		cc: "",
		subject: "Thank you for applying for Strategy Director at Veeva",
		date: "2026-11-20T10:00:00.000Z",
		labelIds: ["INBOX"],
		snippet: "",
		body: "",
		links: [],
		attachments: [],
		...overrides,
	};
}

function makeAppEntity(
	id: string,
	title: string,
	props: Record<string, unknown>,
): EntityRow {
	return {
		id,
		entity_type: "arrangement",
		title,
		archived: false,
		aliases: [],
		properties: {
			kind: JOB_APPLICATION_ENTITY_KIND,
			...props,
		},
	} as unknown as EntityRow;
}

function makeOrgEntity(id: string, title: string, aliases: string[] = []): EntityRow {
	return {
		id,
		entity_type: "organization",
		title,
		archived: false,
		aliases,
		properties: {},
	} as unknown as EntityRow;
}

function makeDeps(overrides: Partial<JobHuntGmailIngestDeps> = {}) {
	const watermarksWritten: JobApplicationWatermarkRecord[] = [];
	const parkedApprovals: Array<{ actionId: string; input: unknown }> = [];
	const createdTasks: Array<Record<string, unknown>> = [];
	const createdEntities: Array<Record<string, unknown>> = [];
	const updatedEntities: Array<{ id: string; patch: Record<string, unknown> }> = [];
	const modifiedLabels: Array<{ messageId: string; addLabelIds?: string[]; removeLabelIds?: string[] }> = [];
	const upsertedLinks: Array<Record<string, unknown>> = [];

	const gmail: GmailPort = {
		searchMessages: vi.fn(async ({ query }) => {
			if (query.startsWith("in:sent")) return [];
			return [];
		}),
		getMessage: vi.fn(),
		getThread: vi.fn(),
		getProfile: vi.fn(),
		listLabels: vi.fn(async () => []),
		ensureLabel: vi.fn(async ({ name }) => ({
			label: { id: "lbl-job-hunt", name },
			created: true,
		})),
		getReplyContext: vi.fn(),
		createDraft: vi.fn(),
		updateDraft: vi.fn(),
		getDraft: vi.fn(),
		sendDraft: vi.fn(),
		modifyLabels: vi.fn(async (params) => {
			modifiedLabels.push({
				messageId: params.target.id,
				addLabelIds: params.addLabelIds,
				removeLabelIds: params.removeLabelIds,
			});
			return { id: params.target.id, labelIds: params.addLabelIds ?? [] };
		}),
	};

	const entities = {
		loadRows: vi.fn(async () => ({ rows: [], total: 0 })),
		getById: vi.fn(async () => null),
		getByIds: vi.fn(async () => []),
		getTitleById: vi.fn(async () => null),
		create: vi.fn(async (row: Record<string, unknown>) => {
			const id = `ent-${createdEntities.length + 1}`;
			createdEntities.push({ id, ...row });
			return { id, ...row };
		}),
		update: vi.fn(async (ids: string | readonly string[], patch: Record<string, unknown>) => {
			const id = typeof ids === "string" ? ids : ids[0];
			updatedEntities.push({ id, patch });
			return [{ id, ...patch }];
		}),
		upsert: vi.fn(),
	} as unknown as JobHuntGmailIngestDeps["entities"];

	const decisions = {
		listJobApplicationWatermarks: vi.fn(async () => new Set<string>()),
		recordJobApplicationWatermarks: vi.fn(async (records: readonly JobApplicationWatermarkRecord[]) => {
			watermarksWritten.push(...records);
		}),
	} as unknown as DecisionRepository;

	const approvalStore: ActionApprovalStore = {
		park: vi.fn(async (req) => {
			parkedApprovals.push({ actionId: req.actionId, input: req.input });
			return { decisionId: `dec-${parkedApprovals.length}` };
		}),
	};

	const capturedPayloads: Array<Record<string, unknown>> = [];

	const tasks = {
		insert: vi.fn(async (row: Record<string, unknown>) => {
			for (const col of Object.keys(row)) {
				if (!VALID_USER_TASKS_COLUMNS.has(col)) {
					throw new Error(`Could not find the '${col}' column of 'user_tasks' in the schema cache`);
				}
			}
			const id = typeof row.id === "string" ? row.id : `task-${createdTasks.length + 1}`;
			createdTasks.push({ ...row, id });
			return { ...row, id };
		}),
		list: vi.fn(async () => []),
		query: vi.fn(async () => []),
		update: vi.fn(async () => ({})),
	} as unknown as JobHuntGmailIngestDeps["tasks"];

	const links = {
		upsert: vi.fn(async (rows: readonly Record<string, unknown>[]) => {
			upsertedLinks.push(...rows);
			return rows;
		}),
	} as unknown as JobHuntGmailIngestDeps["links"];

	const capture: CapturePort = {
		capture: vi.fn(async (input) => {
			const parsed = captureSchema.parse(input);
			const resolvedAt = resolveCapturedAt(parsed.captured_at, parsed.content_subtype);
			capturedPayloads.push(parsed as unknown as Record<string, unknown>);
			return {
				id: "00000000-0000-4000-8000-000000000099",
				title: parsed.title ?? "Email",
				tags: parsed.tags ?? [],
				source_channel: parsed.surface ?? "gmail",
				storage_bucket: "artifacts",
				storage_path: "test/art-1.md",
				captured_at: resolvedAt,
				captured_at_declared: Boolean(parsed.captured_at),
				deduplicated: false,
			};
		}),
	};

	const config = {
		loadPreferencesRow: vi.fn(async () => ({
			confidence_thresholds: {},
		})),
	} as unknown as ConfigPreferencesRepository;

	const deps: JobHuntGmailIngestDeps = {
		gmail,
		ownerAddresses: ["owner@personal.example"],
		entities,
		decisions,
		approvalStore,
		tasks,
		links,
		capture,
		config,
		ownerId: "user-1",
		...overrides,
	};

	return {
		deps,
		watermarksWritten,
		parkedApprovals,
		createdTasks,
		createdEntities,
		updatedEntities,
		modifiedLabels,
		upsertedLinks,
		capturedPayloads,
	};
}

describe("job_hunt_gmail_ingest", () => {
	it("enforces personal 'angus' mailbox only and rejects 'work'", async () => {
		const { deps } = makeDeps();
		const action = createJobHuntGmailIngestAction(deps);

		await expect(
			executeAction(
				action,
				{ domain: "work", mode: "shadow", dry_run: false },
				{ context: { caller: "worker", userId: "user-1" } },
			),
		).rejects.toThrow(/personal 'angus' mailbox/i);
	});

	it("dry_run writes nothing to Supabase or Gmail", async () => {
		const msg = makeMessage({ id: "m-dry", threadId: "t-dry" });
		const { deps, watermarksWritten, parkedApprovals, modifiedLabels } = makeDeps({
			gmail: {
				...makeDeps().deps.gmail!,
				searchMessages: vi.fn(async ({ query }) => (query.startsWith("in:sent") ? [] : [msg])),
			},
		});

		const action = createJobHuntGmailIngestAction(deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "label", dry_run: true },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.dry_run).toBe(true);
		expect(res.classified_updates).toBe(1);
		expect(res.items[0].outcome).toBe("dry_run");
		expect(watermarksWritten).toHaveLength(0);
		expect(parkedApprovals).toHaveLength(0);
		expect(modifiedLabels).toHaveLength(0);
	});

	it("shadow mode logs audit-only watermarks with zero Gmail writes or approvals", async () => {
		const msg = makeMessage({ id: "m-shadow", threadId: "t-shadow" });
		const { deps, watermarksWritten, parkedApprovals, modifiedLabels } = makeDeps({
			gmail: {
				...makeDeps().deps.gmail!,
				searchMessages: vi.fn(async ({ query }) => (query.startsWith("in:sent") ? [] : [msg])),
			},
		});

		const action = createJobHuntGmailIngestAction(deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "shadow", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.shadow_logged).toBe(1);
		expect(watermarksWritten).toHaveLength(1);
		expect(watermarksWritten[0]).toMatchObject({
			message_id: "m-shadow",
			mode: "shadow",
			outcome: "shadow_logged",
		});
		expect(parkedApprovals).toHaveLength(0);
		expect(modifiedLabels).toHaveLength(0);
	});

	it("skips seeded provenance message IDs and non-shadow watermarks", async () => {
		const mSeeded = makeMessage({ id: "m-seeded", threadId: "t-1" });
		const mWatermarked = makeMessage({ id: "m-wm", threadId: "t-2" });
		const mFresh = makeMessage({ id: "m-fresh", threadId: "t-3" });

		const app = makeAppEntity("app-1", "Veeva · Strategy Director", {
			role_title: "Strategy Director",
			stage: "applied",
		});

		const base = makeDeps();
		const { deps, watermarksWritten } = makeDeps({
			gmail: {
				...base.deps.gmail!,
				searchMessages: vi.fn(async ({ query }) =>
					query.startsWith("in:sent") ? [] : [mSeeded, mWatermarked, mFresh],
				),
			},
			entities: {
				...base.deps.entities,
				loadRows: vi.fn(async () => ({ rows: [app], total: 1 })),
			} as unknown as JobHuntGmailIngestDeps["entities"],
			artifacts: {
				listLinkedArtifactsForEntities: vi.fn(async () => [
					{
						entity_id: "app-1",
						artifact_id: "art-seed",
						link_type: "related",
						confidence_score: null,
						notes: null,
						artifact: {
							id: "art-seed",
							title: "Seeded",
							source: "gmail:m-seeded",
							source_channel: "gmail",
							source_url: null,
							storage_url: null,
							file_type: null,
							captured_at: null,
							originated_at: null,
							created_at: null,
							archived: false,
							processing_metadata: { gmail_message_id: "m-seeded" },
						},
					},
				]),
			} as unknown as JobHuntGmailIngestDeps["artifacts"],
			decisions: {
				listJobApplicationWatermarks: vi.fn(async () => new Set(["m-wm::primary"])),
				recordJobApplicationWatermarks: vi.fn(async (recs) => {
					watermarksWritten.push(...recs);
				}),
			} as unknown as DecisionRepository,
		});

		const action = createJobHuntGmailIngestAction(deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.skipped_seeded_provenance).toBe(1);
		expect(res.skipped_watermarked).toBe(1);
		expect(res.parked_approvals).toBe(1);
		expect(watermarksWritten.map((w) => w.message_id)).toEqual(["m-fresh"]);
	});

	it("matches by platform_ref -> thread_id -> (org, role) and parks ambiguous multi-candidates", async () => {
		const uclMsg = makeMessage({
			id: "m-ucl",
			threadId: "t-ucl",
			from: "noreply@university.example.com",
			subject: "UCL - Associate Director Data and Digital (B28-00397) - Application Received",
		});
		const ambigMsg = makeMessage({
			id: "m-ambig",
			threadId: "t-ambig",
			from: "no-reply@example.com",
			subject: "Thank you for applying for Product Lead at Acme",
		});

		const appUcl = makeAppEntity("app-ucl", "UCL · Associate Director", {
			role_title: "Associate Director Data and Digital",
			platform_ref: "B28-00397",
			stage: "identified",
		});
		const appAcme1 = makeAppEntity("app-acme-1", "Acme · Product Lead", {
			role_title: "Product Lead",
			stage: "applied",
		});
		const appAcme2 = makeAppEntity("app-acme-2", "Acme · Product Lead", {
			role_title: "Product Lead",
			stage: "matched",
		});
		const orgAcme = makeOrgEntity("org-acme", "Acme");

		const base = makeDeps();
		const { deps, parkedApprovals } = makeDeps({
			gmail: {
				...base.deps.gmail!,
				searchMessages: vi.fn(async ({ query }) =>
					query.startsWith("in:sent") ? [] : [uclMsg, ambigMsg],
				),
			},
			entities: {
				...base.deps.entities,
				loadRows: vi.fn(async () => ({ rows: [appUcl, appAcme1, appAcme2], total: 3 })),
				getByIds: vi.fn(async () => [orgAcme]),
			} as unknown as JobHuntGmailIngestDeps["entities"],
			graphRead: {
				getOutEdges: vi.fn(async () => [
					{ from_entity_id: "app-acme-1", to_entity_id: "org-acme", relationship_type: "applied_to" },
					{ from_entity_id: "app-acme-2", to_entity_id: "org-acme", relationship_type: "applied_to" },
				]),
				getNodesByIds: vi.fn(async () => [orgAcme]),
			} as unknown as JobHuntGmailIngestDeps["graphRead"],
		});

		const action = createJobHuntGmailIngestAction(deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.items[0]).toMatchObject({
			message_id: "m-ucl",
			matched_application_id: "app-ucl",
			match_step: "platform_ref",
			outcome: "parked_approval",
		});
		expect(res.items[1]).toMatchObject({
			message_id: "m-ambig",
			match_step: "ambiguous",
			candidate_ids: ["app-acme-1", "app-acme-2"],
			outcome: "needs_review",
		});
		expect(parkedApprovals).toHaveLength(2);
	});

	it("label mode adds additive ahOS/job-hunt label without removing INBOX, creates proposed task, and updates last_inbound_at only on inbound human replies", async () => {
		const taskMsg = makeMessage({
			id: "m-cord",
			threadId: "t-cord",
			from: "update@hiring.example.com",
			subject: "New message from Paddy, Co-founder & CEO at Stackfix",
		});
		const sentMsg = makeMessage({
			id: "m-sent",
			threadId: "t-linked",
			from: "owner@personal.example",
			to: "recruiter@employer.example.com",
			subject: "Re: Stackfix",
			labelIds: ["SENT"],
		});
		const inboundMsg = makeMessage({
			id: "m-in",
			threadId: "t-linked",
			from: "recruiter@employer.example.com",
			subject: "Re: Stackfix",
			body: "Let's chat!",
		});

		const appSfId = "00000000-0000-4000-8000-000000000010";
		const orgSfId = "00000000-0000-4000-8000-000000000011";
		const personId = "00000000-0000-4000-8000-000000000012";

		const appStackfix = makeAppEntity(appSfId, "Stackfix · Head of AI", {
			role_title: "Head of AI",
			stage: "applied",
		});
		const orgStackfix = makeOrgEntity(orgSfId, "Stackfix");
		const recruiter = {
			id: personId,
			entity_type: "people",
			title: "Paddy",
			archived: false,
			properties: { email: "recruiter@employer.example.com" },
		} as unknown as EntityRow;

		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [sentMsg] : [taskMsg, inboundMsg],
		);
		ctx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [appStackfix], total: 1 };
			return { rows: [], total: 0 };
		});
		ctx.deps.entities.getByIds = vi.fn(async (ids: string[]) => {
			const out: EntityRow[] = [];
			if (ids.includes(orgSfId)) out.push(orgStackfix);
			if (ids.includes(personId)) out.push(recruiter);
			return out;
		});
		ctx.deps.entities.getById = vi.fn(async (id: string) => (id === appSfId ? appStackfix : null));
		ctx.deps.entities.getTitleById = vi.fn(async () => "Stackfix");
		ctx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: appSfId, to_entity_id: orgSfId, relationship_type: "applied_to" },
				{ from_entity_id: appSfId, to_entity_id: personId, relationship_type: "recruiter" },
			]),
			getNodesByIds: vi.fn(async (ids: string[]) => {
				const out: EntityRow[] = [];
				if (ids.includes(orgSfId)) out.push(orgStackfix);
				if (ids.includes(personId)) out.push(recruiter);
				return out;
			}),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];
		ctx.deps.artifacts = {
			getById: vi.fn(async (id: string) => ({ id, title: "Email" })),
			listLinkedArtifactsForEntities: vi.fn(async () => [
				{
					entity_id: appSfId,
					artifact_id: "00000000-0000-4000-8000-000000000013",
					link_type: "related",
					confidence_score: null,
					notes: null,
					artifact: {
						id: "00000000-0000-4000-8000-000000000013",
						title: "Initial",
						source: "gmail:m-old",
						source_channel: "gmail",
						source_url: null,
						storage_url: null,
						file_type: null,
						captured_at: null,
						originated_at: null,
						created_at: null,
						archived: false,
						processing_metadata: { gmail_message_id: "m-old", gmail_thread_id: "t-linked" },
					},
				},
			]),
		} as unknown as JobHuntGmailIngestDeps["artifacts"];

		const { deps, modifiedLabels, createdTasks, updatedEntities } = ctx;

		const action = createJobHuntGmailIngestAction(deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.tasks_created).toBe(1);
		expect(res.evidence_linked).toBe(2);
		expect(res.labels_added).toBe(3);
		for (const mod of modifiedLabels) {
			expect(mod.addLabelIds).toEqual(["lbl-job-hunt"]);
			expect(mod.removeLabelIds).toBeUndefined();
		}
		expect(createdTasks[0]).toMatchObject({
			title: "Read Cord message from Paddy (Stackfix)",
			status: "proposed",
			source: "email_triage",
			entity_id: appSfId,
		});
		// Only inbound human reply updates last_inbound_at (once)
		expect(updatedEntities).toHaveLength(1);
		expect(updatedEntities[0].patch.properties).toMatchObject({
			last_inbound_at: "2026-11-20T10:00:00.000Z",
		});
	});

	it("act mode auto-executes only when user_preferences.confidence_thresholds.job_application.auto_apply is enabled and met", async () => {
		const msg = makeMessage({ id: "m-act", threadId: "t-act" });
		const appId = "00000000-0000-4000-8000-000000000020";
		const orgId = "00000000-0000-4000-8000-000000000021";
		const app = makeAppEntity(appId, "Veeva · Strategy Director", {
			role_title: "Strategy Director",
			stage: "identified",
		});
		const org = makeOrgEntity(orgId, "Veeva");

		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [msg],
		);
		ctx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [app], total: 1 };
			return { rows: [], total: 0 };
		});
		ctx.deps.entities.getByIds = vi.fn(async () => [org]);
		ctx.deps.entities.getById = vi.fn(async () => app);
		ctx.deps.entities.getTitleById = vi.fn(async () => "Veeva");
		ctx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: appId, to_entity_id: orgId, relationship_type: "applied_to" },
			]),
			getNodesByIds: vi.fn(async () => [org]),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];
		ctx.deps.config = {
			loadPreferencesRow: vi.fn(async () => ({
				confidence_thresholds: { job_application: { auto_apply: 85 } },
			})),
		} as unknown as ConfigPreferencesRepository;

		const { deps, parkedApprovals, updatedEntities } = ctx;

		const action = createJobHuntGmailIngestAction(deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "act", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.errors).toEqual([]);
		expect(res.auto_applied).toBe(1);
		expect(res.parked_approvals).toBe(0);
		expect(parkedApprovals).toHaveLength(0);
		expect(updatedEntities).toHaveLength(1);
	});

	it("passes properties_contains: { kind: 'job_application' } and limit: 1000 to entities.loadRows", async () => {
		const msg = makeMessage({ id: "m-gin", threadId: "t-gin" });
		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [msg],
		);

		const action = createJobHuntGmailIngestAction(ctx.deps);
		await executeAction(
			action,
			{ domain: "angus", mode: "shadow", dry_run: true },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(ctx.deps.entities.loadRows).toHaveBeenCalledWith(
			expect.objectContaining({
				entity_type: "arrangement",
				properties_contains: { kind: JOB_APPLICATION_ENTITY_KIND },
				include_archived: false,
				limit: 1000,
			}),
			"user-1",
		);
	});

	it("captures evidence_only emails through real runCapture without captured_at even when body/snippet/subject are empty", async () => {
		const appId = "00000000-0000-4000-8000-000000000101";
		const personId = "00000000-0000-4000-8000-000000000102";
		const app = makeAppEntity(appId, "Acme · AI Lead", {
			role_title: "AI Lead",
			stage: "applied",
		});
		const recruiter = {
			id: personId,
			entity_type: "people",
			title: "Sam",
			archived: false,
			properties: { email: "sam@acme.example" },
		} as unknown as EntityRow;
		const emptyReply = makeMessage({
			id: "m-empty-body",
			threadId: "t-empty-thread",
			from: "sam@acme.example",
			subject: "",
			body: "",
			snippet: "",
			date: "2026-11-21T12:00:00.000Z",
		});

		const insertedArtifacts: Array<Record<string, unknown>> = [];
		const realCapturePort: CapturePort = {
			capture: (captureInput, userId) =>
				runCapture(
					{
						artifacts: {
							insert: vi.fn(async (row) => {
								insertedArtifacts.push(row as unknown as Record<string, unknown>);
								return {
									id: "00000000-0000-4000-8000-000000000199",
									...row,
								} as any;
							}),
							findOldestByDedupKey: vi.fn(async () => null),
							findOldestByFingerprint: vi.fn(async () => null),
						},
						storage: {
							upload: vi.fn(async () => ({ path: "artifacts/test.md" })),
							remove: vi.fn(async () => {}),
							publicUrl: vi.fn(() => "https://storage.example/test.md"),
						},
						config: {
							loadCapturePreferences: vi.fn(async () => null),
						},
						ownerId: "user-1",
					},
					captureInput,
					userId,
				),
		};

		const ctx = makeDeps({ capture: realCapturePort });
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [emptyReply],
		);
		ctx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [app], total: 1 };
			return { rows: [], total: 0 };
		});
		ctx.deps.entities.getById = vi.fn(async (id: string) => (id === appId ? app : null));
		ctx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: appId, to_entity_id: personId, relationship_type: "recruiter" },
			]),
			getNodesByIds: vi.fn(async () => [recruiter]),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];

		const action = createJobHuntGmailIngestAction(ctx.deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.errors).toEqual([]);
		expect(res.evidence_linked).toBe(1);
		expect(res.items[0]).toMatchObject({
			message_id: "m-empty-body",
			match_step: "contact_email",
			matched_application_id: appId,
			outcome: "evidence_linked",
		});
		expect(insertedArtifacts).toHaveLength(1);
		expect(insertedArtifacts[0].processing_metadata).toMatchObject({
			gmail_message_id: "m-empty-body",
			gmail_thread_id: "t-empty-thread",
			direction: "inbound",
			received_at: "2026-11-21T12:00:00.000Z",
		});
	});

	it("writes only valid user_tasks columns (no metadata) with provenance in notes and created_via: system", async () => {
		const cordMsg = makeMessage({
			id: "m-cord-schema",
			threadId: "t-cord-schema",
			from: "update@hiring.example.com",
			subject: "New message from Paddy, Co-founder & CEO at Stackfix",
		});
		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [cordMsg],
		);

		const action = createJobHuntGmailIngestAction(ctx.deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.errors).toEqual([]);
		expect(res.tasks_created).toBe(1);
		expect(ctx.createdTasks).toHaveLength(1);
		expect(ctx.createdTasks[0]).not.toHaveProperty("metadata");
		expect(ctx.createdTasks[0]).toMatchObject({
			created_via: "system",
			status: "proposed",
			source: "email_triage",
			task_type: "one_off",
		});
		expect(String(ctx.createdTasks[0].notes)).toContain("gmail_message_id=m-cord-schema");
		expect(String(ctx.createdTasks[0].notes)).toContain("gmail_thread_id=t-cord-schema");
		expect(String(ctx.createdTasks[0].notes)).toContain("rule_id=cord_new_message_task");
	});

	it("matches organisation aliases via entities.loadRows even when graphRead strips aliases, and enforces the Dex jobs alias collision guard", async () => {
		const brainlabsMsg = makeMessage({
			id: "m-bl",
			threadId: "t-bl",
			from: "no-reply@example.com",
			subject: "Thank you for applying to Brainlabs",
			body: "We received your application for the Director, Data Strategy role.",
		});
		const dexCrmNamedMsg = makeMessage({
			id: "m-dex-collision",
			threadId: "t-dex-collision",
			from: "no-reply@example.com",
			subject: "Thank you for applying for AI Engineer at Dex",
		});

		const appBlId = "00000000-0000-4000-8000-000000000201";
		const orgBlId = "00000000-0000-4000-8000-000000000202";
		const appDexId = "00000000-0000-4000-8000-000000000203";
		const orgDexId = "00000000-0000-4000-8000-000000000204";

		const appBl = makeAppEntity(appBlId, "Brainlabs Digital · Director, Data Strategy", {
			role_title: "Director, Data Strategy",
			stage: "identified",
		});
		const orgBl = makeOrgEntity(orgBlId, "Brainlabs Digital", ["Brainlabs"]);
		const appDex = makeAppEntity(appDexId, "Dex jobs · AI Engineer", {
			role_title: "AI Engineer",
			stage: "identified",
		});
		const orgDex = makeOrgEntity(orgDexId, "Dex jobs", ["Dex", "meetdex.ai"]);

		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [brainlabsMsg, dexCrmNamedMsg],
		);
		ctx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [appBl, appDex], total: 2 };
			if (filter.ids) {
				const allOrgs = [orgBl, orgDex];
				return {
					rows: allOrgs.filter((o) => filter.ids!.includes(o.id)),
					total: allOrgs.length,
				};
			}
			return { rows: [], total: 0 };
		});
		// Simulate production graphRead.getNodesByIds which NEVER returns `aliases`
		ctx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: appBlId, to_entity_id: orgBlId, relationship_type: "applied_to" },
				{ from_entity_id: appDexId, to_entity_id: orgDexId, relationship_type: "applied_to" },
			]),
			getNodesByIds: vi.fn(async (ids: string[]) =>
				[orgBl, orgDex]
					.filter((o) => ids.includes(o.id))
					.map(({ id, entity_type, title, properties, archived }) => ({
						id,
						entity_type,
						title,
						properties,
						archived,
					})),
			),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];

		const action = createJobHuntGmailIngestAction(ctx.deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "shadow", dry_run: true },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.items[0]).toMatchObject({
			message_id: "m-bl",
			matched_application_id: appBlId,
			match_step: "org_role",
		});
		// Bare "Dex" alias on "Dex jobs" must be blocked by isForbiddenDexJobsAlias
		expect(res.items[1]).toMatchObject({
			message_id: "m-dex-collision",
			matched_application_id: null,
			match_step: "none",
		});
	});

	it("matches new-thread linked-contact replies via contactEmail -> appIds and never watermarks unmatched or ambiguous evidence_only", async () => {
		const app1Id = "00000000-0000-4000-8000-000000000301";
		const app2Id = "00000000-0000-4000-8000-000000000302";
		const app3Id = "00000000-0000-4000-8000-000000000303";
		const singleContactId = "00000000-0000-4000-8000-000000000311";
		const sharedRecruiterId = "00000000-0000-4000-8000-000000000312";

		const app1 = makeAppEntity(app1Id, "Alpha · VP Data", { role_title: "VP Data", stage: "applied" });
		const app2 = makeAppEntity(app2Id, "Beta · Head of AI", { role_title: "Head of AI", stage: "applied" });
		const app3 = makeAppEntity(app3Id, "Gamma · Director AI", { role_title: "Director AI", stage: "applied" });
		const singleContact = {
			id: singleContactId,
			entity_type: "people",
			title: "Alice",
			archived: false,
			properties: { email: "alice@alpha.example" },
		} as unknown as EntityRow;
		const sharedRecruiter = {
			id: sharedRecruiterId,
			entity_type: "people",
			title: "Bob Agency",
			archived: false,
			properties: { email: "bob@agency.example" },
		} as unknown as EntityRow;

		const singleNewThreadInbound = makeMessage({
			id: "m-contact-single",
			threadId: "t-brand-new-1",
			from: "Alice <alice@alpha.example>",
			subject: "Quick question about your background",
			body: "Would love to schedule 20 minutes.",
			date: "2026-11-21T15:00:00.000Z",
		});
		const ambigNewThreadInbound = makeMessage({
			id: "m-contact-ambig",
			threadId: "t-brand-new-2",
			from: "Bob <bob@agency.example>",
			subject: "Checking in on your interviews",
			body: "How are things progressing?",
		});
		const unmatchedBriefing = makeMessage({
			id: "m-briefing-unmatched",
			threadId: "t-briefing-unknown",
			from: "notify@updates.jobs.example.com",
			subject: "Briefing: UnknownCo Screening (Jane Doe)",
		});

		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent")
				? []
				: [singleNewThreadInbound, ambigNewThreadInbound, unmatchedBriefing],
		);
		ctx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [app1, app2, app3], total: 3 };
			return { rows: [], total: 0 };
		});
		ctx.deps.entities.getById = vi.fn(async (id: string) =>
			[app1, app2, app3].find((a) => a.id === id) ?? null,
		);
		ctx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: app1Id, to_entity_id: singleContactId, relationship_type: "hiring_contact" },
				{ from_entity_id: app2Id, to_entity_id: sharedRecruiterId, relationship_type: "recruiter" },
				{ from_entity_id: app3Id, to_entity_id: sharedRecruiterId, relationship_type: "recruiter" },
			]),
			getNodesByIds: vi.fn(async (ids: string[]) =>
				[singleContact, sharedRecruiter].filter((p) => ids.includes(p.id)),
			),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];

		const action = createJobHuntGmailIngestAction(ctx.deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.errors).toEqual([]);
		expect(res.evidence_linked).toBe(1);
		expect(res.needs_review_count).toBe(2);
		expect(res.items[0]).toMatchObject({
			message_id: "m-contact-single",
			matched_application_id: app1Id,
			match_step: "contact_email",
			outcome: "evidence_linked",
		});
		expect(res.items[1]).toMatchObject({
			message_id: "m-contact-ambig",
			matched_application_id: null,
			match_step: "ambiguous",
			candidate_ids: [app2Id, app3Id],
			outcome: "needs_review",
		});
		expect(res.items[2]).toMatchObject({
			message_id: "m-briefing-unmatched",
			matched_application_id: null,
			match_step: "none",
			outcome: "needs_review",
		});
		// Only the unambiguously matched message was watermarked
		expect(ctx.watermarksWritten.map((w) => w.message_id)).toEqual(["m-contact-single"]);
	});

	it("stores direction: 'automated' on Dex CRM screening briefings so job_pipeline_read does not reset last_inbound_at", async () => {
		const appId = "00000000-0000-4000-8000-000000000401";
		const orgId = "00000000-0000-4000-8000-000000000402";
		const app = makeAppEntity(appId, "Telemachus · Special Projects Lead", {
			role_title: "Special Projects Lead",
			stage: "applied",
			applied_on: "2026-11-01",
		});
		const org = makeOrgEntity(orgId, "Telemachus");
		const briefingMsg = makeMessage({
			id: "m-dex-briefing",
			threadId: "t-dex-briefing",
			from: "notify@updates.jobs.example.com",
			subject: "Briefing: Telemachus Screening (Sam Taylor)",
			body: "Prep notes for your upcoming call.",
			date: "2026-11-20T08:00:00.000Z",
		});

		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [briefingMsg],
		);
		ctx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [app], total: 1 };
			if (filter.ids?.includes(orgId)) return { rows: [org], total: 1 };
			return { rows: [], total: 0 };
		});
		ctx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: appId, to_entity_id: orgId, relationship_type: "applied_to" },
			]),
			getNodesByIds: vi.fn(async () => [org]),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];

		const ingestAction = createJobHuntGmailIngestAction(ctx.deps);
		const res = await executeAction(
			ingestAction,
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.errors).toEqual([]);
		expect(res.evidence_linked).toBe(1);
		expect(ctx.capturedPayloads).toHaveLength(1);
		expect(ctx.capturedPayloads[0].processing_metadata).toMatchObject({
			direction: "automated",
			subtype: "dex_screening_briefing",
		});
		expect(ctx.updatedEntities).toHaveLength(0);

		// Verify end-to-end with job_pipeline_read: automated briefing keeps last_inbound_at === null and silent === true
		const pipelineAction = createJobPipelineReadAction({
			...ctx.deps,
			artifacts: {
				listLinkedArtifactsForEntities: vi.fn(async () => [
					{
						entity_id: appId,
						artifact_id: "00000000-0000-4000-8000-000000000099",
						link_type: "related",
						confidence_score: null,
						notes: null,
						artifact: {
							id: "00000000-0000-4000-8000-000000000099",
							title: briefingMsg.subject,
							source: "gmail:m-dex-briefing",
							source_channel: "gmail",
							source_url: null,
							storage_url: null,
							file_type: null,
							captured_at: "2026-11-20T08:00:00.000Z",
							originated_at: null,
							created_at: "2026-11-20T08:00:00.000Z",
							archived: false,
							processing_metadata: ctx.capturedPayloads[0].processing_metadata as Record<
								string,
								unknown
							>,
						},
					},
				]),
			} as unknown as JobHuntGmailIngestDeps["artifacts"],
		});
		const pipeline = await executeAction(
			pipelineAction,
			{ as_of: "2026-11-20" },
			{ context: { caller: "ui", userId: "user-1" } },
		);
		expect(pipeline.applications[0].last_inbound_at).toBeNull();
		expect(pipeline.applications[0].silent).toBe(true);
	});

	it("lists candidates on ambiguous parked approvals (refusing blind execute) and blocks act auto-create when role_title is empty", async () => {
		const app1Id = "00000000-0000-4000-8000-000000000501";
		const app2Id = "00000000-0000-4000-8000-000000000502";
		const orgId = "00000000-0000-4000-8000-000000000503";
		const app1 = makeAppEntity(app1Id, "Acme · Product Lead", { role_title: "Product Lead", stage: "applied" });
		const app2 = makeAppEntity(app2Id, "Acme · Product Lead", { role_title: "Product Lead", stage: "matched" });
		const org = makeOrgEntity(orgId, "Acme");

		const ambigMsg = makeMessage({
			id: "m-ambig-park",
			threadId: "t-ambig-park",
			from: "no-reply@example.com",
			subject: "Thank you for applying for Product Lead at Acme",
		});
		const missingRoleMsg = makeMessage({
			id: "m-no-role",
			threadId: "t-no-role",
			from: "no-reply@example.com",
			subject: "Thanks for applying to NovaCo!",
			body: "We got your application and will be in touch soon.",
		});

		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [ambigMsg, missingRoleMsg],
		);
		ctx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [app1, app2], total: 2 };
			if (filter.ids?.includes(orgId)) return { rows: [org], total: 1 };
			return { rows: [], total: 0 };
		});
		ctx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: app1Id, to_entity_id: orgId, relationship_type: "applied_to" },
				{ from_entity_id: app2Id, to_entity_id: orgId, relationship_type: "applied_to" },
			]),
			getNodesByIds: vi.fn(async () => [org]),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];
		ctx.deps.config = {
			loadPreferencesRow: vi.fn(async () => ({
				confidence_thresholds: { job_application: { auto_apply: 85 } },
			})),
		} as unknown as ConfigPreferencesRepository;

		const action = createJobHuntGmailIngestAction(ctx.deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "act", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.errors).toEqual([]);
		expect(res.auto_applied).toBe(0);
		expect(res.parked_approvals).toBe(2);
		expect(res.needs_review_count).toBe(2);

		// 1. Ambiguous approval carries disambiguation_candidates and refuses blind execution
		const ambigInput = ctx.parkedApprovals[0].input as Record<string, unknown>;
		expect(ambigInput.disambiguation_candidates).toEqual([
			expect.objectContaining({ id: app1Id, title: "Acme · Product Lead", stage: "applied" }),
			expect.objectContaining({ id: app2Id, title: "Acme · Product Lead", stage: "matched" }),
		]);
		expect(String(ambigInput.stage_note)).toContain(app1Id);
		expect(String(ambigInput.stage_note)).toContain(app2Id);
		expect(ctx.watermarksWritten[0].candidate_ids).toEqual([app1Id, app2Id]);

		const upsertAction = createJobApplicationUpsertAction(ctx.deps);
		await expect(
			executeAction(upsertAction, ambigInput as any, {
				context: { caller: "ui", userId: "user-1" },
			}),
		).rejects.toThrow(/Cannot execute ambiguous job application update/);

		// 2. Empty role_title on new application omits role_title (never "Untitled Role") and refuses blind create
		const missingRoleInput = ctx.parkedApprovals[1].input as Record<string, unknown>;
		expect(missingRoleInput.role_title).toBeUndefined();
		expect(String(missingRoleInput.stage_note)).toContain("Role title could not be extracted");
		await expect(
			executeAction(upsertAction, missingRoleInput as any, {
				context: { caller: "ui", userId: "user-1" },
			}),
		).rejects.toThrow(/requires both organisation.*and role_title/i);
	});

	it("isolates per-item errors, persists watermarks for succeeded items, and refuses to watermark when deps.tasks is missing", async () => {
		const m1 = makeMessage({
			id: "m-ok-1",
			threadId: "t-ok-1",
			from: "update@hiring.example.com",
			subject: "New message from Alice, CEO at FirstCo",
		});
		const m2 = makeMessage({
			id: "m-fail-2",
			threadId: "t-fail-2",
			from: "update@hiring.example.com",
			subject: "New message from Bob, CTO at BoomCo",
		});
		const m3 = makeMessage({
			id: "m-ok-3",
			threadId: "t-ok-3",
			from: "update@hiring.example.com",
			subject: "New message from Carol, VP at ThirdCo",
		});

		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [m1, m2, m3],
		);
		let insertCount = 0;
		ctx.deps.tasks!.insert = vi.fn(async (row) => {
			insertCount += 1;
			if (insertCount === 2) throw new Error("transient DB error");
			return { ...row, id: `task-${insertCount}` } as any;
		});

		const action = createJobHuntGmailIngestAction(ctx.deps);
		const res = await executeAction(
			action,
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.tasks_created).toBe(2);
		expect(res.errors).toHaveLength(1);
		expect(res.errors[0]).toContain("m-fail-2");
		// Watermarks were written immediately for m-ok-1 and m-ok-3, NOT for m-fail-2
		expect(ctx.watermarksWritten.map((w) => w.message_id)).toEqual(["m-ok-1", "m-ok-3"]);

		// Missing deps.tasks must NOT watermark task_created
		const ctxNoTasks = makeDeps({ tasks: undefined });
		ctxNoTasks.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [m1],
		);
		const resNoTasks = await executeAction(
			createJobHuntGmailIngestAction(ctxNoTasks.deps),
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);
		expect(resNoTasks.tasks_created).toBe(0);
		expect(resNoTasks.errors).toHaveLength(1);
		expect(ctxNoTasks.watermarksWritten).toHaveLength(0);
	});

	it("enforces the 0.85 review-band floor in act mode when user_preferences auto_apply is configured below 85", async () => {
		const msg = makeMessage({
			id: "m-low-thresh",
			threadId: "t-low-thresh",
			from: "notifications@ats.example.com",
			subject: "Application paused for Head of Data at Data Idols",
		});
		const msgPausedAbove = makeMessage({
			id: "m-80-conf",
			threadId: "t-80-conf",
			from: "recruiter@talent.example.com",
			subject: "Roles",
			body: "1. Head of AI at Acme Labs (£120k-£150k)",
		});
		// Test Jack & Jill (0.90) vs a lower-threshold preference: 0.90 >= 0.85 while 0.70 paused is < 0.85
		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [msg, msgPausedAbove],
		);
		ctx.deps.config = {
			loadPreferencesRow: vi.fn(async () => ({
				confidence_thresholds: { job_application: { auto_apply: 65 } },
			})),
		} as unknown as ConfigPreferencesRepository;
		// Even with auto_apply: 65, Firststage paused (0.70, needs_review) parks cleanly instead of throwing PendingApprovalError
		ctx.deps.entities.insertArrangementNodes = vi.fn(async () => {});
		ctx.deps.entities.insert = vi.fn(async (rows) =>
			rows.map((r, i) => ({ id: `00000000-0000-4000-8000-00000000060${i}`, ...r })) as any,
		);
		ctx.deps.entities.insertParticipantEdges = vi.fn(async () => {});

		const res = await executeAction(
			createJobHuntGmailIngestAction(ctx.deps),
			{ domain: "angus", mode: "act", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.errors).toEqual([]);
		expect(res.parked_approvals).toBe(1);
		expect(res.auto_applied).toBe(1);
		expect(ctx.watermarksWritten).toHaveLength(2);

		// Also verify PendingApprovalError from upsert gate is handled as parked_approval + watermarked (never retried as duplicate)
		const gateCtx = makeDeps();
		const leverMsg = makeMessage({ id: "m-pending-err", threadId: "t-pending-err" });
		const appId = "00000000-0000-4000-8000-000000000650";
		const orgId = "00000000-0000-4000-8000-000000000651";
		const app = makeAppEntity(appId, "Veeva · Strategy Director", {
			role_title: "Strategy Director",
			stage: "identified",
		});
		const org = makeOrgEntity(orgId, "Veeva");
		gateCtx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [leverMsg],
		);
		gateCtx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [app], total: 1 };
			if (filter.ids?.includes(orgId)) return { rows: [org], total: 1 };
			return { rows: [], total: 0 };
		});
		gateCtx.deps.entities.getById = vi.fn(async () => app);
		gateCtx.deps.entities.update = vi.fn(async () => {
			throw new PendingApprovalError("dec-gate-99", "job_application_upsert");
		});
		gateCtx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: appId, to_entity_id: orgId, relationship_type: "applied_to" },
			]),
			getNodesByIds: vi.fn(async () => [org]),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];
		gateCtx.deps.config = {
			loadPreferencesRow: vi.fn(async () => ({
				confidence_thresholds: { job_application: { auto_apply: 85 } },
			})),
		} as unknown as ConfigPreferencesRepository;

		const gateRes = await executeAction(
			createJobHuntGmailIngestAction(gateCtx.deps),
			{ domain: "angus", mode: "act", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);
		expect(gateRes.errors).toEqual([]);
		expect(gateRes.parked_approvals).toBe(1);
		expect(gateRes.auto_applied).toBe(0);
		expect(gateRes.items[0]).toMatchObject({
			outcome: "parked_approval",
			decision_id: "dec-gate-99",
		});
		expect(gateCtx.watermarksWritten).toHaveLength(1);
		expect(gateCtx.watermarksWritten[0]).toMatchObject({
			message_id: "m-pending-err",
			outcome: "parked_approval",
			decision_id: "dec-gate-99",
		});
	});

	it("captures and links email provenance and surfaces hiring_contact on Jumpstart interview introductions", async () => {
		const appId = "00000000-0000-4000-8000-000000000701";
		const orgId = "00000000-0000-4000-8000-000000000702";
		const contactId = "00000000-0000-4000-8000-000000000703";
		const app = makeAppEntity(appId, "Telemachus · Special Projects Lead", {
			role_title: "Special Projects Lead",
			stage: "applied",
		});
		const org = makeOrgEntity(orgId, "Telemachus");
		const contact = {
			id: contactId,
			entity_type: "people",
			title: "Sam Taylor",
			archived: false,
			properties: { email: "recruiter1@example.com" },
		} as unknown as EntityRow;

		const introMsg = makeMessage({
			id: "m-js-intro",
			threadId: "t-js-intro",
			from: "hello@mkt.careers.example.com",
			to: '"Taylor, Sam" <recruiter1@example.com>, owner@personal.example',
			subject: "Angus @ Jumpstart <> Jack @ Telemachus - interview introduction!",
			body: "Connecting you both regarding the Special Projects Lead role.",
		});

		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [introMsg],
		);
		ctx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [app], total: 1 };
			if (filter.entity_type === "people") return { rows: [contact], total: 1 };
			if (filter.ids?.includes(orgId)) return { rows: [org], total: 1 };
			return { rows: [], total: 0 };
		});
		ctx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: appId, to_entity_id: orgId, relationship_type: "applied_to" },
			]),
			getNodesByIds: vi.fn(async () => [org]),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];

		const res = await executeAction(
			createJobHuntGmailIngestAction(ctx.deps),
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.errors).toEqual([]);
		expect(res.parked_approvals).toBe(1);
		expect(ctx.capturedPayloads).toHaveLength(1);
		expect(ctx.capturedPayloads[0].processing_metadata).toMatchObject({
			gmail_thread_id: "t-js-intro",
			direction: "automated",
			hiring_contact: { name: "Taylor, Sam", email: "recruiter1@example.com" },
		});
		// Provenance artifact linked to matched application so follow-up replies match via thread_id
		expect(ctx.upsertedLinks).toEqual([
			{
				artifact_id: "00000000-0000-4000-8000-000000000099",
				entity_id: appId,
				link_type: "related",
			},
		]);
		const parkedInput = ctx.parkedApprovals[0].input as Record<string, unknown>;
		expect(parkedInput.evidence_artifact_id).toBe("00000000-0000-4000-8000-000000000099");
		expect(parkedInput.hiring_contact_ids).toEqual([contactId]);
		expect(String(parkedInput.stage_note)).toContain("recruiter1@example.com");
		expect(res.items[0].hiring_contact).toEqual({
			name: "Taylor, Sam",
			email: "recruiter1@example.com",
		});
	});

	it("passes as_of, guards last_inbound_at monotonically, and avoids duplicate links.upsert on inbound_human_reply", async () => {
		const appId = "00000000-0000-4000-8000-000000000801";
		const personId = "00000000-0000-4000-8000-000000000802";
		const app = makeAppEntity(appId, "MonotonicCo · Lead", {
			role_title: "Lead",
			stage: "screening",
			last_inbound_at: "2026-11-18T12:00:00.000Z",
		});
		const contact = {
			id: personId,
			entity_type: "people",
			title: "Dana",
			archived: false,
			properties: { email: "dana@monotonic.example" },
		} as unknown as EntityRow;

		const newerReply = makeMessage({
			id: "m-newer",
			threadId: "t-mono",
			from: "dana@monotonic.example",
			subject: "Re: Interview",
			body: "Confirmed for Friday.",
			date: "2026-11-20T09:30:00.000Z",
		});
		const olderBackfillReply = makeMessage({
			id: "m-older",
			threadId: "t-mono",
			from: "dana@monotonic.example",
			subject: "Re: Interview",
			body: "Earlier note from Monday.",
			date: "2026-11-16T09:30:00.000Z",
		});

		const ctx = makeDeps();
		ctx.deps.gmail!.searchMessages = vi.fn(async ({ query }) =>
			query.startsWith("in:sent") ? [] : [newerReply, olderBackfillReply],
		);
		ctx.deps.entities.loadRows = vi.fn(async (filter) => {
			if (filter.entity_type === "arrangement") return { rows: [app], total: 1 };
			return { rows: [], total: 0 };
		});
		ctx.deps.entities.getById = vi.fn(async (id: string) => (id === appId ? app : null));
		ctx.deps.graphRead = {
			getOutEdges: vi.fn(async () => [
				{ from_entity_id: appId, to_entity_id: personId, relationship_type: "recruiter" },
			]),
			getNodesByIds: vi.fn(async () => [contact]),
		} as unknown as JobHuntGmailIngestDeps["graphRead"];

		const res = await executeAction(
			createJobHuntGmailIngestAction(ctx.deps),
			{ domain: "angus", mode: "label", dry_run: false },
			{ context: { caller: "worker", userId: "user-1" } },
		);

		expect(res.errors).toEqual([]);
		expect(res.evidence_linked).toBe(2);
		// Only the newer reply updates the entity; the older backfill does NOT overwrite last_inbound_at
		expect(ctx.updatedEntities).toHaveLength(1);
		const updatedProps = ctx.updatedEntities[0].patch.properties as Record<string, unknown>;
		expect(updatedProps.last_inbound_at).toBe("2026-11-20T09:30:00.000Z");
		const history = updatedProps.stage_history as Array<{ at: string }>;
		expect(history[history.length - 1].at).toBe("2026-11-20T09:30:00.000Z");
		// Exactly 2 link upserts total (1 per message — zero duplicate upserts)
		expect(ctx.upsertedLinks).toHaveLength(2);
	});
});
