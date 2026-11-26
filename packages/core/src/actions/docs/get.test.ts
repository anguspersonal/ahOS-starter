import { describe, expect, it, vi } from "vitest";
import type { DocsDocument, DocsPort } from "../../ports/docs.js";
import { executeAction } from "../adapters/direct.js";
import { createDocsGetAction, formatDocsGetMcp } from "./get.js";

const SAMPLE_DOC: DocsDocument = {
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
};

describe("createDocsGetAction (#1523)", () => {
	it("returns revisionId, tabs, and compact outline with start/end indices and formats MCP output", async () => {
		const getDocument = vi.fn().mockResolvedValue(SAMPLE_DOC);
		const port: DocsPort = { getDocument };
		const action = createDocsGetAction(port);

		const out = await executeAction(action, {
			document_id: "doc-123",
			domain: "angus",
		});

		expect(getDocument).toHaveBeenCalledWith({
			domain: "angus",
			documentId: "doc-123",
			includeTabsContent: true,
		});

		const text = formatDocsGetMcp(out);
		expect(text).toContain("Document: Test Document");
		expect(text).toContain("Revision ID: rev-456");
		expect(text).toContain(
			"Note: Provide required_revision_id='rev-456' when calling docs_batch_update to prevent concurrency conflicts.",
		);
		expect(text).toContain("Tab: Main (tabId: 't.0')");
		expect(text).toContain('[1..20] TITLE: "Document Title"');
		expect(text).toContain('[20..50] PARAGRAPH: "This is a body paragraph."');
		expect(text).toContain("[50..120] TABLE (2 rows x 2 cols)");
	});

	it("passes suggestionsViewMode and fields when requested and supports max_chars truncation", async () => {
		const getDocument = vi.fn().mockResolvedValue(SAMPLE_DOC);
		const action = createDocsGetAction({ getDocument });

		const out = await executeAction(action, {
			document_id: "doc-123",
			domain: "work",
			include_suggestions: true,
			field_mask: "title,revisionId",
			max_chars: 120,
		});

		expect(getDocument).toHaveBeenCalledWith({
			domain: "work",
			documentId: "doc-123",
			includeTabsContent: true,
			suggestionsViewMode: "SUGGESTIONS_INLINE",
			fields: "title,revisionId",
		});

		const text = formatDocsGetMcp(out);
		expect(text).toMatch(/\n\n… \[truncated at 120 chars of \d+\]$/);
	});

	it("throws when tab_id does not exist or when neither domain nor account is given", async () => {
		const getDocument = vi.fn().mockResolvedValue({
			documentId: "doc-123",
			title: "Tabbed Doc",
			revisionId: "rev-1",
			tabs: [
				{ tabProperties: { tabId: "t.1", title: "Summary" } },
				{ tabProperties: { tabId: "t.2", title: "Details" } },
			],
		});
		const action = createDocsGetAction({ getDocument });

		await expect(
			executeAction(action, {
				document_id: "doc-123",
				domain: "work",
				tab_id: "non-existent-tab",
			}),
		).rejects.toThrow(
			"Tab 'non-existent-tab' not found in document 'Tabbed Doc'. Available tabs: 't.1' (Summary), 't.2' (Details).",
		);

		await expect(
			executeAction(action, { document_id: "doc-123" } as any, { skipValidation: true }),
		).rejects.toThrow(
			"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);
	});
});
