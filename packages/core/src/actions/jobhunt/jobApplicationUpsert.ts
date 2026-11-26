import {
	addUtcDays,
	addUtcWorkingDays,
	buildPreApplicationTaskSpec,
	defaultNextActionForStage,
	formatJobApplicationTitle,
	isForbiddenDexJobsAlias,
	isTerminalStage,
	JOB_APPLICATION_CV_EDGE,
	JOB_APPLICATION_ENTITY_KIND,
	JOB_SEARCH_AREA_TITLE,
	normaliseRoleTitle,
	statusForStage,
	type ApplicationChannel,
	type JobApplicationStage,
	type JobApplicationStageHistoryEntry,
	type RoleCategory,
} from "../../domain/jobApplications.js";
import {
	isPriorityLevel,
	priorityLevelToTaskPriority,
	type PriorityLevel,
} from "../../domain/priorityScale.js";
import type { EntityRepository, EntityRow } from "../../ports/entities.js";
import type { UserTaskRow } from "../../ports/tasks.js";
import { defineAction } from "../defineAction.js";
import { needsReviewBandApproval } from "../gate.js";
import type { ActionDefinition } from "../types.js";
import {
	jobApplicationUpsertSchema,
	type JobApplicationCandidate,
	type JobApplicationUpsertInput,
	type JobApplicationUpsertResult,
} from "../domain/jobhunt.js";
import {
	extractOrganisationFromApplicationTitle,
	loadOutgoingEdgesForEntities,
	parseJobApplicationProperties,
	resolveJobHuntUserId,
	strOrNull,
	toUtcDateOnly,
	toUtcIsoTimestamp,
	type JobHuntDeps,
} from "./shared.js";

export const JOB_APPLICATION_UPSERT_DESCRIPTION =
	"Create or update a job application arrangement node (ADR-120) with its participant edges " +
	"(applicant, applied_to, applied_via, recruiter, hiring_contact, references CV, belongs_to Job Search), " +
	"provenance links, and open next-action task. Interactive UI/MCP calls execute directly (refusing with " +
	"candidates on ambiguous match); unattended worker calls or review-band confidence calls park in the " +
	"owner Approvals inbox.";

const OPEN_TASK_EXCLUDED_STATUSES = new Set(["done", "cancelled"]);
const PRE_SUBMISSION_STAGES: ReadonlySet<JobApplicationStage> = new Set([
	"identified",
	"matched",
	"drafting",
]);
const SUBMITTED_STAGES: ReadonlySet<JobApplicationStage> = new Set([
	"applied",
	"screening",
	"interviewing",
	"offer",
	"accepted",
	"rejected",
	"closed_no_reply",
]);

function normalizeText(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function entityMatchesNameOrAlias(entity: EntityRow, queryName: string): boolean {
	const needle = normalizeText(queryName);
	if (!needle) return false;
	if (normalizeText(entity.title) === needle) return true;
	const aliases = Array.isArray(entity.aliases) ? entity.aliases : [];
	return aliases.some((alias) => normalizeText(alias) === needle);
}

type OrgResolution =
	| { kind: "resolved"; entity: EntityRow | null }
	| { kind: "create"; title: string }
	| { kind: "ambiguous"; candidates: JobApplicationCandidate[]; message: string };

async function resolveOrganisationByIdOrName(
	entities: EntityRepository,
	opts: {
		id?: string;
		name?: string;
		label: string;
		guardDexAlias?: boolean;
	},
	userId?: string,
): Promise<OrgResolution> {
	if (opts.id) {
		const row = await entities.getById(opts.id, userId);
		if (!row || row.archived) {
			throw new Error(`${opts.label} entity ${opts.id} not found.`);
		}
		if (row.entity_type !== "organization") {
			throw new Error(
				`${opts.label} entity ${opts.id} has entity_type "${row.entity_type}", expected "organization".`,
			);
		}
		return { kind: "resolved", entity: row };
	}

	const trimmedName = opts.name?.trim();
	if (!trimmedName) {
		return { kind: "resolved", entity: null };
	}

	if (opts.guardDexAlias && isForbiddenDexJobsAlias(trimmedName)) {
		throw new Error(
			`Refusing ambiguous/forbidden job site name "${trimmedName}": bare "Dex" is reserved for Dex CRM (getdex.com). Use "Dex jobs" or "meetdex.ai" (ADR-120 §4).`,
		);
	}

	const { rows } = await entities.loadRows(
		{
			entity_type: "organization",
			query: trimmedName,
			include_archived: false,
			limit: 50,
		},
		userId,
	);
	const exactMatches = rows.filter((row) => entityMatchesNameOrAlias(row, trimmedName));

	if (exactMatches.length === 1) {
		return { kind: "resolved", entity: exactMatches[0] };
	}
	if (exactMatches.length > 1) {
		return {
			kind: "ambiguous",
			candidates: exactMatches.map((row) => ({
				id: row.id,
				title: row.title ?? trimmedName,
				organisation: row.title ?? trimmedName,
				role_title: null,
				stage: null,
				channel: null,
				platform_ref: null,
				applied_on: null,
				match_reason: `Ambiguous ${opts.label.toLowerCase()} match for "${trimmedName}"`,
			})),
			message: `Multiple ${opts.label.toLowerCase()} entities match "${trimmedName}". Pass an explicit ID to disambiguate.`,
		};
	}

	return { kind: "create", title: trimmedName };
}

async function upsertSingleTargetEdge(
	entities: EntityRepository,
	fromEntityId: string,
	toEntityId: string,
	relationshipType: string,
	singleCardinality: boolean,
	userId?: string,
): Promise<void> {
	if (singleCardinality && entities.queryRelationships && entities.archiveEdgesByIds) {
		const existingOutgoing = await entities.queryRelationships(
			{
				entity_id: fromEntityId,
				direction: "outgoing",
				relationship_type: relationshipType,
				limit: 50,
			},
			userId,
		);
		const staleIds = existingOutgoing
			.filter(
				(edge) =>
					!(edge as { archived?: boolean }).archived &&
					edge.to_entity_id !== toEntityId,
			)
			.map((edge) => edge.id);
		if (staleIds.length > 0) {
			await entities.archiveEdgesByIds(staleIds, userId);
		}
	}

	if (entities.findRelationshipEdge && entities.updateRelationshipEdge && entities.insertRelationshipEdge) {
		const existing = await entities.findRelationshipEdge(
			fromEntityId,
			toEntityId,
			relationshipType,
			userId,
		);
		if (existing) {
			if (existing.archived) {
				await entities.updateRelationshipEdge(existing.id, { archived: false }, userId);
			}
			return;
		}
		await entities.insertRelationshipEdge(
			{
				from_entity_id: fromEntityId,
				to_entity_id: toEntityId,
				relationship_type: relationshipType,
				confidence_score: 1,
				metadata: {},
				created_by: "job_application_upsert",
				notes: null,
				valid_from: null,
				valid_to: null,
			},
			userId,
		);
		return;
	}

	await entities.insertParticipantEdges(
		[
			{
				user_id: userId ?? "",
				from_entity_id: fromEntityId,
				to_entity_id: toEntityId,
				relationship_type: relationshipType,
				confidence_score: 1,
				metadata: {},
				created_by: "job_application_upsert",
				notes: `Job application ${relationshipType} edge`,
				valid_from: null,
				valid_to: null,
			},
		],
		userId,
	);
}

async function archiveLiveEdgesOfType(
	entities: EntityRepository,
	fromEntityId: string,
	relationshipType: string,
	userId?: string,
): Promise<void> {
	if (!entities.queryRelationships || !entities.archiveEdgesByIds) return;
	const existingOutgoing = await entities.queryRelationships(
		{
			entity_id: fromEntityId,
			direction: "outgoing",
			relationship_type: relationshipType,
			limit: 50,
		},
		userId,
	);
	const liveIds = existingOutgoing
		.filter((edge) => !(edge as { archived?: boolean }).archived)
		.map((edge) => edge.id);
	if (liveIds.length > 0) {
		await entities.archiveEdgesByIds(liveIds, userId);
	}
}

async function resolveDefaultAreaId(
	entities: EntityRepository,
	explicitAreaId: string | undefined,
	userId?: string,
): Promise<string | null> {
	if (explicitAreaId) {
		const row = await entities.getById(explicitAreaId, userId);
		if (!row || row.archived) {
			throw new Error(`Area entity ${explicitAreaId} not found.`);
		}
		if (row.entity_type !== "area") {
			throw new Error(
				`Area entity ${explicitAreaId} has entity_type "${row.entity_type}", expected "area".`,
			);
		}
		return row.id;
	}
	if (entities.findByExactTitle) {
		const matches = await entities.findByExactTitle(
			{ entity_type: "area", title: JOB_SEARCH_AREA_TITLE, limit: 5 },
			userId,
		);
		if (matches.length === 1) return matches[0].id;
		const angusPreferred = matches.find((m) => m.domain_override === "angus");
		if (angusPreferred) return angusPreferred.id;
		if (matches.length > 0) return matches[0].id;
	}
	const { rows } = await entities.loadRows(
		{
			entity_type: "area",
			query: JOB_SEARCH_AREA_TITLE,
			include_archived: false,
			limit: 20,
		},
		userId,
	);
	const exact = rows.filter((r) => normalizeText(r.title) === normalizeText(JOB_SEARCH_AREA_TITLE));
	const angusArea = exact.find((r) => r.domain_override === "angus");
	return angusArea?.id ?? exact[0]?.id ?? null;
}

async function resolveDefaultApplicantId(
	deps: JobHuntDeps,
	explicitApplicantId: string | undefined,
	userId?: string,
): Promise<string | null> {
	if (explicitApplicantId) {
		const row = await deps.entities.getById(explicitApplicantId, userId);
		if (!row || row.archived) {
			throw new Error(`Applicant entity ${explicitApplicantId} not found.`);
		}
		if (row.entity_type !== "people") {
			throw new Error(
				`Applicant entity ${explicitApplicantId} has entity_type "${row.entity_type}", expected "people".`,
			);
		}
		return row.id;
	}
	if (!deps.people) return null;
	try {
		if (deps.people.readSelfPreferences) {
			const prefs = await deps.people.readSelfPreferences(userId);
			if (prefs.self_entity_id) return prefs.self_entity_id;
		}
		if (deps.people.findSelfEntityByFlag) {
			const selfRow = await deps.people.findSelfEntityByFlag(userId);
			if (selfRow) return selfRow.id;
		}
	} catch {
		return null;
	}
	return null;
}

function disambiguateTitle(
	baseTitle: string,
	existingTitlesLower: Set<string>,
	appliedOrAsOfDate: string,
): string {
	if (!existingTitlesLower.has(baseTitle.toLowerCase())) {
		return baseTitle;
	}
	const dated = `${baseTitle} (${appliedOrAsOfDate})`;
	if (!existingTitlesLower.has(dated.toLowerCase())) {
		return dated;
	}
	let n = 2;
	while (existingTitlesLower.has(`${dated} #${n}`.toLowerCase())) {
		n += 1;
	}
	return `${dated} #${n}`;
}

function toCandidate(
	row: EntityRow,
	orgName: string | null,
	matchReason: string,
): JobApplicationCandidate {
	const props = parseJobApplicationProperties(row);
	return {
		id: row.id,
		title: row.title ?? formatJobApplicationTitle(orgName ?? "Unknown", props.role_title),
		organisation: orgName ?? extractOrganisationFromApplicationTitle(row.title),
		role_title: props.role_title,
		stage: props.stage,
		channel: props.channel,
		platform_ref: props.platform_ref ?? null,
		applied_on: props.applied_on ?? null,
		match_reason: matchReason,
	};
}

async function syncApplicationTask(
	deps: JobHuntDeps,
	args: {
		applicationId: string;
		stage: JobApplicationStage;
		stageChanged: boolean;
		isCreate: boolean;
		asOfDate: string;
		nowIso: string;
		caller: string;
		screeningCallHeld?: boolean;
		nextActionTitle?: string;
		nextActionDueDate?: string;
		evidenceArtifactId?: string;
	},
	userId?: string,
): Promise<UserTaskRow | null> {
	if (!deps.tasks) return null;

	const existingTasks = await deps.tasks.query(
		{ entity_id: args.applicationId, limit: 50 },
		userId,
	);
	const openTasks = existingTasks.filter(
		(task) => !OPEN_TASK_EXCLUDED_STATUSES.has(task.status),
	);

	if (isTerminalStage(args.stage)) {
		const targetStatus = args.stage === "accepted" ? "done" : "cancelled";
		for (const openTask of openTasks) {
			await deps.tasks.update(
				openTask.id,
				{
					status: targetStatus,
					...(targetStatus === "done" ? { completed_at: args.nowIso } : {}),
					updated_at: args.nowIso,
				},
				userId,
			);
		}
		return null;
	}

	const spec =
		args.stage === "identified" || args.stage === "matched"
			? (() => {
					const pre = buildPreApplicationTaskSpec(args.stage, args.asOfDate);
					return {
						title: pre.title,
						dueDate: pre.due_date,
						priority_level: pre.priority_level,
						energy_mode: pre.energy_mode,
						status: pre.status,
						source: pre.source,
					};
				})()
			: (() => {
					const next = defaultNextActionForStage(args.stage, {
						screeningCallHeld: args.screeningCallHeld,
					});
					if (!next) return null;
					const dueDate = next.working_days
						? addUtcWorkingDays(args.asOfDate, next.due_days)
						: addUtcDays(args.asOfDate, next.due_days);
					return {
						title: next.title,
						dueDate,
						priority_level: next.priority_level,
						energy_mode: next.energy_mode,
						status: next.status,
						source: next.source,
					};
				})();

	if (!spec) return null;

	const desiredTitle = args.nextActionTitle?.trim() || spec.title;
	const desiredDueIso = toUtcIsoTimestamp(args.nextActionDueDate?.trim() || spec.dueDate);

	const hasExplicitTaskOverride = Boolean(args.nextActionTitle || args.nextActionDueDate);
	const screeningStageSpecRotated =
		args.stage === "screening" &&
		args.screeningCallHeld !== undefined &&
		openTasks.length > 0 &&
		openTasks[0].title !== desiredTitle;
	if (
		!args.isCreate &&
		!args.stageChanged &&
		!hasExplicitTaskOverride &&
		!screeningStageSpecRotated &&
		openTasks.length > 0
	) {
		return openTasks[0];
	}

	if (
		!args.isCreate &&
		!args.stageChanged &&
		hasExplicitTaskOverride &&
		openTasks.length === 1
	) {
		return deps.tasks.update(
			openTasks[0].id,
			{
				title: desiredTitle,
				due_date: desiredDueIso,
				updated_at: args.nowIso,
			},
			userId,
		);
	}

	// Replace/complete any existing open tasks when entering a new stage
	for (const openTask of openTasks) {
		await deps.tasks.update(
			openTask.id,
			{
				status: "done",
				completed_at: args.nowIso,
				updated_at: args.nowIso,
			},
			userId,
		);
	}

	const taskRow: Record<string, unknown> = {
		id: globalThis.crypto.randomUUID(),
		title: desiredTitle,
		description: null,
		status: spec.status,
		priority: priorityLevelToTaskPriority(spec.priority_level),
		priority_level: spec.priority_level,
		task_type: "one_off",
		effort: null,
		energy_mode: spec.energy_mode,
		source: spec.source,
		due_date: desiredDueIso,
		entity_id: args.applicationId,
		source_artifact_id: args.evidenceArtifactId ?? null,
		created_via: args.caller === "ui" ? "manual" : "system",
		created_at: args.nowIso,
		updated_at: args.nowIso,
	};
	if (userId) {
		taskRow.user_id = userId;
		taskRow.created_by = userId;
	}

	return deps.tasks.insert(taskRow, userId);
}

export function formatJobApplicationUpsertMcp(result: JobApplicationUpsertResult): string {
	if (result.status === "ambiguous") {
		const lines = [
			result.message,
			...(result.candidates ?? []).map(
				(c) =>
					`• [${c.id}] ${c.title} (stage=${c.stage ?? "?"}, channel=${c.channel ?? "?"}${c.platform_ref ? `, ref=${c.platform_ref}` : ""}) — ${c.match_reason}`,
			),
		];
		return lines.join("\n");
	}
	const app = result.application;
	if (!app) return result.message;
	const parts = [
		`${result.status === "created" ? "Created" : "Updated"} application [${app.id}] "${app.title}"`,
		`stage=${app.stage} (status=${app.entity_status})`,
		`channel=${app.channel}`,
		`category=${app.role_category}`,
	];
	if (app.applied_on) parts.push(`applied_on=${app.applied_on}`);
	if (app.cv_entity_id) parts.push(`cv=${app.cv_entity_id}`);
	if (result.open_task) {
		parts.push(
			`next_task="${result.open_task.title}" (due ${result.open_task.due_date?.slice(0, 10) ?? "?"}, P${result.open_task.priority_level ?? "?"})`,
		);
	}
	return parts.join(" · ");
}

export function createJobApplicationUpsertAction(
	deps: JobHuntDeps,
): ActionDefinition<typeof jobApplicationUpsertSchema, JobApplicationUpsertResult> {
	return defineAction({
		id: "job_application_upsert",
		name: "job_application_upsert",
		description: JOB_APPLICATION_UPSERT_DESCRIPTION,
		domain: "kg",
		schema: jobApplicationUpsertSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		needsApproval: (input, ctx) => {
			const reviewBand = needsReviewBandApproval(input, ctx);
			return ctx.caller === "worker" || reviewBand;
		},
		run: async (input: JobApplicationUpsertInput, ctx) => {
			if (
				Array.isArray(input.disambiguation_candidates) &&
				input.disambiguation_candidates.length > 0 &&
				!input.id &&
				!input.reapplication
			) {
				const list = input.disambiguation_candidates
					.map((c) => `[${c.id}] ${c.title}${c.stage ? ` (${c.stage})` : ""}`)
					.join(", ");
				throw new Error(
					`Cannot execute ambiguous job application update without an explicit id (or reapplication: true). Candidates: ${list}.`,
				);
			}

			const userId = resolveJobHuntUserId(deps, ctx.userId);
			const nowIso = input.as_of?.trim()
				? toUtcIsoTimestamp(input.as_of.trim())
				: new Date().toISOString();
			const asOfDate = toUtcDateOnly(input.as_of ?? nowIso);

			// 1. Validate optional CV, people, area, applicant, and evidence artifact IDs before writing anything
			if (input.cv_entity_id) {
				const cvRow = await deps.entities.getById(input.cv_entity_id, userId);
				if (!cvRow || cvRow.archived) {
					throw new Error(`CV resource entity ${input.cv_entity_id} not found.`);
				}
				if (cvRow.entity_type !== "resource") {
					throw new Error(
						`CV resource entity ${input.cv_entity_id} has entity_type "${cvRow.entity_type}", expected "resource".`,
					);
				}
			}
			const peopleIds = Array.from(
				new Set([...(input.recruiter_ids ?? []), ...(input.hiring_contact_ids ?? [])]),
			);
			if (peopleIds.length > 0) {
				const { rows: peopleRows } = await deps.entities.loadRows(
					{ ids: peopleIds, include_archived: false, limit: peopleIds.length },
					userId,
				);
				const peopleById = new Map(peopleRows.map((row) => [row.id, row]));
				const missingPeople = peopleIds.filter((pid) => !peopleById.has(pid));
				if (missingPeople.length > 0) {
					throw new Error(
						`Referenced people entities not found or not owned: ${missingPeople.join(", ")}`,
					);
				}
				const wrongTypePeople = peopleIds.filter(
					(pid) => peopleById.get(pid)?.entity_type !== "people",
				);
				if (wrongTypePeople.length > 0) {
					throw new Error(
						`Referenced people entities must have entity_type "people": ${wrongTypePeople.join(", ")}`,
					);
				}
			}
			const prevalidatedAreaId = input.area_id
				? await resolveDefaultAreaId(deps.entities, input.area_id, userId)
				: null;
			const prevalidatedApplicantId = input.applicant_entity_id
				? await resolveDefaultApplicantId(deps, input.applicant_entity_id, userId)
				: null;
			if (input.evidence_artifact_id && typeof deps.artifacts?.getById === "function") {
				const artifactRow = await deps.artifacts.getById(input.evidence_artifact_id);
				if (!artifactRow) {
					throw new Error(`Evidence artifact ${input.evidence_artifact_id} not found.`);
				}
			}

			// 2. Resolve organisation & job site (purely read-only first to catch ambiguities)
			const orgResolution = await resolveOrganisationByIdOrName(
				deps.entities,
				{
					id: input.organisation_id,
					name: input.organisation,
					label: "Organisation",
				},
				userId,
			);
			if (orgResolution.kind === "ambiguous") {
				return {
					status: "ambiguous",
					candidates: orgResolution.candidates,
					message: orgResolution.message,
				};
			}

			const jobSiteResolution = await resolveOrganisationByIdOrName(
				deps.entities,
				{
					id: input.job_site_id,
					name: input.job_site,
					label: "Job site",
					guardDexAlias: true,
				},
				userId,
			);
			if (jobSiteResolution.kind === "ambiguous") {
				return {
					status: "ambiguous",
					candidates: jobSiteResolution.candidates,
					message: jobSiteResolution.message,
				};
			}

			// 3. Load existing job application arrangements to match or detect ambiguity
			const { rows: existingAppsRaw } = await deps.entities.loadRows(
				{
					entity_type: "arrangement",
					properties_contains: { kind: JOB_APPLICATION_ENTITY_KIND },
					include_archived: false,
					limit: 1000,
				},
				userId,
			);
			const existingApps = existingAppsRaw.filter(
				(row) => row.properties?.kind === JOB_APPLICATION_ENTITY_KIND,
			);

			let targetApp: EntityRow | null = null;
			if (input.id) {
				const byId =
					existingApps.find((row) => row.id === input.id) ??
					(await deps.entities.getById(input.id, userId));
				if (
					!byId ||
					byId.entity_type !== "arrangement" ||
					byId.properties?.kind !== JOB_APPLICATION_ENTITY_KIND
				) {
					throw new Error(`Job application ${input.id} not found.`);
				}
				targetApp = byId;
			} else if (!input.reapplication && existingApps.length > 0) {
				const outEdges = await loadOutgoingEdgesForEntities(
					deps,
					existingApps.map((a) => a.id),
					userId,
				);
				const appliedToByApp = new Map<string, string>();
				for (const edge of outEdges) {
					if (edge.relationship_type === "applied_to" && !appliedToByApp.has(edge.from_entity_id)) {
						appliedToByApp.set(edge.from_entity_id, edge.to_entity_id);
					}
				}

				const resolvedOrgId =
					orgResolution.kind === "resolved" ? orgResolution.entity?.id ?? null : null;
				const resolvedOrgTitle =
					orgResolution.kind === "resolved"
						? orgResolution.entity?.title ?? null
						: orgResolution.title;

				// Priority 1: platform_ref exact match
				const refNeedle = normalizeText(input.platform_ref);
				if (refNeedle) {
					const refMatches = existingApps.filter(
						(row) => normalizeText(strOrNull(row.properties?.platform_ref)) === refNeedle,
					);
					if (refMatches.length > 1) {
						return {
							status: "ambiguous",
							candidates: refMatches.map((row) =>
								toCandidate(
									row,
									extractOrganisationFromApplicationTitle(row.title),
									`Matched platform_ref "${input.platform_ref}"`,
								),
							),
							message: `Multiple applications match platform_ref "${input.platform_ref}". Pass id to disambiguate.`,
						};
					}
					if (refMatches.length === 1) {
						targetApp = refMatches[0];
					}
				}

				// Priority 2: (organisation, normalised role_title)
				if (!targetApp && (resolvedOrgId || resolvedOrgTitle)) {
					const orgMatches = existingApps.filter((row) => {
						const linkedOrgId = appliedToByApp.get(row.id);
						if (resolvedOrgId && linkedOrgId === resolvedOrgId) return true;
						if (!resolvedOrgTitle) return false;
						const titleOrg = extractOrganisationFromApplicationTitle(row.title);
						if (normalizeText(titleOrg) === normalizeText(resolvedOrgTitle)) return true;
						if (orgResolution.kind === "resolved" && orgResolution.entity) {
							return titleOrg ? entityMatchesNameOrAlias(orgResolution.entity, titleOrg) : false;
						}
						return false;
					});

					if (input.role_title) {
						const wantedRole = normaliseRoleTitle(input.role_title);
						const roleMatches = orgMatches.filter((row) => {
							const props = parseJobApplicationProperties(row);
							return normaliseRoleTitle(props.role_title) === wantedRole;
						});
						if (roleMatches.length > 1) {
							return {
								status: "ambiguous",
								candidates: roleMatches.map((row) =>
									toCandidate(
										row,
										resolvedOrgTitle,
										`Matched organisation "${resolvedOrgTitle}" and role "${input.role_title}"`,
									),
								),
								message: `Multiple applications match "${resolvedOrgTitle} · ${input.role_title}". Pass id to disambiguate or reapplication: true for a new application.`,
							};
						}
						if (roleMatches.length === 1) {
							targetApp = roleMatches[0];
						}
					} else if (orgMatches.length > 1) {
						return {
							status: "ambiguous",
							candidates: orgMatches.map((row) =>
								toCandidate(
									row,
									resolvedOrgTitle,
									`Matched organisation "${resolvedOrgTitle}" without role_title`,
								),
							),
							message: `Multiple applications exist for "${resolvedOrgTitle}". Pass id or role_title to select one.`,
						};
					} else if (orgMatches.length === 1) {
						targetApp = orgMatches[0];
					}
				}
			}

			const isCreate = targetApp === null;
			if (isCreate) {
				const hasOrg =
					(orgResolution.kind === "resolved" && orgResolution.entity !== null) ||
					orgResolution.kind === "create";
				if (!hasOrg || !input.role_title?.trim()) {
					throw new Error(
						"Creating a new job application requires both organisation (or organisation_id) and role_title.",
					);
				}
			}

			// 4. Persist organisation / job-site entities if newly needed
			let organisationEntity: EntityRow | null =
				orgResolution.kind === "resolved" ? orgResolution.entity : null;
			if (orgResolution.kind === "create") {
				const [createdOrg] = await deps.entities.insert(
					[
						{
							entity_type: "organization",
							title: orgResolution.title,
							tags: [],
							properties: {},
						},
					],
					userId,
				);
				organisationEntity = createdOrg;
				if (deps.embedEntity && createdOrg) {
					await deps.embedEntity(createdOrg.id, {
						title: createdOrg.title,
						description: createdOrg.description,
						properties: createdOrg.properties,
					});
				}
			}

			let jobSiteEntity: EntityRow | null =
				jobSiteResolution.kind === "resolved" ? jobSiteResolution.entity : null;
			if (jobSiteResolution.kind === "create") {
				const [createdSite] = await deps.entities.insert(
					[
						{
							entity_type: "organization",
							title: jobSiteResolution.title,
							tags: ["job-site"],
							properties: {},
						},
					],
					userId,
				);
				jobSiteEntity = createdSite;
				if (deps.embedEntity && createdSite) {
					await deps.embedEntity(createdSite.id, {
						title: createdSite.title,
						description: createdSite.description,
						properties: createdSite.properties,
					});
				}
			}

			// 5. Compute merged properties, stage transitions, and title
			const existingProps = targetApp ? parseJobApplicationProperties(targetApp) : null;
			const previousStage = existingProps?.stage ?? null;
			const nextStage: JobApplicationStage =
				input.stage ?? existingProps?.stage ?? "identified";
			const stageChanged = isCreate || previousStage !== nextStage;

			const roleTitle =
				input.role_title?.trim() ?? existingProps?.role_title ?? "Untitled Role";
			const roleCategory: RoleCategory =
				input.role_category ?? existingProps?.role_category ?? "other";
			const channel: ApplicationChannel =
				input.channel ?? existingProps?.channel ?? "company_site";
			const ats =
				input.ats !== undefined ? input.ats : existingProps?.ats ?? null;

			let appliedOn: string | null =
				input.applied_on !== undefined
					? input.applied_on
					: existingProps?.applied_on ?? null;
			if (PRE_SUBMISSION_STAGES.has(nextStage) && input.applied_on === undefined) {
				appliedOn = null;
			} else if (!appliedOn && SUBMITTED_STAGES.has(nextStage) && input.applied_on === undefined) {
				appliedOn = asOfDate;
			}

			let closedOn: string | null =
				input.closed_on !== undefined
					? input.closed_on
					: existingProps?.closed_on ?? null;
			if (isTerminalStage(nextStage) && !closedOn && input.closed_on === undefined) {
				closedOn = asOfDate;
			} else if (!isTerminalStage(nextStage) && input.closed_on === undefined) {
				closedOn = null;
			}

			const lastInboundAt =
				input.last_inbound_at !== undefined
					? input.last_inbound_at
					: strOrNull(targetApp?.properties?.last_inbound_at);

			const priorityLevel: PriorityLevel | null =
				input.priority_level !== undefined
					? (input.priority_level as PriorityLevel | null)
					: existingProps?.priority_level ?? null;
			const validatedPriority =
				priorityLevel !== null && isPriorityLevel(priorityLevel)
					? priorityLevel
					: null;

			const stageHistory: JobApplicationStageHistoryEntry[] = [
				...(existingProps?.stage_history ?? []),
			];
			if (
				stageChanged ||
				input.stage_note ||
				input.evidence_artifact_id
			) {
				stageHistory.push({
					stage: nextStage,
					at: nowIso,
					...(input.source ? { source: input.source } : {}),
					...(input.evidence_artifact_id
						? { evidence_artifact_id: input.evidence_artifact_id }
						: {}),
					...(input.stage_note ? { note: input.stage_note } : {}),
				});
			}

			const cvEntityId =
				input.cv_entity_id !== undefined
					? input.cv_entity_id
					: existingProps?.cv_entity_id ?? null;

			const entityStatus = statusForStage(nextStage);
			const nextProperties: Record<string, unknown> = {
				...(targetApp?.properties ?? {}),
				kind: JOB_APPLICATION_ENTITY_KIND,
				role_title: roleTitle,
				role_category: roleCategory,
				channel,
				ats,
				stage: nextStage,
				stage_history: stageHistory,
				applied_on: appliedOn,
				date_precision: input.date_precision ?? existingProps?.date_precision ?? "day",
				closed_on: closedOn,
				last_inbound_at: lastInboundAt,
				salary_band:
					input.salary_band !== undefined
						? input.salary_band
						: existingProps?.salary_band ?? null,
				salary_expectation_submitted:
					input.salary_expectation_submitted !== undefined
						? input.salary_expectation_submitted
						: existingProps?.salary_expectation_submitted ?? null,
				platform_ref:
					input.platform_ref !== undefined
						? input.platform_ref
						: existingProps?.platform_ref ?? null,
				priority_level: validatedPriority,
				status: entityStatus,
				source:
					input.source !== undefined
						? input.source
						: existingProps?.source ?? (ctx.caller === "ui" ? "owner" : "agent_proposed"),
				notes: input.notes !== undefined ? input.notes : existingProps?.notes ?? null,
				cv_entity_id: cvEntityId,
			};

			const orgDisplayName =
				organisationEntity?.title ??
				extractOrganisationFromApplicationTitle(targetApp?.title ?? null) ??
				input.organisation?.trim() ??
				"Unknown";
			const baseTitle = formatJobApplicationTitle(orgDisplayName, roleTitle);
			const existingTitlesLower = new Set(
				existingApps
					.filter((r) => r.id !== targetApp?.id && r.title)
					.map((r) => r.title!.trim().toLowerCase()),
			);
			const finalTitle =
				isCreate || input.organisation || input.organisation_id || input.role_title
					? disambiguateTitle(baseTitle, existingTitlesLower, appliedOn ?? asOfDate)
					: (targetApp?.title ?? baseTitle);

			const mergedTags = Array.from(
				new Set([
					"job-application",
					...(targetApp?.tags ?? []),
					...(input.tags ?? []),
				]),
			);

			let savedApp: EntityRow;
			if (isCreate) {
				const newId = globalThis.crypto.randomUUID();
				await deps.entities.insertArrangementNodes(
					[
						{
							id: newId,
							entity_type: "arrangement",
							title: finalTitle,
							description:
								input.notes !== undefined ? input.notes : null,
							properties: nextProperties,
							tags: mergedTags,
							archived: false,
							user_id: userId ?? "",
							team_id: null,
						},
					],
					userId,
				);
				savedApp = {
					id: newId,
					entity_type: "arrangement",
					title: finalTitle,
					description: input.notes ?? null,
					archived: false,
					archived_at: null,
					properties: nextProperties,
					tags: mergedTags,
					source_url: null,
					user_id: userId ?? null,
					team_id: null,
					created_at: nowIso,
					updated_at: nowIso,
				};
			} else {
				const updatedRows = await deps.entities.update(
					targetApp!.id,
					{
						title: finalTitle,
						...(input.notes !== undefined ? { description: input.notes } : {}),
						properties: nextProperties,
						tags: mergedTags,
					},
					userId,
				);
				savedApp = updatedRows[0] ?? {
					...targetApp!,
					title: finalTitle,
					properties: nextProperties,
					tags: mergedTags,
				};
			}

			if (deps.embedEntity) {
				await deps.embedEntity(savedApp.id, {
					title: finalTitle,
					description: savedApp.description ?? null,
					properties: nextProperties,
				});
			}

			// 6. Write participant, containment, and optional CV edges idempotently
			const writtenEdges: Array<{ relationship_type: string; to_entity_id: string }> = [];

			if (organisationEntity) {
				await upsertSingleTargetEdge(
					deps.entities,
					savedApp.id,
					organisationEntity.id,
					"applied_to",
					true,
					userId,
				);
				writtenEdges.push({ relationship_type: "applied_to", to_entity_id: organisationEntity.id });
			}

			if (jobSiteEntity) {
				await upsertSingleTargetEdge(
					deps.entities,
					savedApp.id,
					jobSiteEntity.id,
					"applied_via",
					true,
					userId,
				);
				writtenEdges.push({ relationship_type: "applied_via", to_entity_id: jobSiteEntity.id });
			}

			const areaId =
				prevalidatedAreaId ?? (await resolveDefaultAreaId(deps.entities, undefined, userId));
			if (areaId) {
				await upsertSingleTargetEdge(
					deps.entities,
					savedApp.id,
					areaId,
					"belongs_to",
					true,
					userId,
				);
				writtenEdges.push({ relationship_type: "belongs_to", to_entity_id: areaId });
			}

			const applicantId =
				prevalidatedApplicantId ?? (await resolveDefaultApplicantId(deps, undefined, userId));
			if (applicantId) {
				await upsertSingleTargetEdge(
					deps.entities,
					savedApp.id,
					applicantId,
					"applicant",
					true,
					userId,
				);
				writtenEdges.push({ relationship_type: "applicant", to_entity_id: applicantId });
			}

			if (input.cv_entity_id === null) {
				await archiveLiveEdgesOfType(
					deps.entities,
					savedApp.id,
					JOB_APPLICATION_CV_EDGE,
					userId,
				);
			} else if (cvEntityId) {
				await upsertSingleTargetEdge(
					deps.entities,
					savedApp.id,
					cvEntityId,
					JOB_APPLICATION_CV_EDGE,
					true,
					userId,
				);
				writtenEdges.push({ relationship_type: JOB_APPLICATION_CV_EDGE, to_entity_id: cvEntityId });
			}

			for (const recruiterId of input.recruiter_ids ?? []) {
				await upsertSingleTargetEdge(
					deps.entities,
					savedApp.id,
					recruiterId,
					"recruiter",
					false,
					userId,
				);
				writtenEdges.push({ relationship_type: "recruiter", to_entity_id: recruiterId });
			}

			for (const contactId of input.hiring_contact_ids ?? []) {
				await upsertSingleTargetEdge(
					deps.entities,
					savedApp.id,
					contactId,
					"hiring_contact",
					false,
					userId,
				);
				writtenEdges.push({ relationship_type: "hiring_contact", to_entity_id: contactId });
			}

			// 7. Provenance artifact link if supplied
			if (input.evidence_artifact_id) {
				if (deps.links?.upsert) {
					await deps.links.upsert(
						[
							{
								artifact_id: input.evidence_artifact_id,
								entity_id: savedApp.id,
								link_type: input.evidence_link_type ?? "related",
								created_by: "job_application_upsert",
							},
						],
						{ userId },
					);
				} else {
					await deps.entities.insertProvenanceLinks(
						[
							{
								user_id: userId ?? "",
								artifact_id: input.evidence_artifact_id,
								entity_id: savedApp.id,
								link_type: input.evidence_link_type ?? "related",
								confidence_score: null,
								created_by: "job_application_upsert",
								notes: null,
							},
						],
						userId,
					);
				}
			}

			// 8. Maintain single-open-task invariant
			const openTask = input.skip_task_sync
				? null
				: await syncApplicationTask(
						deps,
						{
							applicationId: savedApp.id,
							stage: nextStage,
							stageChanged,
							isCreate,
							asOfDate,
							nowIso,
							caller: ctx.caller,
							screeningCallHeld: input.screening_call_held,
							nextActionTitle: input.next_action_title,
							nextActionDueDate: input.next_action_due_date,
							evidenceArtifactId: input.evidence_artifact_id,
						},
						userId,
					);

			let resolvedOrganisationId: string | null = organisationEntity?.id ?? null;
			let resolvedOrganisationName: string | null = orgDisplayName;
			let resolvedJobSiteId: string | null = jobSiteEntity?.id ?? null;
			let resolvedJobSiteName: string | null = jobSiteEntity?.title ?? null;

			if (!isCreate && (!resolvedOrganisationId || !resolvedJobSiteId)) {
				const existingEdges = await loadOutgoingEdgesForEntities(deps, [savedApp.id], userId);
				if (!resolvedOrganisationId) {
					const appliedToEdge = existingEdges.find((e) => e.relationship_type === "applied_to");
					if (appliedToEdge) {
						resolvedOrganisationId = appliedToEdge.to_entity_id;
						const orgTitle = await deps.entities.getTitleById(appliedToEdge.to_entity_id, userId);
						if (orgTitle) resolvedOrganisationName = orgTitle;
					}
				}
				if (!resolvedJobSiteId) {
					const appliedViaEdge = existingEdges.find((e) => e.relationship_type === "applied_via");
					if (appliedViaEdge) {
						resolvedJobSiteId = appliedViaEdge.to_entity_id;
						resolvedJobSiteName =
							(await deps.entities.getTitleById(appliedViaEdge.to_entity_id, userId)) ?? null;
					}
				}
			}

			const result: JobApplicationUpsertResult = {
				status: isCreate ? "created" : "updated",
				application: {
					id: savedApp.id,
					title: finalTitle,
					stage: nextStage,
					entity_status: entityStatus,
					role_title: roleTitle,
					role_category: roleCategory,
					channel,
					ats,
					organisation_id: resolvedOrganisationId,
					organisation: resolvedOrganisationName,
					job_site_id: resolvedJobSiteId,
					job_site: resolvedJobSiteName,
					cv_entity_id: cvEntityId,
					applied_on: appliedOn,
					closed_on: closedOn,
					last_inbound_at: lastInboundAt,
					platform_ref: strOrNull(nextProperties.platform_ref),
					priority_level: validatedPriority,
					stage_history: stageHistory,
				},
				edges: writtenEdges,
				open_task: openTask
					? {
							id: openTask.id,
							title: openTask.title,
							status: openTask.status,
							due_date: openTask.due_date,
							priority_level: openTask.priority_level,
						}
					: null,
				message: `${isCreate ? "Created" : "Updated"} ${finalTitle} (${nextStage})`,
			};
			return result;
		},
		formatMcp: formatJobApplicationUpsertMcp,
	});
}
