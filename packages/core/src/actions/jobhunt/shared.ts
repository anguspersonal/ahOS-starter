import {
	isApplicationChannel,
	isJobApplicationStage,
	isRoleCategory,
	JOB_APPLICATION_DATE_PRECISIONS,
	JOB_APPLICATION_ENTITY_KIND,
	statusForStage,
	type ApplicationChannel,
	type JobApplicationDatePrecision,
	type JobApplicationProperties,
	type JobApplicationRecord,
	type JobApplicationStage,
	type JobApplicationStageHistoryEntry,
	type RoleCategory,
} from "../../domain/jobApplications.js";
import type { EntityEmbedFields } from "../../domain/embeddings.js";
import { isPriorityLevel, type PriorityLevel } from "../../domain/priorityScale.js";
import type { ArtifactRepository } from "../../ports/artifacts.js";
import type { EntityRepository, EntityRow, LinkRepository } from "../../ports/entities.js";
import type { GraphEdgeRow, GraphEntityRow, GraphReadPort } from "../../ports/graphRead.js";
import type { PeopleRepository } from "../../ports/people.js";
import type { TaskRepository } from "../../ports/tasks.js";

export interface JobHuntDeps {
	entities: EntityRepository;
	artifacts?: ArtifactRepository;
	tasks?: TaskRepository;
	links?: LinkRepository;
	graphRead?: GraphReadPort;
	people?: PeopleRepository;
	embedEntity?: (id: string, fields: EntityEmbedFields) => Promise<unknown>;
	ownerId?: string | (() => string | undefined);
}

export function resolveJobHuntUserId(
	deps: Pick<JobHuntDeps, "ownerId">,
	ctxUserId?: string,
): string | undefined {
	if (ctxUserId) return ctxUserId;
	if (typeof deps.ownerId === "function") return deps.ownerId();
	return deps.ownerId;
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

export function strOrNull(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function numOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function toUtcIsoTimestamp(dateOrIso: string): string {
	const trimmed = dateOrIso.trim();
	if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
		return `${trimmed}T09:00:00.000Z`;
	}
	const parsed = Date.parse(trimmed);
	if (Number.isFinite(parsed)) {
		return new Date(parsed).toISOString();
	}
	return new Date().toISOString();
}

export function toUtcDateOnly(dateOrIso?: string | null): string {
	const raw = dateOrIso?.trim();
	if (!raw) return new Date().toISOString().slice(0, 10);
	const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
	if (match) return match[1];
	const parsed = Date.parse(raw);
	if (Number.isFinite(parsed)) {
		return new Date(parsed).toISOString().slice(0, 10);
	}
	return new Date().toISOString().slice(0, 10);
}

export function parseJobApplicationProperties(
	row: Pick<EntityRow, "title" | "properties">,
): JobApplicationProperties {
	const raw = (row.properties ?? {}) as Record<string, unknown>;
	const stage: JobApplicationStage = isJobApplicationStage(raw.stage)
		? raw.stage
		: "identified";
	const roleCategory: RoleCategory = isRoleCategory(raw.role_category)
		? raw.role_category
		: "other";
	const channel: ApplicationChannel = isApplicationChannel(raw.channel)
		? raw.channel
		: "company_site";
	const datePrecision: JobApplicationDatePrecision | undefined =
		typeof raw.date_precision === "string" &&
		(JOB_APPLICATION_DATE_PRECISIONS as readonly string[]).includes(raw.date_precision)
			? (raw.date_precision as JobApplicationDatePrecision)
			: undefined;

	const rawHistory = Array.isArray(raw.stage_history) ? raw.stage_history : [];
	const stageHistory: JobApplicationStageHistoryEntry[] = rawHistory
		.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
		.map((item) => ({
			stage: isJobApplicationStage(item.stage) ? item.stage : stage,
			at: typeof item.at === "string" && item.at.trim() ? item.at.trim() : "",
			...(typeof item.source === "string" && item.source.trim()
				? { source: item.source.trim() }
				: {}),
			...(typeof item.evidence_artifact_id === "string" && item.evidence_artifact_id.trim()
				? { evidence_artifact_id: item.evidence_artifact_id.trim() }
				: {}),
			...(typeof item.note === "string" && item.note.trim()
				? { note: item.note.trim() }
				: {}),
		}))
		.filter((entry) => entry.at.length > 0);

	const inferredRoleTitle =
		strOrNull(raw.role_title) ??
		extractRoleFromApplicationTitle(row.title) ??
		row.title ??
		"Untitled Role";

	const priorityLevel =
		typeof raw.priority_level === "number" && isPriorityLevel(raw.priority_level)
			? (raw.priority_level as PriorityLevel)
			: null;

	return {
		kind: JOB_APPLICATION_ENTITY_KIND,
		role_title: inferredRoleTitle,
		role_category: roleCategory,
		channel,
		ats: strOrNull(raw.ats),
		stage,
		stage_history: stageHistory,
		applied_on: strOrNull(raw.applied_on),
		date_precision: datePrecision,
		closed_on: strOrNull(raw.closed_on),
		salary_band: strOrNull(raw.salary_band),
		salary_expectation_submitted: numOrNull(raw.salary_expectation_submitted),
		platform_ref: strOrNull(raw.platform_ref),
		priority_level: priorityLevel,
		status: statusForStage(stage),
		source: strOrNull(raw.source) as JobApplicationProperties["source"],
		notes: strOrNull(raw.notes),
		cv_entity_id: strOrNull(raw.cv_entity_id),
	};
}

export function extractOrganisationFromApplicationTitle(title: string | null): string | null {
	if (!title) return null;
	const idx = title.indexOf("·");
	if (idx <= 0) return null;
	return title.slice(0, idx).trim() || null;
}

export function extractRoleFromApplicationTitle(title: string | null): string | null {
	if (!title) return null;
	const idx = title.indexOf("·");
	if (idx < 0) return null;
	return title.slice(idx + 1).trim() || null;
}

export function toJobApplicationRecord(
	row: Pick<EntityRow, "id" | "title" | "properties">,
	organisationName: string | null,
	lastInboundAt: string | null,
): JobApplicationRecord {
	const props = parseJobApplicationProperties(row);
	return {
		id: row.id,
		org: organisationName ?? extractOrganisationFromApplicationTitle(row.title) ?? undefined,
		role_title: props.role_title,
		role_category: props.role_category,
		channel: props.channel,
		stage: props.stage,
		applied_on: props.applied_on ?? null,
		closed_on: props.closed_on ?? null,
		stage_history: props.stage_history,
		last_inbound_at: lastInboundAt,
		priority_level: props.priority_level ?? null,
	};
}

export async function loadOutgoingEdgesForEntities(
	deps: Pick<JobHuntDeps, "entities" | "graphRead">,
	entityIds: readonly string[],
	userId?: string,
): Promise<GraphEdgeRow[]> {
	if (entityIds.length === 0) return [];

	if (deps.graphRead && userId) {
		const out: GraphEdgeRow[] = [];
		for (let i = 0; i < entityIds.length; i += 100) {
			const batch = entityIds.slice(i, i + 100);
			const edges = await deps.graphRead.getOutEdges(batch, userId, {
				includeArchivedEdges: false,
			});
			out.push(...edges);
		}
		return out;
	}

	if (deps.entities.queryRelationships) {
		const results = await Promise.all(
			entityIds.map((entityId) =>
				deps.entities.queryRelationships!(
					{ entity_id: entityId, direction: "outgoing", limit: 100 },
					userId,
				),
			),
		);
		const out: GraphEdgeRow[] = [];
		for (const list of results) {
			for (const rel of list) {
				if ((rel as { archived?: boolean }).archived) continue;
				out.push({
					from_entity_id: rel.from_entity_id,
					to_entity_id: rel.to_entity_id,
					relationship_type: rel.relationship_type,
					confidence_score: rel.confidence_score ?? null,
					metadata: rel.metadata ?? {},
					notes: (rel as { notes?: string | null }).notes ?? null,
					valid_from: (rel as { valid_from?: string | null }).valid_from ?? null,
					valid_to: (rel as { valid_to?: string | null }).valid_to ?? null,
				});
			}
		}
		return out;
	}

	return [];
}

export async function loadEntitiesMapByIds(
	deps: Pick<JobHuntDeps, "entities" | "graphRead">,
	ids: readonly string[],
	userId?: string,
): Promise<Map<string, GraphEntityRow>> {
	const uniqueIds = [...new Set(ids.filter(Boolean))];
	const map = new Map<string, GraphEntityRow>();
	if (uniqueIds.length === 0) return map;

	if (deps.graphRead && userId) {
		for (let i = 0; i < uniqueIds.length; i += 100) {
			const nodes = await deps.graphRead.getNodesByIds(uniqueIds.slice(i, i + 100), userId);
			for (const node of nodes) {
				map.set(node.id, node);
			}
		}
		return map;
	}

	for (let i = 0; i < uniqueIds.length; i += 100) {
		const batch = uniqueIds.slice(i, i + 100);
		const { rows } = await deps.entities.loadRows(
			{ ids: batch, include_archived: true, limit: batch.length },
			userId,
		);
		for (const row of rows) {
			map.set(row.id, {
				id: row.id,
				entity_type: row.entity_type,
				title: row.title ?? "",
				properties: row.properties ?? null,
				archived: row.archived ?? false,
			});
		}
	}
	return map;
}
