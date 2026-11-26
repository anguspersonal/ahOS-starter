import { describe, expect, it, vi } from "vitest";
import { executeAction } from "../adapters/direct.js";
import type { BlockPayload } from "../../domain/stateDoc.js";
import type { ConfigRepository } from "../../ports/config.js";
import type { NotionPort } from "../../ports/notion.js";
import {
	createStateDocUpdateAction,
	formatStateDocUpdateMcp,
} from "./stateDocUpdate.js";

function makePage(): BlockPayload[] {
	return [
		{
			id: "b-callout",
			type: "callout",
			callout: {
				rich_text: [
					{
						type: "text",
						text: {
							content:
								"📌 Last updated: 2026-07-01 (state_doc_update: init)\nSole writer: dos-hl ritual\nRead by: every operating-partner session",
						},
						plain_text:
							"📌 Last updated: 2026-07-01 (state_doc_update: init)\nSole writer: dos-hl ritual\nRead by: every operating-partner session",
					},
				],
			},
		},
		{
			id: "b-h2-stack",
			type: "heading_2",
			heading_2: {
				rich_text: [
					{
						type: "text",
						text: { content: "🧱 Tech stack" },
						plain_text: "🧱 Tech stack",
					},
				],
			},
		},
		{
			id: "b-p-stack",
			type: "paragraph",
			paragraph: {
				rich_text: [
					{
						type: "text",
						text: { content: "Next.js, Supabase, Railway." },
						plain_text: "Next.js, Supabase, Railway.",
					},
				],
			},
		},
		{
			id: "b-h2-actions",
			type: "heading_2",
			heading_2: {
				rich_text: [
					{
						type: "text",
						text: { content: "📌 Open Actions" },
						plain_text: "📌 Open Actions",
					},
				],
			},
		},
		{
			id: "b-b-action1",
			type: "bulleted_list_item",
			bulleted_list_item: {
				rich_text: [
					{
						type: "text",
						text: { content: "Ship Wave 27" },
						plain_text: "Ship Wave 27",
					},
				],
			},
		},
	];
}

function createFakeNotionPort(
	page: BlockPayload[],
	stateDocMap: Record<string, string | undefined> = {
		work: "sdp-1",
		angus: "sdp-angus",
	},
) {
	const writes: Array<{ op: string; args: unknown }> = [];
	let nextId = 1;

	const hydrate = (block: BlockPayload): BlockPayload => {
		const type = block.type;
		const inner = (block[type] ?? {}) as { rich_text?: Array<Record<string, unknown>> };
		const rich = (inner.rich_text ?? []).map((r: any) => ({
			...r,
			plain_text: r.plain_text ?? r.text?.content ?? "",
		}));
		return {
			id: `new-${nextId++}`,
			type,
			[type]: { ...inner, rich_text: rich },
		};
	};

	const port: NotionPort = {
		resolveToken: vi.fn(async (w) => `token-${w}`),
		getStateDocPageId: vi.fn(async (w) => stateDocMap[w]),
		search: vi.fn(),
		retrievePage: vi.fn(),
		retrieveDatabase: vi.fn(),
		retrieveDataSource: vi.fn(),
		queryDataSource: vi.fn(),
		retrieveBlock: vi.fn(),
		listComments: vi.fn(),
		createComment: vi.fn(),
		listBlockChildren: vi.fn(async () => ({
			results: page.map((b) => structuredClone(b)) as any,
			has_more: false,
			next_cursor: null,
		})),
		appendBlockChildren: vi.fn(async (params) => {
			writes.push({ op: "append", args: params });
			const hydrated = (params.children as BlockPayload[]).map(hydrate);
			if (params.after) {
				const idx = page.findIndex((b) => b.id === params.after);
				if (idx === -1) throw new Error(`after block ${params.after} not found`);
				page.splice(idx + 1, 0, ...hydrated);
			} else {
				page.push(...hydrated);
			}
			return { results: hydrated as any };
		}),
		updateBlock: vi.fn(async (params) => {
			writes.push({ op: "update", args: params });
			const idx = page.findIndex((b) => b.id === params.blockId);
			if (idx === -1) throw new Error(`block ${params.blockId} not found`);
			const hydrated = hydrate({
				id: params.blockId,
				type: page[idx].type,
				...params.payload,
			});
			page[idx] = { ...page[idx], ...hydrated, id: params.blockId };
			return page[idx] as any;
		}),
		deleteBlock: vi.fn(async (params) => {
			writes.push({ op: "delete", args: params });
			const idx = page.findIndex((b) => b.id === params.blockId);
			if (idx === -1) throw new Error(`block ${params.blockId} not found`);
			const [removed] = page.splice(idx, 1);
			return { id: removed.id!, archived: true, type: removed.type };
		}),
	};

	return { port, writes };
}

describe("createStateDocUpdateAction", () => {
	it("exposes the expected metadata and contract shape", () => {
		const { port } = createFakeNotionPort(makePage());
		const action = createStateDocUpdateAction(port);

		expect(action.id).toBe("state_doc_update");
		expect(action.domain).toBe("ops");
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		expect(action.description).toContain("docs/guides/tools/state_doc_update.md");
		expect(Object.keys((action.schema as any).shape)).toEqual([
			"domain",
			"op",
			"heading",
			"new_heading",
			"body",
			"after_heading",
			"before_heading",
			"at_end",
			"heading_level",
		]);
	});

	it("returns ADR-053 back-compat refusal when op is omitted", async () => {
		const { port, writes } = createFakeNotionPort(makePage());
		const action = createStateDocUpdateAction(port);

		await expect(
			executeAction(action, { heading: "EOD 2026-06-10", body: "x" }),
		).rejects.toThrow(/`op` is required \u2014 one of replace \| rename \| insert \| delete/);
		expect(writes).toHaveLength(0);
	});

	it("refuses when domain is omitted", async () => {
		const { port, writes } = createFakeNotionPort(makePage());
		const action = createStateDocUpdateAction(port);

		await expect(
			executeAction(action, { op: "delete", heading: "🧱 Tech stack" }),
		).rejects.toThrow(/`domain` is required/);
		expect(writes).toHaveLength(0);
	});

	it("refuses insert of an existing heading", async () => {
		const { port, writes } = createFakeNotionPort(makePage());
		const action = createStateDocUpdateAction(port);

		await expect(
			executeAction(action, {
				domain: "work",
				op: "insert",
				new_heading: "🧱 Tech stack",
				body: "- item",
				at_end: true,
			}),
		).rejects.toThrow(/already a heading/);
		expect(writes).toHaveLength(0);
	});

	it("refuses insert with zero or two anchors", async () => {
		const { port, writes } = createFakeNotionPort(makePage());
		const action = createStateDocUpdateAction(port);

		await expect(
			executeAction(action, {
				domain: "work",
				op: "insert",
				new_heading: "🧪 Experiments",
				body: "- item",
			}),
		).rejects.toThrow(/exactly one anchor/);

		await expect(
			executeAction(action, {
				domain: "work",
				op: "insert",
				new_heading: "🧪 Experiments",
				body: "- item",
				at_end: true,
				before_heading: "📌 Open Actions",
			}),
		).rejects.toThrow(/exactly one anchor/);

		expect(writes).toHaveLength(0);
	});

	it("replaces a section body in place and stamps Last updated", async () => {
		const page = makePage();
		const { port, writes } = createFakeNotionPort(page);
		const action = createStateDocUpdateAction(port);

		const out = await executeAction(action, {
			domain: "work",
			op: "replace",
			heading: "🧱 Tech stack",
			body: "Next.js, Supabase.",
		});

		expect(writes.map((w) => w.op)).toEqual(["append", "delete", "update"]);
		expect(out.domain).toBe("work");
		expect(out.op).toBe("replace");
		expect(out.summary).toContain('replaced section "🧱 Tech stack" (1 block(s) \u2192 1)');
		expect(formatStateDocUpdateMcp(out)).toContain("State Doc (work):");
		expect(formatStateDocUpdateMcp(out)).toContain("Stamped: Last updated:");
	});

	it("can resolve state_doc_page_id via ConfigRepository when provided", async () => {
		const page = makePage();
		const { port } = createFakeNotionPort(page, { work: undefined, angus: undefined });
		delete port.getStateDocPageId;

		const config: ConfigRepository = {
			loadConfigDetailed: vi.fn(),
			loadConfig: vi.fn(async (provider) =>
				provider === "notion_work" ? ({ state_doc_page_id: "sdp-cfg" } as any) : null,
			),
			loadIntegration: vi.fn(),
			listIntegrations: vi.fn(),
			upsertIntegrationConfig: vi.fn(),
			getCapturePreferences: vi.fn(),
			getUserPreferences: vi.fn(),
			updateUserPreferences: vi.fn(),
			getMeetingNoteSources: vi.fn(),
			getPastedInstructions: vi.fn(),
			savePastedInstructions: vi.fn(),
		};

		const action = createStateDocUpdateAction({ notion: port, config });
		const out = await executeAction(action, {
			domain: "work",
			op: "delete",
			heading: "🧱 Tech stack",
		});

		expect(out.pageId).toBe("sdp-cfg");
		expect(out.summary).toContain('deleted section "🧱 Tech stack"');
	});
});
