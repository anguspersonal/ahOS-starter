import { getCredential } from "./credentials.js";
import { withBackoff } from "./backoff.js";
import { ExternalItemCreatedButUnreadable } from "./outwardWrite.js";
import { markdownToBlocks } from "@ahkms/core/actions";

// Thin Notion REST client (no SDK dependency — global fetch is fine on Node 20+).
// Only what task_create needs: create a page in a database. Keeps the "rent the
// mechanics, thinly" posture from the design principles.
//
// This module reads no env directly: every token comes from getCredential(), the
// single credential seam (ADR-045 seam 1 / #424).

const NOTION_API = "https://api.notion.com/v1";
// Pinned API version. Notion requires this header; bump deliberately when adopting
// newer request shapes.
const NOTION_VERSION = "2022-06-28";
// The 2025-09-03 API restructured databases into data sources: querying moved to
// POST /v1/data_sources/{id}/query and page parents now carry `data_source_id`.
// The automations rule config (#546 / ADR-048) is keyed by data source id, so its
// page/query calls pin THIS version; the pre-existing endpoints above stay on the
// old pin until deliberately migrated.
const NOTION_DATA_SOURCE_VERSION = "2025-09-03";

/** Build the Notion request headers, authenticating with `token`. */
function notionHeaders(
	token: string,
	version: string = NOTION_VERSION,
): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"Notion-Version": version,
		"Content-Type": "application/json",
	};
}

/**
 * The token an explicit-token argument falls back to. Callers that only ever touch the
 * work workspace (state_doc_update) omit it; workspace-aware callers resolve their own
 * via getCredential(workspace) so a `notion_personal` call authenticates with the
 * personal token rather than the work one (#424 defect 1).
 */
async function resolveToken(token?: string): Promise<string> {
	return token ?? (await getCredential("notion_work"));
}

// --- Search (read side for the scheduled discover cadence, #339) -------------

// One rich-text run as returned by Notion (title properties + database titles).
type NotionRichText = { plain_text?: string };

/**
 * A single object from POST /v1/search. Notion returns pages and databases with a
 * shared envelope (id/url/timestamps/archived) plus a shape that differs by object
 * type: a page carries its title inside `properties` (the one property of type
 * "title"), a database carries it in the top-level `title` rich-text array. Only the
 * fields the discover mapping needs are typed; everything else is ignored.
 */
export type NotionSearchResult = {
	id: string;
	object?: "page" | "database";
	url?: string;
	created_time?: string;
	last_edited_time?: string;
	archived?: boolean;
	in_trash?: boolean;
	// Databases: top-level title rich text.
	title?: NotionRichText[];
	// Pages: properties keyed by name; the title lives on the one of type "title".
	properties?: Record<string, { type?: string; title?: NotionRichText[] }>;
};

/**
 * One page of Notion's POST /v1/search, returning the pages and databases the
 * integration token can see (search only ever returns objects explicitly shared with
 * the integration — that IS the scope, #355). Cursor-paginated (Notion caps page_size
 * at 100). Authenticates with `token` (resolve per workspace via getCredential(workspace)).
 *
 * `query` matches object TITLES only, never page content — Notion's search does not
 * index block text, so a phrase that appears inside a page will not find it (#830).
 *
 * Sorting is conditional on purpose. With no `query` this is a listing, and the
 * discover cadence (#339) wants it newest-first, so the last_edited_time sort stays.
 * With a `query` an explicit sort would override Notion's own relevance ranking and
 * hand back the most recently touched match rather than the best one, so it is omitted.
 */
export async function searchNotion(
	token: string,
	opts: {
		cursor?: string;
		pageSize?: number;
		query?: string;
		objectType?: "page" | "database";
	} = {},
): Promise<{ results: NotionSearchResult[]; next_cursor: string | null; has_more: boolean }> {
	const query = opts.query?.trim();
	const body: Record<string, unknown> = {
		page_size: opts.pageSize ?? 100,
	};
	if (query) body.query = query;
	else body.sort = { direction: "descending", timestamp: "last_edited_time" };
	if (opts.objectType) body.filter = { property: "object", value: opts.objectType };
	if (opts.cursor) body.start_cursor = opts.cursor;

	// Notion's public API is rate-limited (~3 req/s); a large workspace's paginated
	// scan can trip a 429 mid-run. Retrying here (rather than in each caller) means
	// every consumer of /v1/search gets 429/5xx backoff for free (#474). The thrown
	// error carries status + headers so withBackoff can classify it and honour a
	// server-sent Retry-After.
	const res = await withBackoff(
		async () => {
			const r = await fetch(`${NOTION_API}/search`, {
				method: "POST",
				headers: notionHeaders(token),
				body: JSON.stringify(body),
			});
			if (!r.ok) {
				const detail = await r.text().catch(() => "");
				throw Object.assign(
					new Error(`Notion search failed (${r.status}): ${detail || r.statusText}`),
					{ status: r.status, headers: r.headers },
				);
			}
			return r;
		},
		{ label: "notion /v1/search" },
	);

	const json = (await res.json()) as {
		results?: NotionSearchResult[];
		next_cursor?: string | null;
		has_more?: boolean;
	};
	return {
		results: json.results ?? [],
		next_cursor: json.next_cursor ?? null,
		has_more: json.has_more ?? false,
	};
}

/**
 * Human-readable title of a search result. Databases expose it as a top-level
 * `title` rich-text array; pages expose it via the single property of type "title".
 * Concatenates the rich-text runs' plain_text and falls back to "Untitled" (discover
 * requires a non-empty title) when neither yields text.
 */
export function notionResultTitle(result: NotionSearchResult): string {
	const joinRuns = (runs?: unknown): string => {
		if (Array.isArray(runs)) {
			return runs.map((r) => r?.plain_text ?? "").join("").trim();
		}
		if (typeof runs === "string") {
			return runs.trim();
		}
		return "";
	};

	// Database: top-level title.
	const dbTitle = joinRuns(result.title);
	if (dbTitle) return dbTitle;

	// Page: the property whose type is "title".
	for (const prop of Object.values(result.properties ?? {})) {
		if (prop?.type === "title") {
			const pageTitle = joinRuns(prop.title);
			if (pageTitle) return pageTitle;
		}
	}

	return "Untitled";
}

export type CreateTaskInput = {
	databaseId: string;
	titleProperty: string;
	title: string;
	// Optional ISO date (YYYY-MM-DD or full ISO) + the property name to set it on.
	due?: string;
	dueProperty?: string;
	// Optional free text rendered as the page body (schema-independent).
	body?: string;
	// Pre-built Notion property values (issue #145 gap 2), keyed by Notion property
	// NAME — e.g. { Status: { status: { name: "Done" } }, Tags: { multi_select: [...] } }.
	// Built by the caller (createTask.ts) via introspection-driven per-type shaping; this
	// function just merges it in. Backward compatible: omitted/empty means no change to
	// today's title/due/body-only behaviour.
	properties?: Record<string, unknown>;
};

export type CreatedNotionPage = { id: string; url: string };

/**
 * Create a page in a Notion database. The title goes on `titleProperty` (Notion
 * databases always have exactly one title property, but its name varies per DB).
 * `body` is converted via `markdownToBlocks` (supporting multi-block Markdown and inline links/annotations) so it works regardless of the DB's schema.
 * `properties`, if given, is merged in last so extra caller-supplied values win over
 * nothing (there's no overlap today: title/due are always set from titleProperty/
 * dueProperty, which the caller keeps out of `properties`).
 */
export async function createNotionTask(
	input: CreateTaskInput,
	token?: string,
): Promise<CreatedNotionPage> {
	const properties: Record<string, unknown> = {
		[input.titleProperty]: {
			title: [{ text: { content: input.title } }],
		},
	};
	if (input.due && input.dueProperty) {
		properties[input.dueProperty] = { date: { start: input.due } };
	}
	if (input.properties) {
		Object.assign(properties, input.properties);
	}

	const blocks = input.body ? markdownToBlocks(input.body) : [];
	const children = blocks.length > 0 ? blocks : undefined;

	return createNotionPage({ databaseId: input.databaseId, properties, children }, token);
}

export type CreateNotionPageInput = {
	/** Database parent. Exactly one of `databaseId` / `parentPageId`. */
	databaseId?: string;
	/**
	 * Page parent — a child page under an ordinary page (#1057). A page parent takes no
	 * schema, so the only property Notion accepts is the title; `properties` is passed
	 * through unchanged and it is the caller's job to send `{ title: { title: [...] } }`.
	 */
	parentPageId?: string;
	/** Ready-built Notion property values keyed by property NAME. */
	properties: Record<string, unknown>;
	/** Ready-built block payloads for the page body. Notion accepts at most 100 per call. */
	children?: Record<string, unknown>[];
	/** Page icon, as Notion's emoji shape. */
	icon?: { emoji: string };
};

/**
 * Create a page in a Notion database from already-built property values and blocks.
 *
 * The raw primitive under createNotionTask, split out by #674 so a caller with a
 * pre-built block array (such as the Daily Log writer or custom heading handlers) can
 * hand over ready-made blocks directly rather than going through createNotionTask's
 * default `markdownToBlocks(input.body)` conversion.
 *
 * `parent: { database_id }` on the default 2022-06-28 pin, deliberately: the write
 * side needs no data-source id, so a destination is writable from the database id
 * alone (the data-source id is the READ half -- queryNotionDataSource).
 */
export async function createNotionPage(
	input: CreateNotionPageInput,
	token?: string,
): Promise<CreatedNotionPage> {
	// Exactly one parent. Notion rejects a payload carrying both, but its error names the
	// JSON rather than the call, so catch it here where the caller can see which argument.
	if (Boolean(input.databaseId) === Boolean(input.parentPageId)) {
		throw new Error(
			"createNotionPage needs exactly one parent: `databaseId` (a row in a database) or `parentPageId` (a child page under a page).",
		);
	}
	const parent = input.databaseId
		? { database_id: input.databaseId }
		: { page_id: input.parentPageId };

	const res = await fetch(`${NOTION_API}/pages`, {
		method: "POST",
		headers: notionHeaders(await resolveToken(token)),
		body: JSON.stringify({
			parent,
			properties: input.properties,
			...(input.children && input.children.length > 0 ? { children: input.children } : {}),
			...(input.icon ? { icon: { type: "emoji", emoji: input.icon.emoji } } : {}),
		}),
	});

	if (!res.ok) {
		// Notion returns a JSON error body with a human-readable `message`.
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion create page failed (${res.status}): ${detail || res.statusText}`,
		);
	}

	// Past this point Notion has ACCEPTED the create — the page exists. A body that cannot
	// be read (socket reset mid-stream, truncated or non-JSON payload) loses the page's id,
	// not the page. It must not surface as an ordinary write failure: task_create's caller
	// releases its dedup claim on exactly that signal, and releasing for a page that DOES
	// exist lets the retry create a second one (issue #653; see outwardWrite.ts).
	let json: { id: string; url?: string };
	try {
		json = (await res.json()) as { id: string; url?: string };
	} catch (cause) {
		throw new ExternalItemCreatedButUnreadable("A Notion page", cause);
	}
	return { id: json.id, url: json.url ?? "" };
}

/**
 * Resolve a data source id to the database id that contains it (#1057).
 *
 * The two ids are not interchangeable and the split is not cosmetic. Notion's
 * 2025-09-03 API made the data source the READ handle (queryNotionDataSource) while
 * page creation stayed on the 2022-06-28 pin, where `parent` takes a `database_id`.
 * So a caller holding the id `notion_config_get` prints for a *_data_source_id key
 * cannot create a row with it, and Notion's refusal names neither id as the problem.
 * One extra GET on the newer pin turns the read handle into the write handle.
 */
export async function retrieveDataSourceDatabaseId(
	dataSourceId: string,
	token: string,
): Promise<string> {
	const res = await fetch(`${NOTION_API}/data_sources/${encodeURIComponent(dataSourceId)}`, {
		method: "GET",
		headers: notionHeaders(token, NOTION_DATA_SOURCE_VERSION),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion retrieve data source failed (${res.status}): ${detail || res.statusText}`,
		);
	}

	const json = (await res.json()) as { parent?: { database_id?: string; type?: string } };
	const databaseId = json.parent?.database_id;
	if (!databaseId) {
		throw new Error(
			`Data source ${dataSourceId} reports no parent database, so there is no id to create pages against. Pass \`database_id\` directly.`,
		);
	}
	return databaseId;
}

/** One entry from GET /v1/users. */
export type NotionUser = {
	id: string;
	name: string;
	type: string;
	email?: string;
};

/**
 * Every user the integration can see (#1057), following Notion's cursor pagination to
 * the end rather than returning the first page. Skills currently hard-code Angus's and
 * Briana's ids; a person-typed property needs a real id, and an id copied into a skill
 * body is wrong the moment someone joins or the workspace is rebuilt.
 */
export async function listNotionUsers(token: string): Promise<NotionUser[]> {
	const users: NotionUser[] = [];
	let cursor: string | undefined;

	do {
		const url = new URL(`${NOTION_API}/users`);
		url.searchParams.set("page_size", "100");
		if (cursor) url.searchParams.set("start_cursor", cursor);

		const res = await fetch(url, { method: "GET", headers: notionHeaders(token) });
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`Notion list users failed (${res.status}): ${detail || res.statusText}`);
		}

		const json = (await res.json()) as {
			results?: Array<{
				id?: string;
				name?: string;
				object?: string;
				type?: string;
				person?: { email?: string };
			}>;
			next_cursor?: string | null;
			has_more?: boolean;
		};

		for (const raw of json.results ?? []) {
			if (!raw.id) continue;
			users.push({
				id: raw.id,
				name: raw.name ?? "(unnamed)",
				type: raw.type ?? "unknown",
				...(raw.person?.email ? { email: raw.person.email } : {}),
			});
		}

		cursor = json.has_more && json.next_cursor ? json.next_cursor : undefined;
	} while (cursor);

	return users;
}

export type NotionDatabaseProperty = {
	name: string;
	type: string;
	options?: string[];
};

export type NotionDatabaseSchema = {
	properties: NotionDatabaseProperty[];
};

type NotionSelectOption = { name?: string };
type NotionDatabasePropertyRaw = {
	type?: string;
	select?: { options?: NotionSelectOption[] };
	multi_select?: { options?: NotionSelectOption[] };
	status?: { options?: NotionSelectOption[] };
};

/**
 * Retrieve a Notion database's schema (GET /v1/databases/{id}) and flatten it from
 * Notion's "properties keyed by name" shape into a plain array of
 * { name, type, options } — options populated only for select-like types (select,
 * multi_select, status), pulled from prop[prop.type].options[].name. This is the read
 * side that lets a caller discover valid property names/types/option vocabulary without
 * hand-driving a raw Notion fetch (issue #145 gap 3).
 */
export async function retrieveDatabaseSchema(
	databaseId: string,
	token?: string,
): Promise<NotionDatabaseSchema> {
	const res = await fetch(`${NOTION_API}/databases/${databaseId}`, {
		method: "GET",
		headers: notionHeaders(await resolveToken(token)),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion retrieve database failed (${res.status}): ${detail || res.statusText}`,
		);
	}

	const json = (await res.json()) as {
		properties?: Record<string, NotionDatabasePropertyRaw>;
	};
	const rawProperties = json.properties ?? {};

	const properties = Object.keys(rawProperties).map((name) => {
		const prop = rawProperties[name];
		const type = prop?.type ?? "unknown";
		const optionsHolder =
			type === "select"
				? prop?.select
				: type === "multi_select"
					? prop?.multi_select
					: type === "status"
						? prop?.status
						: undefined;
		const options = optionsHolder?.options
			?.map((o) => o.name)
			.filter((n): n is string => Boolean(n));

		return {
			name,
			type,
			...(options && options.length > 0 ? { options } : {}),
		};
	});

	return { properties };
}

// --- Page read/write + data-source query (Notion automations, #546 / ADR-048) ---

/**
 * One property value as returned on a retrieved page. Originally only the slices the
 * completed_at_stamp rule reads were typed (status name, date start, and the
 * property's stable id for matching webhook `updated_properties`); `select`, `title` and
 * `relation` were added for the Tasks-DB duplicate guard (#734, `findExistingNotionTask`
 * in createTask.ts), which reads a query result's title text (to compare against the
 * candidate task's title) and status/select name (to classify open vs. closed) and
 * relation ids (to check whether a source page is already linked). Everything else
 * passes through untouched.
 */
export type NotionPropertyValue = {
	id?: string;
	type?: string;
	status?: { name?: string } | null;
	select?: { name?: string } | null;
	date?: { start?: string | null } | null;
	title?: NotionRichText[];
	rich_text?: NotionRichText[];
	multi_select?: Array<{ name?: string }>;
	relation?: Array<{ id: string }>;
};

/**
 * A page as returned by GET /v1/pages/{id} (or a data-source query result) under
 * NOTION_DATA_SOURCE_VERSION. `parent` carries `data_source_id` (and usually the
 * legacy `database_id` too) so callers can match a page to a configured data source.
 */
export type NotionPage = {
	id: string;
	/** Every Notion page carries this; typed here (added for #734's Tasks-DB duplicate
	 *  guard) so a query result's page can be reported back the same way createNotionTask's
	 *  CreatedNotionPage is. */
	url?: string;
	last_edited_time?: string;
	archived?: boolean;
	parent?: { type?: string; data_source_id?: string; database_id?: string };
	properties?: Record<string, NotionPropertyValue>;
};

/**
 * Retrieve a page with its property values. Webhook events carry property IDs but
 * no values, so every rule evaluation starts here (#546).
 */
export async function retrieveNotionPage(
	pageId: string,
	token: string,
): Promise<NotionPage> {
	const res = await fetch(`${NOTION_API}/pages/${encodeURIComponent(pageId)}`, {
		method: "GET",
		headers: notionHeaders(token, NOTION_DATA_SOURCE_VERSION),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion retrieve page failed (${res.status}): ${detail || res.statusText}`,
		);
	}

	return (await res.json()) as NotionPage;
}

/**
 * Patch a page's properties (PATCH /v1/pages/{id}). `properties` is keyed by
 * property NAME with ready-built Notion value shapes, e.g.
 * `{ "Completed at": { date: { start: "…" } } }` or `{ "Completed at": { date: null } }`.
 */
export async function updateNotionPageProperties(
	pageId: string,
	properties: Record<string, unknown>,
	token: string,
): Promise<void> {
	await patchNotionPage(pageId, { properties }, token);
}

/** What PATCH /v1/pages/{id} accepts, as far as this codebase uses it (#1058). */
export type NotionPagePatch = {
	properties?: Record<string, unknown>;
	/** Notion's raw icon shape: `{ emoji: "📓" }` or `{ external: { url } }`. */
	icon?: Record<string, unknown> | null;
	/**
	 * Notion's TRASH flag, not a permanent delete — the public API has none. `true`
	 * moves the page to trash, `false` restores it, and properties survive both.
	 */
	archived?: boolean;
};

/**
 * One PATCH against a page (#1058). Properties, icon and the trash flag travel in a
 * single request because Notion accepts them that way: archiving a page and patching
 * the property that records WHY it was archived is one atomic call, where two calls
 * could leave the page trashed with the reason unwritten.
 *
 * Only the keys the caller actually supplied are sent. That matters for `archived` and
 * `icon` specifically: a literal `{ icon: null }` is a meaningful instruction to Notion
 * (remove the icon), so an undefined-to-null normalisation here would silently strip
 * the icon off every page whose properties anyone patched.
 */
export async function patchNotionPage(
	pageId: string,
	patch: NotionPagePatch,
	token: string,
): Promise<void> {
	const body: Record<string, unknown> = {};
	if (patch.properties !== undefined) body.properties = patch.properties;
	if (patch.icon !== undefined) body.icon = patch.icon;
	if (patch.archived !== undefined) body.archived = patch.archived;

	const res = await fetch(`${NOTION_API}/pages/${encodeURIComponent(pageId)}`, {
		method: "PATCH",
		headers: notionHeaders(token, NOTION_DATA_SOURCE_VERSION),
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion update page failed (${res.status}): ${detail || res.statusText}`,
		);
	}
}

/**
 * One page of POST /v1/data_sources/{id}/query — the reconciliation sweep's read
 * side (#546). Cursor-paginated like searchNotion; Notion caps page_size at 100.
 */
export async function queryNotionDataSource(
	dataSourceId: string,
	token: string,
	opts: {
		cursor?: string;
		pageSize?: number;
		filter?: Record<string, unknown>;
		sorts?: Array<Record<string, unknown>>;
	} = {},
): Promise<{ results: NotionPage[]; next_cursor: string | null; has_more: boolean }> {
	const body: Record<string, unknown> = { page_size: opts.pageSize ?? 100 };
	if (opts.cursor) body.start_cursor = opts.cursor;
	// Notion's own filter grammar, passed through: the Daily Log duplicate guard asks for
	// one date rather than paging a whole year of entries to find it (#673).
	if (opts.filter) body.filter = opts.filter;
	// Notion's own sort grammar, passed through the same way (notion_database_query, #830):
	// [{ property, direction }] or [{ timestamp: 'last_edited_time', direction }].
	if (opts.sorts && opts.sorts.length > 0) body.sorts = opts.sorts;

	const res = await fetch(`${NOTION_API}/data_sources/${encodeURIComponent(dataSourceId)}/query`, {
		method: "POST",
		headers: notionHeaders(token, NOTION_DATA_SOURCE_VERSION),
		body: JSON.stringify(body),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion data source query failed (${res.status}): ${detail || res.statusText}`,
		);
	}

	const json = (await res.json()) as {
		results?: NotionPage[];
		next_cursor?: string | null;
		has_more?: boolean;
	};
	return {
		results: json.results ?? [],
		next_cursor: json.next_cursor ?? null,
		has_more: json.has_more ?? false,
	};
}

// --- Block API (the State Doc's section writer, ADR-053) ---------------------
//
// The State Doc is edited one section at a time through THESE calls, never through
// Notion's page content-update path: that path re-serialises a whole block rather
// than patching a line, and has been observed flipping an unrelated checkbox,
// deleting an action item, and rewriting footnote syntax (ADR-053 § Context).

/**
 * One rich-text run on a block. `plain_text` is what Notion returns; `text.content`
 * is what it accepts on write. Both are read so a run read back from the API can be
 * re-sent without a lossy round-trip, and `annotations` / `text.link` are carried
 * through so a rewrite of one line leaves the formatting of neighbouring runs intact.
 */
export type NotionRichTextRun = {
	type?: string;
	text?: { content?: string; link?: { url: string } | null };
	plain_text?: string;
	annotations?: Record<string, unknown>;
	href?: string | null;
};

/** A block as returned by GET /v1/blocks/{id}/children. Type-specific payload is open. */
export type NotionBlock = {
	id: string;
	type: string;
	has_children?: boolean;
	archived?: boolean;
} & Record<string, unknown>;

/**
 * Every child block of a page (or block), following Notion's cursor pagination to the
 * end. The State Doc's section addressing needs the whole ordered list — a section's
 * end is "the next heading block", which a partial page cannot answer.
 */
export async function listNotionBlockChildren(
	blockId: string,
	token?: string,
): Promise<NotionBlock[]> {
	const headers = notionHeaders(await resolveToken(token));
	const blocks: NotionBlock[] = [];
	let cursor: string | undefined;

	do {
		const url = new URL(`${NOTION_API}/blocks/${encodeURIComponent(blockId)}/children`);
		url.searchParams.set("page_size", "100");
		if (cursor) url.searchParams.set("start_cursor", cursor);

		const res = await fetch(url.toString(), { method: "GET", headers });
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(
				`Notion list block children failed (${res.status}): ${detail || res.statusText}`,
			);
		}

		const json = (await res.json()) as {
			results?: NotionBlock[];
			next_cursor?: string | null;
			has_more?: boolean;
		};
		blocks.push(...(json.results ?? []));
		cursor = json.has_more && json.next_cursor ? json.next_cursor : undefined;
	} while (cursor);

	return blocks;
}

/**
 * Append blocks as children of `blockId`. `after` positions them immediately after an
 * existing sibling instead of at the end — that is what makes a section replace an
 * insert-then-delete (new content lands in place first, so a mid-way failure leaves
 * the page duplicated rather than truncated).
 */
export async function appendNotionBlockChildren(
	blockId: string,
	children: Record<string, unknown>[],
	opts: { after?: string } = {},
	token?: string,
): Promise<void> {
	const res = await fetch(`${NOTION_API}/blocks/${encodeURIComponent(blockId)}/children`, {
		method: "PATCH",
		headers: notionHeaders(await resolveToken(token)),
		body: JSON.stringify({ children, ...(opts.after ? { after: opts.after } : {}) }),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion append blocks failed (${res.status}): ${detail || res.statusText}`,
		);
	}
}

/**
 * Patch one block (PATCH /v1/blocks/{id}). `payload` is the type-keyed slice Notion
 * expects, e.g. `{ heading_2: { rich_text: [...] } }` or `{ callout: { rich_text: [...] } }`.
 */
export async function updateNotionBlock(
	blockId: string,
	payload: Record<string, unknown>,
	token?: string,
): Promise<void> {
	const res = await fetch(`${NOTION_API}/blocks/${encodeURIComponent(blockId)}`, {
		method: "PATCH",
		headers: notionHeaders(await resolveToken(token)),
		body: JSON.stringify(payload),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion update block failed (${res.status}): ${detail || res.statusText}`,
		);
	}
}

/** A block's `parent`, the one field #1058's State Doc guard needs off GET /v1/blocks/{id}. */
export type NotionBlockParent = {
	type?: string;
	page_id?: string;
	block_id?: string;
	database_id?: string;
	data_source_id?: string;
	workspace?: boolean;
};

/**
 * One block by id (GET /v1/blocks/{id}). Exists for the parent pointer: a block id
 * carries no indication of which page it belongs to, so nothing can tell whether
 * deleting it would edit the State Doc without asking Notion first (#1058, ADR-053).
 */
export async function retrieveNotionBlock(
	blockId: string,
	token?: string,
): Promise<NotionBlock & { parent?: NotionBlockParent }> {
	const res = await fetch(`${NOTION_API}/blocks/${encodeURIComponent(blockId)}`, {
		method: "GET",
		headers: notionHeaders(await resolveToken(token)),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion retrieve block failed (${res.status}): ${detail || res.statusText}`,
		);
	}

	return (await res.json()) as NotionBlock & { parent?: NotionBlockParent };
}

/** Delete one block (DELETE /v1/blocks/{id}) — Notion moves it to trash, so it is recoverable. */
export async function deleteNotionBlock(blockId: string, token?: string): Promise<void> {
	const res = await fetch(`${NOTION_API}/blocks/${encodeURIComponent(blockId)}`, {
		method: "DELETE",
		headers: notionHeaders(await resolveToken(token)),
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Notion delete block failed (${res.status}): ${detail || res.statusText}`,
		);
	}
}

// --- Comments (read and write sides for meeting-note discussions, #1136) ------

export type NotionComment = {
	id: string;
	parent?: {
		type?: string;
		page_id?: string;
		block_id?: string;
	};
	discussion_id?: string;
	created_time?: string;
	last_edited_time?: string;
	created_by?: {
		id?: string;
		object?: string;
	};
	rich_text?: Array<{
		type?: string;
		plain_text?: string;
		text?: { content?: string; link?: { url: string } | null };
	}>;
};

export type NotionCommentsPage = {
	results: NotionComment[];
	next_cursor: string | null;
	has_more: boolean;
};

/**
 * List comments on a block or page (GET /v1/comments?block_id={id}).
 * Notion returns unresolved comments in ascending chronological order.
 */
export async function listNotionComments(
	blockId: string,
	token: string,
	opts: { cursor?: string; pageSize?: number } = {},
): Promise<NotionCommentsPage> {
	const url = new URL(`${NOTION_API}/comments`);
	url.searchParams.set("block_id", blockId);
	if (opts.pageSize) url.searchParams.set("page_size", String(opts.pageSize));
	if (opts.cursor) url.searchParams.set("start_cursor", opts.cursor);

	return withBackoff(
		async () => {
			const res = await fetch(url, {
				method: "GET",
				headers: notionHeaders(token),
			});

			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw Object.assign(
					new Error(`Notion list comments failed (${res.status}): ${detail || res.statusText}`),
					{ status: res.status, headers: res.headers },
				);
			}

			const json = (await res.json()) as {
				results?: NotionComment[];
				next_cursor?: string | null;
				has_more?: boolean;
			};

			return {
				results: json.results ?? [],
				next_cursor: json.next_cursor ?? null,
				has_more: Boolean(json.has_more),
			};
		},
		{ label: `notion list comments on ${blockId}` },
	);
}

export type CreateNotionCommentInput = {
	parent?: {
		page_id?: string;
		block_id?: string;
	};
	discussion_id?: string;
	rich_text: Array<Record<string, unknown>>;
};

/**
 * Create a new comment on a page/block, or reply to an existing discussion thread
 * (POST /v1/comments).
 */
export async function createNotionComment(
	token: string,
	input: CreateNotionCommentInput,
): Promise<NotionComment> {
	const body: Record<string, unknown> = {
		rich_text: input.rich_text,
	};
	if (input.discussion_id) {
		body.discussion_id = input.discussion_id;
	} else if (input.parent) {
		body.parent = input.parent;
	}

	return withBackoff(
		async () => {
			const res = await fetch(`${NOTION_API}/comments`, {
				method: "POST",
				headers: notionHeaders(token),
				body: JSON.stringify(body),
			});

			if (!res.ok) {
				const detail = await res.text().catch(() => "");
				throw Object.assign(
					new Error(`Notion create comment failed (${res.status}): ${detail || res.statusText}`),
					{ status: res.status, headers: res.headers },
				);
			}

			return (await res.json()) as NotionComment;
		},
		{ label: "notion create comment" },
	);
}

