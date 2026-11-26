import { z } from "zod";
import { ARTIFACT_SURFACES, deriveArtifactTitle, slugify } from "../../domain/artifacts.js";
import {
	DOMAIN_LEGACY_SCOPE,
	DOMAIN_PROVIDER,
	LEGACY_DOMAIN_VALUE,
	reconcileDomain,
} from "../../domain/domains.js";
import {
	notionConfigSchema,
	notionPersonalConfigSchema,
	type NotionConfig,
	type NotionPersonalConfig,
} from "../../domain/integrations.js";
import type { PriorityLevel } from "../../domain/priorityScale.js";
import { TASK_REQUEST_CONTENT_SUBTYPE } from "../../domain/vocab.js";
import type { ArtifactRepository } from "../../ports/artifacts.js";
import type { ConfigRepository } from "../../ports/config.js";
import type { EntityRepository, LinkRepository } from "../../ports/entities.js";
import type { ExternalLinkRepository } from "../../ports/externalLinks.js";
import type { NotionApiError, NotionPageResponse, NotionPort } from "../../ports/notion.js";
import type { StoragePort } from "../../ports/storage.js";
import { createTaskSchema, type CreateTaskResult } from "../domain/tasks.js";
import { markdownToBlocks } from "../notion/blocks.js";
import { readDatabaseProperties } from "../notion/schemaGuard.js";
import {
	extractNotionPageId,
	isOpenStatus,
	notionDuplicateText,
	readTitleText,
	resolveClosedStatusNames,
	skippedDuplicateText,
	statusValueName,
	titlesMatch,
	tomorrowDateOnly,
	type TaskStatusPropertyShape,
} from "./createTaskRules.js";
import {
	assertDuePropertyUsable,
	buildNotionProperties,
	DEFAULT_PRIORITY_CANDIDATES,
	pickDefaultPriority,
	resolvePriorityLevel,
	resolvePriorityTier,
	resolvePropertyName,
	type CreateTaskPropertiesInput,
	type NotionDatabaseSchema,
} from "./taskProperties.js";

/** The core ports `task_create`'s body runs over (ADR-101 §1, #1662). */
export interface CreateTaskPorts {
	notion: Pick<NotionPort, "queryDataSource" | "retrieveDatabase" | "createPage"> &
		Partial<Pick<NotionPort, "retrieveDataSource">>;
	config: Pick<ConfigRepository, "loadConfig">;
	links: Pick<
		ExternalLinkRepository,
		| "inspectDedupSlot"
		| "claimDedupSlot"
		| "finalizeExternalLink"
		| "recordExternalLink"
		| "releaseClaimForFailedWrite"
		| "interruptedClaimMessage"
	>;
	artifacts: Pick<ArtifactRepository, "insert">;
	storage: Pick<StoragePort, "upload" | "remove" | "publicUrl">;
	entities: Pick<EntityRepository, "getById">;
	entityLinks: Required<Pick<LinkRepository, "upsert">>;
	storageBucket: string | (() => string);
}

type CreatedNotionPage = { id: string; url: string };
type NotionPage = NotionPageResponse;
type NotionPropertyValue = TaskStatusPropertyShape & { relation?: Array<{ id: string }> };
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * `errorText` minus a core Supabase adapter's own prefix (e.g. `Entities get failed: `), so
 * the text reads as `dev`'s raw Postgres message did before the body moved (#1662).
 */
const adapterErrorText = (prefix: string) => (error: unknown) => {
	const text = errorText(error);
	return text.startsWith(prefix) ? text.slice(prefix.length) : text;
};
const entitiesGetErrorText = adapterErrorText("Entities get failed: ");
const linkUpsertErrorText = adapterErrorText("Upsert artifact_entity_links failed: ");

/** Rewords a port's `NotionApiError` as `dev` worded it, so no output text moves (#1662). */
async function notionCall<T>(label: string, call: () => Promise<T>): Promise<T> {
	try {
		return await call();
	} catch (error) {
		if (!(error instanceof Error) || error.name !== "NotionApiError") throw error;
		const detail = error.message.replace(/^Notion API error \(\d+\): /, "");
		throw new Error(
			`Notion ${label} failed (${(error as NotionApiError).status ?? 500}): ${detail}`,
			{ cause: error },
		);
	}
}

/**
 * Auto-capture the message that requested a task as its source artifact (issue #413:
 * every task should be traceable back to the thought that produced it). Called ONLY when
 * `task_create` is invoked without an `artifact_id` — the request itself IS the source, so
 * there is no ambiguity about which artifact the task belongs to.
 *
 * Stamped `content_subtype='task_request'` (the "distinct provenance" path chosen over the
 * normal capture path): it deliberately does NOT go through `capture`'s routing (default
 * tags / channel maps) and is NOT embedded, so one-line task requests ("add task: buy
 * milk") stay lean and don't crowd search — `knowledge_search` excludes this subtype by
 * default (opt in with `include_task_requests`). The artifacts-row shape mirrors
 * `capture.ts`'s insert (kept in sync by hand — the two writers must agree on the NOT NULL
 * storage_* fields); the divergences are intentional: no routing, no embed, and the
 * provenance marker.
 *
 * Best-effort: returns `{ ok: false }` instead of throwing, so a provenance-capture
 * failure never blocks the task itself — the task in Notion is the deliverable; its source
 * link is metadata (same stance as `recordExternalLink`). On a failed artifacts insert the
 * just-uploaded storage object is cleaned up so a failure doesn't orphan it.
 */
async function captureTaskRequestArtifact(
	ports: Pick<CreateTaskPorts, "artifacts" | "storage" | "storageBucket">,
	ownerId: string,
	text: string,
	titleHint: string,
	account: string,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
	const id = globalThis.crypto.randomUUID();
	const bucket =
		typeof ports.storageBucket === "function" ? ports.storageBucket() : ports.storageBucket;
	// Title from the task title (`titleHint`, always a non-empty string) so the provenance
	// artifact reads cleanly in any listing and the derivation can never fall through to
	// null even on a whitespace-only `source_text`; the full request lives in plain_text.
	const title = deriveArtifactTitle({ explicitTitle: titleHint, text })!;
	const filename = `${slugify(title)}-${id.slice(0, 8)}.md`;
	const storagePath = `notes/${ownerId}/${id}.md`;

	const uploadError = await ports.storage
		.upload(bucket, storagePath, text, { contentType: "text/markdown" })
		.then(() => null, errorText);
	if (uploadError) {
		return { ok: false, error: `storage upload failed: ${uploadError}` };
	}

	const error = await ports.artifacts.insert({
		id,
		user_id: ownerId,
		storage_bucket: bucket,
		storage_path: storagePath,
		storage_url: ports.storage.publicUrl(bucket, storagePath),
		filename,
		original_file_name: filename,
		file_type: "text/markdown",
		content_type: "text/markdown",
		file_extension: "md",
		file_size: new TextEncoder().encode(text).length,
		artifact_type: "original",
		captured_at: new Date().toISOString(),
		// Provenance (ADR-026; ADR-046 §2/§3, #736). Act-path receipts have no
		// EXTERNAL surface to copy — nobody sent this row in, the system wrote it
		// from a request it was handed — but "system-written receipt" is itself an
		// envelope fact, and a nameable one. Shared with createEvent.ts's twin of
		// this function (#584) by design: ADR-046 §3 stores one role per surface,
		// and the policy for both is identical — the task-vs-event distinction
		// already rides on content_subtype, which is what knowledge_search
		// excludes on.
		surface: ARTIFACT_SURFACES.actReceipt,
		lifecycle_stage: "uploaded",
		processing_status: "pending",
		title,
		plain_text: text,
		tags: [`account:${account}`],
		content_subtype: TASK_REQUEST_CONTENT_SUBTYPE,
	}).then(() => null, errorText);

	if (error) {
		// Best-effort cleanup so a failed insert doesn't orphan the storage object.
		await ports.storage.remove(bucket, [storagePath]).catch(() => {});
		return { ok: false, error: `artifact insert failed: ${error}` };
	}

	return { ok: true, id };
}

type Workspace = NonNullable<z.infer<typeof createTaskSchema>["workspace"]>;

/**
 * `workspace` is required and never defaulted (#820) — the same rule state_doc_update,
 * notion_page_get and notion_page_update enforce (ADR-054 §9). The two workspaces are
 * separate Notion integrations with separate tasks databases and separate tokens, so a
 * default is not a convenience: it is a coin flip that reports success either way.
 */
function requireWorkspace(args: { domain?: string; workspace?: string }): Workspace {
	const domain = reconcileDomain(args.domain, args.workspace, "workspace");
	if (!domain) {
		throw new Error(
			"`domain` is required to create a task — 'work' (the Work workspace) or 'angus' (the personal one). There is no default: each domain has its own tasks database and its own token, and a task written to the wrong one looks exactly like a task written to the right one.",
		);
	}
	// DOMAIN_PROVIDER, not a second map: `provider` is part of the marker ledger's
	// unique key, so the domain -> provider answer has to be the same one every
	// other writer gets (domains.ts).
	return DOMAIN_PROVIDER[domain] as Workspace;
}

/** The Notion page a request produced, plus the response notes gathered on the way. */
type TaskCreation = {
	page: CreatedNotionPage;
	/** Config/default notes, already in response order. */
	notes: string;
};

type WorkspaceConfig = NotionConfig | NotionPersonalConfig;

/**
 * Load the target workspace's integration config, throwing the same clear "not
 * configured" error every workspace-aware tool throws. Split out of `createTaskInNotion`
 * (#734) so the handler can load it ONCE, up front — before the Tasks-DB duplicate guard
 * below, which needs the config's `tasks_database_id`/`*_data_source_id`/`property_map`
 * — rather than loading it a second time inside `createTaskInNotion`.
 */
async function loadWorkspaceConfig(
	ports: Pick<CreateTaskPorts, "config">,
	workspace: Workspace,
): Promise<WorkspaceConfig> {
	const config =
		workspace === "notion_personal"
			? await ports.config.loadConfig("notion_personal", notionPersonalConfigSchema)
			: await ports.config.loadConfig("notion_work", notionConfigSchema);
	if (!config) {
		const label = workspace === "notion_personal" ? "personal" : "Work";
		throw new Error(
			`No Notion ${label} integration configured. Add a '${workspace}' row to user_integrations with { tasks_database_id } for this user (see migration 046 / .claude/skills/create-task).`,
		);
	}
	return config;
}

/**
 * The data source id to QUERY the workspace's tasks database through (#734). Notion's
 * 2025-09-03 API split the database into data sources; `queryNotionDataSource` (the read
 * side used by the Tasks-DB duplicate guard) takes a data source id, not the database id
 * `createNotionTask` writes through. The two schemas name this pointer differently for
 * historical reasons (`integrations.ts`'s per-key comments): the Work config calls it
 * `tasks_source_data_source_id`, the personal config `tasks_data_source_id`. Neither name
 * is renamed here — a live config key rename breaks every row already written.
 *
 * Returns `undefined` when the workspace has no data source id wired yet, which the
 * caller treats as "the guard cannot run" rather than an error — the pointer is optional
 * config, not a required one, precisely so an unconfigured workspace doesn't start
 * failing every task_create call the day this guard ships.
 */
function resolveTasksDataSourceId(
	workspace: Workspace,
	config: WorkspaceConfig,
): string | undefined {
	return workspace === "notion_personal"
		? (config as NotionPersonalConfig).tasks_data_source_id
		: (config as NotionConfig).tasks_source_data_source_id;
}

/**
 * The Tasks-DB duplicate guard itself (issue #734 / ADR-040's erratum, #413): before
 * creating, consult the target Tasks database — the system of record — for an OPEN task
 * whose title matches this one (exact, case-insensitive, trimmed) or whose configured
 * relation property already points at the same source page(s) the caller is about to
 * link (`properties.relation`, when given). This is what the ledger-only guards
 * (single_task/dedup_key) cannot do: they only see tasks `create_task` itself wrote
 * (`artifact_external_links`), so a task entered straight into Notion, or one that
 * actually landed after an ambiguous Notion failure, is invisible to them.
 *
 * One Notion API call (POST /v1/data_sources/{id}/query), filtered server-side to a
 * superset of true matches — `title contains <trimmed title>` (Notion's own contains
 * filter is case-insensitive) OR'd with a relation-contains filter per candidate page id
 * — then narrowed to an exact, case-insensitive, trimmed title match (or a relation hit)
 * client-side, since Notion's filter grammar has no case-insensitive EQUALS. Only pages
 * whose (mapped) status resolves to "open" per `isOpenStatus` count as a match.
 *
 * Returns `null` when the guard cannot run at all (no data source id wired for this
 * workspace) or when it ran and found nothing. On a Notion QUERY ERROR (network, auth,
 * 5xx, …) this degrades to `null` — the guard could not consult the system of record, so
 * task_create proceeds as if unguarded rather than blocking a legitimate create on a
 * transient read failure. This is a deliberate choice, not an oversight: it matches every
 * other best-effort ledger read in this codebase (`inspectDedupSlot`/`getExternalLinks`
 * degrade to "free"/`[]` on a read error, `claimDedupSlot` degrades to the pre-existing
 * best-effort path on a non-conflict error) and this repo's stated risk posture (AGENTS.md:
 * "move fast and break things... An outage here costs that user some minutes and nothing
 * else"). The caller is told this happened via a note in the response text — it is never
 * silent — so a genuinely important duplicate check can be re-run once Notion recovers.
 */
async function findExistingNotionTask(opts: {
	notion: CreateTaskPorts["notion"];
	config: WorkspaceConfig;
	workspace: Workspace;
	title: string;
	relation?: { property: string; page_ids: string[] };
}): Promise<{ match: NotionPage | null; queryFailed?: string }> {
	const dataSourceId = resolveTasksDataSourceId(opts.workspace, opts.config);
	if (!dataSourceId) return { match: null };

	const trimmedTitle = opts.title.trim();
	const titleProperty = opts.config.title_property;
	// Round-1 QA (#734): unlike setting a property (where a wrong guessed name is caught
	// immediately by schema introspection, e.g. `assertDuePropertyUsable`), a guessed
	// relation name used in a QUERY FILTER fails the whole request if it's wrong — Notion
	// 400s the combined title-OR-relation filter, and the catch below degrades to
	// fail-open, silently losing title-based duplicate detection too. So this reads
	// `property_map` directly rather than through `resolvePropertyName`: an unmapped
	// relation key means "relation matching unavailable for this workspace", which
	// degrades to title-only matching (still correct), not a guessed name that can break
	// the whole query.
	const relationPropertyName = opts.relation
		? opts.config.property_map[opts.relation.property]
		: undefined;

	const titleCondition = trimmedTitle
		? { property: titleProperty, title: { contains: trimmedTitle } }
		: undefined;
	const relationConditions =
		relationPropertyName && opts.relation
			? opts.relation.page_ids.map((id) => ({
					property: relationPropertyName,
					relation: { contains: id },
				}))
			: [];
	const conditions = [
		...(titleCondition ? [titleCondition] : []),
		...relationConditions,
	];
	if (conditions.length === 0) return { match: null };
	const filter = conditions.length === 1 ? conditions[0] : { or: conditions };

	const relationPageIds = new Set(opts.relation?.page_ids ?? []);
	const statusPropertyName = resolvePropertyName("status", opts.config.property_map);
	const closedStatusNames = resolveClosedStatusNames(opts.config, dataSourceId, statusPropertyName);

	// Round-1 QA (#734): follow Notion's cursor pagination to the end (like
	// `listNotionUsers`/`listNotionBlockChildren`) instead of only ever reading page one —
	// a common/short title substring against a large Tasks DB can plausibly have more than
	// 100 server-side `contains` matches, and a real duplicate on page 2+ was previously
	// invisible to this guard. The loop still returns at the FIRST genuine match, so this
	// only costs extra requests on the (correct, non-duplicate) case where none of the
	// matches pan out. `MAX_QUERY_PAGES` bounds the worst case (1,000 candidate rows) so a
	// pathological Tasks DB can't turn a duplicate check into an unbounded read; beyond
	// that the guard degrades the same way an unconfigured workspace does — no match found.
	const MAX_QUERY_PAGES = 10;
	let cursor: string | undefined;
	let pagesRead = 0;

	try {
		do {
			const page = await notionCall("data source query", () =>
				opts.notion.queryDataSource({
					workspace: LEGACY_DOMAIN_VALUE[opts.workspace],
					dataSourceId,
					filter,
					pageSize: 100,
					cursor,
				}),
			);
			pagesRead += 1;

			for (const result of page.results) {
				if (result.archived) continue;
				const props = (result.properties ?? {}) as Record<string, NotionPropertyValue>;
				const titleHit = titleCondition
					? titlesMatch(readTitleText(props[titleProperty]), trimmedTitle)
					: false;
				const relationHit =
					relationPropertyName && relationPageIds.size > 0
						? (props[relationPropertyName]?.relation ?? []).some((r) => relationPageIds.has(r.id))
						: false;
				if (!titleHit && !relationHit) continue;
				const statusName = statusValueName(props[statusPropertyName]);
				if (!isOpenStatus(statusName, closedStatusNames)) continue;
				return { match: result };
			}

			cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
		} while (cursor && pagesRead < MAX_QUERY_PAGES);
	} catch (error) {
		return { match: null, queryFailed: errorText(error) };
	}

	return { match: null };
}

/**
 * The tasks database's schema, flattened as `dev`'s `retrieveDatabaseSchema` flattened it.
 * Read through `readDatabaseProperties` because a database no longer carries its own
 * properties under the SDK's Notion-Version (#2285).
 */
async function loadTasksSchema(
	ports: Pick<CreateTaskPorts, "notion">,
	workspace: Workspace,
	config: WorkspaceConfig,
): Promise<NotionDatabaseSchema> {
	const read = await notionCall("retrieve database", () =>
		readDatabaseProperties(ports.notion, {
			workspace: LEGACY_DOMAIN_VALUE[workspace],
			databaseId: config.tasks_database_id,
			dataSourceId: resolveTasksDataSourceId(workspace, config),
		}),
	);
	const raw = read.properties ?? {};
	return {
		properties: Object.keys(raw).map((name) => {
			const prop = raw[name];
			const type = prop?.type ?? "unknown";
			const holder =
				type === "select" || type === "multi_select" || type === "status" ? prop?.[type] : undefined;
			const options = holder?.options?.map((o) => o.name).filter(Boolean);
			return { name, type, ...(options && options.length > 0 ? { options } : {}) };
		}),
	};
}

/**
 * Everything between claiming the dedup slot and the Notion page existing: apply the
 * triage defaults, introspect + build properties, and create the page. `config` is
 * preloaded by the handler (#734: the Tasks-DB duplicate guard needs it earlier too, so
 * loading it here a second time would cost an extra `user_integrations` read for no
 * reason).
 *
 * This is a function rather than inline code so the boundary is structural instead of a
 * comment: **every throw in here happens with no Notion page created**, which is exactly
 * the condition under which the caller may release its dedup claim (issue #653). Adding
 * a step after `createNotionTask` inside this function would silently break that — put
 * post-write work in the handler, below the try.
 *
 * The one exception is inside `createNotionTask` itself, where Notion can accept the
 * create and then fail to deliver a readable response. That throws
 * `ExternalItemCreatedButUnreadable`, which `releaseClaimForFailedWrite` refuses to
 * release on, so the invariant the caller relies on holds end to end.
 */
async function createTaskInNotion(
	ports: Pick<CreateTaskPorts, "notion">,
	args: z.infer<typeof createTaskSchema>,
	workspace: Workspace,
	config: WorkspaceConfig,
	forPersonPageId: string | null = null,
): Promise<TaskCreation> {
	// Two different questions, deliberately kept apart (#817).
	//
	// `dueName` is WHICH Notion property a due date goes in. It now resolves like every
	// other abstract key — property_map first, then DEFAULT_PROPERTY_NAMES — instead of
	// reading property_map directly. Both workspaces have an empty property_map, so the
	// direct read meant every due date ever passed was silently dropped.
	//
	// `dueMapped` is whether the OWNER opted this database into automatic dating, and it
	// still keys on an explicit property_map entry. Fixing the name lookup must not, as a
	// side effect, switch on the #298 tomorrow-default for every task on both workspaces:
	// that is a live behavioural change with real blast radius and it is Angus's call, not
	// this fix's (#817 "explicitly out of scope"). Today no workspace maps `due`, so the
	// default stays off exactly as it has always been.
	const dueName = resolvePropertyName("due", config.property_map);
	const dueMapped = Boolean(config.property_map.due);

	// Triage default 1/2 (issue #298, per docs/design/capture-skill-consolidation.md):
	// Due = tomorrow when the caller gives no due date. Task-metadata defaults live HERE,
	// at task creation — capture never sets due/priority (ADR-018 dumb capture). Gated on
	// an explicitly mapped 'due' property, and made explicit in the response below rather
	// than applied silently. Inference is the skill layer's half of the contract: the
	// create-task skill passes an explicit `due` when the request states/implies one, so
	// this default only fires for genuinely undated requests.
	let effectiveDue = args.due;
	let dueDefaultNote = "";
	if (!effectiveDue && dueMapped) {
		effectiveDue = tomorrowDateOnly();
		dueDefaultNote = `\nDefaulted due date to tomorrow (${effectiveDue}) — no due date was given (triage default); pass 'due' to override.`;
	}

	// Fast path (preserved): only introspect the database schema when the caller actually
	// passes a `properties` object. This keeps the common case (just title/notes/due) at
	// exactly one Notion API call, as before this field existed. Passing `properties: {}`
	// (no keys set) still opts in — that's how a caller gets the "assign to me unless
	// clearly someone else" owner default without setting any other property explicitly.
	const hasSuppliedProperties = args.properties !== undefined;

	// Triage default 2/2 (issue #298): Priority = top tier when the caller gives none.
	// Choosing a value the DB actually accepts requires the introspected schema, so the
	// default applies when introspection happens anyway (`properties` supplied) OR when
	// the integration maps a 'priority' property — an explicit config opt-in that this
	// tasks DB has a priority worth defaulting, mirroring how the due default keys on the
	// 'due' mapping. Unmapped-and-no-properties keeps the one-API-call fast path intact.
	const priorityMapped = Boolean(config.property_map.priority);
	const wantsPriorityDefault =
		args.properties?.priority === undefined &&
		args.properties?.priority_tier === undefined &&
		args.properties?.priority_level === undefined &&
		(hasSuppliedProperties || priorityMapped);

	// Check the due property against the live schema only when the NAME WAS GUESSED.
	//
	// An explicit `property_map.due` entry is the owner asserting that property exists, so
	// trusting it keeps the one-API-call fast path for a configured workspace (and a wrong
	// mapping still fails loudly, as a Notion 400). A fallback name is OUR guess, and #817
	// exists precisely because a wrong guess used to be silent — so a guessed name is
	// verified before anything is written, and the error names the property, the workspace
	// and the date properties that DO exist.
	const needsDueCheck = Boolean(effectiveDue) && !dueMapped;
	const wantsForPersonRelation = Boolean(forPersonPageId);

	let notionProperties: Record<string, unknown> | undefined;
	let priorityDefaultNote = "";
	if (hasSuppliedProperties || wantsPriorityDefault || needsDueCheck || wantsForPersonRelation) {
		// Introspect with the SELECTED workspace's token, same as the create call below
		// — the personal tasks DB is not visible to the Work credential (#424).
		const schema = await loadTasksSchema(ports, workspace, config);

		if (needsDueCheck) assertDuePropertyUsable(schema.properties, dueName, workspace);

		let effectiveProperties: CreateTaskPropertiesInput = {
			...(args.properties ?? {}),
			priority_level: args.properties?.priority_level as PriorityLevel | undefined,
		};
		if (forPersonPageId) {
			effectiveProperties = {
				...effectiveProperties,
				for_person: {
					property: "for_person",
					page_ids: [forPersonPageId],
				},
			};
		}
		if (args.properties?.priority_level !== undefined) {
			const level = args.properties.priority_level as PriorityLevel;
			const priorityPropName = resolvePropertyName("priority", config.property_map);
			const res = resolvePriorityLevel(schema.properties, priorityPropName, level);
			if ("applied" in res) {
				effectiveProperties = { ...effectiveProperties, priority: res.applied };
				delete effectiveProperties.priority_level;
				priorityDefaultNote = `\nPriority level ${level} resolved to '${res.applied}'.`;
			} else if (res.skipped === "no-tier-option") {
				throw new Error(
					`task_create: priority_level ${level} has no option on '${priorityPropName}' in the '${workspace}' tasks database: tried ${res.tried.join(", ")}; it offers ${res.options.join(", ")}.`,
				);
			} else {
				throw new Error(
					`task_create: priority_level ${level} has no option on '${priorityPropName}' in the '${workspace}' tasks database: '${priorityPropName}' is missing or not a select/status.`,
				);
			}
		} else if (args.properties?.priority_tier !== undefined) {
			const tier = args.properties.priority_tier;
			const priorityPropName = resolvePropertyName("priority", config.property_map);
			const res = resolvePriorityTier(schema.properties, priorityPropName, tier);
			if ("applied" in res) {
				effectiveProperties = { ...effectiveProperties, priority: res.applied };
				delete effectiveProperties.priority_tier;
				priorityDefaultNote = `\nPriority tier ${tier} resolved to '${res.applied}'.`;
			} else if (res.skipped === "no-tier-option") {
				throw new Error(
					`task_create: priority_tier ${tier} has no option on '${priorityPropName}' in the '${workspace}' tasks database: tried ${res.tried.join(", ")}; it offers ${res.options.join(", ")}.`,
				);
			} else {
				throw new Error(
					`task_create: priority_tier ${tier} has no option on '${priorityPropName}' in the '${workspace}' tasks database: '${priorityPropName}' is missing or not a select/status.`,
				);
			}
		} else if (wantsPriorityDefault) {
			const pick = pickDefaultPriority(
				schema.properties,
				resolvePropertyName("priority", config.property_map),
			);
			if ("applied" in pick) {
				effectiveProperties = { ...effectiveProperties, priority: pick.applied };
				priorityDefaultNote = `\nDefaulted priority to '${pick.applied}' — no priority was given (triage default); pass properties.priority to override.`;
			} else if (priorityMapped) {
				// The config opted in (mapped a priority) but the default couldn't apply —
				// say so rather than silently creating an unprioritised task that ADR-040 §3
				// warns will sink to the bottom tier. When the caller merely supplied other
				// properties and the DB has no select-like priority at all, stay quiet:
				// nothing was promised.
				const reason =
					pick.skipped === "property-missing"
						? "the mapped priority property is missing or not a select/status"
						: `none of ${DEFAULT_PRIORITY_CANDIDATES.join("/")} is a configured option`;
				priorityDefaultNote = `\n(note: no priority default applied — ${reason})`;
			}
		}

		notionProperties = await buildNotionProperties({
			tasksDatabaseId: config.tasks_database_id,
			propertyMap: config.property_map,
			properties: effectiveProperties,
			// The owner default remains coupled to the caller explicitly opting into
			// `properties` (pre-#298 behaviour, unchanged): entering this path solely to
			// default a priority must not start silently assigning owners too.
			defaultOwnerPersonId: hasSuppliedProperties ? config.notion_user_id : undefined,
			schema,
		});
	}

	const properties: Record<string, unknown> = {
		[config.title_property]: { title: [{ text: { content: args.title } }] },
	};
	if (effectiveDue && dueName) properties[dueName] = { date: { start: effectiveDue } };
	if (notionProperties) Object.assign(properties, notionProperties);
	const page = await notionCall("create page", () =>
		ports.notion.createPage({
			// Authenticate with the token for the SELECTED workspace, not always the work
			// token — otherwise a notion_personal task hits the personal DB id with the
			// Work credential and 404s/401s (issue #424 defect 1).
			workspace: LEGACY_DOMAIN_VALUE[workspace],
			databaseId: config.tasks_database_id,
			properties,
			children: args.notes ? (markdownToBlocks(args.notes) as Record<string, unknown>[]) : [],
		}),
	);

	// The note that used to live here ("a due date was given but no 'due' property is
	// mapped, so it was skipped") is gone: an unplaceable due date now raises above,
	// before the page is created, rather than reporting success with the date missing.
	return { page, notes: `${dueDefaultNote}${priorityDefaultNote}` };
}

/**
 * Create a task in the user's external task system (currently Notion). Which workspace
 * to write to is chosen by the caller via `workspace` (issue #145 gap 1) — required,
 * 'notion_work' or 'notion_personal', with no default (#820). The database id +
 * property names come from that workspace's persisted
 * user_integrations row; the API token comes from env. Both are per-user wiring kept
 * out of the shared skill.
 *
 * Triage defaults (issue #298, per docs/design/capture-skill-consolidation.md): when the
 * caller omits a due date, it defaults to tomorrow (if a 'due' property is mapped); when
 * the caller omits a priority, it defaults to the top priority tier the DB accepts
 * (first of High/P1/P0 — ADR-040 §3's tier 1), applied when introspection happens anyway
 * or the config maps a 'priority' property. These defaults live HERE because task
 * metadata is a task-creation concern — capture must never set due/priority (ADR-018
 * dumb capture). Both are explicit in the response text, never silent; "unless
 * inferable" is the create-task skill's half (it passes explicit values inferred from
 * the request, which win over the defaults).
 *
 * Provenance (issue #413): every task should be traceable back to the thought that
 * produced it. When the caller supplies `artifact_id`, the task links to it. When it does
 * NOT, the requesting message (`source_text`, or the title as a thin fallback) is
 * auto-captured as the task's source artifact — via `captureTaskRequestArtifact`, which
 * marks it `content_subtype='task_request'` (distinct provenance, kept out of
 * knowledge_search by default). Either way the task ends up with a source rather than
 * none. This replaces the old "no artifact_id → no lineage at all" behaviour.
 *
 * Dedup (issue #141): eager Act (at capture, e.g. process_artifact Step 7) and a later
 * EOD Act pass over the same atom must not both create a task from it. Two guards, both
 * requiring a CALLER-SUPPLIED `artifact_id` (they exist to dedup against an atom that may
 * already have been actioned; the auto-captured provenance artifact above is brand new and
 * has no prior links, so it is never subject to these guards):
 *   - `single_task`: skip if the artifact already has ANY kind='task' link (1:1 case).
 *   - `dedup_key`: skip if the artifact already has a kind='task' link with this exact
 *     key (1:N case — several tasks spawned from one atom, deduped individually).
 *
 * Concurrency (round-1 review follow-up): a plain pre-check (SELECT) then
 * create-then-best-effort-link has a check-then-act race — two concurrent calls with
 * the same dedup key can both pass the check and both create a real Notion page before
 * either records a link. When a dedup guard is active, this claims a slot on migration
 * 064's partial unique index via `claimDedupSlot` (a raw INSERT, not an upsert — see
 * that function's doc comment for why supabase-js/PostgREST cannot express the
 * partial-index predicate as an `onConflict` target) BEFORE calling Notion at all. The
 * loser of a race gets a real `23505` unique-violation back from the claim attempt,
 * which is reported as a skipped duplicate — Notion is never called on the losing path.
 * `inspectDedupSlot` still runs first as a cheap pre-check to avoid claim-row churn in
 * the common (non-racing) case; the claim is what actually closes the race, not the
 * pre-check.
 *
 * Failure semantics of a claim (issue #653). A claim is a promise to reach one of two
 * terminal states, and this handler makes all three outcomes explicit:
 *   - **The Notion write throws** → the claim is released (`releaseClaimForFailedWrite`)
 *     and the error propagates. No page exists, so releasing cannot resurrect a
 *     duplicate; and a retry finds a free slot instead of a permanent block. The sole
 *     throw that does not carry that guarantee — Notion accepting the create and then
 *     failing to return a readable body — is raised as
 *     `ExternalItemCreatedButUnreadable` and is not released on, so it lands in the
 *     pending case below instead of double-creating.
 *   - **The Notion write succeeds** → the release window is closed. Everything after it
 *     (provenance capture, `finalizeExternalLink`) is best-effort and never releases, so
 *     a failure there leaves a pending row rather than stripping the slot for a task
 *     that really is in Notion.
 *   - **A pending row is already there** → reported as an unfinished claim, not a
 *     duplicate, with the statement that clears it. It is deliberately not auto-reclaimed:
 *     the row may belong to an in-flight call (reclaiming double-creates) or to one whose
 *     page landed before its finalize was lost (reclaiming double-creates). Per ADR-040's
 *     erratum (#413) the ledger is not the duplicate guard — the Tasks DB is — so the
 *     resolution is a look at the system of record, which no ledger-side heuristic can
 *     substitute for.
 */
export async function runCreateTask(
	ports: CreateTaskPorts,
	args: z.infer<typeof createTaskSchema>,
	ownerId: string,
): Promise<CreateTaskResult> {
	// Resolve the target workspace up front: it is BOTH which integration config to load
	// AND the `provider` value the dedup pre-check / claim / lineage link must be scoped
	// by (migration 064's unique index keys on provider), so a notion_personal task claims
	// its own slot and records its own lineage rather than colliding with notion_work.
	// No default (#820). The old `?? "notion_work"` was right about half the time,
	// which is worse than never guessing: the call succeeded, a task appeared, and
	// nothing signalled that it had landed in the wrong workspace. On 2026-08-08 that put
	// a personal wedding task on the Work board, caught only because someone happened
	// to open the returned URL.
	const workspace = requireWorkspace(args);
	if (args.properties?.priority !== undefined && args.properties?.priority_tier !== undefined) {
		throw new Error("task_create: pass properties.priority or properties.priority_tier, not both");
	}
	if (
		args.properties?.priority_level !== undefined &&
		(args.properties?.priority !== undefined || args.properties?.priority_tier !== undefined)
	) {
		throw new Error(
			"task_create: pass properties.priority_level, properties.priority, or properties.priority_tier, not more than one",
		);
	}
	let forPersonPageId: string | null = null;
	if (args.for_person_id) {
		const personEntity = await ports.entities.getById(args.for_person_id, ownerId).catch((err) => {
			throw new Error(`Failed to check person entity '${args.for_person_id}': ${entitiesGetErrorText(err)}`);
		});
		if (!personEntity) {
			throw new Error(`Person entity '${args.for_person_id}' not found for current user.`);
		}
		// entity_type='people' is the repo-wide person/entity split (see search.ts's
		// GraphKind doc-comment, migration 097) — reject any other kind (place, org,
		// project) rather than silently mining it for a Notion page id and mislabeling
		// the graph with notes:'promise_to' below (#1028 round-1 QA finding).
		if (personEntity.entity_type !== "people") {
			throw new Error(
				`Entity '${args.for_person_id}' is not a person (entity_type='${personEntity.entity_type}'); for_person_id requires entity_type='people'.`,
			);
		}
		forPersonPageId = extractNotionPageId(personEntity);
	}

	// Loaded ONCE, up front (#734): both the Tasks-DB duplicate guard below and
	// `createTaskInNotion` need it, and loading it here means the guard's extra Notion
	// read is the ONLY extra cost it adds — no second `user_integrations` round-trip.
	const config = await loadWorkspaceConfig(ports, workspace);

	// The Tasks-DB duplicate guard (issue #734 / ADR-040 erratum #413): runs BEFORE the
	// ledger-side single_task/dedup_key guard below and before any dedup slot is claimed,
	// because it is checking a different, more authoritative thing — whether the task
	// already exists in the system of record — and a match here means no claim should
	// ever be taken. Default ON; `skip_notion_dedup: true` skips this block entirely, so
	// the unguarded fast path pays no extra Notion call for it (issue #734 AC 3).
	let notionGuardFailureNote = "";
	if (!args.skip_notion_dedup) {
		const guard = await findExistingNotionTask({
			notion: ports.notion,
			config,
			workspace,
			title: args.title,
			relation: args.properties?.relation,
		});
		if (guard.match) {
			// Same lineage machinery the successful-create path uses below (#653's pattern,
			// reused rather than re-invented): no claim was ever taken on this path, so this
			// is always the best-effort `recordExternalLink` branch, never a finalize.
			const { provenanceNote, lineageNote } = await resolveArtifactAndRecordLineage(
				ports,
				ownerId,
				args,
				workspace,
				{ id: guard.match.id, url: guard.match.url },
			);
			return {
				status: "skipped_duplicate",
				title: args.title,
				pageId: guard.match.id,
				pageUrl: guard.match.url,
				deduplicated: true,
				message: `${notionDuplicateText({ title: args.title, page: guard.match, pageUrl: guard.match.url })}${provenanceNote}${lineageNote}`,
			};
		}
		// A note, not a silent pass: the guard couldn't consult the system of record, so
		// this create proceeds unguarded by it — see findExistingNotionTask's doc comment
		// for why that is the deliberate failure direction rather than blocking the create.
		notionGuardFailureNote = guard.queryFailed
			? `\n(Tasks-DB duplicate guard could not run: ${guard.queryFailed} - proceeded without it)`
			: "";
	}

	const dedupOn = Boolean(args.artifact_id) && (args.single_task || Boolean(args.dedup_key));
	let claimedLinkId: string | null = null;

	if (dedupOn && args.artifact_id) {
		// Cheap pre-check: in the common non-racing case, avoids leaving a claim row
		// behind for a request that was always going to be skipped anyway.
		const slot = await ports.links.inspectDedupSlot(args.artifact_id, workspace, "task", args.dedup_key);
		if (slot === "linked") {
			return {
				status: "skipped_duplicate",
				title: args.title,
				deduplicated: true,
				message: skippedDuplicateText({
					artifactId: args.artifact_id,
					dedupKey: args.dedup_key,
					singleTask: args.single_task,
				}),
			};
		}
		if (slot === "pending") {
			// An unfinished claim, not a task (issue #653). Refuse rather than reclaim: the
			// slot may belong to a call that is in flight right now, and it may equally
			// belong to one whose Notion page DID land before the finalize was lost —
			// reclaiming either would double-create. Refusing is the same outcome the old
			// boolean produced; saying WHICH refusal this is, and how to clear it, is the
			// fix.
			return {
				status: "interrupted_claim",
				title: args.title,
				deduplicated: false,
				message: ports.links.interruptedClaimMessage({
					artifactId: args.artifact_id,
					provider: workspace,
					kind: "task",
					dedupKey: args.dedup_key,
				}),
			};
		}

		// The actual race-closer: claim the dedup slot before ever calling Notion.
		const claim = await ports.links.claimDedupSlot(
			args.artifact_id,
			workspace,
			"task",
			args.dedup_key ?? null,
		);
		if (!claim.claimed) {
			if (claim.reason === "conflict") {
				return {
					status: "skipped_duplicate",
					title: args.title,
					deduplicated: true,
					message: skippedDuplicateText({
						artifactId: args.artifact_id,
						dedupKey: args.dedup_key,
						singleTask: args.single_task,
						raceLost: true,
					}),
				};
			}
			// Claim failed for an infra reason (e.g. migration 064 not applied) rather than
			// a real conflict — degrade to the pre-064 best-effort path instead of blocking
			// task creation on schema that isn't there yet. The residual race this reopens
			// is the same one the round-1 review flagged as pre-existing on this fallback.
			claimedLinkId = null;
		} else {
			claimedLinkId = claim.linkId;
		}
	}

	let created: TaskCreation;
	try {
		created = await createTaskInNotion(ports, args, workspace, config, forPersonPageId);
	} catch (error) {
		// The claim must not outlive the attempt that made it (issue #653). Every throw
		// inside `createTaskInNotion` happens with no Notion page created, so releasing here
		// cannot orphan a real task — and it cannot reintroduce the duplicate the claim
		// guards against either, because there is nothing yet to duplicate.
		//
		// This is the ONLY release site, and it sits above every post-write step on purpose:
		// once the page exists, a pending row is the safe state and must be left alone.
		throw await ports.links.releaseClaimForFailedWrite(claimedLinkId, error);
	}
	const { page } = created;

	// Resolve the artifact this task links back to and record lineage (issue #413 / #653 —
	// same machinery the Tasks-DB duplicate guard above reuses on its own skip path).
	const { provenanceNote, lineageNote } = await resolveArtifactAndRecordLineage(
		ports,
		ownerId,
		args,
		workspace,
		page,
		claimedLinkId,
	);

	return {
		status: "created",
		title: args.title,
		pageId: page.id,
		pageUrl: page.url,
		deduplicated: false,
		message: `Created Notion task: ${args.title}\nPage: ${page.url || page.id}${created.notes}${provenanceNote}${lineageNote}${notionGuardFailureNote}`,
	};
}

/**
 * Resolve the artifact a Notion task page links back to, and record that lineage
 * (issue #413 / #653). When the caller supplied `artifact_id`, it is used unchanged; when
 * not, the requesting message (`source_text`, or the title as a thin fallback) is
 * auto-captured as the task's source artifact so it ends up with a provenance rather than
 * none — the request itself IS the source. Best-effort throughout: a capture or lineage
 * write failure is surfaced as a note, it never fails the call, because by the time this
 * runs the task (or, on the Tasks-DB guard's skip path, an existing task) already exists.
 *
 * Shared by two call sites (#734): the normal successful-create path (with `claimedLinkId`
 * when a ledger dedup guard claimed one, finalizing it — issue #653's pattern) and the
 * Tasks-DB duplicate guard's skip path (always `claimedLinkId: null`, since that path never
 * takes a ledger claim — there is nothing to create). Reusing this rather than duplicating
 * it is the point: "read how #653 handles an existing claim so you reuse it rather than
 * inventing a second path" (issue #734).
 */
async function resolveArtifactAndRecordLineage(
	ports: CreateTaskPorts,
	ownerId: string,
	args: z.infer<typeof createTaskSchema>,
	workspace: Workspace,
	page: { id: string; url?: string },
	claimedLinkId: string | null = null,
): Promise<{ provenanceNote: string; lineageNote: string }> {
	let effectiveArtifactId = args.artifact_id;
	let provenanceNote = "";
	if (!effectiveArtifactId) {
		const domain =
			reconcileDomain(args.domain, args.workspace, "workspace") ??
			LEGACY_DOMAIN_VALUE[workspace];
		const account = DOMAIN_LEGACY_SCOPE[domain];
		const captured = await captureTaskRequestArtifact(
			ports,
			ownerId,
			args.source_text ?? args.title,
			args.title,
			account,
		);
		if (captured.ok) {
			effectiveArtifactId = captured.id;
			provenanceNote = `\nSource captured as artifact ${captured.id} (content_subtype='${TASK_REQUEST_CONTENT_SUBTYPE}')`;
		} else {
			provenanceNote = `\n(could not capture task-request provenance: ${captured.error})`;
		}
	}

	let lineageNote = "";
	if (effectiveArtifactId) {
		const linked = claimedLinkId
			? await ports.links.finalizeExternalLink(claimedLinkId, page.id, page.url || null)
			: await ports.links.recordExternalLink(effectiveArtifactId, {
					provider: workspace,
					kind: "task",
					external_id: page.id,
					external_url: page.url || null,
					dedup_key: args.dedup_key ?? null,
				});
		lineageNote = linked.ok
			? `\nLinked to artifact ${effectiveArtifactId}`
			: `\n(could not record lineage link: ${linked.error}; is migration 047 applied?)`;

		if (args.for_person_id) {
			// #1474's link upsert: on `user_id,artifact_id,entity_id,link_type`, owner-scoped.
			const personLinkErr = await ports.entityLinks.upsert(
				[
					{
						artifact_id: effectiveArtifactId,
						entity_id: args.for_person_id,
						link_type: "related",
						confidence_score: 1.0,
						created_by: "mcp",
						notes: "promise_to",
					},
				],
				{ userId: ownerId },
			).then(() => null, linkUpsertErrorText);
			if (personLinkErr) {
				lineageNote += `\n(could not record person promise link: ${personLinkErr})`;
			} else {
				lineageNote += `\nLinked promise to person entity ${args.for_person_id}`;
			}
		}
	}

	return { provenanceNote, lineageNote };
}
