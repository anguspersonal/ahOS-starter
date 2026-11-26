import { describe, expect, it, vi } from "vitest";
import { createNotionBlockDeleteAction, resolveParentPageId, sameNotionId } from "./blockDelete.js";
import type { NotionPort } from "../../ports/notion.js";

const PAGE_ID = "8db39ce2-4513-4593-9a57-f3a9a0a05ed7";
const STATE_DOC_ID = "aaaabbbb-cccc-dddd-eeee-ffff00001111";
const BLOCK_ID = "11112222-3333-4444-5555-666677778888";
const OUTER_BLOCK_ID = "99998888-7777-6666-5555-444433332222";

describe("sameNotionId helper", () => {
	it("matches dashed and undashed ids case-insensitively", () => {
		expect(sameNotionId(STATE_DOC_ID, STATE_DOC_ID.replace(/-/g, "").toUpperCase())).toBe(true);
		expect(sameNotionId(STATE_DOC_ID, PAGE_ID)).toBe(false);
	});
});

describe("notionBlockDeleteAction", () => {
	const createMockPort = (overrides?: Partial<NotionPort>): NotionPort => ({
		resolveToken: vi.fn(),
		search: vi.fn(),
		retrievePage: vi.fn(),
		listBlockChildren: vi.fn(),
		retrieveDatabase: vi.fn(),
		retrieveDataSource: vi.fn(),
		queryDataSource: vi.fn(),
		retrieveBlock: vi.fn(),
		deleteBlock: vi.fn(),
		listComments: vi.fn(),
		createComment: vi.fn(),
		...overrides,
	});

	it("refuses when domain is missing", async () => {
		const action = createNotionBlockDeleteAction(createMockPort());
		await expect(action.run({} as any, { caller: "test", requestId: "r1" })).rejects.toThrow(
			"`domain` is required to delete a Notion block",
		);
	});

	it("refuses when block_id is missing", async () => {
		const action = createNotionBlockDeleteAction(createMockPort());
		await expect(
			action.run({ domain: "work" } as any, { caller: "test", requestId: "r1" }),
		).rejects.toThrow("`block_id` is required");
	});

	it("deletes a block whose parent is an ordinary page and formats trash message", async () => {
		let deletedBlockId: string | undefined;
		const mockPort = createMockPort({
			retrieveBlock: vi.fn(async () => ({
				id: BLOCK_ID,
				type: "paragraph",
				parent: { type: "page_id", page_id: PAGE_ID },
			})),
			deleteBlock: vi.fn(async ({ blockId }) => {
				deletedBlockId = blockId;
				return { id: blockId, archived: true, type: "paragraph" };
			}),
		});

		const action = createNotionBlockDeleteAction(mockPort);
		const result = await action.run(
			{ domain: "work", block_id: BLOCK_ID },
			{ caller: "test", requestId: "r1" },
		);

		expect(deletedBlockId).toBe(BLOCK_ID);
		expect(result).toEqual({
			domain: "work",
			blockId: BLOCK_ID,
			pageId: PAGE_ID,
		});

		const formatted = action.formatMcp!(result);
		expect(formatted).toBe(
			`Deleted block ${BLOCK_ID} from page ${PAGE_ID} (domain='work'). Notion moved it to that page's trash, so it can be restored from the Notion UI.`,
		);
	});

	it("walks up nested block parents to find owning page", async () => {
		const mockPort = createMockPort({
			retrieveBlock: vi.fn(async ({ blockId }) => {
				if (blockId === BLOCK_ID) {
					return {
						id: BLOCK_ID,
						type: "paragraph",
						parent: { type: "block_id", block_id: OUTER_BLOCK_ID },
					};
				}
				if (blockId === OUTER_BLOCK_ID) {
					return {
						id: OUTER_BLOCK_ID,
						type: "toggle",
						parent: { type: "page_id", page_id: PAGE_ID },
					};
				}
				throw new Error("unexpected block");
			}),
			deleteBlock: vi.fn(async ({ blockId }) => ({ id: blockId, archived: true, type: "paragraph" })),
		});

		const action = createNotionBlockDeleteAction(mockPort);
		const result = await action.run(
			{ domain: "work", block_id: BLOCK_ID },
			{ caller: "test", requestId: "r1" },
		);

		expect(result.pageId).toBe(PAGE_ID);
	});

	it("refuses when parent cannot be resolved to a page", async () => {
		const mockPort = createMockPort({
			retrieveBlock: vi.fn(async () => ({
				id: BLOCK_ID,
				type: "paragraph",
				parent: { type: "workspace", workspace: true },
			})),
		});

		const action = createNotionBlockDeleteAction(mockPort);
		await expect(
			action.run({ domain: "work", block_id: BLOCK_ID }, { caller: "test", requestId: "r1" }),
		).rejects.toThrow("Could not resolve which page block " + BLOCK_ID + " belongs to, so the State Doc guard (ADR-053) cannot be applied.");
	});

	it("refuses a block nested inside the State Doc", async () => {
		const mockPort = createMockPort({
			getStateDocPageId: vi.fn(async (domain) => (domain === "angus" ? STATE_DOC_ID.replace(/-/g, "") : undefined)),
			retrieveBlock: vi.fn(async ({ blockId }) => {
				if (blockId === BLOCK_ID) {
					return {
						id: BLOCK_ID,
						type: "paragraph",
						parent: { type: "block_id", block_id: OUTER_BLOCK_ID },
					};
				}
				return {
					id: OUTER_BLOCK_ID,
					type: "column",
					parent: { type: "page_id", page_id: STATE_DOC_ID },
				};
			}),
			deleteBlock: vi.fn(),
		});

		const action = createNotionBlockDeleteAction(mockPort);
		await expect(
			action.run({ domain: "angus", block_id: BLOCK_ID }, { caller: "test", requestId: "r1" }),
		).rejects.toThrow("This is the 'angus' State Doc. Its sections are edited only through state_doc_update (ADR-053 one-writer rule)");

		expect(mockPort.deleteBlock).not.toHaveBeenCalled();
	});

	it("adds cross-workspace hint on 404 status even without (404) in message, and ignores (404) text when status is 500", async () => {
		const notFoundErr = Object.assign(new Error("Notion API error: object_not_found"), {
			name: "NotionApiError" as const,
			status: 404,
		});
		const mockPort404 = createMockPort({
			retrieveBlock: vi.fn(async () => {
				throw notFoundErr;
			}),
		});

		const action404 = createNotionBlockDeleteAction(mockPort404);
		await expect(
			action404.run({ domain: "work", block_id: BLOCK_ID }, { caller: "test", requestId: "r1" }),
		).rejects.toThrow("The two workspaces have disjoint page access — if this page lives in the other one, retry with domain='angus'.");

		const serverErr = Object.assign(new Error("Notion API error (404): internal failure"), {
			name: "NotionApiError" as const,
			status: 500,
		});
		const mockPort500 = createMockPort({
			retrieveBlock: vi.fn(async () => {
				throw serverErr;
			}),
		});

		const action500 = createNotionBlockDeleteAction(mockPort500);
		await expect(
			action500.run({ domain: "work", block_id: BLOCK_ID }, { caller: "test", requestId: "r2" }),
		).rejects.not.toThrow(/retry with domain/);
	});
});
