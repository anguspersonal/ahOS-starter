import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { serverRegistry } from "../actions/serverRegistry.js";
import { docsGetHandler } from "../tools/docs/get.js";
import { docsFindTextHandler } from "../tools/docs/findText.js";
import * as docsModule from "../google/docs.js";
import * as driveModule from "../google/drive.js";

const docsBatchUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("docs_batch_update")!).handler(args);

const docsCommentsHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("docs_comments")!).handler(args);

vi.mock("../google/docs.js", async (importOriginal) => {
	const actual = await importOriginal<typeof docsModule>();
	return {
		...actual,
		getDocs: vi.fn(),
	};
});

vi.mock("../google/docsPort.js", () => ({
	docsPort: {
		getDocument: vi.fn(
			async ({
				domain,
				documentId,
				includeTabsContent,
				suggestionsViewMode,
				fields,
			}: {
				domain: "work" | "angus";
				documentId: string;
				includeTabsContent?: boolean;
				suggestionsViewMode?: string;
				fields?: string;
			}) => {
				const account = domain === "work" ? "work" : "personal";
				const docs = await docsModule.getDocs(account);
				const params: Record<string, unknown> = {
					documentId,
					includeTabsContent: includeTabsContent ?? true,
				};
				if (suggestionsViewMode !== undefined) {
					params.suggestionsViewMode = suggestionsViewMode;
				}
				if (fields !== undefined) {
					params.fields = fields;
				}
				const res = await docs.documents.get(params as any);
				return res.data;
			},
		),
		batchUpdate: vi.fn(
			async ({
				domain,
				documentId,
				requests,
				writeControl,
			}: {
				domain: "work" | "angus";
				documentId: string;
				requests: Record<string, unknown>[];
				writeControl?: Record<string, unknown>;
			}) => {
				const account = domain === "work" ? "work" : "personal";
				const docs = await docsModule.getDocs(account);
				const res = await docs.documents.batchUpdate({
					documentId,
					requestBody: {
						requests,
						writeControl,
					},
				} as any);
				return res.data;
			},
		),
	},
}));

vi.mock("../google/drive.js", async (importOriginal) => {
	const actual = await importOriginal<typeof driveModule>();
	return {
		...actual,
		getDrive: vi.fn(),
	};
});

vi.mock("../google/drivePort.js", () => ({
	drivePort: {
		listComments: vi.fn(async ({ domain, fileId, pageSize, includeDeleted }: any) => {
			const account = domain === "work" ? "work" : "personal";
			const drive = await driveModule.getDrive(account);
			const res = await drive.comments.list({
				fileId,
				fields: "comments(id,content,author(displayName,emailAddress),createdTime,modifiedTime,resolved,quotedFileContent,replies(id,content,author(displayName,emailAddress),createdTime))",
				pageSize: pageSize ?? 20,
				includeDeleted: includeDeleted ?? false,
			});
			return { comments: res.data.comments ?? [] };
		}),
		createComment: vi.fn(async ({ domain, fileId, content, quotedFileContent }: any) => {
			const account = domain === "work" ? "work" : "personal";
			const drive = await driveModule.getDrive(account);
			const requestBody: Record<string, unknown> = { content };
			if (quotedFileContent) requestBody.quotedFileContent = quotedFileContent;
			const res = await drive.comments.create({
				fileId,
				requestBody,
				fields: "id,content,author(displayName,emailAddress),createdTime,quotedFileContent",
			} as any);
			return res.data;
		}),
		createReply: vi.fn(async ({ domain, fileId, commentId, content }: any) => {
			const account = domain === "work" ? "work" : "personal";
			const drive = await driveModule.getDrive(account);
			const res = await drive.replies.create({
				fileId,
				commentId,
				requestBody: { content },
				fields: "id,content,author(displayName,emailAddress),createdTime",
			});
			return res.data;
		}),
	},
}));

vi.mock("../supabase.js", () => ({
	supabase: {
		from: vi.fn(() => ({
			select: vi.fn(() => ({
				eq: vi.fn(() => ({
					limit: vi.fn(async () => ({ data: [], error: null })),
				})),
			})),
			update: vi.fn(() => ({
				eq: vi.fn(async () => ({ error: null })),
			})),
		})),
	},
}));

describe("Google Docs MCP Tools", () => {
	const mockDocsGet = vi.fn();
	const mockDocsBatchUpdate = vi.fn();
	const mockCommentsList = vi.fn();
	const mockCommentsCreate = vi.fn();
	const mockRepliesCreate = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(docsModule.getDocs).mockResolvedValue({
			documents: {
				get: mockDocsGet,
				batchUpdate: mockDocsBatchUpdate,
			},
		} as unknown as ReturnType<typeof docsModule.getDocs> extends Promise<infer T> ? T : never);

		vi.mocked(driveModule.getDrive).mockResolvedValue({
			comments: {
				list: mockCommentsList,
				create: mockCommentsCreate,
			},
			replies: {
				create: mockRepliesCreate,
			},
		} as unknown as ReturnType<typeof driveModule.getDrive> extends Promise<infer T> ? T : never);
	});

	// ---- docs_get -------------------------------------------------------------
	describe("docs_get", () => {
		it("returns revisionId, tabs, and compact outline with start/end indices", async () => {
			mockDocsGet.mockResolvedValueOnce({
				data: {
					documentId: "doc-123",
					title: "Test Document",
					revisionId: "rev-456",
					tabs: [
						{
							tabProperties: { tabId: "t.0", title: "Main", index: 0 },
							documentTab: {
								body: {
									content: [
										{
											startIndex: 1,
											endIndex: 20,
											paragraph: {
												elements: [{ textRun: { content: "Document Title\n" } }],
												paragraphStyle: { namedStyleType: "TITLE" },
											},
										},
										{
											startIndex: 20,
											endIndex: 50,
											paragraph: {
												elements: [{ textRun: { content: "This is a body paragraph.\n" } }],
												paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
											},
										},
										{
											startIndex: 50,
											endIndex: 120,
											table: {
												tableRows: [
													{ tableCells: [{ content: [] }, { content: [] }] },
													{ tableCells: [{ content: [] }, { content: [] }] },
												],
											},
										},
									],
								},
							},
						},
					],
				},
			});

			const res = await docsGetHandler({
				document_id: "doc-123",
				domain: "angus",
			});

			expect(mockDocsGet).toHaveBeenCalledWith({
				documentId: "doc-123",
				includeTabsContent: true,
			});

			const text = res.content[0].text;
			expect(text).toContain("Document: Test Document");
			expect(text).toContain("Revision ID: rev-456");
			expect(text).toContain("Tab: Main (tabId: 't.0')");
			expect(text).toContain('[1..20] TITLE: "Document Title"');
			expect(text).toContain('[20..50] PARAGRAPH: "This is a body paragraph."');
			expect(text).toContain("[50..120] TABLE (2 rows x 2 cols)");
		});

		it("filters by single tab_id and errors cleanly on non-existent tab", async () => {
			mockDocsGet.mockResolvedValueOnce({
				data: {
					documentId: "doc-123",
					title: "Tabbed Doc",
					revisionId: "rev-1",
					tabs: [
						{ tabProperties: { tabId: "t.1", title: "Summary" } },
						{ tabProperties: { tabId: "t.2", title: "Details" } },
					],
				},
			});

			await expect(
				docsGetHandler({
					document_id: "doc-123",
					domain: "work",
					tab_id: "non-existent-tab",
				}),
			).rejects.toThrow(/Tab 'non-existent-tab' not found/);
		});

		it("passes suggestionsViewMode when include_suggestions is true", async () => {
			mockDocsGet.mockResolvedValueOnce({
				data: {
					documentId: "doc-1",
					title: "Doc",
					revisionId: "rev-1",
					tabs: [],
				},
			});

			await docsGetHandler({
				document_id: "doc-1",
				domain: "angus",
				include_suggestions: true,
				field_mask: "title,revisionId",
			});

			expect(mockDocsGet).toHaveBeenCalledWith({
				documentId: "doc-1",
				includeTabsContent: true,
				suggestionsViewMode: "SUGGESTIONS_INLINE",
				fields: "title,revisionId",
			});
		});
	});

	// ---- docs_batch_update ----------------------------------------------------
	describe("docs_batch_update", () => {
		it("refuses calls without required_revision_id", async () => {
			await expect(
				docsBatchUpdateHandler({
					document_id: "doc-123",
					domain: "angus",
					required_revision_id: "",
					requests: [{ insertText: { text: "hi", location: { index: 1 } } }],
				}),
			).rejects.toThrow(/required_revision_id is required/);
		});

		it("sends writeControl.requiredRevisionId and returns updated revisionId", async () => {
			mockDocsBatchUpdate.mockResolvedValueOnce({
				data: {
					writeControl: { requiredRevisionId: "rev-new" },
					replies: [{ insertText: {} }],
				},
			});

			const res = await docsBatchUpdateHandler({
				document_id: "doc-123",
				domain: "angus",
				required_revision_id: "rev-old",
				requests: [{ insertText: { text: "new text", location: { index: 1 } } }],
			});

			expect(mockDocsBatchUpdate).toHaveBeenCalledWith({
				documentId: "doc-123",
				requestBody: {
					requests: [{ insertText: { text: "new text", location: { index: 1 } } }],
					writeControl: { requiredRevisionId: "rev-old" },
				},
			});

			const text = res.content[0].text;
			expect(text).toContain("Successfully applied 1 batchUpdate request(s)");
			expect(text).toContain("Revision before: rev-old");
			expect(text).toContain("Revision after:  rev-new");
			expect(text).toContain("Mode: Direct edit");
		});

		it("translates a revision mismatch error into a clear re-read instruction", async () => {
			mockDocsBatchUpdate.mockRejectedValueOnce(
				Object.assign(
					new Error(
						"The required revision ID 'AHj4eMT-iY_uIZEkTXEh3liXTV0_5DwQyF4UZINPQHPsvJ5EZ-r1pjTTvqFM3wr_7ZqOF45WXXRSnUbU5ABe5VpfGyld8F1ygKponeoVDIw' does not match the latest revision.",
					),
					{ status: 400, googleStatus: "INVALID_ARGUMENT" },
				),
			);

			await expect(
				docsBatchUpdateHandler({
					document_id: "doc-123",
					domain: "work",
					required_revision_id: "stale-rev",
					requests: [{ insertText: { text: "new text", location: { index: 1 } } }],
				}),
			).rejects.toThrow(/Doc changed since your read \(revision mismatch: required 'stale-rev'\)/);
		});

		it("sends writeControl.writeMode = 'SUGGEST' when suggest: true, and never falls back to direct edit on refusal", async () => {
			mockDocsBatchUpdate.mockRejectedValueOnce(
				new Error("403 Suggestion mode writeMode is not permitted"),
			);

			await expect(
				docsBatchUpdateHandler({
					document_id: "doc-123",
					domain: "angus",
					required_revision_id: "rev-1",
					requests: [{ insertText: { text: "proposed text", location: { index: 1 } } }],
					suggest: true,
				}),
			).rejects.toThrow(/Google refused suggestion mode \(suggest: true\).*ahKMS will never fall back to a direct edit/);

			expect(mockDocsBatchUpdate).toHaveBeenCalledTimes(1);
			expect(mockDocsBatchUpdate).toHaveBeenCalledWith({
				documentId: "doc-123",
				requestBody: {
					requests: [{ insertText: { text: "proposed text", location: { index: 1 } } }],
					writeControl: { requiredRevisionId: "rev-1", writeMode: "SUGGEST" },
				},
			});
		});
	});

	// ---- docs_find_text -------------------------------------------------------
	describe("docs_find_text", () => {
		it("accurately finds text match spanning multiple textRuns in paragraph", async () => {
			mockDocsGet.mockResolvedValueOnce({
				data: {
					documentId: "doc-search",
					title: "Search Test",
					revisionId: "rev-10",
					tabs: [
						{
							tabProperties: { tabId: "t.alpha", title: "Alpha Tab" },
							documentTab: {
								body: {
									content: [
										{
											startIndex: 10,
											endIndex: 30,
											paragraph: {
												elements: [
													{ startIndex: 10, endIndex: 16, textRun: { content: "Target" } },
													{ startIndex: 16, endIndex: 17, textRun: { content: " " } },
													{ startIndex: 17, endIndex: 23, textRun: { content: "Phrase" } },
													{ startIndex: 23, endIndex: 30, textRun: { content: " is here\n" } },
												],
											},
										},
									],
								},
							},
						},
					],
				},
			});

			const res = await docsFindTextHandler({
				document_id: "doc-search",
				domain: "angus",
				text: "Target Phrase",
			});

			const text = res.content[0].text;
			expect(text).toContain('Found 1 occurrence(s) of "Target Phrase"');
			expect(text).toContain("Tab:          Alpha Tab (tabId: 't.alpha')");
			expect(text).toContain("Range:        startIndex: 10, endIndex: 23");
			expect(text).toContain('Matched text: "Target Phrase"');
		});

		it("searches inside table cells and reports occurrences", async () => {
			mockDocsGet.mockResolvedValueOnce({
				data: {
					documentId: "doc-table",
					title: "Table Doc",
					revisionId: "rev-11",
					tabs: [
						{
							tabProperties: { tabId: "t.table", title: "Grid" },
							documentTab: {
								body: {
									content: [
										{
											startIndex: 1,
											endIndex: 100,
											table: {
												tableRows: [
													{
														tableCells: [
															{
																content: [
																	{
																		startIndex: 5,
																		endIndex: 25,
																		paragraph: {
																			elements: [
																				{
																					startIndex: 5,
																					endIndex: 25,
																					textRun: { content: "Needle in table cell\n" },
																				},
																			],
																		},
																	},
																],
															},
														],
													},
												],
											},
										},
									],
								},
							},
						},
					],
				},
			});

			const res = await docsFindTextHandler({
				document_id: "doc-table",
				domain: "work",
				text: "Needle",
			});

			const text = res.content[0].text;
			expect(text).toContain('Found 1 occurrence(s) of "Needle"');
			expect(text).toContain("startIndex: 5, endIndex: 11");
		});

		it("returns clean message when no match is found", async () => {
			mockDocsGet.mockResolvedValueOnce({
				data: {
					documentId: "doc-none",
					title: "Empty Doc",
					revisionId: "rev-0",
					tabs: [],
					body: { content: [] },
				},
			});

			const res = await docsFindTextHandler({
				document_id: "doc-none",
				domain: "angus",
				text: "missing text",
			});

			expect(res.content[0].text).toContain('No occurrences of "missing text" found');
		});
	});

	// ---- docs_comments --------------------------------------------------------
	describe("docs_comments", () => {
		it("lists comments and replies, filtering out resolved comments by default", async () => {
			mockCommentsList.mockResolvedValueOnce({
				data: {
					comments: [
						{
							id: "c-1",
							content: "Please check this paragraph",
							author: { displayName: "Alice" },
							createdTime: "2026-10-02T09:00:00Z",
							resolved: false,
							quotedFileContent: { value: "some important text" },
							replies: [
								{
									id: "r-1",
									content: "Looks good to me",
									author: { displayName: "Bob" },
									createdTime: "2026-10-02T09:10:00Z",
								},
							],
						},
						{
							id: "c-2",
							content: "Old resolved comment",
							resolved: true,
						},
					],
				},
			});

			const res = await docsCommentsHandler({
				document_id: "doc-comments",
				domain: "work",
				action: "list",
			});

			const text = res.content[0].text;
			expect(text).toContain("Comments on work:doc-comments (1 returned, 2 scanned):");
			expect(text).toContain('- [c-1] Alice: "Please check this paragraph" (1 reply)');
			expect(text).not.toContain("Old resolved comment");
		});

		it("creates a comment anchored to quoted text", async () => {
			mockCommentsCreate.mockResolvedValueOnce({
				data: {
					id: "c-created",
					content: "Needs revision",
					author: { displayName: "Angus" },
					createdTime: "2026-10-02T10:00:00Z",
				},
			});

			const res = await docsCommentsHandler({
				document_id: "doc-comments",
				domain: "angus",
				action: "create",
				content: "Needs revision",
				quoted_text: "quoted phrase",
			});

			expect(mockCommentsCreate).toHaveBeenCalledWith({
				fileId: "doc-comments",
				requestBody: {
					content: "Needs revision",
					quotedFileContent: {
						value: "quoted phrase",
						mimeType: "text/plain",
					},
				},
				fields: "id,content,author(displayName,emailAddress),createdTime,quotedFileContent",
			});

			const text = res.content[0].text;
			expect(text).toContain("Created comment c-created on document doc-comments");
			expect(text).toContain('Quoted:  "quoted phrase"');
			expect(text).toContain('Content: "Needs revision"');
		});

		it("replies to an existing comment", async () => {
			mockRepliesCreate.mockResolvedValueOnce({
				data: {
					id: "r-new",
					content: "Fixed now",
					author: { displayName: "Angus" },
					createdTime: "2026-10-02T10:05:00Z",
				},
			});

			const res = await docsCommentsHandler({
				document_id: "doc-comments",
				domain: "angus",
				action: "reply",
				comment_id: "c-1",
				content: "Fixed now",
			});

			expect(mockRepliesCreate).toHaveBeenCalledWith({
				fileId: "doc-comments",
				commentId: "c-1",
				requestBody: { content: "Fixed now" },
				fields: "id,content,author(displayName,emailAddress),createdTime",
			});

			const text = res.content[0].text;
			expect(text).toContain("Created reply r-new on comment c-1");
			expect(text).toContain('Content: "Fixed now"');
		});
	});
});
