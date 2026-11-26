import { describe, expect, it, vi } from "vitest";
import { countDocumentTabs, readDocument, type DocsAuth } from "./reader.js";

type FetchCall = { url: string; init: RequestInit };

let fetchFn: typeof fetch;

function stubFetch(payload: unknown, ok = true, status = 200): FetchCall[] {
	const calls: FetchCall[] = [];
	fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
		calls.push({ url, init: init ?? {} });
		return {
			ok,
			status,
			statusText: ok ? "OK" : "Error",
			json: async () => payload,
			text: async () => JSON.stringify(payload),
		} as Response;
	}) as unknown as typeof fetch;
	return calls;
}

const auth = (label = "personal", token = "fake_access_token"): DocsAuth => ({
	label,
	accessToken: async () => token,
});

/** Shorthand for the Docs structural element a paragraph of plain text produces. */
function para(text: string, style?: string) {
	return {
		paragraph: {
			elements: [{ textRun: { content: `${text}\n` } }],
			...(style ? { paragraphStyle: { namedStyleType: style } } : {}),
		},
	};
}

function tab(title: string, content: unknown[], childTabs?: unknown[]) {
	return {
		tabProperties: { tabId: `t_${title}`, title },
		documentTab: { body: { content } },
		...(childTabs ? { childTabs } : {}),
	};
}

describe("readDocument", () => {
	it("requests includeTabsContent, which is the entire reason this module exists", async () => {
		const calls = stubFetch({ documentId: "d1", title: "T", body: { content: [] } });

		await readDocument("d1", auth("work"), fetchFn);

		expect(calls[0].url).toContain("includeTabsContent=true");
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
			"Bearer fake_access_token",
		);
	});

	it("returns every tab, not just the first — the failure Drive export has silently", async () => {
		// This is the case that motivated the module: a Gemini meeting note splits the
		// summary and the transcript into separate tabs, and Drive's export renders only
		// the default one with no error to signal the loss.
		stubFetch({
			documentId: "d1",
			title: 'Notes: "Work Team Weekly"',
			tabs: [
				tab("Summary", [para("Three decisions were taken.")]),
				tab("Transcript", [para("Angus: morning all.")]),
			],
		});

		const doc = await readDocument("d1", auth("work"), fetchFn);

		expect(doc.tabs.map((t) => t.title)).toEqual(["Summary", "Transcript"]);
		expect(doc.text).toContain("Three decisions were taken.");
		expect(doc.text).toContain("Angus: morning all.");
	});

	it("descends into child tabs, so nesting does not reintroduce the same loss", async () => {
		stubFetch({
			documentId: "d1",
			title: "T",
			tabs: [
				tab("Parent", [para("top")], [tab("Child", [para("nested")])]),
			],
		});

		const doc = await readDocument("d1", auth(), fetchFn);

		expect(doc.tabs.map((t) => t.title)).toEqual(["Parent", "Child"]);
		expect(doc.tabs[1].depth).toBe(1);
		expect(doc.text).toContain("nested");
	});

	it("falls back to the top-level body for a document with no tabs", async () => {
		stubFetch({
			documentId: "d1",
			title: "Old doc",
			body: { content: [para("legacy content")] },
		});

		const doc = await readDocument("d1", auth(), fetchFn);

		expect(doc.tabs).toHaveLength(1);
		expect(doc.text).toBe("legacy content");
	});

	it("maps named styles to Markdown headings and renders tables as pipe rows", async () => {
		stubFetch({
			documentId: "d1",
			title: "T",
			tabs: [
				tab("Summary", [
					para("Action items", "HEADING_2"),
					{
						table: {
							tableRows: [
								{
									tableCells: [
										{ content: [para("Owner")] },
										{ content: [para("Action")] },
									],
								},
								{
									tableCells: [
										{ content: [para("Angus")] },
										{ content: [para("Ship the runbook")] },
									],
								},
							],
						},
					},
				]),
			],
		});

		const doc = await readDocument("d1", auth(), fetchFn);

		expect(doc.text).toContain("## Action items");
		expect(doc.text).toContain("| Owner | Action |");
		expect(doc.text).toContain("| Angus | Ship the runbook |");
	});

	it("skips the table of contents, which would otherwise duplicate every heading", async () => {
		stubFetch({
			documentId: "d1",
			title: "T",
			tabs: [
				tab("Summary", [
					{ tableOfContents: { content: [para("Action items")] } },
					para("Action items", "HEADING_2"),
				]),
			],
		});

		const doc = await readDocument("d1", auth(), fetchFn);

		expect(doc.text.match(/Action items/g)).toHaveLength(1);
	});

	it("names the account on failure and attaches status, since 404 covers both missing and unreadable", async () => {
		stubFetch({ error: "not found" }, false, 404);

		await expect(readDocument("d1", auth("work"), fetchFn)).rejects.toMatchObject({
			message: expect.stringMatching(/failed for account 'work' \(404\)/),
			status: 404,
		});
	});

	describe("renders smart chips", () => {
		it("renders person chips with name and email, or email only", async () => {
			stubFetch({
				documentId: "d-chips",
				title: "Meeting",
				body: {
					content: [
						{
							paragraph: {
								elements: [
									{ textRun: { content: "Invited " } },
									{
										person: {
											personProperties: {
												name: "Jane Doe",
												email: "jane@example.com",
											},
										},
									},
									{ textRun: { content: ", " } },
									{
										person: {
											personProperties: {
												email: "bob@example.com",
											},
										},
									},
									{ textRun: { content: "\n" } },
								],
							},
						},
					],
				},
			});

			const doc = await readDocument("d-chips", auth(), fetchFn);
			expect(doc.text).toContain("Invited @Jane Doe <jane@example.com>, @bob@example.com");
		});

		it("renders richLink chips with title and uri, or bare uri", async () => {
			stubFetch({
				documentId: "d-chips",
				title: "Links",
				body: {
					content: [
						{
							paragraph: {
								elements: [
									{ textRun: { content: "See " } },
									{
										richLink: {
											richLinkProperties: {
												title: "Q3 plan",
												uri: "https://docs.google.com/document/d/abc",
											},
										},
									},
									{ textRun: { content: "\n" } },
								],
							},
						},
					],
				},
			});

			const doc = await readDocument("d-chips", auth(), fetchFn);
			expect(doc.text).toContain("See [Q3 plan](https://docs.google.com/document/d/abc)");
		});

		it("renders dateElement chips with displayText, or timestamp when displayText is absent", async () => {
			stubFetch({
				documentId: "d-chips",
				title: "Dates",
				body: {
					content: [
						{
							paragraph: {
								elements: [
									{
										dateElement: {
											dateElementProperties: {
												displayText: "15 Oct 2026",
												timestamp: "2026-10-15T00:00:00Z",
											},
										},
									},
									{ textRun: { content: " - " } },
									{
										dateElement: {
											dateElementProperties: {
												timestamp: "2026-10-15T00:00:00Z",
											},
										},
									},
									{ textRun: { content: "\n" } },
								],
							},
						},
					],
				},
			});

			const doc = await readDocument("d-chips", auth(), fetchFn);
			expect(doc.text).toContain("15 Oct 2026");
			expect(doc.text).toContain("2026-10-15T00:00:00Z");
		});

		it("renders chips inside table rows", async () => {
			stubFetch({
				documentId: "d-chips",
				title: "Table",
				body: {
					content: [
						{
							table: {
								tableRows: [
									{
										tableCells: [
											{ content: [para("Owner")] },
											{
												content: [
													{
														paragraph: {
															elements: [
																{
																	person: {
																		personProperties: {
																			name: "Jane Doe",
																			email: "jane@example.com",
																		},
																	},
																},
																{ textRun: { content: "\n" } },
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
			});

			const doc = await readDocument("d-chips", auth(), fetchFn);
			expect(doc.text).toContain("| Owner | @Jane Doe <jane@example.com> |");
		});

		it("keeps a paragraph whose only content is a person chip plus newline", async () => {
			stubFetch({
				documentId: "d-chips",
				title: "Single chip",
				body: {
					content: [
						{
							paragraph: {
								elements: [
									{
										person: {
											personProperties: {
												name: "Jane Doe",
												email: "jane@example.com",
											},
										},
									},
									{ textRun: { content: "\n" } },
								],
							},
						},
					],
				},
			});

			const doc = await readDocument("d-chips", auth(), fetchFn);
			expect(doc.text).toContain("@Jane Doe <jane@example.com>");
		});
	});
});

describe("countDocumentTabs", () => {
	it("asks for tab ids only, with tabs content switched on", async () => {
		const calls = stubFetch({ tabs: [tab("Only", [])] });

		await countDocumentTabs("d1", auth("work"), fetchFn);

		const url = new URL(calls[0].url);
		expect(url.pathname).toBe("/v1/documents/d1");
		expect(url.searchParams.get("includeTabsContent")).toBe("true");
		// A field mask, so counting a long Doc's tabs never downloads its body.
		expect(url.searchParams.get("fields")).toBe(
			"tabs(tabProperties(tabId),childTabs(tabProperties(tabId),childTabs(tabProperties(tabId))))",
		);
	});

	it("counts nested child tabs as well as top-level ones", async () => {
		stubFetch({
			tabs: [tab("Summary", [], [tab("Detail", [], [tab("Appendix", [])])]), tab("Transcript", [])],
		});

		expect(await countDocumentTabs("d1", auth(), fetchFn)).toBe(4);
	});

	it("counts a Doc from before tabs existed, which has no tabs array, as one", async () => {
		stubFetch({});

		expect(await countDocumentTabs("d1", auth(), fetchFn)).toBe(1);
	});

	it("names the account on failure and attaches status", async () => {
		stubFetch({ error: "not found" }, false, 404);

		await expect(countDocumentTabs("d1", auth("work"), fetchFn)).rejects.toMatchObject({
			message: expect.stringMatching(/tab count\) failed for account 'work' \(404\)/),
			status: 404,
		});
	});
});
