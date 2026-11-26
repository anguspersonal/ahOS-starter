import type { SupabaseClient } from "@supabase/supabase-js";
import {
	ARTIFACT_SURFACES,
	buildDailyEmailFlowCapturePayload,
	buildDailyEmailFlowSnapshot,
	buildEmailDailyDigest,
	computeDailyEmailFlowDedupKey,
	computeUtcDateKey,
	DAILY_EMAIL_FLOW_CONTENT_SUBTYPE,
	type DailyEmailFlowSnapshot,
	EMAIL_DAILY_DIGEST_SUBTYPE,
	EMAIL_MAILBOX_SNAPSHOT_SUBTYPE,
	emailDailyDigestDedupKey,
	emailMailboxSnapshotDedupKey,
	extractDisplayName,
	formatEmailDailyDigestMarkdown,
	INBOX_ROUTES,
	normaliseAddress,
	resolvePersonRelationship,
	type DecisionJudgePort,
	type EmailContextProbeKind,
	type EmailDailyDigest,
	type EmailDailyDigestItem,
	type EmailHop2ProbeEvidence,
	type EmailMailboxSnapshot,
	type EmailReasonerContext,
	type EmailReasonerPort,
	type EmailSignals,
	type ExtractedEmailTask,
	type GmailAccountDomain,
	type GmailPriorityTriagePort,
	type GmailPriorityTriageSweepTarget,
	type GmailTriageDecisionRecord,
	type GmailTriageGraphContext,
	type GmailTriageThreadCandidate,
} from "@ahkms/core";
import { DEFAULT_OWNER_ADDRESSES } from "@ahkms/core/actions";
import {
	buildRawMessage,
	createDeriveLlmPort,
	createJevWithGeminiFallbackJudgeAdapter,
	createLlmEmailReasoner,
	createSupabaseGmailReconcileStore,
	GMAIL_TRIAGE_DECISION_TYPE,
	type GmailReconcileSupabaseClient,
} from "@ahkms/core/adapters";
import { listCalendarEvents } from "../google/calendar.js";
import { getStateDocPageId } from "../notionDomain.js";
import { listNotionBlockChildren } from "../notion.js";
import { createTaskCore } from "../tools/createTask.js";
import { supabase as defaultSupabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";
import { getCredential } from "../credentials.js";
import { captureCore } from "../tools/capture.js";
import {
	getThread,
	modifyLabels,
	listLabels,
	listMessageIds,
	ensureLabel,
	searchMessages,
	getLabelCounts,
	getReplyContext,
	createDraft,
	LABEL_INBOX,
} from "../google/gmail.js";

// The Work mailbox is owner@work.example.com: with only the old .com alias listed,
// every Work message read as "not addressed to Angus" and scored low (ADR-118).
export const ANGUS_EMAIL_ADDRESSES = DEFAULT_OWNER_ADDRESSES;

function resolveOptionalUserId(): string | undefined {
	try {
		return getCurrentUserId();
	} catch {
		return undefined;
	}
}

export function buildGmailThreadUrl(
	account: GmailAccountDomain,
	threadId: string,
): string {
	const accountIndex = account === "work" ? "1" : "0";
	return `https://mail.google.com/mail/u/${accountIndex}/#inbox/${threadId}`;
}

/** The State Doc is read at most once per account per this long (ADR-118 System 2 context). */
const STATE_DOC_TTL_MS = 30 * 60 * 1000;
const STATE_DOC_MAX_CHARS = 3000;

interface NotionRichTextBlock {
	type?: string;
	[key: string]: unknown;
}

/** Plain text of a page's top-level blocks: enough for "what matters this week". */
export function notionBlocksToText(blocks: readonly NotionRichTextBlock[], maxChars = STATE_DOC_MAX_CHARS): string {
	const lines: string[] = [];
	let length = 0;
	for (const block of blocks) {
		const body = block.type ? (block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined) : undefined;
		const text = (body?.rich_text ?? []).map((t) => t.plain_text ?? "").join("").trim();
		if (!text) continue;
		const prefix = block.type?.startsWith("heading") ? "## " : block.type?.includes("list_item") ? "- " : "";
		lines.push(prefix + text);
		length += text.length + prefix.length + 1;
		if (length >= maxChars) break;
	}
	return lines.join("\n").slice(0, maxChars);
}

/** The System 2 reasoner on the derive LLM transport, or undefined when no model key is set. */
export function createDefaultEmailReasoner(): EmailReasonerPort | undefined {
	const geminiApiKey = process.env.GEMINI_API_KEY;
	const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
	if (!geminiApiKey && !anthropicApiKey) return undefined;
	const llm = createDeriveLlmPort({
		geminiApiKey,
		anthropicApiKey,
		defaultProvider: process.env.KMS_EMAIL_REASONER_PROVIDER === "anthropic" ? "anthropic" : "gemini",
		geminiModel: process.env.KMS_EMAIL_REASONER_GEMINI_MODEL ?? process.env.KMS_DERIVE_GEMINI_MODEL,
	});
	return createLlmEmailReasoner(llm, {
		onError: (err) => console.warn("[GmailTriage] System 2 call failed:", err instanceof Error ? err.message : err),
	});
}

/** The calibrated Stage 1 -> Hop 1 -> Hop 2 decision judge (TypeSafe AI Jev with Gemini fallback). */
export function createDefaultDecisionJudge(): DecisionJudgePort | undefined {
	const jevApiKey = process.env.TYPESAFE_API_KEY || process.env.JEV_API_KEY;
	const geminiApiKey = process.env.GEMINI_API_KEY;
	if (!jevApiKey && !geminiApiKey) return undefined;
	return createJevWithGeminiFallbackJudgeAdapter({
		jevApiKey,
		geminiApiKey,
		onError: (err) => console.warn("[GmailTriage] DecisionJudge call failed:", err instanceof Error ? err.message : err),
	});
}

type PersonRow = {
	id?: string;
	entity_id?: string | null;
	name?: string | null;
	email?: string | null;
	relationship?: string | null;
	organization?: string | null;
	role?: string | null;
	tags?: string[] | null;
	last_contact?: string | null;
};

const PERSON_SELECT_COLUMNS =
	"id, entity_id, name, email, relationship, organization, role, tags, last_contact";

const FREE_MAIL_DOMAINS = new Set([
	"gmail.com",
	"googlemail.com",
	"icloud.com",
	"me.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"yahoo.com",
	"proton.me",
	"protonmail.com",
]);

export function createGmailPriorityTriagePort(
	options: {
		client?: SupabaseClient;
		getUserId?: () => string | undefined;
		reasoner?: EmailReasonerPort | null;
		decisionJudge?: DecisionJudgePort | null;
	} = {},
): GmailPriorityTriagePort {
	const client = options.client ?? defaultSupabase;
	const getUserId = options.getUserId ?? resolveOptionalUserId;
	const store = createSupabaseGmailReconcileStore(
		client as unknown as GmailReconcileSupabaseClient,
		getUserId,
	);
	const reasoner = options.reasoner === null ? undefined : (options.reasoner ?? createDefaultEmailReasoner());
	const decisionJudge =
		options.decisionJudge === null ? undefined : (options.decisionJudge ?? createDefaultDecisionJudge());

	// The port is a process-lifetime singleton, so every cache here expires.
	const personCache = new Map<string, { at: number; row: PersonRow | null }>();
	const stateDocCache = new Map<GmailAccountDomain, { at: number; text: string | null }>();
	const labelIdCache = new Map<string, string>();
	const sentHistoryCache = new Map<string, { at: number; written: boolean | null }>();

	async function checkHasOwnerWrittenTo(address: string): Promise<boolean | null> {
		const addr = address.trim().toLowerCase();
		// Only a bare address goes into a Gmail query.
		if (!/^[^\s"(){}<>]+@[^\s"(){}<>]+\.[a-z0-9-]+$/i.test(addr)) return null;
		const hit = sentHistoryCache.get(addr);
		if (hit && Date.now() - hit.at < STATE_DOC_TTL_MS) return hit.written;
		let answered = 0;
		let written = false;
		for (const account of ["personal", "work"] as const) {
			try {
				const { ids } = await listMessageIds(account, `in:sent (to:${addr} OR cc:${addr})`, { maxResults: 1 });
				answered += 1;
				if (ids.length > 0) {
					written = true;
					break;
				}
			} catch (err) {
				console.warn(`[GmailTriage] sent-history lookup failed (${account}):`, err instanceof Error ? err.message : err);
			}
		}
		// "Never written" needs both mailboxes to answer; one found message is enough for "yes".
		const result = written ? true : answered === 2 ? false : null;
		sentHistoryCache.set(addr, { at: Date.now(), written: result });
		return result;
	}

	async function findPerson(
		senderEmail: string,
		senderName?: string | null,
		ownerHasWrittenHint?: boolean | null,
	): Promise<PersonRow | null> {
		if (!senderEmail) return null;
		const cacheKey = `${senderEmail}|${(senderName ?? "").toLowerCase()}`;
		const hit = personCache.get(cacheKey);
		if (hit && Date.now() - hit.at < STATE_DOC_TTL_MS) return hit.row;
		let row: PersonRow | null = null;
		const userId = getUserId();
		try {
			let query = client
				.from("people")
				.select(PERSON_SELECT_COLUMNS)
				.ilike("email", senderEmail)
				.limit(1);
			if (userId) query = query.eq("user_id", userId);
			const { data } = await query;
			row = Array.isArray(data) && data[0] ? (data[0] as PersonRow) : null;
		} catch {
			row = null;
		}

		// Fallback: if no email matched, check for an exact display-name match on a `people` row
		// whose `email` is still null (e.g. seeded from Notion/Drive before email backfill),
		// gated on sent-mail verification so cold senders cannot spoof a contact by display name.
		const cleanName = (senderName ?? "").trim();
		if (
			!row &&
			cleanName.includes(" ") &&
			!cleanName.includes("@") &&
			!/\bvia\b/i.test(cleanName)
		) {
			try {
				let nameQuery = client
					.from("people")
					.select(PERSON_SELECT_COLUMNS)
					.ilike("name", cleanName)
					.is("email", null)
					.limit(1);
				if (userId) nameQuery = nameQuery.eq("user_id", userId);
				const { data: nameData } = await nameQuery;
				const candidateRow =
					Array.isArray(nameData) && nameData[0] ? (nameData[0] as PersonRow) : null;
				if (candidateRow) {
					const written =
						typeof ownerHasWrittenHint === "boolean"
							? ownerHasWrittenHint
							: await checkHasOwnerWrittenTo(senderEmail);
					if (written === true) {
						row = candidateRow;
					}
				}
			} catch {
				// Ignore name-fallback lookup errors; leave row null.
			}
		}

		personCache.set(cacheKey, { at: Date.now(), row });
		return row;
	}

	async function findOrganisation(domain: string): Promise<{ id: string; name: string; type: string } | null> {
		if (!domain || FREE_MAIL_DOMAINS.has(domain)) return null;
		const stem = domain.split(".").slice(-2, -1)[0] ?? "";
		if (stem.length < 3) return null;
		try {
			let query = client
				.from("entities")
				.select("id, title, entity_type")
				.ilike("title", stem)
				.eq("archived", false)
				.limit(1);
			const userId = getUserId();
			if (userId) query = query.eq("user_id", userId);
			const { data } = await query;
			const row = Array.isArray(data) ? (data[0] as { id?: string; title?: string; entity_type?: string } | undefined) : undefined;
			return row?.id && row.title ? { id: row.id, name: row.title, type: row.entity_type ?? "organization" } : null;
		} catch {
			return null;
		}
	}

	async function stateDocExcerpt(account: GmailAccountDomain): Promise<string | null> {
		const cached = stateDocCache.get(account);
		if (cached && Date.now() - cached.at < STATE_DOC_TTL_MS) return cached.text;
		let text: string | null = null;
		try {
			const domain = account === "work" ? "work" : "angus";
			const pageId = await getStateDocPageId(domain);
			if (pageId) {
				const token = await getCredential(domain === "work" ? "notion_work" : "notion_personal");
				const blocks = await listNotionBlockChildren(pageId, token);
				text = notionBlocksToText(blocks as unknown as NotionRichTextBlock[]) || null;
			}
		} catch (err) {
			console.warn(`[GmailTriage] State Doc read failed (${account}):`, err instanceof Error ? err.message : err);
		}
		stateDocCache.set(account, { at: Date.now(), text });
		return text;
	}

	async function labelId(account: GmailAccountDomain, name: string): Promise<string> {
		const key = `${account}:${name}`;
		const cached = labelIdCache.get(key);
		if (cached) return cached;
		const { label } = await ensureLabel(account, name);
		labelIdCache.set(key, label.id);
		return label.id;
	}

	return {
		reasoner,
		decisionJudge,

		async getOwnerAddresses(): Promise<string[]> {
			const out = new Set<string>(ANGUS_EMAIL_ADDRESSES);
			try {
				let query = client.from("user_preferences").select("identity").limit(1);
				const userId = getUserId();
				if (userId) query = query.eq("user_id", userId);
				const { data } = await query;
				const identity = (Array.isArray(data) ? data[0]?.identity : null) as { emails?: unknown } | null;
				if (Array.isArray(identity?.emails)) {
					for (const e of identity.emails) if (typeof e === "string" && e.includes("@")) out.add(e.toLowerCase());
				}
			} catch {
				// Constant fallback above is enough to run.
			}
			return Array.from(out);
		},

		async hasOwnerWrittenTo(address: string): Promise<boolean | null> {
			return checkHasOwnerWrittenTo(address);
		},

		async listInboxThreads(
			account: GmailAccountDomain,
			maxThreads: number,
		): Promise<GmailTriageThreadCandidate[]> {
			const messages = await searchMessages(account, "in:inbox", maxThreads);
			const seenThreads = new Set<string>();
			const candidates: GmailTriageThreadCandidate[] = [];

			for (const msg of messages) {
				const threadId = msg.threadId || msg.id;
				if (!threadId || seenThreads.has(threadId)) {
					continue;
				}
				seenThreads.add(threadId);

				candidates.push({
					thread_id: threadId,
					message_id: msg.id,
					account,
					sender: msg.from ?? "",
					to: msg.to ?? null,
					cc: msg.cc ?? null,
					subject: msg.subject ?? "",
					snippet: msg.snippet ?? null,
					body: msg.body ?? null,
					received_at: msg.date || null,
					source_url: buildGmailThreadUrl(account, threadId),
					label_ids: msg.labelIds ?? [],
					list_unsubscribe: msg.listUnsubscribe ?? null,
					list_id: msg.listId ?? null,
					precedence: msg.precedence ?? null,
					auto_submitted: msg.autoSubmitted ?? null,
				});

				if (candidates.length >= maxThreads) {
					break;
				}
			}

			return candidates;
		},

		async resolveGraphContext(
			candidate: GmailTriageThreadCandidate,
		): Promise<GmailTriageGraphContext | undefined> {
			const senderEmail = normaliseAddress(candidate.sender);
			const senderName = extractDisplayName(candidate.sender);
			const person = await findPerson(senderEmail, senderName, candidate.owner_has_written ?? null);
			if (!person) return undefined;
			const entityId = person.entity_id ?? person.id;
			const hasEmail = typeof person.email === "string" && person.email.trim().length > 0;
			return {
				matchedHotEntities: entityId ? [entityId] : [],
				isKeyPerson: true,
				contactId: person.id ?? null,
				contactMissingEmail: !hasEmail,
				relationship: resolvePersonRelationship(person),
			};
		},

		async loadReasonerContext(candidate): Promise<EmailReasonerContext> {
			const senderEmail = normaliseAddress(candidate.sender);
			const senderName = extractDisplayName(candidate.sender);
			const [person, org, excerpt] = await Promise.all([
				findPerson(senderEmail, senderName, candidate.owner_has_written ?? null),
				findOrganisation(senderEmail.split("@")[1] ?? ""),
				stateDocExcerpt(candidate.account),
			]);
			const openTasks: Array<{ title: string; status: string | null }> = [];
			const needle = (person?.organization || org?.name || person?.name || "").trim();
			if (needle.length >= 3) {
				try {
					let query = client
						.from("user_tasks")
						.select("title, status")
						.ilike("title", `%${needle}%`)
						.not("status", "in", "(done,cancelled)")
						.limit(5);
					const userId = getUserId();
					if (userId) query = query.eq("user_id", userId);
					const { data } = await query;
					for (const row of (data ?? []) as Array<{ title?: string; status?: string }>) {
						if (row.title) openTasks.push({ title: row.title, status: row.status ?? null });
					}
				} catch {
					// Tasks are context, not a requirement.
				}
			}
			return {
				sender_profile: person
					? {
							entity_id: person.entity_id ?? person.id ?? null,
							name: person.name ?? null,
							relationship: resolvePersonRelationship(person),
							organization: person.organization ?? null,
							role: person.role ?? null,
							last_contact: person.last_contact ?? null,
						}
					: null,
				related_entities: org ? [org] : [],
				open_tasks: openTasks,
				state_doc_excerpt: excerpt,
			};
		},

		async listDecidedThreadIds(threadIds: string[], userId?: string): Promise<Set<string>> {
			return store.listDecidedThreadIds(threadIds, userId);
		},

		async countSurfacedSince(sinceIso: string, userId?: string): Promise<number> {
			const effectiveUserId = userId ?? getUserId();
			let query = client
				.from("system_decisions")
				.select("decision_payload")
				.eq("decision_type", GMAIL_TRIAGE_DECISION_TYPE)
				.gte("created_at", sinceIso)
				.limit(500);
			if (effectiveUserId) query = query.eq("user_id", effectiveUserId);
			const { data, error } = await query;
			if (error) throw new Error(error.message);
			return ((data ?? []) as Array<{ decision_payload?: { route?: string } | null }>).filter((row) =>
				INBOX_ROUTES.has((row.decision_payload?.route ?? "") as never),
			).length;
		},

		async countMailbox(account: GmailAccountDomain) {
			const counts = await getLabelCounts(account, LABEL_INBOX);
			return { inbox: counts.threadsTotal, unread: counts.threadsUnread };
		},

		async recordTriageDecisions(
			decisions: GmailTriageDecisionRecord[],
			userId?: string,
		): Promise<GmailTriageDecisionRecord[]> {
			return store.recordTriageDecisions(decisions, userId);
		},

		async promoteThreadToArtifact(
			candidate: GmailTriageThreadCandidate,
			decision: GmailTriageDecisionRecord,
			userId?: string,
		): Promise<{ artifact_id: string } | null> {
			const title =
				candidate.subject.trim() || `Gmail thread ${candidate.thread_id}`;
			const textBody =
				candidate.body?.trim() ||
				candidate.snippet?.trim() ||
				candidate.subject.trim() ||
				`Gmail thread ${candidate.thread_id}`;
			const formattedText = [
				`From: ${candidate.sender}`,
				`Subject: ${title}`,
				`Thread: ${candidate.thread_id}`,
				"",
				textBody,
			].join("\n");

			const sourceUrl =
				candidate.source_url ??
				buildGmailThreadUrl(candidate.account, candidate.thread_id);

			const captured = await captureCore(
				{
					title,
					text: formattedText,
					source_url: sourceUrl,
					content_subtype: "email",
					tags: [
						`account:${candidate.account}`,
						`intent:${decision.intent_category}`,
						`priority:${decision.priority}`,
						`route:${decision.route ?? "attention"}`,
						"triage:tier_3",
					],
					surface: "mcp",
					processing_metadata: {
						gmail: {
							thread_id: candidate.thread_id,
							message_id: decision.message_id,
							account: candidate.account,
							priority: decision.priority,
							intent_category: decision.intent_category,
							route: decision.route ?? null,
							thinking_mode: decision.thinking_mode ?? null,
							rubric_version: decision.rubric_version ?? null,
							// System 2's extraction rides along so the derive pass and the
							// process_artifact skill start from it rather than from nothing.
							extracted_entities: decision.extracted_entities ?? [],
							extracted_tasks: decision.extracted_tasks ?? [],
						},
					},
				},
				userId,
			);

			return { artifact_id: captured.id };
		},

		async recordMailboxSnapshot(snapshot: EmailMailboxSnapshot, userId?: string): Promise<void> {
			const lines = Object.entries(snapshot.accounts).map(
				([account, c]) => `- ${account}: ${c.inbox} threads in inbox, ${c.unread} unread`,
			);
			await captureCore(
				{
					title: `Mailbox snapshot ${snapshot.date}`,
					text: [`Mailbox snapshot for ${snapshot.date} (latest at ${snapshot.observed_at})`, "", ...lines].join("\n"),
					content_subtype: EMAIL_MAILBOX_SNAPSHOT_SUBTYPE,
					surface: ARTIFACT_SURFACES.kpiSnapshot,
					captured_by: "gmail_priority_triage",
					dedup_key: emailMailboxSnapshotDedupKey(snapshot.date),
					tags: ["metrics", "email", EMAIL_MAILBOX_SNAPSHOT_SUBTYPE, snapshot.date],
					processing_metadata: {
						mailbox: snapshot,
						derivation: { status: "skipped", reason: "role_metrics" },
					},
				},
				userId,
				{ updateOnDedupKey: true },
			);
		},

		async recordDailyDigest(digest: EmailDailyDigest, userId?: string): Promise<{ artifact_id: string } | null> {
			if (!digest.items.length) return null;
			const dedupKey = emailDailyDigestDedupKey(digest.date);
			const effectiveUserId = userId ?? getUserId();
			let existingItems: EmailDailyDigestItem[] = [];
			try {
				let query = client
					.from("artifacts")
					.select("processing_metadata")
					.eq("dedup_key", dedupKey);
				if (effectiveUserId) {
					query = query.eq("user_id", effectiveUserId);
				}
				const { data } = await query.maybeSingle();
				const prevDigest = (data?.processing_metadata as { digest?: { items?: EmailDailyDigestItem[] } } | null)?.digest;
				if (Array.isArray(prevDigest?.items)) {
					existingItems = prevDigest.items;
				}
			} catch {
				// Best-effort merge with earlier runs on the same day.
			}
			const mergedDigest = buildEmailDailyDigest({
				date: digest.date,
				generated_at: digest.generated_at,
				existingItems,
				items: digest.items,
			});
			const captured = await captureCore(
				{
					title: `Email Daily Digest — ${mergedDigest.date}`,
					text: formatEmailDailyDigestMarkdown(mergedDigest),
					content_subtype: EMAIL_DAILY_DIGEST_SUBTYPE,
					surface: "mcp",
					captured_by: "gmail_priority_triage",
					dedup_key: dedupKey,
					tags: ["email", "digest", EMAIL_DAILY_DIGEST_SUBTYPE, mergedDigest.date],
					processing_metadata: {
						digest: mergedDigest,
						derivation: { status: "skipped", reason: "role_digest" },
					},
				},
				userId,
				{ updateOnDedupKey: true },
			);
			return { artifact_id: captured.id };
		},

		async applyLabels(target: GmailPriorityTriageSweepTarget, labels: { add: string[]; remove: string[] }) {
			const addLabelIds = await Promise.all(labels.add.map((name) => labelId(target.account, name)));
			const removeLabelIds = await Promise.all(labels.remove.map((name) => labelId(target.account, name)));
			await modifyLabels(target.account, { kind: "thread", id: target.thread_id }, { addLabelIds, removeLabelIds });
		},

		async sweepThread(
			target: GmailPriorityTriageSweepTarget,
		): Promise<void> {
			await modifyLabels(
				target.account,
				{ kind: "thread", id: target.thread_id },
				{ removeLabelIds: [LABEL_INBOX] },
			);
		},

		async getDailyEmailFlow(
			context,
			userId,
		): Promise<DailyEmailFlowSnapshot | undefined> {
			const dateKey = computeUtcDateKey(new Date());
			const afterDate = dateKey.replace(/-/g, "/");
			const resolvedUserId = userId ?? getUserId();

			const fetchMailboxCounts = async (
				account: GmailAccountDomain,
			): Promise<{ end: number; newToday: number }> => {
				try {
					const [labelCounts, newTodayRes] = await Promise.all([
						typeof getLabelCounts === "function"
							? getLabelCounts(account, LABEL_INBOX)
							: Promise.resolve(undefined),
						listMessageIds(account, `after:${afterDate} -from:me`, {
							maxResults: 500,
						}),
					]);
					let end: number;
					if (labelCounts && typeof labelCounts.threadsUnread === "number") {
						end = labelCounts.threadsUnread;
					} else {
						const unreadRes = await listMessageIds(
							account,
							"in:inbox is:unread",
							{ maxResults: 500 },
						);
						end = unreadRes.ids.length;
					}
					return {
						end,
						newToday: newTodayRes.ids.length,
					};
				} catch {
					return {
						end: context.curatedByAccount[account],
						newToday: context.newTodayByAccount[account],
					};
				}
			};

			const [personalCounts, workCounts] = await Promise.all([
				fetchMailboxCounts("personal"),
				fetchMailboxCounts("work"),
			]);

			let priorPersonalStarting: number | undefined;
			let priorWorkStarting: number | undefined;
			let priorPersonalSweptToday = 0;
			let priorWorkSweptToday = 0;

			if (resolvedUserId) {
				try {
					const { data } = await client
						.from("artifacts")
						.select("dedup_key, processing_metadata")
						.eq("user_id", resolvedUserId)
						.eq("content_subtype", DAILY_EMAIL_FLOW_CONTENT_SUBTYPE)
						.order("created_at", { ascending: false })
						.limit(2);

					const rows = Array.isArray(data)
						? (data as Array<{
								dedup_key?: string | null;
								processing_metadata?: Record<string, unknown> | null;
							}>)
						: [];

					const todayDedupKey = computeDailyEmailFlowDedupKey(dateKey);
					const todayRow = rows.find((r) => r.dedup_key === todayDedupKey);
					const prevRow = rows.find((r) => r.dedup_key !== todayDedupKey);

					const extractStoredFlow = (
						row:
							| { processing_metadata?: Record<string, unknown> | null }
							| undefined,
					): Record<string, unknown> | null => {
						const meta = row?.processing_metadata;
						if (
							meta &&
							typeof meta.daily_email_flow === "object" &&
							meta.daily_email_flow !== null
						) {
							return meta.daily_email_flow as Record<string, unknown>;
						}
						return null;
					};

					const todayFlow = extractStoredFlow(todayRow);
					const prevFlow = extractStoredFlow(prevRow);

					const todayPersonal = todayFlow?.personal as
						| { starting?: number; swept_today?: number }
						| undefined;
					const todayWork = todayFlow?.work as
						| { starting?: number; swept_today?: number }
						| undefined;
					const prevPersonal = prevFlow?.personal as
						| { end?: number }
						| undefined;
					const prevWork = prevFlow?.work as
						| { end?: number }
						| undefined;

					if (typeof todayPersonal?.starting === "number") {
						priorPersonalStarting = todayPersonal.starting;
					} else if (typeof prevPersonal?.end === "number") {
						priorPersonalStarting = prevPersonal.end;
					}

					if (typeof todayWork?.starting === "number") {
						priorWorkStarting = todayWork.starting;
					} else if (typeof prevWork?.end === "number") {
						priorWorkStarting = prevWork.end;
					}

					if (typeof todayPersonal?.swept_today === "number") {
						priorPersonalSweptToday = todayPersonal.swept_today;
					}
					if (typeof todayWork?.swept_today === "number") {
						priorWorkSweptToday = todayWork.swept_today;
					}
				} catch {
					// Non-fatal: derive starting from waterfall when artifact store is unavailable
				}
			}

			const personalSweptToday =
				priorPersonalSweptToday + context.sweptByAccount.personal;
			const workSweptToday =
				priorWorkSweptToday + context.sweptByAccount.work;

			const snapshot = buildDailyEmailFlowSnapshot({
				date_key: dateKey,
				personal: {
					...(priorPersonalStarting !== undefined
						? { starting: priorPersonalStarting }
						: { processed_today: personalSweptToday }),
					new_today: personalCounts.newToday,
					swept_today: personalSweptToday,
					end: personalCounts.end,
				},
				work: {
					...(priorWorkStarting !== undefined
						? { starting: priorWorkStarting }
						: { processed_today: workSweptToday }),
					new_today: workCounts.newToday,
					swept_today: workSweptToday,
					end: workCounts.end,
				},
			});

			if (!context.dryRun && resolvedUserId) {
				try {
					await captureCore(
						buildDailyEmailFlowCapturePayload(snapshot),
						resolvedUserId,
						{ updateOnDedupKey: true },
					);
				} catch {
					// Best-effort metrics persistence
				}
			}

			return snapshot;
		},

		async createReplyDraft(candidate: GmailTriageThreadCandidate, body: string) {
			const messageId = candidate.message_id ?? candidate.thread_id;
			const reply = await getReplyContext(candidate.account, messageId);
			const to = normaliseAddress(reply.from);
			if (!to) return null;
			const raw = buildRawMessage({
				to: [to],
				subject: reply.replySubject,
				body,
				inReplyTo: reply.messageIdHeader || undefined,
				references: reply.references || undefined,
			});
			const draft = await createDraft(candidate.account, raw, reply.threadId);
			return { draft_id: draft.draftId };
		},

		async createTasks(
			candidate: GmailTriageThreadCandidate,
			tasks: ExtractedEmailTask[],
			artifactId: string | null,
			userId?: string,
		): Promise<number> {
			let created = 0;
			for (const task of tasks) {
				const result = await createTaskCore(
					{
						workspace: candidate.account === "work" ? "notion_work" : "notion_personal",
						title: task.title,
						notes: `From email: ${candidate.subject} (${candidate.source_url ?? buildGmailThreadUrl(candidate.account, candidate.thread_id)})`,
						...(task.due ? { due: task.due } : {}),
						...(artifactId ? { artifact_id: artifactId } : {}),
						dedup_key: `gmail:${candidate.thread_id}:${task.title.toLowerCase()}`,
					} as Parameters<typeof createTaskCore>[0],
					userId,
				);
				if (result.status === "created") created += 1;
			}
			return created;
		},

		async fetchProbeEvidence(
			candidate: GmailTriageThreadCandidate,
			probes: readonly EmailContextProbeKind[],
			_graph: GmailTriageGraphContext | undefined,
			userId?: string,
		): Promise<EmailHop2ProbeEvidence> {
			const effectiveUserId = userId ?? getUserId();
			const senderEmail = normaliseAddress(candidate.sender);
			const senderName = extractDisplayName(candidate.sender) ?? "";
			const evidence: EmailHop2ProbeEvidence = {};

			if (probes.includes("calendar")) {
				try {
					const nowMs = Date.now();
					const events = await listCalendarEvents(candidate.account, {
						calendarId: "primary",
						timeMin: new Date(nowMs - 2 * 86_400_000).toISOString(),
						timeMax: new Date(nowMs + 21 * 86_400_000).toISOString(),
						maxResults: 25,
					});
					const nameTokens = senderName
						.toLowerCase()
						.split(/\s+/)
						.filter((w) => w.length >= 3);
					const matched = events.filter((ev) => {
						const hay = `${ev.summary} ${ev.description} ${ev.attendees.map((a) => a.email).join(" ")}`.toLowerCase();
						if (senderEmail && hay.includes(senderEmail)) return true;
						return nameTokens.some((tok) => hay.includes(tok));
					});
					const chosen = matched.length > 0 ? matched : events.slice(0, 8);
					evidence.calendarEvents = chosen.map(
						(ev) =>
							`${ev.summary} | ${ev.start} to ${ev.end}${ev.attendees.length > 0 ? ` (attendees: ${ev.attendees.map((a) => a.email).join(", ")})` : ""}`,
					);
				} catch {
					evidence.calendarEvents = [];
				}
			}

			if (probes.includes("tasks")) {
				try {
					let query = client
						.from("user_tasks")
						.select("title, status, due_date")
						.not("status", "in", "(done,cancelled)")
						.limit(15);
					if (effectiveUserId) query = query.eq("user_id", effectiveUserId);
					const { data } = await query;
					const rows = (data ?? []) as Array<{ title?: string; status?: string; due_date?: string | null }>;
					evidence.openTasks = rows
						.filter((r) => Boolean(r.title))
						.map((r) => `${r.title} [status: ${r.status ?? "todo"}${r.due_date ? `, due: ${r.due_date}` : ""}]`);
				} catch {
					evidence.openTasks = [];
				}
			}

			if (probes.includes("drive")) {
				try {
					const subjectStem = candidate.subject.replace(/^(re|fwd):\s*/gi, "").trim().slice(0, 40);
					let query = client
						.from("artifacts")
						.select("title, source_url")
						.eq("source_channel", "google_drive")
						.limit(5);
					if (subjectStem.length >= 3) query = query.ilike("title", `%${subjectStem}%`);
					if (effectiveUserId) query = query.eq("user_id", effectiveUserId);
					const { data } = await query;
					evidence.driveFiles = ((data ?? []) as Array<{ title?: string; source_url?: string | null }>)
						.filter((r) => Boolean(r.title))
						.map((r) => `${r.title}${r.source_url ? ` (${r.source_url})` : ""}`);
				} catch {
					evidence.driveFiles = [];
				}
			}

			if (probes.includes("graph_artifacts")) {
				try {
					const subjectStem = candidate.subject.replace(/^(re|fwd):\s*/gi, "").trim().slice(0, 40);
					let query = client
						.from("artifacts")
						.select("title, content_subtype, created_at")
						.limit(5);
					if (subjectStem.length >= 3) query = query.ilike("title", `%${subjectStem}%`);
					if (effectiveUserId) query = query.eq("user_id", effectiveUserId);
					const { data } = await query;
					evidence.graphArtifacts = (
						(data ?? []) as Array<{ title?: string; content_subtype?: string | null; created_at?: string | null }>
					)
						.filter((r) => Boolean(r.title))
						.map((r) => `${r.title} (${r.content_subtype ?? "artifact"}, ${r.created_at ?? ""})`);
				} catch {
					evidence.graphArtifacts = [];
				}
			}

			return evidence;
		},

		async backfillContactEmail(
			contactId: string,
			email: string,
			userId?: string,
		): Promise<void> {
			const cleanEmail = email.trim().toLowerCase();
			if (!contactId || !cleanEmail) return;
			const effectiveUserId = userId ?? getUserId();
			let query = client
				.from("people")
				.update({ email: cleanEmail, last_contact: new Date().toISOString() })
				.eq("id", contactId)
				.is("email", null);
			if (effectiveUserId) {
				query = query.eq("user_id", effectiveUserId);
			}
			const { error } = await query;
			if (error) throw new Error(error.message);
			personCache.clear();
		},

		async createContact(
			candidate: GmailTriageThreadCandidate,
			signals: EmailSignals,
			userId?: string,
		): Promise<{ contact_id: string } | null> {
			const cleanEmail = signals.senderAddress.trim().toLowerCase();
			if (!cleanEmail) return null;
			const existing = await findPerson(cleanEmail, signals.senderName, true);
			if (existing?.id) return { contact_id: existing.id };
			const effectiveUserId = userId ?? getUserId();
			const payload: Record<string, unknown> = {
				name: (signals.senderName ?? "").trim() || cleanEmail,
				email: cleanEmail,
				last_contact: candidate.received_at || new Date().toISOString(),
			};
			if (effectiveUserId) payload.user_id = effectiveUserId;
			const { data, error } = await client
				.from("people")
				.insert(payload)
				.select("id")
				.limit(1);
			if (error) throw new Error(error.message);
			personCache.clear();
			const row = Array.isArray(data) ? (data[0] as { id?: string } | undefined) : undefined;
			return row?.id ? { contact_id: row.id } : null;
		},
	};
}

export const gmailPriorityTriagePort: GmailPriorityTriagePort =
	createGmailPriorityTriagePort();
