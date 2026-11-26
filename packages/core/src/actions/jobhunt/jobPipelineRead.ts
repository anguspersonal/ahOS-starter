import {
	APPLICATION_CHANNEL_SLUGS,
	deriveLastActionAt,
	derivePipelineMetrics,
	evaluateApplicationCadence,
	isSilent,
	isSubmitted,
	isTerminalStage,
	isToReviewStage,
	JOB_APPLICATION_CV_EDGE,
	JOB_APPLICATION_ENTITY_KIND,
	reachedInterview,
	statusForStage,
	type ApplicationChannel,
	type JobApplicationRecord,
	type JobApplicationStage,
} from "../../domain/jobApplications.js";
import type { LinkedArtifactForEntityRow } from "../../ports/artifacts.js";
import type { UserTaskRow } from "../../ports/tasks.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import {
	jobPipelineReadSchema,
	type JobPipelineApplicationItem,
	type JobPipelineArtifactRef,
	type JobPipelineChannelSummary,
	type JobPipelineEntityRef,
	type JobPipelineOrganisationSummary,
	type JobPipelineReadInput,
	type JobPipelineReadResult,
	type JobPipelineRecruiterSummary,
	type JobPipelineTaskRef,
} from "../domain/jobhunt.js";
import {
	extractOrganisationFromApplicationTitle,
	loadEntitiesMapByIds,
	loadOutgoingEdgesForEntities,
	parseJobApplicationProperties,
	resolveJobHuntUserId,
	strOrNull,
	toJobApplicationRecord,
	toUtcDateOnly,
	type JobHuntDeps,
} from "./shared.js";

export const JOB_PIPELINE_READ_DESCRIPTION =
	"Read the job search pipeline (ADR-120): loads job application arrangement nodes, participant edges " +
	"(applied_to, applied_via, recruiter, hiring_contact, applicant, references CV), linked artifacts, and " +
	"linked user_tasks, then computes 14-day silence flags, 7/14/28/42-day cadence state, last_action_at, " +
	"and funnel metrics overall, by channel, and by role category.";

const CLOSED_TASK_STATUSES = new Set(["done", "cancelled"]);

function artifactTimestamp(row: LinkedArtifactForEntityRow): string | null {
	return (
		strOrNull(row.artifact.originated_at) ??
		strOrNull(row.artifact.captured_at) ??
		strOrNull(row.artifact.created_at)
	);
}

function isOutboundArtifact(row: LinkedArtifactForEntityRow): boolean {
	const meta = row.artifact.processing_metadata;
	if (meta && typeof meta === "object" && !Array.isArray(meta)) {
		const dir = (meta as Record<string, unknown>).direction;
		if (dir === "outbound" || dir === "sent") return true;
	}
	return row.artifact.source_channel === "gmail_sent" || row.link_type === "outbound_mail";
}

function isInboundArtifact(row: LinkedArtifactForEntityRow): boolean {
	if (row.link_type === "inbound_reply") return true;
	const meta = row.artifact.processing_metadata;
	if (meta && typeof meta === "object" && !Array.isArray(meta)) {
		const dir = (meta as Record<string, unknown>).direction;
		if (dir === "inbound") return true;
	}
	return false;
}

function isEmailArtifact(row: LinkedArtifactForEntityRow): boolean {
	if (isOutboundArtifact(row) || isInboundArtifact(row)) return true;
	return (
		row.artifact.source_channel === "gmail" ||
		row.artifact.file_type === "message/rfc822"
	);
}

function sortOpenTasks(tasks: readonly JobPipelineTaskRef[]): JobPipelineTaskRef[] {
	return [...tasks].sort((a, b) => {
		const da = a.due_date ?? "9999-12-31";
		const db = b.due_date ?? "9999-12-31";
		if (da !== db) return da < db ? -1 : 1;
		return (b.priority_level ?? 0) - (a.priority_level ?? 0);
	});
}

function matchesSearch(item: JobPipelineApplicationItem, needle: string): boolean {
	const haystacks = [
		item.title,
		item.organisation_name,
		item.role_title,
		item.platform_ref,
		item.notes,
		item.job_site?.title,
		...item.recruiters.map((r) => r.title),
		...item.hiring_contacts.map((c) => c.title),
	]
		.filter((v): v is string => typeof v === "string" && v.length > 0)
		.map((v) => v.toLowerCase());
	return haystacks.some((h) => h.includes(needle));
}

export function formatJobPipelineReadMcp(result: JobPipelineReadResult): string {
	const m = result.metrics;
	const pct = Math.round(m.interview_rate * 100);
	const lines: string[] = [
		`Job Pipeline (as of ${result.as_of}) — ${m.total} total | ${m.submitted} submitted | ${m.reached_interview} interview (${pct}%) | ${m.rejected} rejected | ${m.silent} silent (>=14d) | ${m.to_review} to review | ${m.drafting} drafting`,
	];

	if (result.needs_attention.length > 0) {
		lines.push(
			`Needs attention (${result.needs_attention.length}):`,
			...result.needs_attention.slice(0, 10).map((app) => {
				const flags: string[] = [];
				if (isToReviewStage(app.stage)) flags.push("to_review");
				if (app.silent) flags.push("silent");
				if (app.cadence.action !== "none") flags.push(app.cadence.action);
				return `• [${app.id}] ${app.title} — ${app.stage} (${flags.join(", ")})`;
			}),
		);
	}

	if (result.applications.length === 0) {
		lines.push("No applications match the requested filters.");
	} else {
		lines.push(
			`Applications (${result.filtered_count} shown of ${result.total_count}):`,
			...result.applications.slice(0, 30).map((app) => {
				const taskNote = app.open_task
					? ` · task: "${app.open_task.title}" (${app.open_task.due_date?.slice(0, 10) ?? "no due"})`
					: "";
				return `• [${app.id}] ${app.title} | ${app.stage} | ${app.channel} | ${app.role_category}${app.silent ? " | SILENT" : ""}${taskNote}`;
			}),
		);
		if (result.applications.length > 30) {
			lines.push(`…and ${result.applications.length - 30} more.`);
		}
	}

	return lines.join("\n");
}

export function createJobPipelineReadAction(
	deps: JobHuntDeps,
): ActionDefinition<typeof jobPipelineReadSchema, JobPipelineReadResult> {
	return defineAction({
		id: "job_pipeline_read",
		name: "job_pipeline_read",
		description: JOB_PIPELINE_READ_DESCRIPTION,
		domain: "kg",
		schema: jobPipelineReadSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		run: async (input: JobPipelineReadInput, ctx) => {
			const userId = resolveJobHuntUserId(deps, ctx.userId);
			const asOfDate = toUtcDateOnly(input.as_of);

			const { rows: rawApps } = await deps.entities.loadRows(
				{
					entity_type: "arrangement",
					properties_contains: { kind: JOB_APPLICATION_ENTITY_KIND },
					include_archived: input.include_archived ?? false,
					limit: 1000,
				},
				userId,
			);
			const appRows = rawApps.filter(
				(row) => row.properties?.kind === JOB_APPLICATION_ENTITY_KIND,
			);

			if (appRows.length === 0) {
				const emptyMetrics = derivePipelineMetrics([], asOfDate);
				return {
					as_of: asOfDate,
					total_count: 0,
					filtered_count: 0,
					metrics: emptyMetrics,
					applications: [],
					needs_attention: [],
					organisations: [],
					job_sites: [],
					recruiters: [],
				};
			}

			const appIds = appRows.map((r) => r.id);

			const [outEdges, linkedArtifacts, linkedTasks] = await Promise.all([
				loadOutgoingEdgesForEntities(deps, appIds, userId),
				deps.artifacts?.listLinkedArtifactsForEntities
					? deps.artifacts.listLinkedArtifactsForEntities(appIds, userId)
					: Promise.resolve([] as LinkedArtifactForEntityRow[]),
				deps.tasks
					? deps.tasks.query(
							{ entity_ids: appIds, limit: Math.max(500, appIds.length * 10) },
							userId,
						)
					: Promise.resolve([] as UserTaskRow[]),
			]);

			const targetNodeIds = new Set<string>();
			for (const edge of outEdges) {
				targetNodeIds.add(edge.to_entity_id);
			}
			for (const row of appRows) {
				const cvProp = strOrNull(row.properties?.cv_entity_id);
				if (cvProp) targetNodeIds.add(cvProp);
			}
			const nodesMap = await loadEntitiesMapByIds(deps, [...targetNodeIds], userId);

			const edgesByApp = new Map<string, typeof outEdges>();
			for (const edge of outEdges) {
				const list = edgesByApp.get(edge.from_entity_id) ?? [];
				list.push(edge);
				edgesByApp.set(edge.from_entity_id, list);
			}

			const artifactsByApp = new Map<string, LinkedArtifactForEntityRow[]>();
			for (const art of linkedArtifacts) {
				const list = artifactsByApp.get(art.entity_id) ?? [];
				list.push(art);
				artifactsByApp.set(art.entity_id, list);
			}

			const tasksByApp = new Map<string, UserTaskRow[]>();
			for (const task of linkedTasks) {
				if (!task.entity_id) continue;
				const list = tasksByApp.get(task.entity_id) ?? [];
				list.push(task);
				tasksByApp.set(task.entity_id, list);
			}

			const allItems: JobPipelineApplicationItem[] = [];
			const metricRecords: JobApplicationRecord[] = [];

			for (const row of appRows) {
				const props = parseJobApplicationProperties(row);
				const appEdges = edgesByApp.get(row.id) ?? [];
				const appArtifacts = artifactsByApp.get(row.id) ?? [];
				const appTasks = tasksByApp.get(row.id) ?? [];

				const toRef = (entityId: string): JobPipelineEntityRef => ({
					id: entityId,
					title: nodesMap.get(entityId)?.title ?? entityId,
				});

				const appliedToEdge = appEdges.find((e) => e.relationship_type === "applied_to");
				const appliedViaEdge = appEdges.find((e) => e.relationship_type === "applied_via");
				const applicantEdge = appEdges.find((e) => e.relationship_type === "applicant");
				const cvEdge = appEdges.find((e) => e.relationship_type === JOB_APPLICATION_CV_EDGE);
				const recruiterEdges = appEdges.filter((e) => e.relationship_type === "recruiter");
				const hiringContactEdges = appEdges.filter(
					(e) => e.relationship_type === "hiring_contact",
				);

				const organisation = appliedToEdge ? toRef(appliedToEdge.to_entity_id) : null;
				const organisationName =
					organisation?.title ?? extractOrganisationFromApplicationTitle(row.title);
				const jobSite = appliedViaEdge ? toRef(appliedViaEdge.to_entity_id) : null;
				const cvId = cvEdge?.to_entity_id ?? props.cv_entity_id ?? null;
				const cv = cvId ? toRef(cvId) : null;
				const recruiters = recruiterEdges.map((e) => toRef(e.to_entity_id));
				const hiringContacts = hiringContactEdges.map((e) => toRef(e.to_entity_id));

				const linkedEmailDates: string[] = [];
				const sentMailDates: string[] = [];
				const inboundDates: string[] = [];
				const artifactRefs: JobPipelineArtifactRef[] = [];

				for (const link of appArtifacts) {
					if (link.artifact.archived) continue;
					const ts = artifactTimestamp(link);
					if (ts) {
						if (isOutboundArtifact(link)) {
							sentMailDates.push(ts);
						} else if (isEmailArtifact(link)) {
							linkedEmailDates.push(ts);
							if (isInboundArtifact(link)) {
								inboundDates.push(ts);
							}
						}
					}
					artifactRefs.push({
						artifact_id: link.artifact_id,
						title: link.artifact.title,
						link_type: link.link_type,
						source_channel: link.artifact.source_channel,
						source_url: link.artifact.source_url,
						storage_url: link.artifact.storage_url,
						originated_at: link.artifact.originated_at,
						captured_at: link.artifact.captured_at,
						created_at: link.artifact.created_at,
					});
				}

				const propInbound = strOrNull(row.properties?.last_inbound_at);
				if (propInbound) inboundDates.push(propInbound);
				const lastInboundAt =
					inboundDates.length > 0
						? inboundDates.sort((a, b) => Date.parse(b) - Date.parse(a))[0]
						: null;

				const taskRefs: JobPipelineTaskRef[] = appTasks.map((t) => ({
					id: t.id,
					title: t.title,
					status: t.status,
					priority_level: t.priority_level ?? null,
					energy_mode: t.energy_mode ?? null,
					source: t.source ?? null,
					due_date: t.due_date ?? null,
					completed_at: t.completed_at ?? null,
				}));

				const openTasks = sortOpenTasks(
					taskRefs.filter((t) => !CLOSED_TASK_STATUSES.has(t.status)),
				);
				const completedTaskDates = taskRefs
					.filter((t) => t.status === "done")
					.map((t) => t.completed_at)
					.filter((d): d is string => Boolean(d));

				const record = toJobApplicationRecord(row, organisationName, lastInboundAt);
				metricRecords.push(record);

				const lastActionAt = deriveLastActionAt({
					linkedEmailDates,
					sentMailDates,
					stageHistory: props.stage_history,
					completedTaskDates,
				});
				const silent = isSilent(record, asOfDate);
				const cadence = evaluateApplicationCadence(record, asOfDate);
				const submitted = isSubmitted(record);
				const interviewReached = reachedInterview(record);

				allItems.push({
					id: row.id,
					title: row.title ?? `${organisationName ?? "Unknown"} · ${props.role_title}`,
					organisation,
					organisation_name: organisationName,
					job_site: jobSite,
					applicant_id: applicantEdge?.to_entity_id ?? null,
					recruiters,
					hiring_contacts: hiringContacts,
					cv,
					role_title: props.role_title,
					role_category: props.role_category,
					channel: props.channel,
					ats: props.ats ?? null,
					stage: props.stage,
					entity_status: statusForStage(props.stage),
					applied_on: props.applied_on ?? null,
					date_precision: props.date_precision ?? null,
					closed_on: props.closed_on ?? null,
					last_inbound_at: lastInboundAt,
					last_action_at: lastActionAt,
					platform_ref: props.platform_ref ?? null,
					salary_band: props.salary_band ?? null,
					salary_expectation_submitted: props.salary_expectation_submitted ?? null,
					priority_level: props.priority_level ?? null,
					source: props.source ?? null,
					notes: props.notes ?? null,
					stage_history: props.stage_history,
					submitted,
					reached_interview: interviewReached,
					silent,
					cadence,
					open_task: openTasks[0] ?? null,
					tasks: taskRefs,
					artifacts: artifactRefs,
				});
			}

			const metrics = derivePipelineMetrics(metricRecords, asOfDate);

			// Aggregated views for organisations, job_sites, recruiters
			const orgMap = new Map<string, JobPipelineOrganisationSummary>();
			const siteByChannel = new Map<ApplicationChannel, JobPipelineEntityRef | null>();
			const recruiterMap = new Map<string, JobPipelineRecruiterSummary>();

			for (const item of allItems) {
				const orgKey = item.organisation?.id ?? `name:${(item.organisation_name ?? "Unknown").toLowerCase()}`;
				const orgEntry =
					orgMap.get(orgKey) ??
					{
						id: item.organisation?.id ?? null,
						title: item.organisation_name ?? "Unknown",
						application_count: 0,
						submitted_count: 0,
						stages: {} as Partial<Record<JobApplicationStage, number>>,
					};
				orgEntry.application_count += 1;
				if (item.submitted) orgEntry.submitted_count += 1;
				orgEntry.stages[item.stage] = (orgEntry.stages[item.stage] ?? 0) + 1;
				orgMap.set(orgKey, orgEntry);

				if (item.job_site && !siteByChannel.has(item.channel)) {
					siteByChannel.set(item.channel, item.job_site);
				}

				for (const r of item.recruiters) {
					const key = `recruiter:${r.id}`;
					const existing =
						recruiterMap.get(key) ??
						{
							id: r.id,
							title: r.title,
							role: "recruiter" as const,
							application_ids: [],
							application_count: 0,
						};
					existing.application_ids.push(item.id);
					existing.application_count += 1;
					recruiterMap.set(key, existing);
				}
				for (const c of item.hiring_contacts) {
					const key = `hiring_contact:${c.id}`;
					const existing =
						recruiterMap.get(key) ??
						{
							id: c.id,
							title: c.title,
							role: "hiring_contact" as const,
							application_ids: [],
							application_count: 0,
						};
					existing.application_ids.push(item.id);
					existing.application_count += 1;
					recruiterMap.set(key, existing);
				}
			}

			const jobSites: JobPipelineChannelSummary[] = APPLICATION_CHANNEL_SLUGS
				.filter((ch) => Boolean(metrics.by_channel[ch]))
				.map((ch) => ({
					channel: ch,
					job_site: siteByChannel.get(ch) ?? null,
					...metrics.by_channel[ch]!,
				}));

			const needsAttention = allItems.filter(
				(item) =>
					isToReviewStage(item.stage) ||
					item.silent ||
					item.cadence.action !== "none",
			);

			const includeClosed = input.include_closed ?? true;
			const stageGroup = input.stage_group ?? "all";
			const searchNeedle = input.search?.trim().toLowerCase() ?? "";

			const filtered = allItems.filter((item) => {
				if (!includeClosed && isTerminalStage(item.stage)) return false;
				if (input.stage && item.stage !== input.stage) return false;
				if (input.category && item.role_category !== input.category) return false;
				if (input.channel && item.channel !== input.channel) return false;
				if (stageGroup === "to_review" && !isToReviewStage(item.stage)) return false;
				if (stageGroup === "drafting" && item.stage !== "drafting") return false;
				if (stageGroup === "active" && isTerminalStage(item.stage)) return false;
				if (stageGroup === "submitted" && !item.submitted) return false;
				if (stageGroup === "silent" && !item.silent) return false;
				if (stageGroup === "terminal" && !isTerminalStage(item.stage)) return false;
				if (searchNeedle && !matchesSearch(item, searchNeedle)) return false;
				return true;
			});

			return {
				as_of: asOfDate,
				total_count: allItems.length,
				filtered_count: filtered.length,
				metrics,
				applications: filtered,
				needs_attention: needsAttention,
				organisations: Array.from(orgMap.values()).sort((a, b) =>
					a.title.localeCompare(b.title),
				),
				job_sites: jobSites,
				recruiters: Array.from(recruiterMap.values()).sort((a, b) =>
					a.title.localeCompare(b.title),
				),
			};
		},
		formatMcp: formatJobPipelineReadMcp,
	});
}
