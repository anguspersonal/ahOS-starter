import notionClientPkg, { type Client } from "@notionhq/client";

const { Client: NotionClientCtor, isNotionClientError } = notionClientPkg;
import { ExternalItemCreatedButUnreadable } from "../../actions/outwardWrite.js";
import type {
	NotionApiError,
	NotionAppendBlockChildrenParams,
	NotionBlockChildrenResponse,
	NotionBlockItem,
	NotionCommentResponse,
	NotionCreateCommentParams,
	NotionCreatedPageResponse,
	NotionCreatePageParams,
	NotionDatabaseResponse,
	NotionDataSourceResponse,
	NotionDeleteBlockParams,
	NotionListBlockChildrenParams,
	NotionListCommentsParams,
	NotionListCommentsResponse,
	NotionListUsersParams,
	NotionPageResponse,
	NotionPort,
	NotionQueryDataSourceParams,
	NotionQueryDataSourceResponse,
	NotionRetrieveBlockParams,
	NotionRetrieveDatabaseParams,
	NotionRetrieveDataSourceParams,
	NotionRetrievePageParams,
	NotionSearchParams,
	NotionSearchResponse,
	NotionSearchResultItem,
	NotionUpdateBlockParams,
	NotionUpdatePageParams,
	NotionUser,
} from "../../ports/notion.js";

const CHILDREN_PER_CALL = 100;

export type NotionTokenResolver = (
	workspace: string,
) => Promise<string | null | undefined> | string | null | undefined;

export interface NotionAdapterOptions {
	clientFactory?: (options: { auth: string }) => Client;
	getStateDocPageId?: (workspace: string) => Promise<string | undefined>;
	getDailyLogTargetIds?: (workspace: string) => Promise<string[]>;
}

/**
 * Builds a structured NotionApiError from a @notionhq/client error, or re-throws
 * non-Notion errors unchanged (#1569).
 */
export function toNotionApiError(err: unknown): NotionApiError {
	if (!isNotionClientError(err)) {
		throw err;
	}
	const rawStatus = (err as { status?: number }).status;
	const rawCode = (err as { code?: string }).code;
	const apiErr = new Error(`Notion API error (${rawStatus ?? 500}): ${err.message}`) as NotionApiError;
	apiErr.name = "NotionApiError";
	apiErr.status = rawStatus;
	if (rawCode !== undefined) {
		apiErr.code = rawCode;
	}
	return apiErr;
}

/**
 * Adapter implementing NotionPort using the official @notionhq/client SDK (ADR-101 §1).
 *
 * Characteristics:
 * - No hand-written HTTP; all communication flows through @notionhq/client Client.
 * - 429 rate limit and server error retries are managed by the SDK's built-in retry mechanics.
 * - Receives a token resolver function; never reads process.env or credentials directly.
 */
export class NotionClientAdapter implements NotionPort {
	getStateDocPageId?: (workspace: string) => Promise<string | undefined>;
	getDailyLogTargetIds?: (workspace: string) => Promise<string[]>;

	constructor(
		private readonly tokenResolver: NotionTokenResolver,
		private readonly options?: NotionAdapterOptions,
	) {
		if (options?.getStateDocPageId) {
			this.getStateDocPageId = (workspace: string) => options.getStateDocPageId!(workspace);
		}
		if (options?.getDailyLogTargetIds) {
			this.getDailyLogTargetIds = (workspace: string) => options.getDailyLogTargetIds!(workspace);
		}
	}

	async resolveToken(workspace: string): Promise<string> {
		const token = await this.tokenResolver(workspace);
		if (!token || typeof token !== "string" || token.trim().length === 0) {
			throw new Error(`Missing Notion token for workspace '${workspace}'`);
		}
		return token.trim();
	}

	private async getClient(workspace: string, onResponse?: (ok: boolean) => void): Promise<Client> {
		const rawToken = await this.resolveToken(workspace);
		const auth = rawToken.replace(/^Bearer\s+/i, "");

		if (this.options?.clientFactory) {
			return this.options.clientFactory({ auth });
		}

		// Ensure global fetch receives normalized headers so test mocks reading Authorization
		// succeed without duplicating authorization header keys (which causes Node fetch to concatenate
		// them with commas, causing Notion API 401 'Authorization header must use format Bearer <token>' #1375).
		// Also handles Headers instance, array of tuples, or plain object.
		const customFetch: typeof fetch = async (url, init = {}) => {
			let headers: Record<string, string>;
			if (typeof Headers !== "undefined" && init.headers instanceof Headers) {
				headers = {};
				init.headers.forEach((val, key) => {
					headers[key] = val;
				});
			} else if (Array.isArray(init.headers)) {
				headers = Object.fromEntries(init.headers);
			} else {
				headers = init.headers ? { ...(init.headers as Record<string, string>) } : {};
			}

			if ("authorization" in headers) {
				if (!("Authorization" in headers)) {
					headers["Authorization"] = headers["authorization"];
				}
				delete headers["authorization"];
			}

			const res = await (globalThis.fetch ?? fetch)(url, { ...init, headers });
			onResponse?.(Boolean(res?.ok));
			if (res && typeof res === "object") {
				const hasText = typeof (res as any).text === "function";
				const hasJson = typeof (res as any).json === "function";
				const originalText = hasText ? (res as any).text.bind(res) : undefined;
				const originalJson = hasJson ? (res as any).json.bind(res) : undefined;

				let cachedJson: unknown;
				let cachedText: string | undefined;

				const getJson = async () => {
					if (cachedJson !== undefined) return cachedJson;
					if (originalJson) {
						cachedJson = await originalJson();
						return cachedJson;
					}
					if (originalText) {
						const textVal = await originalText();
						cachedText = textVal;
						cachedJson = JSON.parse(textVal);
						return cachedJson;
					}
					return {};
				};

				const getText = async () => {
					if (cachedText !== undefined) return cachedText;
					if (originalText) {
						const textVal = await originalText();
						if (textVal === "{}" || textVal === "") {
							try {
								const jsonVal = await getJson();
								if (jsonVal && typeof jsonVal === "object" && Object.keys(jsonVal).length > 0) {
									cachedText = JSON.stringify(jsonVal);
									return cachedText;
								}
							} catch {
								// ignore
							}
						}
						cachedText = textVal;
						return cachedText;
					}
					if (originalJson) {
						const jsonVal = await getJson();
						cachedText = JSON.stringify(jsonVal);
						return cachedText;
					}
					return "";
				};

				return new Proxy(res, {
					get(target, prop) {
						if (prop === "text") return getText;
						if (prop === "json") return getJson;
						if (prop === "headers") {
							const h = Reflect.get(target, "headers", target);
							if (h) return h;
							return {
								get(headerName: string) {
									if (headerName.toLowerCase() === "content-type") return "application/json";
									return null;
								},
							};
						}
						const value = Reflect.get(target, prop, target);
						return typeof value === "function" ? value.bind(target) : value;
					},
				});
			}
			return res;
		};

		return new NotionClientCtor({
			auth,
			fetch: customFetch,
			logger: () => {}, // Suppress console warning noise on expected 404s/400s
		});
	}

	async search(params: NotionSearchParams): Promise<NotionSearchResponse> {
		try {
			const client = await this.getClient(params.workspace);
			const filterValue =
				params.objectType === "database" || params.objectType === "data_source"
					? "data_source"
					: params.objectType;
			const response = await client.search({
				query: params.query,
				filter: filterValue
					? { property: "object", value: filterValue }
					: undefined,
				sort: params.query
					? undefined
					: { direction: "descending", timestamp: "last_edited_time" },
				page_size: params.pageSize,
				start_cursor: params.cursor,
			});

			return {
				results: response.results as NotionSearchResultItem[],
				has_more: response.has_more,
				next_cursor: response.next_cursor,
			};
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async retrievePage(params: NotionRetrievePageParams): Promise<NotionPageResponse> {
		try {
			const client = await this.getClient(params.workspace);
			const response = await client.pages.retrieve({
				page_id: params.pageId,
			});
			return response as NotionPageResponse;
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async listBlockChildren(
		params: NotionListBlockChildrenParams,
	): Promise<NotionBlockChildrenResponse> {
		try {
			const client = await this.getClient(params.workspace);
			const allBlocks: NotionBlockItem[] = [];
			let cursor = params.cursor;
			const maxBlocks = Math.min(1000, Math.max(1, params.maxBlocks ?? 300));
			let hasMore = false;
			let nextCursor: string | null = null;

			do {
				const remaining = maxBlocks - allBlocks.length;
				const pageSize = Math.min(params.pageSize ?? 100, remaining);
				const response = await client.blocks.children.list({
					block_id: params.blockId,
					start_cursor: cursor,
					page_size: pageSize,
				});
				const results = (response.results ?? []) as NotionBlockItem[];
				if (allBlocks.length + results.length > maxBlocks) {
					const take = maxBlocks - allBlocks.length;
					allBlocks.push(...results.slice(0, take));
					hasMore = true;
					nextCursor = response.next_cursor ?? allBlocks[allBlocks.length - 1]?.id ?? null;
					break;
				}
				allBlocks.push(...results);
				hasMore = Boolean(response.has_more);
				nextCursor = response.has_more && response.next_cursor ? response.next_cursor : null;
				cursor = nextCursor ?? undefined;
			} while (cursor && allBlocks.length < maxBlocks);

			return {
				results: allBlocks,
				has_more: hasMore,
				next_cursor: nextCursor,
			};
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async retrieveDatabase(
		params: NotionRetrieveDatabaseParams,
	): Promise<NotionDatabaseResponse> {
		try {
			const client = await this.getClient(params.workspace);
			const response = await client.databases.retrieve({
				database_id: params.databaseId,
			});
			return response as unknown as NotionDatabaseResponse;
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async retrieveDataSource(
		params: NotionRetrieveDataSourceParams,
	): Promise<NotionDataSourceResponse> {
		try {
			const client = await this.getClient(params.workspace);
			const response = await client.dataSources.retrieve({
				data_source_id: params.dataSourceId,
			});
			return response as unknown as NotionDataSourceResponse;
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async queryDataSource(
		params: NotionQueryDataSourceParams,
	): Promise<NotionQueryDataSourceResponse> {
		try {
			const client = await this.getClient(params.workspace);
			const response = await client.dataSources.query({
				data_source_id: params.dataSourceId,
				page_size: params.pageSize,
				start_cursor: params.cursor,
				filter: params.filter as any,
				sorts: params.sorts as any,
			});
			return {
				results: (response.results ?? []) as unknown as NotionPageResponse[],
				has_more: response.has_more ?? false,
				next_cursor: response.next_cursor ?? null,
			};
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async retrieveBlock(params: NotionRetrieveBlockParams): Promise<NotionBlockItem> {
		try {
			const client = await this.getClient(params.workspace);
			const response = await client.blocks.retrieve({
				block_id: params.blockId,
			});
			return response as unknown as NotionBlockItem;
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async deleteBlock(params: NotionDeleteBlockParams): Promise<NotionBlockItem> {
		try {
			const client = await this.getClient(params.workspace);
			const response = await client.blocks.delete({
				block_id: params.blockId,
			});
			return response as unknown as NotionBlockItem;
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async listComments(params: NotionListCommentsParams): Promise<NotionListCommentsResponse> {
		try {
			const client = await this.getClient(params.workspace);
			const response = await client.comments.list({
				block_id: params.blockId,
				page_size: params.pageSize,
				start_cursor: params.cursor,
			});
			return {
				results: (response.results ?? []) as any,
				has_more: response.has_more ?? false,
				next_cursor: response.next_cursor ?? null,
			};
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async createComment(params: NotionCreateCommentParams): Promise<NotionCommentResponse> {
		try {
			const client = await this.getClient(params.workspace);
			const payload: any = {
				rich_text: params.rich_text,
			};
			if (params.discussion_id) {
				payload.discussion_id = params.discussion_id;
			} else if (params.parent) {
				payload.parent = params.parent;
			}
			const response = await client.comments.create(payload);
			return response as unknown as NotionCommentResponse;
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async createPage(params: NotionCreatePageParams): Promise<NotionCreatedPageResponse> {
		if (Boolean(params.databaseId) === Boolean(params.parentPageId)) {
			throw new Error(
				"createNotionPage needs exactly one parent: `databaseId` (a row in a database) or `parentPageId` (a child page under a page).",
			);
		}
		const parent = params.databaseId
			? { database_id: params.databaseId }
			: { page_id: params.parentPageId! };

		// Set by the last answer to this call's request: true once Notion has accepted the create.
		let accepted = false;
		try {
			const client = await this.getClient(params.workspace, (ok) => {
				accepted = ok;
			});
			const response = (await client.pages.create({
				parent: parent as any,
				properties: params.properties as any,
				...(params.children && params.children.length > 0
					? { children: params.children as any }
					: {}),
				...(params.icon ? { icon: { type: "emoji", emoji: params.icon.emoji } as any } : {}),
			})) as unknown as { id: string; url?: string; [key: string]: unknown };
			return {
				...response,
				id: response.id,
				url: response.url ?? "",
			};
		} catch (err: unknown) {
			// A 2xx answer means the page exists; a body that cannot be read or parsed loses its id,
			// not the page. A caller that releases its dedup claim on an ordinary failure would let
			// the retry create a second page (#653; see outwardWrite.ts), so say what happened.
			if (accepted && !isNotionClientError(err)) {
				throw new ExternalItemCreatedButUnreadable("A Notion page", err);
			}
			throw toNotionApiError(err);
		}
	}

	async appendBlockChildren(params: NotionAppendBlockChildrenParams): Promise<string[]> {
		if (params.children.length === 0) return [];
		try {
			const client = await this.getClient(params.workspace);
			const createdIds: string[] = [];
			let after = params.after;

			for (let i = 0; i < params.children.length; i += CHILDREN_PER_CALL) {
				const chunk = params.children.slice(i, i + CHILDREN_PER_CALL);
				const response = await client.blocks.children.append({
					block_id: params.blockId,
					children: chunk as any,
					...(after ? { after } : {}),
				});
				const chunkIds = ((response.results ?? []) as Array<{ id?: string }>)
					.map((b) => b.id)
					.filter((id): id is string => typeof id === "string");
				createdIds.push(...chunkIds);
				if (after && chunkIds.length > 0) {
					after = chunkIds[chunkIds.length - 1];
				}
			}

			return createdIds;
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async updateBlock(params: NotionUpdateBlockParams): Promise<void> {
		try {
			const client = await this.getClient(params.workspace);
			await client.blocks.update({
				...params.payload,
				block_id: params.blockId,
			} as any);
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async updatePage(params: NotionUpdatePageParams): Promise<void> {
		try {
			const client = await this.getClient(params.workspace);
			const body: Record<string, unknown> = {
				page_id: params.pageId,
			};
			if (params.properties !== undefined) body.properties = params.properties;
			if (params.icon !== undefined) body.icon = params.icon;
			if (params.archived !== undefined) body.archived = params.archived;
			await client.pages.update(body as any);
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}

	async listUsers(params: NotionListUsersParams): Promise<NotionUser[]> {
		try {
			const client = await this.getClient(params.workspace);
			const users: NotionUser[] = [];
			let cursor: string | undefined;
			do {
				const response = await client.users.list({ page_size: 100, start_cursor: cursor });
				for (const raw of (response.results ?? []) as Array<{
					id?: string; name?: string | null; type?: string; person?: { email?: string };
				}>) {
					if (!raw.id) continue;
					users.push({
						id: raw.id,
						name: raw.name ?? "(unnamed)",
						type: raw.type ?? "unknown",
						...(raw.person?.email ? { email: raw.person.email } : {}),
					});
				}
				cursor = response.has_more && response.next_cursor ? response.next_cursor : undefined;
			} while (cursor);
			return users;
		} catch (err: unknown) {
			throw toNotionApiError(err);
		}
	}
}
