import {
	classifyJobEmail,
	extractEmailAddress,
	JOB_APPLICATION_GMAIL_LABEL,
	parseEmailAddressList,
	resolveThreadConflicts,
	type JobEmailApplicationUpdate,
	type JobEmailHiringContact,
	type JobEmailInput,
} from "../../domain/jobApplicationEmail.js";
import {
	isForbiddenDexJobsAlias,
	JOB_APPLICATION_ENTITY_KIND,
	normaliseRoleTitle,
	type JobApplicationProperties,
} from "../../domain/jobApplications.js";
import { priorityLevelToTaskPriority, type PriorityLevel } from "../../domain/priorityScale.js";
import type { CapturePort } from "../../ports/artifacts.js";
import type { ConfigPreferencesRepository } from "../../ports/config.js";
import {
	jobApplicationWatermarkKey,
	type DecisionRepository,
	type JobApplicationWatermarkRecord,
} from "../../ports/decisions.js";
import type { EntityRow } from "../../ports/entities.js";
import type { GmailPort, ParsedMessage } from "../../ports/gmail.js";
import { executeAction } from "../adapters/direct.js";
import { defineAction } from "../defineAction.js";
import {
	getActionApprovalStore,
	isPendingApproval,
	REVIEW_BAND_AUTO_APPLY_THRESHOLD,
	type ActionApprovalStore,
} from "../gate.js";
import { inputSha256 } from "../inputHash.js";
import type { ActionDefinition } from "../types.js";
import {
	jobHuntGmailIngestSchema,
	type JobApplicationUpsertInput,
	type JobHuntGmailIngestInput,
	type JobHuntGmailIngestItemSummary,
	type JobHuntGmailIngestResult,
} from "../domain/jobhunt.js";
import { createJobApplicationUpsertAction } from "./jobApplicationUpsert.js";
import {
	extractOrganisationFromApplicationTitle,
	loadEntitiesMapByIds,
	loadOutgoingEdgesForEntities,
	parseJobApplicationProperties,
	resolveJobHuntUserId,
	strOrNull,
	toUtcDateOnly,
	toUtcIsoTimestamp,
	type JobHuntDeps,
} from "./shared.js";

export const JOB_HUNT_GMAIL_INGEST_DESCRIPTION =
	"Ingest personal-mailbox ('angus') job application emails (ADR-120 Phase 2): " +
	"classifies confirmations, rejections, screening invites, digests, task-only alerts, " +
	"and evidence replies; matches existing applications (platform_ref -> thread_id -> org+role); " +
	"watermarks per message_id in system_decisions; and gates updates via shadow / label / act modes.";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Optional LLM fallback extractor port slot (implemented in Packet 5).
 */
export interface JobEmailExtractorPort {
	extract(email: JobEmailInput): Promise<JobEmailApplicationUpdate[]>;
}

export interface JobHuntGmailIngestDeps extends JobHuntDeps {
	gmail?: GmailPort;
	ownerAddresses?:
		| readonly string[]
		| (() => readonly string[] | ReadonlySet<string> | Promise<readonly string[] | ReadonlySet<string>>);
	decisions?: DecisionRepository;
	config?: ConfigPreferencesRepository;
	capture?: CapturePort;
	approvalStore?: ActionApprovalStore;
	extractor?: JobEmailExtractorPort;
}

interface IndexedApplication {
	id: string;
	title: string;
	props: JobApplicationProperties;
	organisationId: string | null;
	organisationTitle: string | null;
	organisationAliases: string[];
	threadIds: Set<string>;
	lastInboundAt: string | null;
}

type MatchOutcome =
	| {
			step: "platform_ref" | "thread_id" | "org_role" | "contact_email";
			app: IndexedApplication;
	  }
	| {
			step: "ambiguous";
			candidates: IndexedApplication[];
			candidateIds: string[];
			reason: string;
	  }
	| { step: "none" };

/**
 * Resolve the normalised `[0, 1]` auto-apply threshold for `job_application`
 * from `user_preferences.confidence_thresholds`, or `null` when disabled/unset.
 */
export function resolveJobApplicationAutoApplyThreshold(
	confidenceThresholds: unknown,
): number | null {
	if (!confidenceThresholds || typeof confidenceThresholds !== "object" || Array.isArray(confidenceThresholds)) {
		return null;
	}
	const jobApp = (confidenceThresholds as Record<string, unknown>).job_application;
	if (!jobApp || typeof jobApp !== "object" || Array.isArray(jobApp)) {
		return null;
	}
	const raw = (jobApp as Record<string, unknown>).auto_apply;
	if (typeof raw === "boolean") {
		return raw ? REVIEW_BAND_AUTO_APPLY_THRESHOLD : null;
	}
	if (typeof raw === "number" && Number.isFinite(raw)) {
		if (raw <= 0) return null;
		return raw > 1 ? Math.min(1, raw / 100) : raw;
	}
	return null;
}

function normalizeName(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function isUuid(value: string | null | undefined): value is string {
	return typeof value === "string" && UUID_RE.test(value);
}

function parseMetaRecord(meta: unknown): Record<string, unknown> | null {
	if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
	return meta as Record<string, unknown>;
}

function extractGmailIdsFromArtifact(artifact: {
	source?: string | null;
	source_url?: string | null;
	processing_metadata?: unknown;
}): { messageId: string | null; threadId: string | null } {
	const meta = parseMetaRecord(artifact.processing_metadata);
	let messageId =
		strOrNull(meta?.gmail_message_id) ??
		strOrNull(meta?.message_id) ??
		null;
	let threadId =
		strOrNull(meta?.gmail_thread_id) ??
		strOrNull(meta?.thread_id) ??
		null;

	if (!messageId && artifact.source) {
		const m = /^gmail:(?:msg:)?([A-Za-z0-9_-]+)$/.exec(artifact.source.trim());
		if (m) messageId = m[1];
	}
	if (!threadId && artifact.source_url) {
		const m = /mail\.google\.com\/mail\/[^#]*#[^/]+\/([A-Za-z0-9_-]+)$/.exec(
			artifact.source_url.trim(),
		);
		if (m) threadId = m[1];
	}
	return { messageId, threadId };
}

function extractEmailAddressesFromPerson(entity: { properties?: unknown }): string[] {
	const props = (entity.properties ?? {}) as Record<string, unknown>;
	const out: string[] = [];
	if (typeof props.email === "string" && props.email.trim()) {
		const addr = extractEmailAddress(props.email);
		if (addr.includes("@")) out.push(addr);
	}
	if (Array.isArray(props.emails)) {
		for (const item of props.emails) {
			if (typeof item === "string" && item.trim()) {
				const addr = extractEmailAddress(item);
				if (addr.includes("@")) out.push(addr);
			}
		}
	}
	return out;
}

function formatHiringContact(contact: JobEmailHiringContact): string {
	if (contact.name && contact.email) return `${contact.name} <${contact.email}>`;
	return contact.name ?? contact.email ?? "";
}

function parsedMessageToJobEmail(msg: ParsedMessage, isSent: boolean): JobEmailInput {
	const receivedAt = msg.date || undefined;
	return {
		message_id: msg.id,
		thread_id: msg.threadId,
		from: msg.from,
		to: parseEmailAddressList(msg.to),
		cc: parseEmailAddressList(msg.cc),
		subject: msg.subject,
		body: msg.body || msg.snippet,
		snippet: msg.snippet,
		received_at: receivedAt,
		is_sent: isSent || Boolean(msg.labelIds?.includes("SENT")),
		label_ids: msg.labelIds,
	};
}

function orgMatchesNameOrAlias(
	app: IndexedApplication,
	targetOrg: string,
): boolean {
	const needle = normalizeName(targetOrg);
	if (!needle) return false;
	if (normalizeName(app.organisationTitle) === needle) return true;
	const isDexJobs =
		normalizeName(app.organisationTitle) === "dex jobs" ||
		app.organisationAliases.some((a) => {
			const norm = normalizeName(a);
			return norm === "dex jobs" || norm === "meetdex.ai";
		});
	return app.organisationAliases.some((alias) => {
		if (isDexJobs && isForbiddenDexJobsAlias(alias)) return false;
		return normalizeName(alias) === needle;
	});
}

async function loadOrganisationsWithAliases(
	deps: Pick<JobHuntDeps, "entities" | "graphRead">,
	ids: readonly string[],
	userId?: string,
): Promise<Map<string, Pick<EntityRow, "id" | "title" | "aliases" | "properties">>> {
	const uniqueIds = [...new Set(ids.filter(Boolean))];
	const map = new Map<string, Pick<EntityRow, "id" | "title" | "aliases" | "properties">>();
	if (uniqueIds.length === 0) return map;

	for (let i = 0; i < uniqueIds.length; i += 100) {
		const batch = uniqueIds.slice(i, i + 100);
		const { rows } = await deps.entities.loadRows(
			{ ids: batch, include_archived: true, limit: batch.length },
			userId,
		);
		for (const row of rows) {
			if (batch.includes(row.id)) {
				map.set(row.id, row);
			}
		}
	}

	const missingIds = uniqueIds.filter((id) => !map.has(id));
	if (missingIds.length > 0) {
		const fallback = await loadEntitiesMapByIds(deps, missingIds, userId);
		for (const [id, node] of fallback.entries()) {
			const rawAliases = (node as { aliases?: unknown }).aliases;
			map.set(id, {
				id: node.id,
				title: node.title,
				aliases: Array.isArray(rawAliases)
					? rawAliases.filter((a): a is string => typeof a === "string")
					: [],
				properties: node.properties ?? null,
			});
		}
	}

	return map;
}

function matchApplication(
	apps: readonly IndexedApplication[],
	opts: {
		platformRef?: string | null;
		threadId?: string | null;
		organisation?: string | null;
		roleTitle?: string | null;
		contactEmails?: readonly string[];
		appIdsByContactEmail?: ReadonlyMap<string, ReadonlySet<string>>;
	},
): MatchOutcome {
	// 1. platform_ref
	const ref = normalizeName(opts.platformRef);
	if (ref) {
		const byRef = apps.filter((a) => normalizeName(a.props.platform_ref) === ref);
		if (byRef.length === 1) return { step: "platform_ref", app: byRef[0] };
		if (byRef.length > 1) {
			return {
				step: "ambiguous",
				candidates: byRef,
				candidateIds: byRef.map((a) => a.id),
				reason: `multiple applications match platform_ref "${opts.platformRef}"`,
			};
		}
	}

	// 2. single application linked to same Gmail thread_id
	const tid = opts.threadId?.trim();
	if (tid) {
		const byThread = apps.filter((a) => a.threadIds.has(tid));
		if (byThread.length === 1) return { step: "thread_id", app: byThread[0] };
		if (byThread.length > 1) {
			return {
				step: "ambiguous",
				candidates: byThread,
				candidateIds: byThread.map((a) => a.id),
				reason: `multiple applications share Gmail thread "${tid}"`,
			};
		}
	}

	// 3. (organisation, normalised role_title)
	const org = opts.organisation?.trim();
	if (org) {
		const byOrg = apps.filter((a) => orgMatchesNameOrAlias(a, org));
		const normRole = normaliseRoleTitle(opts.roleTitle ?? "");
		if (normRole) {
			const byOrgRole = byOrg.filter(
				(a) => normaliseRoleTitle(a.props.role_title) === normRole,
			);
			if (byOrgRole.length === 1) return { step: "org_role", app: byOrgRole[0] };
			if (byOrgRole.length > 1) {
				return {
					step: "ambiguous",
					candidates: byOrgRole,
					candidateIds: byOrgRole.map((a) => a.id),
					reason: `multiple applications match "${org}" and role "${opts.roleTitle}"`,
				};
			}
		} else {
			if (byOrg.length === 1) return { step: "org_role", app: byOrg[0] };
			if (byOrg.length > 1) {
				return {
					step: "ambiguous",
					candidates: byOrg,
					candidateIds: byOrg.map((a) => a.id),
					reason: `multiple applications exist for organisation "${org}" without role_title`,
				};
			}
		}
	}

	// 4. linked recruiter / hiring_contact email -> application mapping (for new-thread replies)
	if (opts.contactEmails?.length && opts.appIdsByContactEmail) {
		const matchedIds = new Set<string>();
		for (const rawEmail of opts.contactEmails) {
			const addr = extractEmailAddress(rawEmail);
			const ids = opts.appIdsByContactEmail.get(addr);
			if (ids) {
				for (const id of ids) matchedIds.add(id);
			}
		}
		if (matchedIds.size > 0) {
			const byContact = apps.filter((a) => matchedIds.has(a.id));
			if (byContact.length === 1) return { step: "contact_email", app: byContact[0] };
			if (byContact.length > 1) {
				return {
					step: "ambiguous",
					candidates: byContact,
					candidateIds: byContact.map((a) => a.id),
					reason: "linked contact email belongs to multiple applications",
				};
			}
		}
	}

	return { step: "none" };
}

/**
 * Create the `job_hunt_gmail_ingest` CAR action (ADR-120 Phase 2, #2452) for
 * deterministic personal-mailbox (`angus`) job email ingestion, watermarking,
 * provenance linking, and `dry_run` / `shadow` / `label` / `act` gating.
 */
export function createJobHuntGmailIngestAction(
	deps: JobHuntGmailIngestDeps,
): ActionDefinition<typeof jobHuntGmailIngestSchema, JobHuntGmailIngestResult> {
	const upsertAction = createJobApplicationUpsertAction(deps);

	return defineAction({
		id: "job_hunt_gmail_ingest",
		domain: "kg",
		description: JOB_HUNT_GMAIL_INGEST_DESCRIPTION,
		schema: jobHuntGmailIngestSchema,
		run: async (input: JobHuntGmailIngestInput, ctx) => {
			if (input.domain !== "angus") {
				throw new Error(
					`job_hunt_gmail_ingest is scoped strictly to the personal 'angus' mailbox; '${input.domain}' is forbidden (ADR-120 §4).`,
				);
			}
			if (!deps.gmail) {
				throw new Error("GmailPort is required for job_hunt_gmail_ingest.");
			}

			const userId = resolveJobHuntUserId(deps, ctx.userId);
			const asOfIso = toUtcIsoTimestamp(input.as_of ?? new Date().toISOString());
			const rawOwnerAddresses =
				typeof deps.ownerAddresses === "function"
					? await deps.ownerAddresses()
					: (deps.ownerAddresses ?? []);
			const ownerAddresses = Array.from(rawOwnerAddresses);

			const mainQuery = input.query?.trim() || "newer_than:7d";
			const sentQuery = input.query?.trim()
				? `in:sent (${input.query.trim()})`
				: "in:sent newer_than:7d";

			const [inboundMsgs, sentMsgs] = await Promise.all([
				deps.gmail.searchMessages({
					domain: "angus",
					query: mainQuery,
					maxResults: input.max_messages,
				}),
				deps.gmail.searchMessages({
					domain: "angus",
					query: sentQuery,
					maxResults: input.max_messages,
				}),
			]);

			const emailMap = new Map<string, JobEmailInput>();
			for (const msg of inboundMsgs) {
				emailMap.set(msg.id, parsedMessageToJobEmail(msg, false));
			}
			for (const msg of sentMsgs) {
				if (!emailMap.has(msg.id)) {
					emailMap.set(msg.id, parsedMessageToJobEmail(msg, true));
				} else {
					const existing = emailMap.get(msg.id)!;
					emailMap.set(msg.id, { ...existing, is_sent: true });
				}
			}

			const emails = [...emailMap.values()];
			const result: JobHuntGmailIngestResult = {
				domain: "angus",
				mode: input.mode,
				dry_run: input.dry_run,
				scanned_messages: emails.length,
				skipped_watermarked: 0,
				skipped_seeded_provenance: 0,
				ignored_non_job: 0,
				classified_updates: 0,
				classified_tasks: 0,
				classified_evidence: 0,
				shadow_logged: 0,
				parked_approvals: 0,
				auto_applied: 0,
				tasks_created: 0,
				evidence_linked: 0,
				labels_added: 0,
				needs_review_count: 0,
				errors: [],
				items: [],
			};

			if (emails.length === 0) {
				return result;
			}

			// Load existing job applications using GIN properties_contains filter
			const { rows: arrangementRows } = await deps.entities.loadRows(
				{
					entity_type: "arrangement",
					properties_contains: { kind: JOB_APPLICATION_ENTITY_KIND },
					include_archived: false,
					limit: 1000,
				},
				userId,
			);
			const appRows = arrangementRows.filter(
				(r) =>
					(r.properties as Record<string, unknown> | null)?.kind ===
					JOB_APPLICATION_ENTITY_KIND,
			);
			const appIds = appRows.map((r) => r.id);

			const outgoingEdges = await loadOutgoingEdgesForEntities(deps, appIds, userId);
			const orgIds = new Set<string>();
			const contactIds = new Set<string>();
			for (const edge of outgoingEdges) {
				if (edge.relationship_type === "applied_to") orgIds.add(edge.to_entity_id);
				if (
					edge.relationship_type === "recruiter" ||
					edge.relationship_type === "hiring_contact"
				) {
					contactIds.add(edge.to_entity_id);
				}
			}

			// Load organisation entities via entities.loadRows so `aliases` are preserved in production
			const orgMap = await loadOrganisationsWithAliases(deps, [...orgIds], userId);
			const contactMap = await loadEntitiesMapByIds(deps, [...contactIds], userId);

			const linkedContactEmails = new Set<string>();
			const appIdsByContactEmail = new Map<string, Set<string>>();
			const contactIdsByEmail = new Map<string, Set<string>>();
			for (const edge of outgoingEdges) {
				if (
					edge.relationship_type !== "recruiter" &&
					edge.relationship_type !== "hiring_contact"
				) {
					continue;
				}
				const person = contactMap.get(edge.to_entity_id);
				if (!person) continue;
				for (const addr of extractEmailAddressesFromPerson(person)) {
					linkedContactEmails.add(addr);
					const appSet = appIdsByContactEmail.get(addr) ?? new Set<string>();
					appSet.add(edge.from_entity_id);
					appIdsByContactEmail.set(addr, appSet);
					const personSet = contactIdsByEmail.get(addr) ?? new Set<string>();
					personSet.add(person.id);
					contactIdsByEmail.set(addr, personSet);
				}
			}

			const seededMessageIds = new Set<string>();
			const threadIdsByApp = new Map<string, Set<string>>();
			const linkedThreadIds = new Set<string>();

			if (appIds.length > 0 && typeof deps.artifacts?.listLinkedArtifactsForEntities === "function") {
				const linkedArtifacts = await deps.artifacts.listLinkedArtifactsForEntities(
					appIds,
					userId,
				);
				for (const link of linkedArtifacts) {
					const { messageId, threadId } = extractGmailIdsFromArtifact(link.artifact);
					if (messageId) seededMessageIds.add(messageId);
					if (threadId) {
						linkedThreadIds.add(threadId);
						const set = threadIdsByApp.get(link.entity_id) ?? new Set<string>();
						set.add(threadId);
						threadIdsByApp.set(link.entity_id, set);
					}
				}
			}

			const indexedApps: IndexedApplication[] = appRows.map((row) => {
				const appliedToEdge = outgoingEdges.find(
					(e) => e.from_entity_id === row.id && e.relationship_type === "applied_to",
				);
				const orgEntity = appliedToEdge ? orgMap.get(appliedToEdge.to_entity_id) : undefined;
				const rawAliases = orgEntity?.aliases;
				return {
					id: row.id,
					title: row.title ?? "",
					props: parseJobApplicationProperties(row),
					organisationId: orgEntity?.id ?? null,
					organisationTitle:
						orgEntity?.title ?? extractOrganisationFromApplicationTitle(row.title) ?? null,
					organisationAliases: Array.isArray(rawAliases)
						? rawAliases.filter((a): a is string => typeof a === "string")
						: [],
					threadIds: threadIdsByApp.get(row.id) ?? new Set<string>(),
					lastInboundAt: strOrNull(
						(row.properties as Record<string, unknown> | null)?.last_inbound_at,
					),
				};
			});

			const nonSeededEmails: JobEmailInput[] = [];
			for (const email of emails) {
				if (seededMessageIds.has(email.message_id)) {
					result.skipped_seeded_provenance += 1;
				} else {
					nonSeededEmails.push(email);
				}
			}

			const watermarks =
				typeof deps.decisions?.listJobApplicationWatermarks === "function"
					? await deps.decisions.listJobApplicationWatermarks(
							nonSeededEmails.map((e) => e.message_id),
							userId,
						)
					: new Set<string>();

			const classifiedBatch = resolveThreadConflicts(
				nonSeededEmails.map((email) => ({
					email,
					result: classifyJobEmail(email, {
						owner_addresses: ownerAddresses,
						linked_contact_emails: [...linkedContactEmails],
						linked_thread_ids: [...linkedThreadIds],
					}),
				})),
			);

			let autoApplyThreshold: number | null = null;
			if (
				input.mode === "act" &&
				!input.dry_run &&
				typeof deps.config?.loadPreferencesRow === "function"
			) {
				try {
					const prefs = await deps.config.loadPreferencesRow();
					autoApplyThreshold = resolveJobApplicationAutoApplyThreshold(
						prefs?.confidence_thresholds,
					);
				} catch (err) {
					result.errors.push(
						`Failed to load user_preferences.confidence_thresholds: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
			const effectiveAutoApplyThreshold =
				autoApplyThreshold !== null
					? Math.max(autoApplyThreshold, REVIEW_BAND_AUTO_APPLY_THRESHOLD)
					: null;

			let jobHuntLabelId: string | null = null;
			const ensureJobHuntLabel = async (): Promise<string | null> => {
				if (jobHuntLabelId) return jobHuntLabelId;
				const ensured = await deps.gmail!.ensureLabel({
					domain: "angus",
					name: JOB_APPLICATION_GMAIL_LABEL,
				});
				jobHuntLabelId = ensured.label.id;
				return jobHuntLabelId;
			};

			const shadowWatermarks: JobApplicationWatermarkRecord[] = [];
			const approvalStore = deps.approvalStore ?? getActionApprovalStore();

			const persistWatermark = async (record: JobApplicationWatermarkRecord): Promise<void> => {
				if (input.dry_run) return;
				if (record.mode === "shadow") {
					shadowWatermarks.push(record);
					return;
				}
				if (typeof deps.decisions?.recordJobApplicationWatermarks === "function") {
					await deps.decisions.recordJobApplicationWatermarks([record], userId);
				}
				watermarks.add(jobApplicationWatermarkKey(record.message_id, record.item_key));
			};

			const linkArtifactToEntity = async (
				artifactId: string,
				entityId: string,
				linkType: string,
			): Promise<void> => {
				if (deps.links?.upsert) {
					await deps.links.upsert(
						[
							{
								artifact_id: artifactId,
								entity_id: entityId,
								link_type: linkType,
							},
						],
						{ userId },
					);
				} else if (typeof deps.entities.insertProvenanceLinks === "function") {
					await deps.entities.insertProvenanceLinks(
						[
							{
								user_id: userId ?? "",
								artifact_id: artifactId,
								entity_id: entityId,
								link_type: linkType,
								confidence_score: null,
								created_by: "job_hunt_gmail_ingest",
								notes: null,
							},
						],
						userId,
					);
				}
			};

			const resolveExistingHiringContactId = async (
				contact: JobEmailHiringContact | null | undefined,
			): Promise<string | null> => {
				if (!contact?.email) return null;
				const targetEmail = extractEmailAddress(contact.email);
				if (!targetEmail.includes("@")) return null;

				const cachedIds = contactIdsByEmail.get(targetEmail);
				if (cachedIds && cachedIds.size === 1) {
					const [onlyId] = cachedIds;
					return isUuid(onlyId) ? onlyId : null;
				}

				try {
					const { rows } = await deps.entities.loadRows(
						{
							entity_type: "people",
							query: targetEmail,
							include_archived: false,
							limit: 20,
						},
						userId,
					);
					const exact = rows.filter(
						(r) =>
							r.entity_type === "people" &&
							extractEmailAddressesFromPerson(r).includes(targetEmail),
					);
					if (exact.length === 1 && isUuid(exact[0].id)) {
						return exact[0].id;
					}
				} catch {
					// Best-effort lookup; hiring_contact is still preserved in stage_note / metadata
				}
				return null;
			};

			try {
				for (const entry of classifiedBatch) {
					const { email, result: classified } = entry;
					if (classified.kind === "ignore") {
						result.ignored_non_job += 1;
						continue;
					}

					const shouldAddLabel =
						!input.dry_run && (input.mode === "label" || input.mode === "act");
					let labelAppliedForMessage = false;
					const applyLabelIfNeeded = async () => {
						if (!shouldAddLabel || labelAppliedForMessage) return;
						const labelId = await ensureJobHuntLabel();
						if (labelId && !(email.label_ids ?? []).includes(labelId)) {
							await deps.gmail!.modifyLabels({
								domain: "angus",
								target: { kind: "message", id: email.message_id },
								addLabelIds: [labelId],
							});
							result.labels_added += 1;
						}
						labelAppliedForMessage = true;
					};

					let cachedMessageArtifactId: string | null | undefined;
					const captureEmailArtifact = async (meta: {
						direction: "inbound" | "outbound" | "automated";
						subtype: string;
						rule_id?: string;
						hiring_contact?: JobEmailHiringContact | null;
					}): Promise<string | null> => {
						if (cachedMessageArtifactId !== undefined) return cachedMessageArtifactId;
						if (!deps.capture) {
							cachedMessageArtifactId = null;
							return null;
						}
						const title = (email.subject || "").trim() || `Gmail ${email.message_id}`;
						const text =
							(email.body || "").trim() ||
							(email.snippet || "").trim() ||
							title;
						const captured = await deps.capture.capture(
							{
								title,
								text,
								surface: meta.direction === "outbound" ? "gmail_sent" : "gmail",
								tags: ["job-application", "email-evidence"],
								dedup_key: `gmail:msg:${email.message_id}`,
								processing_metadata: {
									gmail_message_id: email.message_id,
									gmail_thread_id: email.thread_id,
									direction: meta.direction,
									subtype: meta.subtype,
									received_at: email.received_at ?? asOfIso,
									...(meta.rule_id ? { rule_id: meta.rule_id } : {}),
									...(meta.hiring_contact ? { hiring_contact: meta.hiring_contact } : {}),
								},
							},
							userId,
						);
						cachedMessageArtifactId = captured.id;
						return captured.id;
					};

					if (classified.kind === "application_updates") {
						for (const update of classified.updates) {
							const wmKey = jobApplicationWatermarkKey(email.message_id, update.item_key);
							if (watermarks.has(wmKey)) {
								result.skipped_watermarked += 1;
								continue;
							}
							result.classified_updates += 1;
							const match = matchApplication(indexedApps, {
								platformRef: update.platform_ref,
								threadId: email.thread_id,
								organisation: update.organisation,
								roleTitle: update.role_title,
							});
							const matchedApp =
								match.step !== "ambiguous" && match.step !== "none" ? match.app : null;
							const matchedId = matchedApp?.id ?? null;
							const missingRoleForNewApp =
								match.step === "none" && !update.role_title.trim();
							const effectiveNeedsReview =
								update.needs_review || match.step === "ambiguous" || missingRoleForNewApp;
							const candidateSummaries =
								match.step === "ambiguous"
									? match.candidates.map((c) => ({ id: c.id, title: c.title }))
									: undefined;

							if (input.dry_run) {
								if (effectiveNeedsReview) {
									result.needs_review_count += 1;
								}
								result.items.push({
									message_id: email.message_id,
									thread_id: email.thread_id,
									item_key: update.item_key,
									kind: "application_update",
									rule_id: update.rule_id,
									outcome: "dry_run",
									organisation: update.organisation,
									role_title: update.role_title,
									stage: update.stage,
									matched_application_id: matchedId,
									match_step: match.step,
									candidate_ids:
										match.step === "ambiguous" ? match.candidateIds : undefined,
									...(update.hiring_contact ? { hiring_contact: update.hiring_contact } : {}),
								});
								continue;
							}

							if (input.mode === "shadow") {
								result.shadow_logged += 1;
								if (effectiveNeedsReview) {
									result.needs_review_count += 1;
								}
								await persistWatermark({
									message_id: email.message_id,
									item_key: update.item_key,
									mode: "shadow",
									outcome: "shadow_logged",
									thread_id: email.thread_id,
									application_id: matchedId,
									organisation: update.organisation,
									role_title: update.role_title,
									stage: update.stage,
									confidence: update.confidence,
									title: `${update.organisation} · ${update.role_title || "(role)"} (${update.stage})`,
									candidate_ids:
										match.step === "ambiguous" ? match.candidateIds : undefined,
									candidates: candidateSummaries,
									hiring_contact: update.hiring_contact ?? null,
								});
								result.items.push({
									message_id: email.message_id,
									thread_id: email.thread_id,
									item_key: update.item_key,
									kind: "application_update",
									rule_id: update.rule_id,
									outcome: "shadow_logged",
									organisation: update.organisation,
									role_title: update.role_title,
									stage: update.stage,
									matched_application_id: matchedId,
									match_step: match.step,
									candidate_ids:
										match.step === "ambiguous" ? match.candidateIds : undefined,
									...(update.hiring_contact ? { hiring_contact: update.hiring_contact } : {}),
								});
								continue;
							}

							try {
								await applyLabelIfNeeded();

								const artifactId = await captureEmailArtifact({
									direction: "automated",
									subtype: "application_update",
									rule_id: update.rule_id,
									hiring_contact: update.hiring_contact ?? null,
								});
								const hiringContactId = await resolveExistingHiringContactId(
									update.hiring_contact,
								);

								const stageNoteParts: string[] = [];
								if (update.stage_note) stageNoteParts.push(update.stage_note);
								if (missingRoleForNewApp) {
									stageNoteParts.push(
										"Role title could not be extracted from email; review and supply explicit id or role_title before creating.",
									);
								}
								if (match.step === "ambiguous") {
									const list = match.candidates
										.map((c) => `[${c.id}] ${c.title} (stage=${c.props.stage})`)
										.join("; ");
									stageNoteParts.push(
										`Ambiguous match (${match.reason}) — candidates: ${list}. Reject and call job_application_upsert with explicit id to apply.`,
									);
								}
								if (
									update.hiring_contact &&
									(update.hiring_contact.name || update.hiring_contact.email)
								) {
									stageNoteParts.push(
										`Hiring contact: ${formatHiringContact(update.hiring_contact)}`,
									);
								}

								const trimmedRole = update.role_title.trim();
								const upsertInput: JobApplicationUpsertInput = {
									...(matchedId
										? { id: matchedId }
										: {
												organisation: update.organisation,
												...(trimmedRole ? { role_title: trimmedRole } : {}),
												...(match.step === "ambiguous"
													? {
															disambiguation_candidates: match.candidates.map((c) => ({
																id: c.id,
																title: c.title,
																stage: c.props.stage,
																match_reason: match.reason,
															})),
														}
													: {}),
											}),
									channel: update.channel,
									ats: update.ats,
									stage: update.stage,
									...(update.stage === "applied"
										? { applied_on: toUtcDateOnly(email.received_at ?? asOfIso) }
										: {}),
									...(update.platform_ref ? { platform_ref: update.platform_ref } : {}),
									...(update.salary_band ? { salary_band: update.salary_band } : {}),
									...(update.salary_expectation_submitted != null
										? { salary_expectation_submitted: update.salary_expectation_submitted }
										: {}),
									...(update.job_site ? { job_site: update.job_site } : {}),
									...(hiringContactId ? { hiring_contact_ids: [hiringContactId] } : {}),
									...(artifactId && isUuid(artifactId)
										? {
												evidence_artifact_id: artifactId,
												evidence_link_type: "related",
											}
										: {}),
									source: "email_triage",
									...(stageNoteParts.length > 0
										? { stage_note: stageNoteParts.join(" | ") }
										: {}),
									as_of: email.received_at ?? asOfIso,
									confidence: { epistemic: update.confidence },
								};

								const canAutoApply =
									input.mode === "act" &&
									effectiveAutoApplyThreshold !== null &&
									update.confidence >= effectiveAutoApplyThreshold &&
									!effectiveNeedsReview &&
									!update.conflict_detected;

								if (canAutoApply) {
									try {
										const upsertRes = await executeAction(upsertAction, upsertInput, {
											context: {
												...ctx,
												caller: "internal",
											},
										});
										if (upsertRes.status === "ambiguous") {
											if (!approvalStore) {
												throw new Error(
													"No ActionApprovalStore configured to park ambiguous job_application_upsert",
												);
											}
											const fallbackCandidates = (upsertRes.candidates ?? []).map((c) => ({
												id: c.id,
												title: c.title,
												...(c.stage ? { stage: c.stage } : {}),
												match_reason: c.match_reason,
											}));
											const parkedInput: JobApplicationUpsertInput = {
												...upsertInput,
												...(fallbackCandidates.length > 0
													? { disambiguation_candidates: fallbackCandidates }
													: {}),
											};
											const hash = await inputSha256(parkedInput);
											const { decisionId } = await approvalStore.park({
												actionId: "job_application_upsert",
												input: parkedInput,
												inputSha256: hash,
												caller: ctx.caller,
												requestId: ctx.requestId,
												userId: userId ?? null,
												clientId: ctx.clientId ?? null,
												sessionId: ctx.sessionId ?? null,
											});
											result.needs_review_count += 1;
											result.parked_approvals += 1;
											await persistWatermark({
												message_id: email.message_id,
												item_key: update.item_key,
												mode: input.mode,
												outcome: "needs_review",
												thread_id: email.thread_id,
												application_id: null,
												decision_id: decisionId,
												artifact_id: artifactId,
												organisation: update.organisation,
												role_title: update.role_title,
												stage: update.stage,
												confidence: update.confidence,
												candidate_ids: fallbackCandidates.map((c) => c.id),
												candidates: fallbackCandidates.map((c) => ({
													id: c.id,
													title: c.title,
												})),
												hiring_contact: update.hiring_contact ?? null,
											});
											result.items.push({
												message_id: email.message_id,
												thread_id: email.thread_id,
												item_key: update.item_key,
												kind: "application_update",
												rule_id: update.rule_id,
												outcome: "needs_review",
												organisation: update.organisation,
												role_title: update.role_title,
												stage: update.stage,
												matched_application_id: null,
												match_step: "ambiguous",
												candidate_ids: fallbackCandidates.map((c) => c.id),
												decision_id: decisionId,
												artifact_id: artifactId,
												...(update.hiring_contact ? { hiring_contact: update.hiring_contact } : {}),
											});
											continue;
										}

										result.auto_applied += 1;
										const appId = upsertRes.application?.id ?? matchedId;
										if (matchedApp) {
											matchedApp.threadIds.add(email.thread_id);
										}
										if (appId && artifactId && !isUuid(artifactId)) {
											await linkArtifactToEntity(artifactId, appId, "related");
										}
										await persistWatermark({
											message_id: email.message_id,
											item_key: update.item_key,
											mode: "act",
											outcome: "auto_applied",
											thread_id: email.thread_id,
											application_id: appId,
											artifact_id: artifactId,
											organisation: update.organisation,
											role_title: update.role_title,
											stage: update.stage,
											confidence: update.confidence,
											hiring_contact: update.hiring_contact ?? null,
										});
										result.items.push({
											message_id: email.message_id,
											thread_id: email.thread_id,
											item_key: update.item_key,
											kind: "application_update",
											rule_id: update.rule_id,
											outcome: "auto_applied",
											organisation: update.organisation,
											role_title: update.role_title,
											stage: update.stage,
											matched_application_id: appId,
											match_step: match.step,
											artifact_id: artifactId,
											...(update.hiring_contact ? { hiring_contact: update.hiring_contact } : {}),
										});
									} catch (err) {
										if (isPendingApproval(err)) {
											// Gate already parked an approval under err.decisionId — record & watermark so it never duplicates.
											if (matchedId && artifactId) {
												await linkArtifactToEntity(artifactId, matchedId, "related");
												matchedApp?.threadIds.add(email.thread_id);
											}
											result.parked_approvals += 1;
											await persistWatermark({
												message_id: email.message_id,
												item_key: update.item_key,
												mode: input.mode,
												outcome: "parked_approval",
												thread_id: email.thread_id,
												application_id: matchedId,
												decision_id: err.decisionId,
												artifact_id: artifactId,
												organisation: update.organisation,
												role_title: update.role_title,
												stage: update.stage,
												confidence: update.confidence,
												hiring_contact: update.hiring_contact ?? null,
											});
											result.items.push({
												message_id: email.message_id,
												thread_id: email.thread_id,
												item_key: update.item_key,
												kind: "application_update",
												rule_id: update.rule_id,
												outcome: "parked_approval",
												organisation: update.organisation,
												role_title: update.role_title,
												stage: update.stage,
												matched_application_id: matchedId,
												match_step: match.step,
												decision_id: err.decisionId,
												artifact_id: artifactId,
												...(update.hiring_contact ? { hiring_contact: update.hiring_contact } : {}),
											});
											continue;
										}
										throw err;
									}
									continue;
								}

								// Park for ADR-104 Approvals inbox
								if (!approvalStore) {
									throw new Error(
										"No ActionApprovalStore configured to park job_application_upsert",
									);
								}

								const hash = await inputSha256(upsertInput);
								const { decisionId } = await approvalStore.park({
									actionId: "job_application_upsert",
									input: upsertInput,
									inputSha256: hash,
									caller: ctx.caller,
									requestId: ctx.requestId,
									userId: userId ?? null,
									clientId: ctx.clientId ?? null,
									sessionId: ctx.sessionId ?? null,
								});
								// Link email provenance to matched application immediately so thread_id matching
								// works on follow-up replies even before owner approval is clicked.
								if (matchedId && artifactId) {
									await linkArtifactToEntity(artifactId, matchedId, "related");
									matchedApp?.threadIds.add(email.thread_id);
								}
								if (effectiveNeedsReview) {
									result.needs_review_count += 1;
								}
								result.parked_approvals += 1;
								const outcome = effectiveNeedsReview ? "needs_review" : "parked_approval";
								await persistWatermark({
									message_id: email.message_id,
									item_key: update.item_key,
									mode: input.mode,
									outcome,
									thread_id: email.thread_id,
									application_id: matchedId,
									decision_id: decisionId,
									artifact_id: artifactId,
									organisation: update.organisation,
									role_title: update.role_title,
									stage: update.stage,
									confidence: update.confidence,
									candidate_ids:
										match.step === "ambiguous" ? match.candidateIds : undefined,
									candidates: candidateSummaries,
									hiring_contact: update.hiring_contact ?? null,
								});
								result.items.push({
									message_id: email.message_id,
									thread_id: email.thread_id,
									item_key: update.item_key,
									kind: "application_update",
									rule_id: update.rule_id,
									outcome,
									organisation: update.organisation,
									role_title: update.role_title,
									stage: update.stage,
									matched_application_id: matchedId,
									match_step: match.step,
									candidate_ids:
										match.step === "ambiguous" ? match.candidateIds : undefined,
									decision_id: decisionId,
									artifact_id: artifactId,
									...(update.hiring_contact ? { hiring_contact: update.hiring_contact } : {}),
								});
							} catch (err) {
								const msg = err instanceof Error ? err.message : String(err);
								result.errors.push(`application_update failed (${email.message_id}): ${msg}`);
								result.items.push({
									message_id: email.message_id,
									thread_id: email.thread_id,
									item_key: update.item_key,
									kind: "application_update",
									rule_id: update.rule_id,
									outcome: "error",
									organisation: update.organisation,
									role_title: update.role_title,
									stage: update.stage,
									matched_application_id: matchedId,
									match_step: match.step,
									error: msg,
								});
							}
						}
						continue;
					}

					if (classified.kind === "task_only") {
						const wmKey = jobApplicationWatermarkKey(email.message_id, "primary");
						if (watermarks.has(wmKey)) {
							result.skipped_watermarked += 1;
							continue;
						}
						result.classified_tasks += 1;
						const match = matchApplication(indexedApps, {
							threadId: email.thread_id,
							organisation: classified.task.organisation,
						});
						const matchedId =
							match.step !== "ambiguous" && match.step !== "none" ? match.app.id : null;

						if (input.dry_run) {
							result.items.push({
								message_id: email.message_id,
								thread_id: email.thread_id,
								item_key: "primary",
								kind: "task_only",
								rule_id: classified.task.rule_id,
								outcome: "dry_run",
								organisation: classified.task.organisation ?? null,
								matched_application_id: matchedId,
								match_step: match.step,
							});
							continue;
						}

						if (input.mode === "shadow") {
							result.shadow_logged += 1;
							await persistWatermark({
								message_id: email.message_id,
								item_key: "primary",
								mode: "shadow",
								outcome: "shadow_logged",
								thread_id: email.thread_id,
								application_id: matchedId,
								organisation: classified.task.organisation ?? null,
								confidence: classified.task.confidence,
								title: classified.task.task_title,
							});
							result.items.push({
								message_id: email.message_id,
								thread_id: email.thread_id,
								item_key: "primary",
								kind: "task_only",
								rule_id: classified.task.rule_id,
								outcome: "shadow_logged",
								organisation: classified.task.organisation ?? null,
								matched_application_id: matchedId,
								match_step: match.step,
							});
							continue;
						}

						try {
							if (!deps.tasks || !userId) {
								throw new Error(
									!deps.tasks
										? "TaskRepository is required to create proposed job-hunt tasks"
										: "User ID is required to create proposed job-hunt tasks",
								);
							}

							await applyLabelIfNeeded();

							const prioLevel = classified.task.priority_level as PriorityLevel;
							const notesParts = [
								`gmail_message_id=${email.message_id}`,
								`gmail_thread_id=${email.thread_id}`,
								`rule_id=${classified.task.rule_id}`,
								...(classified.task.organisation
									? [`organisation=${classified.task.organisation}`]
									: []),
								...(classified.task.person_name
									? [`person=${classified.task.person_name}`]
									: []),
							];
							const created = await deps.tasks.insert(
								{
									id: globalThis.crypto.randomUUID(),
									user_id: userId,
									created_by: userId,
									created_via: "system",
									title: classified.task.task_title,
									description: email.subject || null,
									notes: notesParts.join(" | "),
									status: "proposed",
									source: "email_triage",
									task_type: "one_off",
									priority: priorityLevelToTaskPriority(prioLevel),
									priority_level: prioLevel,
									entity_id: matchedId,
									created_at: asOfIso,
									updated_at: asOfIso,
								},
								userId,
							);
							const taskId = created.id;
							result.tasks_created += 1;

							await persistWatermark({
								message_id: email.message_id,
								item_key: "primary",
								mode: input.mode,
								outcome: "task_created",
								thread_id: email.thread_id,
								application_id: matchedId,
								organisation: classified.task.organisation ?? null,
								confidence: classified.task.confidence,
								title: classified.task.task_title,
							});
							result.items.push({
								message_id: email.message_id,
								thread_id: email.thread_id,
								item_key: "primary",
								kind: "task_only",
								rule_id: classified.task.rule_id,
								outcome: "task_created",
								organisation: classified.task.organisation ?? null,
								matched_application_id: matchedId,
								match_step: match.step,
								task_id: taskId,
							});
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							result.errors.push(`task_only failed (${email.message_id}): ${msg}`);
							result.items.push({
								message_id: email.message_id,
								thread_id: email.thread_id,
								item_key: "primary",
								kind: "task_only",
								rule_id: classified.task.rule_id,
								outcome: "error",
								organisation: classified.task.organisation ?? null,
								matched_application_id: matchedId,
								match_step: match.step,
								error: msg,
							});
						}
						continue;
					}

					if (classified.kind === "evidence_only") {
						const wmKey = jobApplicationWatermarkKey(email.message_id, "primary");
						if (watermarks.has(wmKey)) {
							result.skipped_watermarked += 1;
							continue;
						}
						result.classified_evidence += 1;

						const evidenceContactEmails =
							classified.evidence.direction === "outbound"
								? [...(email.to ?? []), ...(email.cc ?? [])].map(extractEmailAddress)
								: classified.evidence.subtype === "inbound_human_reply"
									? [extractEmailAddress(email.from)]
									: [];

						const match = matchApplication(indexedApps, {
							threadId: email.thread_id,
							organisation: classified.evidence.organisation,
							contactEmails: evidenceContactEmails,
							appIdsByContactEmail,
						});
						const matchedApp =
							match.step !== "ambiguous" && match.step !== "none" ? match.app : null;
						const matchedId = matchedApp?.id ?? null;

						if (input.dry_run) {
							if (!matchedId) {
								result.needs_review_count += 1;
							}
							result.items.push({
								message_id: email.message_id,
								thread_id: email.thread_id,
								item_key: "primary",
								kind: "evidence_only",
								rule_id: classified.evidence.rule_id,
								outcome: "dry_run",
								organisation: classified.evidence.organisation ?? null,
								matched_application_id: matchedId,
								match_step: match.step,
								candidate_ids:
									match.step === "ambiguous" ? match.candidateIds : undefined,
							});
							continue;
						}

						if (input.mode === "shadow") {
							result.shadow_logged += 1;
							if (!matchedId) {
								result.needs_review_count += 1;
							}
							await persistWatermark({
								message_id: email.message_id,
								item_key: "primary",
								mode: "shadow",
								outcome: "shadow_logged",
								thread_id: email.thread_id,
								application_id: matchedId,
								organisation: classified.evidence.organisation ?? null,
								confidence: classified.evidence.confidence,
								title: email.subject,
								candidate_ids:
									match.step === "ambiguous" ? match.candidateIds : undefined,
								candidates:
									match.step === "ambiguous"
										? match.candidates.map((c) => ({ id: c.id, title: c.title }))
										: undefined,
							});
							result.items.push({
								message_id: email.message_id,
								thread_id: email.thread_id,
								item_key: "primary",
								kind: "evidence_only",
								rule_id: classified.evidence.rule_id,
								outcome: "shadow_logged",
								organisation: classified.evidence.organisation ?? null,
								matched_application_id: matchedId,
								match_step: match.step,
								candidate_ids:
									match.step === "ambiguous" ? match.candidateIds : undefined,
							});
							continue;
						}

						// Never watermark or report `evidence_linked` when no unambiguous application matched.
						if (!matchedApp) {
							result.needs_review_count += 1;
							result.items.push({
								message_id: email.message_id,
								thread_id: email.thread_id,
								item_key: "primary",
								kind: "evidence_only",
								rule_id: classified.evidence.rule_id,
								outcome: "needs_review",
								organisation: classified.evidence.organisation ?? null,
								matched_application_id: null,
								match_step: match.step,
								candidate_ids:
									match.step === "ambiguous" ? match.candidateIds : undefined,
							});
							continue;
						}

						try {
							await applyLabelIfNeeded();

							// Automated briefings (e.g. Dex CRM) must NOT carry direction="inbound",
							// otherwise job_pipeline_read treats them as human replies and resets last_inbound_at.
							const artifactDirection =
								classified.evidence.direction === "outbound"
									? "outbound"
									: classified.evidence.updates_last_inbound_at
										? "inbound"
										: "automated";

							const artifactId = await captureEmailArtifact({
								direction: artifactDirection,
								subtype: classified.evidence.subtype,
								rule_id: classified.evidence.rule_id,
							});

							const linkType =
								classified.evidence.direction === "outbound"
									? "outbound_mail"
									: classified.evidence.subtype === "inbound_human_reply"
										? "inbound_reply"
										: "related";

							const emailTimestamp = toUtcIsoTimestamp(email.received_at ?? asOfIso);
							const existingLastInboundMs = matchedApp.lastInboundAt
								? Date.parse(matchedApp.lastInboundAt)
								: Number.NaN;
							const incomingMs = Date.parse(emailTimestamp);
							const shouldAdvanceLastInboundAt =
								classified.evidence.updates_last_inbound_at &&
								(!Number.isFinite(existingLastInboundMs) ||
									incomingMs > existingLastInboundMs);

							if (!artifactId && !shouldAdvanceLastInboundAt) {
								throw new Error(
									"CapturePort is required to link evidence_only job-hunt emails",
								);
							}

							if (shouldAdvanceLastInboundAt) {
								const passEvidenceToUpsert = Boolean(artifactId && isUuid(artifactId));
								await executeAction(
									upsertAction,
									{
										id: matchedApp.id,
										last_inbound_at: emailTimestamp,
										as_of: emailTimestamp,
										skip_task_sync: true,
										...(passEvidenceToUpsert
											? {
													evidence_artifact_id: artifactId!,
													evidence_link_type: linkType,
												}
											: {}),
									},
									{
										context: {
											...ctx,
											caller: "internal",
										},
									},
								);
								if (artifactId && !passEvidenceToUpsert) {
									await linkArtifactToEntity(artifactId, matchedApp.id, linkType);
								}
								matchedApp.lastInboundAt = emailTimestamp;
							} else if (artifactId) {
								await linkArtifactToEntity(artifactId, matchedApp.id, linkType);
							}

							matchedApp.threadIds.add(email.thread_id);
							result.evidence_linked += 1;

							await persistWatermark({
								message_id: email.message_id,
								item_key: "primary",
								mode: input.mode,
								outcome: "evidence_linked",
								thread_id: email.thread_id,
								application_id: matchedApp.id,
								artifact_id: artifactId,
								organisation: classified.evidence.organisation ?? null,
								confidence: classified.evidence.confidence,
								title: email.subject,
							});
							result.items.push({
								message_id: email.message_id,
								thread_id: email.thread_id,
								item_key: "primary",
								kind: "evidence_only",
								rule_id: classified.evidence.rule_id,
								outcome: "evidence_linked",
								organisation: classified.evidence.organisation ?? null,
								matched_application_id: matchedApp.id,
								match_step: match.step,
								artifact_id: artifactId,
							});
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							result.errors.push(`evidence_only failed (${email.message_id}): ${msg}`);
							result.items.push({
								message_id: email.message_id,
								thread_id: email.thread_id,
								item_key: "primary",
								kind: "evidence_only",
								rule_id: classified.evidence.rule_id,
								outcome: "error",
								organisation: classified.evidence.organisation ?? null,
								matched_application_id: matchedApp.id,
								match_step: match.step,
								error: msg,
							});
						}
					}
				}
			} finally {
				if (
					!input.dry_run &&
					shadowWatermarks.length > 0 &&
					typeof deps.decisions?.recordJobApplicationWatermarks === "function"
				) {
					await deps.decisions.recordJobApplicationWatermarks(shadowWatermarks, userId);
				}
			}

			return result;
		},
	});
}
