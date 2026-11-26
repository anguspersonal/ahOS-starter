import { describe, expect, it, vi } from "vitest";
import type { LinkedArtifactForEntityRow } from "../../ports/artifacts.js";
import type {
	ArrangementNodeInsertRow,
	EntityRepository,
	EntityRow,
	LinkRepository,
	ParticipantEdgeInsertRow,
} from "../../ports/entities.js";
import type { PeopleRepository } from "../../ports/people.js";
import type { TaskQueryFilters, TaskRepository, UserTaskRow } from "../../ports/tasks.js";
import type { RelationshipRecord } from "../domain/relationships.js";
import { executeApproved } from "../approvals.js";
import { executeAction } from "../adapters/direct.js";
import { AdapterUnavailableError, buildRegistry } from "../buildRegistry.js";
import { createActionContext } from "../defineAction.js";
import {
	ApprovalDeniedError,
	PendingApprovalError,
	setActionApprovalStore,
	type ApprovalInboxStore,
	type ApprovalRequest,
	type ClaimedApproval,
} from "../gate.js";
import {
	createJobApplicationUpsertAction,
	formatJobApplicationUpsertMcp,
} from "./jobApplicationUpsert.js";
import {
	createJobPipelineReadAction,
	formatJobPipelineReadMcp,
} from "./jobPipelineRead.js";
import type { JobHuntDeps } from "./shared.js";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const AREA_ID = "00000000-0000-4000-8000-000000000010";
const SELF_ID = "00000000-0000-4000-8000-000000000020";
const CV_1_ID = "00000000-0000-4000-8000-000000000031";
const CV_2_ID = "00000000-0000-4000-8000-000000000032";
const RECRUITER_ID = "00000000-0000-4000-8000-000000000040";
const ARTIFACT_1_ID = "00000000-0000-4000-8000-000000000050";

interface InMemoryEdge extends RelationshipRecord {
	archived?: boolean;
}

function createInMemoryJobHuntStore(seedEntities: EntityRow[] = []) {
	const entities = new Map<string, EntityRow>();
	for (const row of seedEntities) {
		entities.set(row.id, { ...row });
	}
	const edges: InMemoryEdge[] = [];
	const tasks: UserTaskRow[] = [];
	const links: Array<{
		id: string;
		artifact_id: string;
		entity_id: string;
		link_type: string | null;
	}> = [];
	const linkedArtifacts: LinkedArtifactForEntityRow[] = [];
	const taskQueryCalls: TaskQueryFilters[] = [];

	const entityRepo: EntityRepository = {
		async getById(id: string) {
			return entities.get(id) ?? null;
		},
		async loadRows(filter) {
			let rows = Array.from(entities.values());
			if (!filter.include_archived) {
				rows = rows.filter((r) => !r.archived);
			}
			if (filter.entity_type) {
				rows = rows.filter((r) => r.entity_type === filter.entity_type);
			}
			if (filter.ids?.length) {
				const idSet = new Set(filter.ids);
				rows = rows.filter((r) => idSet.has(r.id));
			}
			if (filter.properties_contains) {
				rows = rows.filter((r) => {
					const props = (r.properties ?? {}) as Record<string, unknown>;
					return Object.entries(filter.properties_contains!).every(
						([k, v]) => props[k] === v,
					);
				});
			}
			if (filter.query) {
				const needle = filter.query.toLowerCase();
				rows = rows.filter((r) => {
					const hay = [
						r.title ?? "",
						...(r.aliases ?? []),
						JSON.stringify(r.properties ?? {}),
					]
						.join(" ")
						.toLowerCase();
					return hay.includes(needle);
				});
			}
			return { rows: rows.slice(0, filter.limit ?? 20), truncated: false };
		},
		async insert(items) {
			const inserted: EntityRow[] = [];
			for (const item of items) {
				const id = globalThis.crypto.randomUUID();
				const row: EntityRow = {
					id,
					entity_type: item.entity_type ?? "entity",
					title: item.title ?? null,
					description: item.description ?? null,
					archived: item.archived ?? false,
					archived_at: null,
					properties: item.properties ?? {},
					tags: item.tags ?? [],
					source_url: item.source_url ?? null,
					user_id: USER_ID,
					team_id: null,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					aliases: item.aliases ?? [],
					domain_override: item.domain_override ?? null,
				};
				entities.set(id, row);
				inserted.push(row);
			}
			return inserted;
		},
		async update(ids, patch) {
			const idList = typeof ids === "string" ? [ids] : [...ids];
			const updated: EntityRow[] = [];
			for (const id of idList) {
				const cur = entities.get(id);
				if (!cur) continue;
				const next: EntityRow = {
					...cur,
					...(patch.title !== undefined ? { title: patch.title } : {}),
					...(patch.description !== undefined ? { description: patch.description } : {}),
					...(patch.properties !== undefined ? { properties: patch.properties } : {}),
					...(patch.tags !== undefined ? { tags: patch.tags } : {}),
					updated_at: new Date().toISOString(),
				};
				entities.set(id, next);
				updated.push(next);
			}
			return updated;
		},
		async mutateByIds() {
			return [];
		},
		async getDomainRow(id) {
			const row = entities.get(id);
			if (!row) return null;
			return {
				id: row.id,
				title: row.title,
				description: row.description,
				tags: row.tags,
				properties: row.properties,
				domain_override: row.domain_override ?? null,
			};
		},
		async fetchPrimaryParentId() {
			return null;
		},
		async fetchPrimaryParentsBatch() {
			return new Map();
		},
		async getEdgeById() {
			return null;
		},
		async findOwnedEntityIds(ids) {
			return new Set(ids.filter((id) => entities.has(id)));
		},
		async insertArrangementNodes(rows: readonly ArrangementNodeInsertRow[]) {
			for (const r of rows) {
				entities.set(r.id, {
					id: r.id,
					entity_type: r.entity_type,
					title: r.title,
					description: r.description,
					archived: r.archived,
					archived_at: null,
					properties: r.properties,
					tags: r.tags,
					source_url: null,
					user_id: r.user_id,
					team_id: r.team_id,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
				});
			}
		},
		async insertParticipantEdges(rows: readonly ParticipantEdgeInsertRow[]) {
			for (const r of rows) {
				edges.push({
					id: globalThis.crypto.randomUUID(),
					from_entity_id: r.from_entity_id,
					to_entity_id: r.to_entity_id,
					relationship_type: r.relationship_type,
					confidence_score: r.confidence_score ?? 1,
					metadata: r.metadata,
					created_at: new Date().toISOString(),
					updated_at: new Date().toISOString(),
					archived: false,
				});
			}
		},
		async insertProvenanceLinks(rows) {
			for (const r of rows) {
				links.push({
					id: globalThis.crypto.randomUUID(),
					artifact_id: r.artifact_id,
					entity_id: r.entity_id,
					link_type: r.link_type,
				});
			}
		},
		async archiveEdge(edgeId) {
			const found = edges.find((e) => e.id === edgeId);
			if (found) found.archived = true;
		},
		async findRelationshipEdge(fromId, toId, relType) {
			return (
				edges.find(
					(e) =>
						e.from_entity_id === fromId &&
						e.to_entity_id === toId &&
						e.relationship_type === relType,
				) ?? null
			);
		},
		async archiveEdgesByIds(edgeIds) {
			const set = new Set(edgeIds);
			for (const e of edges) {
				if (set.has(e.id)) e.archived = true;
			}
		},
		async updateRelationshipEdge(edgeId, patch) {
			const found = edges.find((e) => e.id === edgeId);
			if (!found) return;
			if (patch.archived !== undefined) found.archived = patch.archived;
			if (patch.metadata !== undefined) found.metadata = patch.metadata;
		},
		async insertRelationshipEdge(row) {
			const id = globalThis.crypto.randomUUID();
			edges.push({
				id,
				from_entity_id: row.from_entity_id,
				to_entity_id: row.to_entity_id,
				relationship_type: row.relationship_type,
				confidence_score: row.confidence_score ?? 1,
				metadata: row.metadata,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				archived: false,
			});
			return { id };
		},
		async queryRelationships(filter) {
			return edges.filter((e) => {
				if (e.archived) return false;
				if (filter.relationship_type && e.relationship_type !== filter.relationship_type) {
					return false;
				}
				if (filter.entity_id) {
					if (filter.direction === "outgoing") return e.from_entity_id === filter.entity_id;
					if (filter.direction === "incoming") return e.to_entity_id === filter.entity_id;
					return (
						e.from_entity_id === filter.entity_id || e.to_entity_id === filter.entity_id
					);
				}
				return true;
			});
		},
		async findTrackedResources() {
			return [];
		},
		async getTitleById(id) {
			return entities.get(id)?.title ?? null;
		},
		async findByExactTitle(query) {
			const needle = query.title.trim().toLowerCase();
			return Array.from(entities.values()).filter(
				(e) =>
					!e.archived &&
					e.entity_type === query.entity_type &&
					(e.title ?? "").trim().toLowerCase() === needle,
			);
		},
	};

	const taskRepo: TaskRepository = {
		async query(filters) {
			taskQueryCalls.push(filters);
			return tasks
				.filter((t) => {
					if (filters.entity_id && t.entity_id !== filters.entity_id) return false;
					if (filters.entity_ids && (!t.entity_id || !filters.entity_ids.includes(t.entity_id))) {
						return false;
					}
					if (filters.status && t.status !== filters.status) return false;
					return true;
				})
				.slice(0, filters.limit ?? 20);
		},
		async get(id) {
			const found = tasks.find((t) => t.id === id);
			if (!found) throw new Error(`Task ${id} not found`);
			return found;
		},
		async insert(row) {
			const created: UserTaskRow = {
				id: String(row.id ?? globalThis.crypto.randomUUID()),
				title: String(row.title ?? "Untitled"),
				description: (row.description as string | null) ?? null,
				status: String(row.status ?? "todo"),
				priority: (row.priority as string | null) ?? "medium",
				priority_level: (row.priority_level as number | null) ?? 4,
				task_type: (row.task_type as string) ?? "one_off",
				energy_mode: (row.energy_mode as string | null) ?? null,
				source: (row.source as string | null) ?? null,
				due_date: (row.due_date as string | null) ?? null,
				completed_at: (row.completed_at as string | null) ?? null,
				assigned_to: null,
				created_by: (row.created_by as string | null) ?? null,
				created_via: (row.created_via as string | null) ?? "system",
				confidence_score: null,
				tags: null,
				notes: null,
				entity_id: (row.entity_id as string | null) ?? null,
				source_artifact_id: (row.source_artifact_id as string | null) ?? null,
				due_time: null,
				duration_minutes: null,
				team_id: null,
				created_at: String(row.created_at ?? new Date().toISOString()),
				updated_at: String(row.updated_at ?? new Date().toISOString()),
				user_id: String(row.user_id ?? USER_ID),
			};
			tasks.push(created);
			return created;
		},
		async update(id, payload) {
			const idx = tasks.findIndex((t) => t.id === id);
			if (idx < 0) throw new Error(`Task ${id} not found`);
			tasks[idx] = { ...tasks[idx], ...payload };
			return tasks[idx];
		},
		async deleteOne(id) {
			return [id];
		},
		async deleteMany(ids) {
			return ids;
		},
	};

	const linkRepo: LinkRepository = {
		async get() {
			return null;
		},
		async query() {
			return [];
		},
		async upsert(items) {
			return items.map((item) => {
				const existing = links.find(
					(l) =>
						l.artifact_id === item.artifact_id &&
						l.entity_id === item.entity_id &&
						l.link_type === (item.link_type ?? "related"),
				);
				if (existing) return existing;
				const row = {
					id: globalThis.crypto.randomUUID(),
					artifact_id: item.artifact_id,
					entity_id: item.entity_id,
					link_type: item.link_type ?? "related",
				};
				links.push(row);
				return row;
			});
		},
	};

	const peopleRepo: PeopleRepository = {
		async getById() {
			return null;
		},
		async load() {
			return { rows: [], truncated: false };
		},
		async readSelfPreferences() {
			return { self_entity_id: SELF_ID, identity: { display_name: "Angus" }, exists: true };
		},
	};

	const artifactRepo = {
		async getById(id: string) {
			if (id === ARTIFACT_1_ID) {
				return { id: ARTIFACT_1_ID, title: "Evidence Email" };
			}
			return null;
		},
		listLinkedArtifactsForEntities: vi.fn(async (entityIds: readonly string[]) => {
			const set = new Set(entityIds);
			return linkedArtifacts.filter((a) => set.has(a.entity_id));
		}),
	} as unknown as NonNullable<JobHuntDeps["artifacts"]>;

	const deps: JobHuntDeps = {
		entities: entityRepo,
		tasks: taskRepo,
		links: linkRepo,
		people: peopleRepo,
		artifacts: artifactRepo,
	};

	return {
		deps,
		entities,
		edges,
		tasks,
		links,
		linkedArtifacts,
		taskQueryCalls,
	};
}

function makeSeedEntities(): EntityRow[] {
	return [
		{
			id: AREA_ID,
			entity_type: "area",
			title: "Job Search",
			description: null,
			archived: false,
			archived_at: null,
			properties: {},
			tags: [],
			source_url: null,
			user_id: USER_ID,
			team_id: null,
			domain_override: "angus",
			created_at: "2026-11-01T00:00:00Z",
			updated_at: "2026-11-01T00:00:00Z",
		},
		{
			id: SELF_ID,
			entity_type: "people",
			title: "Angus Hally",
			description: null,
			archived: false,
			archived_at: null,
			properties: { is_self: true },
			tags: [],
			source_url: null,
			user_id: USER_ID,
			team_id: null,
			created_at: "2026-11-01T00:00:00Z",
			updated_at: "2026-11-01T00:00:00Z",
		},
		{
			id: CV_1_ID,
			entity_type: "resource",
			title: "Angus CV — AI Product Lead v4",
			description: null,
			archived: false,
			archived_at: null,
			properties: { tracked: true, doc_kind: "cv" },
			tags: ["cv"],
			source_url: null,
			user_id: USER_ID,
			team_id: null,
			created_at: "2026-11-01T00:00:00Z",
			updated_at: "2026-11-01T00:00:00Z",
		},
		{
			id: CV_2_ID,
			entity_type: "resource",
			title: "Angus CV — Founding Engineer v5",
			description: null,
			archived: false,
			archived_at: null,
			properties: { tracked: true, doc_kind: "cv" },
			tags: ["cv"],
			source_url: null,
			user_id: USER_ID,
			team_id: null,
			created_at: "2026-11-05T00:00:00Z",
			updated_at: "2026-11-05T00:00:00Z",
		},
		{
			id: RECRUITER_ID,
			entity_type: "people",
			title: "Courtney Moran",
			description: null,
			archived: false,
			archived_at: null,
			properties: {},
			tags: [],
			source_url: null,
			user_id: USER_ID,
			team_id: null,
			created_at: "2026-11-01T00:00:00Z",
			updated_at: "2026-11-01T00:00:00Z",
		},
	];
}

describe("job_application_upsert", () => {
	it("creates an identified/matched application with Job Search containment, participant edges, CV link, and +3d Decide task", async () => {
		const store = createInMemoryJobHuntStore(makeSeedEntities());
		const action = createJobApplicationUpsertAction(store.deps);

		const res = await executeAction(
			action,
			{
				organisation: "36 Labs",
				role_title: "Lead Product Engineer",
				role_category: "product",
				channel: "jack_and_jill",
				stage: "matched",
				job_site: "Jack & Jill",
				cv_entity_id: CV_1_ID,
				recruiter_ids: [RECRUITER_ID],
				evidence_artifact_id: ARTIFACT_1_ID,
				as_of: "2026-11-22",
			},
			{ context: createActionContext({ caller: "mcp", userId: USER_ID }) },
		);

		expect(res.status).toBe("created");
		expect(res.application).toMatchObject({
			title: "36 Labs · Lead Product Engineer",
			stage: "matched",
			entity_status: "proposed",
			role_category: "product",
			channel: "jack_and_jill",
			applied_on: null,
			cv_entity_id: CV_1_ID,
		});

		const appId = res.application!.id;
		const liveEdges = store.edges.filter((e) => !e.archived && e.from_entity_id === appId);
		expect(liveEdges.map((e) => e.relationship_type).sort()).toEqual([
			"applicant",
			"applied_to",
			"applied_via",
			"belongs_to",
			"recruiter",
			"references",
		]);
		expect(liveEdges.find((e) => e.relationship_type === "belongs_to")?.to_entity_id).toBe(
			AREA_ID,
		);
		expect(liveEdges.find((e) => e.relationship_type === "applicant")?.to_entity_id).toBe(
			SELF_ID,
		);
		expect(liveEdges.find((e) => e.relationship_type === "references")?.to_entity_id).toBe(
			CV_1_ID,
		);

		expect(store.links).toHaveLength(1);
		expect(store.links[0]).toMatchObject({
			artifact_id: ARTIFACT_1_ID,
			entity_id: appId,
			link_type: "related",
		});

		expect(res.open_task).toMatchObject({
			title: "Decide: apply or pass",
			status: "todo",
			priority_level: 4,
			due_date: "2026-11-25T09:00:00.000Z",
		});
		expect(formatJobApplicationUpsertMcp(res)).toContain("Created application");
	});

	it("transitions matched -> applied -> screening -> accepted, rotating and closing tasks and updating CV edge", async () => {
		const store = createInMemoryJobHuntStore(makeSeedEntities());
		const action = createJobApplicationUpsertAction(store.deps);

		const created = await executeAction(
			action,
			{
				organisation: "Telemachus",
				role_title: "Special Projects Lead",
				role_category: "ops_chief_of_staff",
				channel: "jumpstart",
				stage: "identified",
				cv_entity_id: CV_1_ID,
				as_of: "2026-11-01",
			},
			{ context: createActionContext({ caller: "ui", userId: USER_ID }) },
		);
		const appId = created.application!.id;
		const firstTaskId = created.open_task!.id;

		// Re-upserting same stage keeps the same open task (idempotent)
		const sameStage = await executeAction(
			action,
			{
				id: appId,
				notes: "Strong mission fit",
				as_of: "2026-11-01",
			},
			{ context: createActionContext({ caller: "ui", userId: USER_ID }) },
		);
		expect(sameStage.status).toBe("updated");
		expect(sameStage.open_task?.id).toBe(firstTaskId);
		expect(store.tasks).toHaveLength(1);

		// Transition to applied + swap CV
		const applied = await executeAction(
			action,
			{
				organisation: "Telemachus",
				role_title: "Special Projects Lead",
				stage: "applied",
				cv_entity_id: CV_2_ID,
				as_of: "2026-11-02",
			},
			{ context: createActionContext({ caller: "ui", userId: USER_ID }) },
		);
		expect(applied.application?.applied_on).toBe("2026-11-02");
		expect(applied.application?.entity_status).toBe("in_progress");
		expect(store.tasks.find((t) => t.id === firstTaskId)?.status).toBe("done");
		expect(applied.open_task?.title).toBe("Chase if no reply");
		expect(applied.open_task?.due_date).toBe("2026-11-09T09:00:00.000Z");

		// Old CV edge archived, new CV edge live
		const cvEdges = store.edges.filter(
			(e) => e.from_entity_id === appId && e.relationship_type === "references",
		);
		expect(cvEdges.find((e) => e.to_entity_id === CV_1_ID)?.archived).toBe(true);
		expect(cvEdges.find((e) => e.to_entity_id === CV_2_ID)?.archived).toBe(false);

		// Transition to terminal accepted -> closes open task as done and sets closed_on
		const accepted = await executeAction(
			action,
			{
				id: appId,
				stage: "accepted",
				as_of: "2026-11-20",
			},
			{ context: createActionContext({ caller: "ui", userId: USER_ID }) },
		);
		expect(accepted.application?.entity_status).toBe("done");
		expect(accepted.application?.closed_on).toBe("2026-11-20");
		expect(accepted.open_task).toBeNull();
		expect(store.tasks.every((t) => t.status === "done")).toBe(true);
	});

	it("refuses with candidates on ambiguous platform_ref or (org, role) match without writing", async () => {
		const store = createInMemoryJobHuntStore([
			...makeSeedEntities(),
			{
				id: "00000000-0000-4000-8000-000000000101",
				entity_type: "arrangement",
				title: "UCL Estates · Associate Director (1)",
				description: null,
				archived: false,
				archived_at: null,
				properties: {
					kind: "job_application",
					role_title: "Associate Director",
					role_category: "data_leadership",
					channel: "company_site",
					stage: "applied",
					platform_ref: "B28-00397",
					stage_history: [{ stage: "applied", at: "2026-10-07" }],
				},
				tags: ["job-application"],
				source_url: null,
				user_id: USER_ID,
				team_id: null,
				created_at: "2026-10-07T00:00:00Z",
				updated_at: "2026-10-07T00:00:00Z",
			},
			{
				id: "00000000-0000-4000-8000-000000000102",
				entity_type: "arrangement",
				title: "UCL Estates · Associate Director (2)",
				description: null,
				archived: false,
				archived_at: null,
				properties: {
					kind: "job_application",
					role_title: "Associate Director",
					role_category: "data_leadership",
					channel: "company_site",
					stage: "drafting",
					platform_ref: "B28-00397",
					stage_history: [{ stage: "drafting", at: "2026-10-08" }],
				},
				tags: ["job-application"],
				source_url: null,
				user_id: USER_ID,
				team_id: null,
				created_at: "2026-10-08T00:00:00Z",
				updated_at: "2026-10-08T00:00:00Z",
			},
		]);
		const action = createJobApplicationUpsertAction(store.deps);

		const res = await executeAction(
			action,
			{
				platform_ref: "B28-00397",
				stage: "screening",
			},
			{ context: createActionContext({ caller: "mcp", userId: USER_ID }) },
		);

		expect(res.status).toBe("ambiguous");
		expect(res.candidates).toHaveLength(2);
		expect(res.candidates?.map((c) => c.id).sort()).toEqual([
			"00000000-0000-4000-8000-000000000101",
			"00000000-0000-4000-8000-000000000102",
		]);
		expect(store.tasks).toHaveLength(0);
		expect(formatJobApplicationUpsertMcp(res)).toContain("Multiple applications match");
	});

	it("supports reapplication: true with title disambiguation and blocks forbidden bare 'Dex' job_site alias", async () => {
		const store = createInMemoryJobHuntStore(makeSeedEntities());
		const action = createJobApplicationUpsertAction(store.deps);

		await executeAction(
			action,
			{
				organisation: "Cohere",
				role_title: "Applied AI Engineer",
				role_category: "ai_engineering",
				channel: "company_site",
				stage: "rejected",
				as_of: "2026-10-05",
			},
			{ context: createActionContext({ caller: "ui", userId: USER_ID }) },
		);

		const second = await executeAction(
			action,
			{
				organisation: "Cohere",
				role_title: "Applied AI Engineer",
				role_category: "ai_engineering",
				channel: "company_site",
				stage: "applied",
				reapplication: true,
				as_of: "2026-11-22",
			},
			{ context: createActionContext({ caller: "ui", userId: USER_ID }) },
		);
		expect(second.status).toBe("created");
		expect(second.application?.title).toBe("Cohere · Applied AI Engineer (2026-11-22)");

		await expect(
			executeAction(
				action,
				{
					organisation: "Calibre",
					role_title: "AI Product Engineer",
					job_site: "Dex",
				},
				{ context: createActionContext({ caller: "ui", userId: USER_ID }) },
			),
		).rejects.toThrow(/Dex CRM/);
	});

	it("routes unattended worker calls and review-band calls through ADR-104 Approvals inbox and executes on approval", async () => {
		const store = createInMemoryJobHuntStore(makeSeedEntities());
		const action = createJobApplicationUpsertAction(store.deps);

		const parked: Array<ApprovalRequest & { decisionId: string }> = [];
		const claimedIds: string[] = [];
		const finished: Array<{ decisionId: string; status: string }> = [];

		const approvalStore: ApprovalInboxStore = {
			async park(req) {
				const decisionId = "00000000-0000-4000-8000-000000000999";
				parked.push({ ...req, decisionId });
				return { decisionId };
			},
			async listPending() {
				return [];
			},
			async claim(decisionId, _approver): Promise<ClaimedApproval | null> {
				const found = parked.find((p) => p.decisionId === decisionId);
				if (!found) return null;
				claimedIds.push(decisionId);
				return {
					decisionId: found.decisionId,
					actionId: found.actionId,
					input: found.input,
					inputSha256: found.inputSha256,
					caller: found.caller,
					userId: found.userId ?? USER_ID,
				};
			},
			async finish(decisionId, resolution) {
				const status = typeof resolution === "string" ? resolution : resolution.status ?? "executed";
				finished.push({ decisionId, status });
			},
			async reject() {
				return true;
			},
		};

		setActionApprovalStore(approvalStore);
		try {
			// Below block threshold -> denied
			await expect(
				executeAction(
					action,
					{
						organisation: "Augur",
						role_title: "Forward Deployed Engineer",
						confidence: { epistemic: 0.2 },
					},
					{ context: createActionContext({ caller: "mcp", userId: USER_ID }) },
				),
			).rejects.toThrow(ApprovalDeniedError);

			// Review band on MCP -> parked
			await expect(
				executeAction(
					action,
					{
						organisation: "Augur",
						role_title: "Forward Deployed Engineer",
						confidence: { epistemic: 0.65 },
					},
					{ context: createActionContext({ caller: "mcp", userId: USER_ID }) },
				),
			).rejects.toThrow(PendingApprovalError);

			// Unattended worker call (even without low confidence) -> parked
			parked.length = 0;
			await expect(
				executeAction(
					action,
					{
						organisation: "Augur",
						role_title: "Forward Deployed Engineer",
						role_category: "ai_engineering",
						channel: "dex_jobs",
						stage: "applied",
						as_of: "2026-11-22",
					},
					{ context: createActionContext({ caller: "worker", userId: USER_ID }) },
				),
			).rejects.toThrow(PendingApprovalError);

			expect(parked).toHaveLength(1);
			// Nothing written before approval
			expect(
				Array.from(store.entities.values()).filter(
					(e) => e.properties?.kind === "job_application",
				),
			).toHaveLength(0);

			// Approving via ADR-104 inbox executes the parked upsert once
			const approved = await executeApproved(parked[0].decisionId, {
				store: approvalStore,
				resolve: (id) => (id === "job_application_upsert" ? action : undefined),
				approvedBy: { userId: USER_ID, via: "web_inbox" },
			});
			expect(approved.status).toBe("executed");
			expect(claimedIds).toEqual([parked[0].decisionId]);
			expect(finished).toEqual([{ decisionId: parked[0].decisionId, status: "executed" }]);
			expect(
				Array.from(store.entities.values()).filter(
					(e) => e.properties?.kind === "job_application",
				),
			).toHaveLength(1);
		} finally {
			setActionApprovalStore(undefined);
		}
	});

	it("validates entity types and referenced artifact/area/applicant IDs before any writes", async () => {
		const store = createInMemoryJobHuntStore(makeSeedEntities());
		const action = createJobApplicationUpsertAction(store.deps);
		const uiCtx = { context: createActionContext({ caller: "ui", userId: USER_ID }) };
		const initialCount = store.entities.size;

		// Wrong entity_type for organisation_id (people instead of organization)
		await expect(
			executeAction(
				action,
				{ organisation_id: RECRUITER_ID, role_title: "Product Lead" },
				uiCtx,
			),
		).rejects.toThrow(/expected "organization"/);

		// Wrong entity_type for cv_entity_id (area instead of resource)
		await expect(
			executeAction(
				action,
				{ organisation: "NewOrg", role_title: "Product Lead", cv_entity_id: AREA_ID },
				uiCtx,
			),
		).rejects.toThrow(/expected "resource"/);

		// Wrong entity_type for recruiter_ids (area instead of people)
		await expect(
			executeAction(
				action,
				{ organisation: "NewOrg", role_title: "Product Lead", recruiter_ids: [AREA_ID] },
				uiCtx,
			),
		).rejects.toThrow(/entity_type "people"/);

		// Missing evidence_artifact_id fails before creating org or application
		await expect(
			executeAction(
				action,
				{
					organisation: "ShouldNotExist",
					role_title: "Product Lead",
					evidence_artifact_id: "00000000-0000-4000-8000-000000000888",
				},
				uiCtx,
			),
		).rejects.toThrow(/Evidence artifact/);

		// Invalid area_id fails before creating org or application
		await expect(
			executeAction(
				action,
				{
					organisation: "ShouldNotExist",
					role_title: "Product Lead",
					area_id: "00000000-0000-4000-8000-000000000889",
				},
				uiCtx,
			),
		).rejects.toThrow(/Area entity/);

		expect(store.entities.size).toBe(initialCount);
		expect(store.edges).toHaveLength(0);
		expect(store.tasks).toHaveLength(0);
	});

	it("clears applied_on when rolling back to a pre-submission stage, rotates screening task on screening_call_held, and hydrates org/job_site on id updates", async () => {
		const store = createInMemoryJobHuntStore(makeSeedEntities());
		const action = createJobApplicationUpsertAction(store.deps);
		const uiCtx = { context: createActionContext({ caller: "ui", userId: USER_ID }) };

		const created = await executeAction(
			action,
			{
				organisation: "Linear",
				role_title: "Product Engineer",
				channel: "cord",
				job_site: "Cord",
				stage: "applied",
				as_of: "2026-11-01",
			},
			uiCtx,
		);
		const appId = created.application!.id;
		expect(created.application?.applied_on).toBe("2026-11-01");

		// Rolling back to drafting clears applied_on unless explicitly supplied, and hydrates org/job_site
		const drafted = await executeAction(
			action,
			{ id: appId, stage: "drafting", as_of: "2026-11-05" },
			uiCtx,
		);
		expect(drafted.application?.applied_on).toBeNull();
		expect(drafted.application?.organisation_id).toBe(created.application?.organisation_id);
		expect(drafted.application?.job_site_id).toBe(created.application?.job_site_id);
		expect(drafted.application?.job_site).toBe("Cord");

		// Entering screening creates "Book the call", then screening_call_held: true rotates to "Follow up for the outcome"
		const screening = await executeAction(
			action,
			{ id: appId, stage: "screening", as_of: "2026-11-10" },
			uiCtx,
		);
		expect(screening.open_task?.title).toBe("Book the call");

		const screeningHeld = await executeAction(
			action,
			{ id: appId, stage: "screening", screening_call_held: true, as_of: "2026-11-12" },
			uiCtx,
		);
		expect(screeningHeld.open_task?.title).toBe("Follow up for the outcome");
		expect(store.tasks.filter((t) => t.status !== "done")).toHaveLength(1);
	});
});

describe("job_pipeline_read", () => {
	it("aggregates arrangements, edges, linked artifacts, and tasks to compute silence, cadence, last_action_at, and metrics", async () => {
		const store = createInMemoryJobHuntStore(makeSeedEntities());
		const upsert = createJobApplicationUpsertAction(store.deps);
		const read = createJobPipelineReadAction(store.deps);
		const uiCtx = { context: createActionContext({ caller: "ui", userId: USER_ID }) };

		// 1. Screening (reached interview)
		const telemachus = await executeAction(
			upsert,
			{
				organisation: "Telemachus",
				role_title: "Special Projects Lead",
				role_category: "ops_chief_of_staff",
				channel: "jumpstart",
				job_site: "Jumpstart",
				stage: "screening",
				applied_on: "2026-11-02",
				cv_entity_id: CV_1_ID,
				recruiter_ids: [RECRUITER_ID],
				as_of: "2026-11-06",
			},
			uiCtx,
		);

		// 2. Silent applied (14+ days since 2026-10-08 as of 2026-11-22 -> 45 days >= 42d auto_close cadence!)
		const calibre = await executeAction(
			upsert,
			{
				organisation: "Calibre",
				role_title: "AI Product Engineer",
				role_category: "product",
				channel: "dex_jobs",
				job_site: "Dex jobs",
				stage: "applied",
				applied_on: "2026-10-08",
				as_of: "2026-10-08",
			},
			uiCtx,
		);

		// 3. Applied with recent inbound reply artifact -> NOT silent!
		const freshApp = await executeAction(
			upsert,
			{
				organisation: "Anthropic",
				role_title: "Product Lead",
				role_category: "product",
				channel: "company_site",
				stage: "applied",
				applied_on: "2026-11-01",
				as_of: "2026-11-01",
			},
			uiCtx,
		);
		store.linkedArtifacts.push({
			entity_id: freshApp.application!.id,
			artifact_id: ARTIFACT_1_ID,
			link_type: "inbound_reply",
			confidence_score: 0.95,
			notes: null,
			artifact: {
				id: ARTIFACT_1_ID,
				title: "Re: Product Lead",
				source: "gmail:msg-2",
				source_channel: "gmail",
				source_url: null,
				storage_url: null,
				file_type: "message/rfc822",
				captured_at: "2026-11-15T10:00:00.000Z",
				originated_at: "2026-11-15T09:55:00.000Z",
				created_at: "2026-11-15T10:00:00.000Z",
				archived: false,
				processing_metadata: { direction: "inbound" },
			},
		});

		// 4. Matched (to_review)
		await executeAction(
			upsert,
			{
				organisation: "36 Labs",
				role_title: "Lead Product Engineer",
				role_category: "product",
				channel: "jack_and_jill",
				job_site: "Jack & Jill",
				stage: "matched",
				as_of: "2026-11-22",
			},
			uiCtx,
		);

		// 5. Rejected
		await executeAction(
			upsert,
			{
				organisation: "Stackfix",
				role_title: "Founding Applied AI Engineer",
				role_category: "ai_engineering",
				channel: "cord",
				job_site: "Cord",
				stage: "rejected",
				applied_on: "2026-10-06",
				closed_on: "2026-10-09",
				as_of: "2026-10-09",
			},
			uiCtx,
		);

		const pipeline = await executeAction(
			read,
			{ as_of: "2026-11-22" },
			{ context: createActionContext({ caller: "mcp", userId: USER_ID }) },
		);

		// Verify TaskRepository.query received explicit high limit and entity_ids batch
		const lastTaskQuery = store.taskQueryCalls[store.taskQueryCalls.length - 1];
		expect(lastTaskQuery.entity_ids).toHaveLength(5);
		expect(lastTaskQuery.limit).toBeGreaterThanOrEqual(500);

		expect(pipeline.total_count).toBe(5);
		expect(pipeline.metrics).toMatchObject({
			total: 5,
			submitted: 4,
			reached_interview: 1,
			rejected: 1,
			silent: 1,
			to_review: 1,
			drafting: 0,
		});
		expect(pipeline.metrics.interview_rate).toBeCloseTo(0.25, 6);

		const calibreItem = pipeline.applications.find(
			(a) => a.id === calibre.application!.id,
		)!;
		expect(calibreItem.silent).toBe(true);
		expect(calibreItem.cadence.action).toBe("auto_close");
		expect(calibreItem.cadence.shouldAutoClose).toBe(true);

		const freshItem = pipeline.applications.find(
			(a) => a.id === freshApp.application!.id,
		)!;
		expect(freshItem.silent).toBe(false);
		expect(freshItem.last_inbound_at).toBe("2026-11-15T09:55:00.000Z");
		expect(freshItem.last_action_at).toBe("2026-11-15T09:55:00.000Z");
		expect(freshItem.artifacts).toHaveLength(1);

		const telemachusItem = pipeline.applications.find(
			(a) => a.id === telemachus.application!.id,
		)!;
		expect(telemachusItem.cv?.id).toBe(CV_1_ID);
		expect(telemachusItem.recruiters.map((r) => r.title)).toEqual(["Courtney Moran"]);
		expect(telemachusItem.open_task?.title).toBe("Book the call");

		expect(pipeline.recruiters).toHaveLength(1);
		expect(pipeline.job_sites.length).toBeGreaterThanOrEqual(4);
		expect(pipeline.organisations).toHaveLength(5);

		// Filtering checks
		const silentOnly = await executeAction(
			read,
			{ stage_group: "silent", as_of: "2026-11-22" },
			uiCtx,
		);
		expect(silentOnly.filtered_count).toBe(1);
		expect(silentOnly.applications[0].id).toBe(calibre.application!.id);
		expect(silentOnly.metrics.total).toBe(5);

		const activeOnly = await executeAction(
			read,
			{ include_closed: false, search: "telemachus", as_of: "2026-11-22" },
			uiCtx,
		);
		expect(activeOnly.filtered_count).toBe(1);
		expect(activeOnly.applications[0].organisation_name).toBe("Telemachus");

		expect(formatJobPipelineReadMcp(pipeline)).toContain("Job Pipeline (as of 2026-11-22)");
	});

	it("excludes non-email artifacts from last_action_at and last_inbound_at while still listing them on the application", async () => {
		const store = createInMemoryJobHuntStore(makeSeedEntities());
		const upsert = createJobApplicationUpsertAction(store.deps);
		const read = createJobPipelineReadAction(store.deps);
		const uiCtx = { context: createActionContext({ caller: "ui", userId: USER_ID }) };

		const created = await executeAction(
			upsert,
			{
				organisation: "Vellum",
				role_title: "Staff AI Engineer",
				channel: "company_site",
				stage: "applied",
				applied_on: "2026-11-01",
				as_of: "2026-11-01",
			},
			uiCtx,
		);
		const appId = created.application!.id;

		store.linkedArtifacts.push({
			entity_id: appId,
			artifact_id: "00000000-0000-4000-8000-000000000555",
			link_type: "related",
			confidence_score: 1,
			notes: "Tailored CV PDF",
			artifact: {
				id: "00000000-0000-4000-8000-000000000555",
				title: "Vellum Tailored CV.pdf",
				source: "upload:cv.pdf",
				source_channel: "upload",
				source_url: null,
				storage_url: null,
				file_type: "application/pdf",
				captured_at: "2026-11-20T12:00:00.000Z",
				originated_at: "2026-11-20T12:00:00.000Z",
				created_at: "2026-11-20T12:00:00.000Z",
				archived: false,
				processing_metadata: null,
			},
		});

		const pipeline = await executeAction(read, { as_of: "2026-11-22" }, uiCtx);
		const item = pipeline.applications.find((a) => a.id === appId)!;
		expect(item.artifacts).toHaveLength(1);
		expect(item.last_inbound_at).toBeNull();
		expect(item.last_action_at).toBe("2026-11-01T09:00:00.000Z");
		expect(item.silent).toBe(true);
	});
});

describe("buildRegistry integration for jobhunt actions", () => {
	it("registers job_application_upsert and job_pipeline_read with default-on exposure and throws AdapterUnavailableError when unwired", async () => {
		const registry = buildRegistry({});
		const upsert = registry.get("job_application_upsert")!;
		const read = registry.get("job_pipeline_read")!;

		expect(upsert).toBeDefined();
		expect(read).toBeDefined();
		expect(upsert.domain).toBe("kg");
		expect(upsert.expose).toMatchObject({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(read.annotations.readOnlyHint).toBe(true);
		expect(read.expose).toMatchObject({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});

		await expect(
			executeAction(read, {}, { context: createActionContext({ caller: "ui", userId: USER_ID }) }),
		).rejects.toThrow(AdapterUnavailableError);
	});
});
