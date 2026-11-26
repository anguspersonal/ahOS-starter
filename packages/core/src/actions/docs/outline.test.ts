import { describe, expect, it } from "vitest";
import type { DocsDocument } from "../../ports/docs.js";
import {
	extractStructuralOutline,
	findTextInDoc,
	flattenDocumentTabs,
} from "./outline.js";

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
								elements: [{ startIndex: 1, endIndex: 20, textRun: { content: "Document Title\n" } }],
								paragraphStyle: { namedStyleType: "TITLE" },
							},
						},
						{
							startIndex: 20,
							endIndex: 50,
							paragraph: {
								elements: [
									{ startIndex: 20, endIndex: 26, textRun: { content: "Target" } },
									{ startIndex: 26, endIndex: 27, textRun: { content: " " } },
									{ startIndex: 27, endIndex: 33, textRun: { content: "Phrase" } },
									{ startIndex: 33, endIndex: 50, textRun: { content: " in a paragraph.\n" } },
								],
								paragraphStyle: { namedStyleType: "NORMAL_TEXT" },
							},
						},
						{
							startIndex: 50,
							endIndex: 120,
							table: {
								tableRows: [
									{
										tableCells: [
											{
												content: [
													{
														startIndex: 55,
														endIndex: 75,
														paragraph: {
															elements: [
																{
																	startIndex: 55,
																	endIndex: 75,
																	textRun: { content: "Needle in table cell\n" },
																},
															],
														},
													},
												],
											},
											{ content: [] },
										],
									},
									{ tableCells: [{ content: [] }, { content: [] }] },
								],
							},
						},
					],
				},
			},
			childTabs: [
				{
					tabProperties: { tabId: "t.1", title: "Sub-tab" },
					documentTab: {
						body: {
							content: [
								{
									startIndex: 1,
									endIndex: 15,
									paragraph: {
										elements: [{ startIndex: 1, endIndex: 15, textRun: { content: "Child content\n" } }],
										paragraphStyle: { namedStyleType: "HEADING_2" },
									},
								},
							],
						},
					},
				},
			],
		},
	],
};

describe("docs outline & text search helpers (#1523)", () => {
	it("flattenDocumentTabs walks nested tabs depth-first and falls back to doc.body when tabs are absent", () => {
		const tabs = flattenDocumentTabs(SAMPLE_DOC);
		expect(tabs).toHaveLength(2);
		expect(tabs[0]).toMatchObject({ tabId: "t.0", title: "Main", depth: 0 });
		expect(tabs[1]).toMatchObject({ tabId: "t.1", title: "Sub-tab", depth: 1 });

		const bodyOnly: DocsDocument = {
			documentId: "d-body",
			title: "Legacy Doc",
			body: {
				content: [
					{
						startIndex: 1,
						endIndex: 6,
						paragraph: {
							elements: [{ startIndex: 1, endIndex: 6, textRun: { content: "Body\n" } }],
						},
					},
				],
			},
		};
		const fallback = flattenDocumentTabs(bodyOnly);
		expect(fallback).toEqual([
			{
				tabId: "",
				title: "Legacy Doc",
				depth: 0,
				content: bodyOnly.body!.content!,
			},
		]);
	});

	it("extractStructuralOutline extracts headings, paragraph previews, and tables", () => {
		const tabs = flattenDocumentTabs(SAMPLE_DOC);
		const outline = extractStructuralOutline(tabs[0].content);
		expect(outline).toEqual([
			{
				type: "heading",
				level: "TITLE",
				text: "Document Title",
				startIndex: 1,
				endIndex: 20,
			},
			{
				type: "paragraph",
				textPreview: "Target Phrase in a paragraph.",
				startIndex: 20,
				endIndex: 50,
			},
			{
				type: "table",
				rows: 2,
				columns: 2,
				startIndex: 50,
				endIndex: 120,
			},
		]);
	});

	it("findTextInDoc locates matches across split textRuns, tables, case sensitivity, and tab filters", () => {
		const phraseMatches = findTextInDoc(SAMPLE_DOC, "Target Phrase");
		expect(phraseMatches).toHaveLength(1);
		expect(phraseMatches[0]).toMatchObject({
			tabId: "t.0",
			tabTitle: "Main",
			startIndex: 20,
			endIndex: 33,
			matchedText: "Target Phrase",
		});

		const tableMatches = findTextInDoc(SAMPLE_DOC, "Needle");
		expect(tableMatches).toHaveLength(1);
		expect(tableMatches[0]).toMatchObject({
			tabId: "t.0",
			tabTitle: "Main",
			startIndex: 55,
			endIndex: 61,
			matchedText: "Needle",
		});

		expect(findTextInDoc(SAMPLE_DOC, "needle", { matchCase: true })).toHaveLength(0);
		expect(findTextInDoc(SAMPLE_DOC, "needle", { matchCase: false })).toHaveLength(1);
		expect(findTextInDoc(SAMPLE_DOC, "Child", { tabIdFilter: "t.1" })).toHaveLength(1);
		expect(findTextInDoc(SAMPLE_DOC, "Child", { tabIdFilter: "t.0" })).toHaveLength(0);
	});
});
