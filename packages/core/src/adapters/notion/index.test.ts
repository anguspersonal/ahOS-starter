import { describe, expect, it, vi } from "vitest";
import { ExternalItemCreatedButUnreadable } from "../../actions/outwardWrite.js";
import { NotionClientAdapter } from "./index.js";
import notionClientPkg from "@notionhq/client";

const { APIResponseError } = notionClientPkg;

describe("NotionClientAdapter", () => {
	it("throws if token resolver returns null, empty, or undefined", async () => {
		const adapter = new NotionClientAdapter(async () => null);
		await expect(adapter.resolveToken("work")).rejects.toThrow(
			"Missing Notion token for workspace 'work'",
		);

		const adapterEmpty = new NotionClientAdapter(async () => "   ");
		await expect(adapterEmpty.resolveToken("angus")).rejects.toThrow(
			"Missing Notion token for workspace 'angus'",
		);
	});

	it("returns trimmed token from token resolver", async () => {
		const adapter = new NotionClientAdapter(async () => "  secret_123  ");
		expect(await adapter.resolveToken("work")).toBe("secret_123");
	});

	it("strips Bearer prefix when instantiating client and passes correct search params", async () => {
		let capturedAuth: string | undefined;
		let capturedSearchParams: any;

		const mockClient = {
			search: vi.fn(async (params: any) => {
				capturedSearchParams = params;
				return {
					results: [
						{
							id: "p1",
							object: "page",
							title: [{ plain_text: "Target" }],
						},
					],
					has_more: false,
					next_cursor: null,
				};
			}),
		};

		const adapter = new NotionClientAdapter(
			async () => "Bearer secret_personal_456",
			{
				clientFactory: (opts) => {
					capturedAuth = opts.auth;
					return mockClient as any;
				},
			},
		);

		const res = await adapter.search({
			workspace: "angus",
			query: "Target",
			objectType: "page",
			pageSize: 10,
		});

		expect(capturedAuth).toBe("secret_personal_456");
		expect(capturedSearchParams).toEqual({
			query: "Target",
			filter: { property: "object", value: "page" },
			sort: undefined, // Omitted when query is provided so Notion sorts by relevance
			page_size: 10,
			start_cursor: undefined,
		});
		expect(res.results).toHaveLength(1);
		expect(res.results[0].id).toBe("p1");
	});

	it("applies last_edited_time sort when query is omitted in search", async () => {
		let capturedSearchParams: any;
		const mockClient = {
			search: vi.fn(async (params: any) => {
				capturedSearchParams = params;
				return { results: [], has_more: false, next_cursor: null };
			}),
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
		});

		await adapter.search({
			workspace: "work",
			pageSize: 25,
		});

		expect(capturedSearchParams.sort).toEqual({
			direction: "descending",
			timestamp: "last_edited_time",
		});
	});

	it("maps objectType 'database' and 'data_source' to filter value 'data_source' for Notion API 2025-09-03 (#1993)", async () => {
		const capturedFilters: any[] = [];
		const mockClient = {
			search: vi.fn(async (params: any) => {
				capturedFilters.push(params.filter);
				return {
					results: [
						{
							id: "ds-1",
							object: "data_source",
							title: [{ plain_text: "Tasks" }],
						},
					],
					has_more: false,
					next_cursor: null,
				};
			}),
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
		});

		const dbRes = await adapter.search({
			workspace: "work",
			objectType: "database",
		});

		const dsRes = await adapter.search({
			workspace: "work",
			objectType: "data_source",
		});

		expect(capturedFilters).toEqual([
			{ property: "object", value: "data_source" },
			{ property: "object", value: "data_source" },
		]);
		expect(dbRes.results[0].object).toBe("data_source");
		expect(dsRes.results[0].object).toBe("data_source");
	});

	it("retrieves page by id", async () => {
		let capturedPageId: string | undefined;
		const mockClient = {
			pages: {
				retrieve: vi.fn(async ({ page_id }: any) => {
					capturedPageId = page_id;
					return { id: page_id, object: "page" };
				}),
			},
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
		});

		const res = await adapter.retrievePage({
			workspace: "work",
			pageId: "page-123",
		});

		expect(capturedPageId).toBe("page-123");
		expect(res.id).toBe("page-123");
	});

	it("lists block children with multi-page cursor traversal", async () => {
		let callCount = 0;
		const mockClient = {
			blocks: {
				children: {
					list: vi.fn(async ({ start_cursor }: any) => {
						callCount++;
						if (!start_cursor) {
							return {
								results: [{ id: "b1", type: "paragraph" }],
								has_more: true,
								next_cursor: "cursor_page_2",
							};
						}
						return {
							results: [{ id: "b2", type: "paragraph" }],
							has_more: false,
							next_cursor: null,
						};
					}),
				},
			},
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
		});

		const res = await adapter.listBlockChildren({
			workspace: "work",
			blockId: "container-block",
		});

		expect(callCount).toBe(2);
		expect(res.results).toHaveLength(2);
		expect(res.results[0].id).toBe("b1");
		expect(res.results[1].id).toBe("b2");
	});

	it("wraps APIResponseError with status code in error message", async () => {
		const mockClient = {
			pages: {
				retrieve: vi.fn(async () => {
					const err = new Error("Could not find page with ID") as any;
					err.code = "object_not_found";
					err.status = 404;
					Object.setPrototypeOf(err, APIResponseError.prototype);
					throw err;
				}),
			},
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
		});

		await expect(
			adapter.retrievePage({ workspace: "work", pageId: "missing-page" }),
		).rejects.toThrow("Notion API error (404): Could not find page with ID");
	});

	it("normalizes authorization headers without duplicating keys (#1375)", async () => {
		let capturedHeaders: Record<string, string> | undefined;

		const fakeFetch = vi.fn(async (_url: string, init: any) => {
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", fakeFetch);

		try {
			const adapter = new NotionClientAdapter(async () => "Bearer secret_test_token");
			await adapter.search({ workspace: "work", query: "Projects" });

			expect(capturedHeaders).toBeDefined();
			expect(capturedHeaders!["Authorization"]).toBe("Bearer secret_test_token");
			expect(capturedHeaders!["authorization"]).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("removes lowercase authorization even if Authorization already exists", async () => {
		let capturedHeaders: Record<string, string> | undefined;

		const fakeFetch = vi.fn(async (_url: string, init: any) => {
			capturedHeaders = init.headers;
			return new Response(JSON.stringify({ results: [], has_more: false, next_cursor: null }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		});

		vi.stubGlobal("fetch", fakeFetch);

		try {
			// Adapter creates Client which sets authorization: "Bearer ..."
			// Verify our customFetch cleans up if both happen to be present
			const adapter = new NotionClientAdapter(async () => "secret_token_123");
			await adapter.retrievePage({ workspace: "angus", pageId: "page_abc" });

			expect(capturedHeaders).toBeDefined();
			expect(capturedHeaders!["Authorization"]).toBe("Bearer secret_token_123");
			expect(capturedHeaders!["authorization"]).toBeUndefined();
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("retrieves database schema by id", async () => {
		let capturedDbId: string | undefined;
		const mockClient = {
			databases: {
				retrieve: vi.fn(async (params: any) => {
					capturedDbId = params.database_id;
					return {
						id: "db_123",
						properties: {
							Name: { type: "title", title: {} },
							Status: { type: "status", status: { options: [{ name: "Done" }] } },
						},
					};
				}),
			},
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
		});

		const res = await adapter.retrieveDatabase({
			workspace: "work",
			databaseId: "db_123",
		});

		expect(capturedDbId).toBe("db_123");
		expect(res.id).toBe("db_123");
		expect(res.properties?.Name.type).toBe("title");
	});

	it("retrieves data source by id", async () => {
		let capturedDsId: string | undefined;
		const mockClient = {
			dataSources: {
				retrieve: vi.fn(async (params: any) => {
					capturedDsId = params.data_source_id;
					return {
						id: "ds_456",
						parent: { type: "database_id", database_id: "db_parent_789" },
					};
				}),
			},
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
		});

		const res = await adapter.retrieveDataSource({
			workspace: "work",
			dataSourceId: "ds_456",
		});

		expect(capturedDsId).toBe("ds_456");
		expect(res.id).toBe("ds_456");
		expect(res.parent?.database_id).toBe("db_parent_789");
	});

	it("queries data source with filter, sorts, limit, and cursor", async () => {
		let capturedQueryParams: any;
		const mockClient = {
			dataSources: {
				query: vi.fn(async (params: any) => {
					capturedQueryParams = params;
					return {
						results: [{ id: "page_row_1", properties: {} }],
						has_more: true,
						next_cursor: "cursor_next",
					};
				}),
			},
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
		});

		const filter = { property: "Status", status: { equals: "Done" } };
		const sorts = [{ property: "Date", direction: "ascending" }];

		const res = await adapter.queryDataSource({
			workspace: "angus",
			dataSourceId: "ds_456",
			pageSize: 15,
			cursor: "cursor_start",
			filter,
			sorts,
		});

		expect(capturedQueryParams).toEqual({
			data_source_id: "ds_456",
			page_size: 15,
			start_cursor: "cursor_start",
			filter,
			sorts,
		});
		expect(res.results).toHaveLength(1);
		expect(res.has_more).toBe(true);
		expect(res.next_cursor).toBe("cursor_next");
	});

	it("wraps APIResponseError on retrieveDatabase and queryDataSource", async () => {
		const mockClient = {
			databases: {
				retrieve: vi.fn(async () => {
					throw new APIResponseError({
						code: "object_not_found",
						message: "Database not found",
						status: 404,
						headers: {} as any,
						body: "{}",
					});
				}),
			},
			dataSources: {
				query: vi.fn(async () => {
					throw new APIResponseError({
						code: "validation_error",
						message: "body.filter is invalid",
						status: 400,
						headers: {} as any,
						body: "{}",
					});
				}),
			},
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
		});

		await expect(
			adapter.retrieveDatabase({ workspace: "work", databaseId: "bad_db" }),
		).rejects.toThrow("Notion API error (404): Database not found");

		await expect(
			adapter.queryDataSource({ workspace: "work", dataSourceId: "bad_ds" }),
		).rejects.toThrow("Notion API error (400): body.filter is invalid");
	});

	it("retrieveBlock, deleteBlock, listComments, createComment, and getStateDocPageId succeed and handle errors", async () => {
		const mockClient = {
			blocks: {
				retrieve: vi.fn(async ({ block_id }) => {
					if (block_id === "err") {
						throw new APIResponseError({
							code: "object_not_found",
							message: "Block not found",
							status: 404,
							headers: {} as any,
							body: "{}",
						});
					}
					return { id: block_id, type: "paragraph", parent: { type: "page_id", page_id: "page-123" } };
				}),
				delete: vi.fn(async ({ block_id }) => {
					if (block_id === "err") {
						throw new APIResponseError({
							code: "object_not_found",
							message: "Block not found",
							status: 404,
							headers: {} as any,
							body: "{}",
						});
					}
					return { id: block_id, archived: true };
				}),
			},
			comments: {
				list: vi.fn(async ({ block_id, page_size, start_cursor }) => {
					if (block_id === "err") {
						throw new APIResponseError({
							code: "object_not_found",
							message: "Object not found",
							status: 404,
							headers: {} as any,
							body: "{}",
						});
					}
					return {
						results: [{ id: "c1", rich_text: [{ plain_text: "hi" }] }],
						has_more: false,
						next_cursor: null,
					};
				}),
				create: vi.fn(async (params: any) => {
					if (params.discussion_id === "err") {
						throw new APIResponseError({
							code: "object_not_found",
							message: "Discussion not found",
							status: 404,
							headers: {} as any,
							body: "{}",
						});
					}
					return {
						id: "c2",
						discussion_id: params.discussion_id ?? "disc-new",
						created_time: "2026-10-07T12:00:00Z",
					};
				}),
			},
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
			getStateDocPageId: async (ws) => (ws === "angus" ? "state-doc-personal" : undefined),
		});

		// getStateDocPageId
		expect(await adapter.getStateDocPageId?.("angus")).toBe("state-doc-personal");
		expect(await adapter.getStateDocPageId?.("work")).toBeUndefined();

		// retrieveBlock
		const block = await adapter.retrieveBlock({ workspace: "work", blockId: "b1" });
		expect(block.id).toBe("b1");
		expect(block.parent?.page_id).toBe("page-123");
		await expect(
			adapter.retrieveBlock({ workspace: "work", blockId: "err" }),
		).rejects.toThrow("Notion API error (404): Block not found");

		// deleteBlock
		const deleted = await adapter.deleteBlock({ workspace: "work", blockId: "b1" });
		expect(deleted.id).toBe("b1");
		await expect(
			adapter.deleteBlock({ workspace: "work", blockId: "err" }),
		).rejects.toThrow("Notion API error (404): Block not found");

		// listComments
		const comments = await adapter.listComments({ workspace: "work", blockId: "b1", pageSize: 10 });
		expect(comments.results).toHaveLength(1);
		await expect(
			adapter.listComments({ workspace: "work", blockId: "err" }),
		).rejects.toThrow("Notion API error (404): Object not found");

		// createComment
		const commentParent = await adapter.createComment({
			workspace: "work",
			parent: { page_id: "page-123" },
			rich_text: [{ type: "text", text: { content: "hello" } }],
		});
		expect(commentParent.id).toBe("c2");
		expect(commentParent.discussion_id).toBe("disc-new");

		const commentDiscussion = await adapter.createComment({
			workspace: "work",
			discussion_id: "disc-existing",
			rich_text: [{ type: "text", text: { content: "reply" } }],
		});
		expect(commentDiscussion.discussion_id).toBe("disc-existing");

		await expect(
			adapter.createComment({
				workspace: "work",
				discussion_id: "err",
				rich_text: [],
			}),
		).rejects.toThrow("Notion API error (404): Discussion not found");
	});

	describe("error status", () => {
		it("rejects with name: 'NotionApiError', status: 404, and unchanged message text when pages.retrieve throws a 404 NotionClientError", async () => {
			const mockClient = {
				pages: {
					retrieve: vi.fn(async () => {
						throw new APIResponseError({
							code: "object_not_found",
							message: "Could not find page with ID",
							status: 404,
							headers: {} as any,
							body: "{}",
						});
					}),
				},
			};

			const adapter = new NotionClientAdapter(async () => "secret_token", {
				clientFactory: () => mockClient as any,
			});

			let caught: unknown;
			try {
				await adapter.retrievePage({ workspace: "work", pageId: "missing-page" });
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(Error);
			expect(caught).toMatchObject({
				name: "NotionApiError",
				status: 404,
				code: "object_not_found",
				message: "Notion API error (404): Could not find page with ID",
			});
		});

		it("rejects with status undefined (never 500) and keeps today's message text when client error has no status", async () => {
			const mockClient = {
				pages: {
					retrieve: vi.fn(async () => {
						const err = new Error("Request timed out") as any;
						err.code = "notionhq_client_request_timeout";
						Object.setPrototypeOf(err, APIResponseError.prototype);
						throw err;
					}),
				},
			};

			const adapter = new NotionClientAdapter(async () => "secret_token", {
				clientFactory: () => mockClient as any,
			});

			let caught: any;
			try {
				await adapter.retrievePage({ workspace: "work", pageId: "timeout-page" });
			} catch (err) {
				caught = err;
			}

			expect(caught).toBeInstanceOf(Error);
			expect(caught.name).toBe("NotionApiError");
			expect(caught.status).toBeUndefined();
			expect(caught.code).toBe("notionhq_client_request_timeout");
			expect(caught.message).toBe("Notion API error (500): Request timed out");
		});

		it("passes a non-Notion error (TypeError) through unchanged", async () => {
			const typeErr = new TypeError("Failed to fetch");
			const mockClient = {
				pages: {
					retrieve: vi.fn(async () => {
						throw typeErr;
					}),
				},
			};

			const adapter = new NotionClientAdapter(async () => "secret_token", {
				clientFactory: () => mockClient as any,
			});

			let caught: unknown;
			try {
				await adapter.retrievePage({ workspace: "work", pageId: "any-page" });
			} catch (err) {
				caught = err;
			}

			expect(caught).toBe(typeErr);
		});
	});

	describe("page writes", () => {
		it("creates a page with a database parent and with a page parent sending the same body as createNotionPage", async () => {
			const calls: any[] = [];
			const mockClient = {
				pages: {
					create: vi.fn(async (body: any) => {
						calls.push(body);
						return { id: `page-${calls.length}`, url: `https://www.notion.so/page-${calls.length}` };
					}),
				},
			};

			const adapter = new NotionClientAdapter(async () => "secret_token", {
				clientFactory: () => mockClient as any,
				getDailyLogTargetIds: async (ws) => (ws === "angus" ? ["db-dl", "ds-dl"] : []),
			});

			expect(await adapter.getDailyLogTargetIds!("angus")).toEqual(["db-dl", "ds-dl"]);

			const dbCreated = await adapter.createPage({
				workspace: "work",
				databaseId: "db-123",
				properties: { Name: { title: [{ text: { content: "Row" } }] } },
				children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [] } }],
				icon: { emoji: "📝" },
			});
			expect(dbCreated).toMatchObject({ id: "page-1", url: "https://www.notion.so/page-1" });
			expect(calls[0]).toEqual({
				parent: { database_id: "db-123" },
				properties: { Name: { title: [{ text: { content: "Row" } }] } },
				children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [] } }],
				icon: { type: "emoji", emoji: "📝" },
			});

			const pageCreated = await adapter.createPage({
				workspace: "angus",
				parentPageId: "parent-456",
				properties: { title: { title: [{ text: { content: "Child" } }] } },
			});
			expect(pageCreated).toMatchObject({ id: "page-2", url: "https://www.notion.so/page-2" });
			expect(calls[1]).toEqual({
				parent: { page_id: "parent-456" },
				properties: { title: { title: [{ text: { content: "Child" } }] } },
			});
		});

		it("refuses createPage when neither or both parents are given before calling client", async () => {
			const createSpy = vi.fn();
			const adapter = new NotionClientAdapter(async () => "secret_token", {
				clientFactory: () => ({ pages: { create: createSpy } }) as any,
			});

			await expect(
				adapter.createPage({ workspace: "work", properties: {} }),
			).rejects.toThrow(/exactly one parent/);
			await expect(
				adapter.createPage({
					workspace: "work",
					databaseId: "db-1",
					parentPageId: "page-1",
					properties: {},
				}),
			).rejects.toThrow(/exactly one parent/);
			expect(createSpy).not.toHaveBeenCalled();
		});

		it("appendBlockChildren sends at most 100 children per call and returns the created ids", async () => {
			const appendCalls: any[] = [];
			const mockClient = {
				blocks: {
					children: {
						append: vi.fn(async (params: any) => {
							appendCalls.push(params);
							return {
								results: params.children.map((_: unknown, idx: number) => ({
									id: `blk-${appendCalls.length}-${idx}`,
								})),
							};
						}),
					},
				},
			};

			const adapter = new NotionClientAdapter(async () => "secret_token", {
				clientFactory: () => mockClient as any,
			});

			const blocks = Array.from({ length: 150 }, (_, i) => ({
				object: "block",
				type: "paragraph",
				paragraph: { rich_text: [{ text: { content: `line ${i}` } }] },
			}));

			const ids = await adapter.appendBlockChildren({
				workspace: "work",
				blockId: "page-1",
				children: blocks,
			});

			expect(appendCalls).toHaveLength(2);
			expect(appendCalls[0].block_id).toBe("page-1");
			expect(appendCalls[0].children).toHaveLength(100);
			expect(appendCalls[0].after).toBeUndefined();
			expect(appendCalls[1].block_id).toBe("page-1");
			expect(appendCalls[1].children).toHaveLength(50);
			expect(appendCalls[1].after).toBeUndefined();
			expect(ids).toHaveLength(150);
			expect(ids[0]).toBe("blk-1-0");
			expect(ids[149]).toBe("blk-2-49");

			appendCalls.length = 0;
			const chainedIds = await adapter.appendBlockChildren({
				workspace: "work",
				blockId: "page-1",
				children: blocks,
				after: "anchor-blk",
			});
			expect(appendCalls).toHaveLength(2);
			expect(appendCalls[0].after).toBe("anchor-blk");
			expect(appendCalls[1].after).toBe("blk-1-99");
			expect(chainedIds).toHaveLength(150);
		});

		it("leaves getStateDocPageId and getDailyLogTargetIds undefined when omitted from options and delegates when wired", async () => {
			const unwired = new NotionClientAdapter(async () => "secret_token");
			expect(unwired.getStateDocPageId).toBeUndefined();
			expect(unwired.getDailyLogTargetIds).toBeUndefined();

			const wired = new NotionClientAdapter(async () => "secret_token", {
				getStateDocPageId: async (ws) => `state-${ws}`,
				getDailyLogTargetIds: async (ws) => [`dl-db-${ws}`, `dl-ds-${ws}`],
			});
			expect(await wired.getStateDocPageId?.("angus")).toBe("state-angus");
			expect(await wired.getDailyLogTargetIds?.("work")).toEqual([
				"dl-db-work",
				"dl-ds-work",
			]);
		});

		it("rejects with NotionApiError and status: 404 when createPage or appendBlockChildren hits a 404", async () => {
			const notFoundErr = () =>
				new APIResponseError({
					code: "object_not_found",
					message: "Could not find parent",
					status: 404,
					headers: {} as any,
					body: "{}",
				});

			const mockClient = {
				pages: {
					create: vi.fn(async () => {
						throw notFoundErr();
					}),
				},
				blocks: {
					children: {
						append: vi.fn(async () => {
							throw notFoundErr();
						}),
					},
				},
			};

			const adapter = new NotionClientAdapter(async () => "secret_token", {
				clientFactory: () => mockClient as any,
			});

			await expect(
				adapter.createPage({
					workspace: "work",
					databaseId: "missing-db",
					properties: {},
				}),
			).rejects.toMatchObject({
				name: "NotionApiError",
				status: 404,
				code: "object_not_found",
			});

			await expect(
				adapter.appendBlockChildren({
					workspace: "work",
					blockId: "missing-page",
					children: [{ type: "paragraph" }],
				}),
			).rejects.toMatchObject({
				name: "NotionApiError",
				status: 404,
				code: "object_not_found",
			});
		});

		describe("createPage on the default client when Notion's answer cannot be read (#2366)", () => {
			const createPageError = async (answer: () => Promise<unknown>) => {
				const fakeFetch = vi.fn(answer);
				vi.stubGlobal("fetch", fakeFetch);
				try {
					const adapter = new NotionClientAdapter(async () => "secret_token");
					const err: unknown = await adapter
						.createPage({ workspace: "work", databaseId: "db-1", properties: {} })
						.catch((e: unknown) => e);
					const [url, init] = fakeFetch.mock.calls[0] as unknown as [string, { method: string }];
					expect(`${init.method} ${new URL(url).pathname}`).toBe("POST /v1/pages");
					return err;
				} finally {
					vi.unstubAllGlobals();
				}
			};

			it("rejects with ExternalItemCreatedButUnreadable on a 200 whose body is not JSON", async () => {
				const err = await createPageError(async () => new Response("<html>oops</html>", { status: 200 }));
				expect(err).toBeInstanceOf(ExternalItemCreatedButUnreadable);
				expect((err as Error).message).toMatch(/^A Notion page was created/);
			});

			it("rejects with ExternalItemCreatedButUnreadable on a 200 whose body read rejects", async () => {
				const err = await createPageError(async () => ({
					ok: true,
					status: 200,
					headers: new Headers(),
					text: async () => {
						throw new Error("socket hang up");
					},
				}));
				expect(err).toBeInstanceOf(ExternalItemCreatedButUnreadable);
				expect((err as Error).message).toMatch(/^A Notion page was created/);
			});

			it("still rejects a non-2xx answer with NotionApiError", async () => {
				const body = { object: "error", status: 404, code: "object_not_found", message: "No parent" };
				const err = await createPageError(async () => new Response(JSON.stringify(body), { status: 404 }));
				expect(err).toMatchObject({ name: "NotionApiError", status: 404, code: "object_not_found" });
				expect(err).not.toBeInstanceOf(ExternalItemCreatedButUnreadable);
			});

			it("passes a rejected fetch through unchanged", async () => {
				const networkErr = new TypeError("fetch failed");
				const err = await createPageError(async () => {
					throw networkErr;
				});
				expect(err).toBe(networkErr);
				expect(err).not.toBeInstanceOf(ExternalItemCreatedButUnreadable);
			});
		});
	});

	describe("page updates", () => {
		it("updateBlock sends the same PATCH body as updateNotionBlock", async () => {
			const calls: Array<{ method: string; path: string; body: unknown; auth?: string }> = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init: RequestInit = {}) => {
					calls.push({
						method: init.method ?? "GET",
						path: new URL(url).pathname,
						body: init.body ? JSON.parse(init.body as string) : undefined,
						auth: (init.headers as Record<string, string> | undefined)?.Authorization,
					});
					return new Response(JSON.stringify({ id: "block-123", type: "to_do" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}),
			);

			try {
				const adapter = new NotionClientAdapter(async () => "Bearer secret_work");
				await adapter.updateBlock({
					workspace: "work",
					blockId: "block-123",
					payload: {
						to_do: {
							rich_text: [{ type: "text", text: { content: "Passport renewed" } }],
							checked: true,
						},
					},
				});

				expect(calls).toEqual([
					{
						method: "PATCH",
						path: "/v1/blocks/block-123",
						body: {
							to_do: {
								rich_text: [{ type: "text", text: { content: "Passport renewed" } }],
								checked: true,
							},
						},
						auth: "Bearer secret_work",
					},
				]);
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("updatePage with archived: true, archived: false, icon, and properties sends the same PATCH bodies as patchNotionPage", async () => {
			const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
			vi.stubGlobal(
				"fetch",
				vi.fn(async (url: string, init: RequestInit = {}) => {
					calls.push({
						method: init.method ?? "GET",
						path: new URL(url).pathname,
						body: init.body ? JSON.parse(init.body as string) : {},
					});
					return new Response(JSON.stringify({ id: "page-123" }), {
						status: 200,
						headers: { "content-type": "application/json" },
					});
				}),
			);

			try {
				const adapter = new NotionClientAdapter(async () => "secret_token");

				await adapter.updatePage({ workspace: "work", pageId: "page-123", archived: true });
				await adapter.updatePage({ workspace: "work", pageId: "page-123", archived: false });
				await adapter.updatePage({
					workspace: "work",
					pageId: "page-123",
					icon: { emoji: "📓" },
				});
				await adapter.updatePage({ workspace: "work", pageId: "page-123", icon: null });
				await adapter.updatePage({
					workspace: "work",
					pageId: "page-123",
					properties: { Status: { select: { name: "Done" } } },
				});
				await adapter.updatePage({
					workspace: "work",
					pageId: "page-123",
					properties: { Status: { select: { name: "Dropped" } } },
					archived: true,
				});

				expect(calls.map((c) => ({ method: c.method, path: c.path }))).toEqual(
					Array(6).fill({ method: "PATCH", path: "/v1/pages/page-123" }),
				);
				expect(calls[0].body).toEqual({ archived: true });
				expect(calls[1].body).toEqual({ archived: false });
				expect(calls[2].body).toEqual({ icon: { emoji: "📓" } });
				expect(calls[3].body).toEqual({ icon: null });
				expect(calls[4].body).toEqual({
					properties: { Status: { select: { name: "Done" } } },
				});
				expect(calls[4].body).not.toHaveProperty("archived");
				expect(calls[4].body).not.toHaveProperty("icon");
				expect(calls[5].body).toEqual({
					properties: { Status: { select: { name: "Dropped" } } },
					archived: true,
				});
			} finally {
				vi.unstubAllGlobals();
			}
		});

		it("rejects with NotionApiError and status: 404 when updateBlock or updatePage hits a 404", async () => {
			const notFoundErr = () =>
				new APIResponseError({
					code: "object_not_found",
					message: "Could not find target",
					status: 404,
					headers: {} as any,
					body: "{}",
				});

			const mockClient = {
				blocks: {
					update: vi.fn(async () => {
						throw notFoundErr();
					}),
				},
				pages: {
					update: vi.fn(async () => {
						throw notFoundErr();
					}),
				},
			};

			const adapter = new NotionClientAdapter(async () => "secret_token", {
				clientFactory: () => mockClient as any,
			});

			await expect(
				adapter.updateBlock({
					workspace: "work",
					blockId: "missing-block",
					payload: { paragraph: { rich_text: [] } },
				}),
			).rejects.toMatchObject({
				name: "NotionApiError",
				status: 404,
				code: "object_not_found",
			});

			await expect(
				adapter.updatePage({
					workspace: "work",
					pageId: "missing-page",
					archived: true,
				}),
			).rejects.toMatchObject({
				name: "NotionApiError",
				status: 404,
				code: "object_not_found",
			});
		});
	});

	it("listUsers pages through has_more and normalizes users", async () => {
		const calls: any[] = [];
		const mockClient = {
			users: {
				list: vi.fn(async (params: any) => {
					calls.push(params);
					return params.start_cursor
						? { results: [{ id: "bot-1" }], has_more: false, next_cursor: null }
						: {
								results: [{ id: "u1", name: "Angus", type: "person", person: { email: "owner@example.com" } }, { name: "NoId" }],
								has_more: true,
								next_cursor: "cursor_2",
							};
				}),
			},
		};
		const adapter = new NotionClientAdapter(async () => "secret_token", { clientFactory: () => mockClient as any });
		const users = await adapter.listUsers({ workspace: "work" });
		expect(calls).toEqual([{ page_size: 100, start_cursor: undefined }, { page_size: 100, start_cursor: "cursor_2" }]);
		expect(users).toEqual([
			{ id: "u1", name: "Angus", type: "person", email: "owner@example.com" },
			{ id: "bot-1", name: "(unnamed)", type: "unknown" },
		]);
	});

	it("covers the State Doc block read and write cycle with NotionBlock and NotionRichTextRun (#1470)", async () => {
		const updatedBlocks: Array<{ block_id: string; payload: unknown }> = [];
		const deletedBlocks: string[] = [];
		const appendedBlocks: Array<{ block_id: string; children: unknown[]; after?: string }> = [];

		const mockClient = {
			blocks: {
				children: {
					list: vi.fn(async ({ block_id }: any) => ({
						results: [
							{
								id: `${block_id}-h2`,
								type: "heading_2",
								heading_2: {
									rich_text: [{ type: "text", plain_text: "🧱 Tech stack", text: { content: "🧱 Tech stack" } }],
								},
							},
							{
								id: `${block_id}-p1`,
								type: "paragraph",
								paragraph: {
									rich_text: [{ type: "text", plain_text: "Old body", text: { content: "Old body" } }],
								},
							},
						],
						has_more: false,
						next_cursor: null,
					})),
					append: vi.fn(async ({ block_id, children, after }: any) => {
						appendedBlocks.push({ block_id, children, after });
						return { results: [{ id: "new-p1" }] };
					}),
				},
				update: vi.fn(async ({ block_id, ...payload }: any) => {
					updatedBlocks.push({ block_id, payload });
					return { id: block_id };
				}),
				delete: vi.fn(async ({ block_id }: any) => {
					deletedBlocks.push(block_id);
					return { id: block_id, type: "paragraph", archived: true };
				}),
			},
		};

		const adapter = new NotionClientAdapter(async () => "secret_token", {
			clientFactory: () => mockClient as any,
			getStateDocPageId: async (ws) => (ws === "work" ? "sdp-1" : undefined),
		});

		const pageId = await adapter.getStateDocPageId!("work");
		expect(pageId).toBe("sdp-1");

		const listed = await adapter.listBlockChildren({ workspace: "work", blockId: pageId! });
		expect(listed.results).toHaveLength(2);

		const createdIds = await adapter.appendBlockChildren({
			workspace: "work",
			blockId: pageId!,
			children: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: "New body" } }] } }],
			after: listed.results[0].id,
		});
		expect(createdIds).toEqual(["new-p1"]);
		expect(appendedBlocks[0]).toMatchObject({ block_id: "sdp-1", after: "sdp-1-h2" });

		await adapter.deleteBlock({ workspace: "work", blockId: listed.results[1].id });
		expect(deletedBlocks).toEqual(["sdp-1-p1"]);

		await adapter.updateBlock({
			workspace: "work",
			blockId: listed.results[0].id,
			payload: { heading_2: { rich_text: [{ type: "text", text: { content: "🧱 Stack" } }] } },
		});
		expect(updatedBlocks).toEqual([
			{
				block_id: "sdp-1-h2",
				payload: { heading_2: { rich_text: [{ type: "text", text: { content: "🧱 Stack" } }] } },
			},
		]);
	});
});

