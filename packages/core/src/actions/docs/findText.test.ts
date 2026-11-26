import { describe, expect, it, vi } from "vitest";
import type { DocsDocument, DocsPort } from "../../ports/docs.js";
import { executeAction } from "../adapters/direct.js";
import { createDocsFindTextAction, formatDocsFindTextMcp } from "./findText.js";

const SAMPLE_DOC: DocsDocument = {
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
};

describe("createDocsFindTextAction (#1523)", () => {
	it("finds text across textRuns and formats MCP occurrence output", async () => {
		const getDocument = vi.fn().mockResolvedValue(SAMPLE_DOC);
		const port: DocsPort = { getDocument };
		const action = createDocsFindTextAction(port);

		const out = await executeAction(action, {
			document_id: "doc-search",
			domain: "angus",
			text: "Target Phrase",
		});

		expect(getDocument).toHaveBeenCalledWith({
			domain: "angus",
			documentId: "doc-search",
			includeTabsContent: true,
		});

		const text = formatDocsFindTextMcp(out);
		expect(text).toContain('Found 1 occurrence(s) of "Target Phrase" in document "Search Test":');
		expect(text).toContain("Current revisionId: rev-10");
		expect(text).toContain("Tab:          Alpha Tab (tabId: 't.alpha')");
		expect(text).toContain("Range:        startIndex: 10, endIndex: 23");
		expect(text).toContain('Matched text: "Target Phrase"');
	});

	it("returns clean message when no match is found and refuses missing identity", async () => {
		const getDocument = vi.fn().mockResolvedValue(SAMPLE_DOC);
		const action = createDocsFindTextAction({ getDocument });

		const out = await executeAction(action, {
			document_id: "doc-search",
			domain: "work",
			text: "missing text",
			tab_id: "t.alpha",
		});

		expect(formatDocsFindTextMcp(out)).toBe(
			'No occurrences of "missing text" found in document "Search Test" (in tab \'t.alpha\').',
		);

		await expect(
			executeAction(action, { document_id: "doc-search", text: "Target" } as any, {
				skipValidation: true,
			}),
		).rejects.toThrow(
			"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);
	});
});
