import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CAPTURE_PREFERENCES } from "../../../domain/capturePreferences.js";
import type { Row, SearchPort } from "../../../ports/search.js";
import { createKnowledgeSearchAction } from "./index.js";

function makeRow(overrides: Partial<Row> = {}): Row {
	return {
		id: "art-1",
		title: "Test Artifact",
		plain_text: "Artifact body content",
		created_at: "2026-08-10T10:00:00Z",
		captured_at: "2026-08-10T10:00:00Z",
		effective_at: "2026-08-10T10:00:00Z",
		lifecycle_stage: "enriched",
		tags: null,
		content_subtype: null,
		...overrides,
	};
}

function makeSearchPort(overrides: Partial<SearchPort> = {}): SearchPort {
	return {
		ftsSearchArtifacts: vi.fn(async () => [makeRow()]),
		hybridSearchArtifacts: vi.fn(async () => [makeRow({ id: "art-hybrid", title: "Hybrid Hit" })]),
		searchGraph: vi.fn(async () => []),
		filterArtifacts: vi.fn(async () => ({ rows: [makeRow()], count: 1 })),
		findConsumedArtifactIds: vi.fn(async () => []),
		...overrides,
	};
}

describe("createKnowledgeSearchAction (#1620)", () => {
	it("runs hybrid search when query and embedding port are provided", async () => {
		const search = makeSearchPort({
			searchGraph: vi.fn(async ({ kind }) =>
				kind === "entity"
					? [{ id: "ent-1", title: "Work", description: "Company", aliases: null, properties: null }]
					: [],
			),
		});
		const embed = vi.fn(async () => [0.1, 0.2, 0.3]);
		const action = createKnowledgeSearchAction({
			search,
			embeddings: { embed, embedBatch: vi.fn() },
		});

		const out = await action.run({ query: "Work" }, { userId: "user-1" });
		expect(embed).toHaveBeenCalledWith("Work");
		expect(search.hybridSearchArtifacts).toHaveBeenCalledWith({
			query: "Work",
			queryEmbedding: "[0.1,0.2,0.3]",
			matchLimit: 30,
			includeArchived: false,
			tags: null,
			userId: "user-1",
		});
		expect(out.text).toContain("[ent-1] Work [entity]");
		expect(out.text).toContain("[art-hybrid] Hybrid Hit");
		expect(out.text).not.toContain("search_mode: full-text-only");
	});

	it("degrades to full-text-only with no-key note when no embedding port is configured", async () => {
		const search = makeSearchPort();
		const action = createKnowledgeSearchAction({ search, embeddings: null });

		const out = await action.run({ query: "roadmap" }, { userId: "user-1" });
		expect(search.ftsSearchArtifacts).toHaveBeenCalledWith({
			query: "roadmap",
			matchLimit: 30,
			includeArchived: false,
			tags: null,
			userId: "user-1",
		});
		expect(out.text).toContain(
			"search_mode: full-text-only (no OpenAI embedding key configured",
		);
		expect(out.text).toContain("[art-1] Test Artifact");
	});

	it("degrades to full-text-only with provider-unavailable note when embedding port throws degradable error, and rethrows non-degradable error", async () => {
		const search = makeSearchPort();
		const warnings: string[] = [];
		const degradableEmbed = vi.fn(async () => {
			throw new Error("OpenAI embeddings failed (429): rate limit exceeded");
		});
		const action = createKnowledgeSearchAction({
			search,
			embeddings: { embed: degradableEmbed, embedBatch: vi.fn() },
			onWarning: (msg) => warnings.push(msg),
		});

		const out = await action.run({ query: "roadmap" }, { userId: "user-1" });
		expect(out.text).toContain(
			"search_mode: full-text-only (embedding provider unavailable: OpenAI embeddings failed (429): rate limit exceeded",
		);
		expect(warnings[0]).toContain("embedding provider unavailable");

		const nonDegradableAction = createKnowledgeSearchAction({
			search,
			embeddings: {
				embed: vi.fn(async () => {
					throw new Error("OpenAI embeddings failed (400): invalid input");
				}),
				embedBatch: vi.fn(),
			},
		});
		await expect(nonDegradableAction.run({ query: "roadmap" })).rejects.toThrow(
			"OpenAI embeddings failed (400): invalid input",
		);
	});

	it("supports filter-only reads and rank_by_role over ConfigRepository", async () => {
		const search = makeSearchPort({
			filterArtifacts: vi.fn(async ({ roleOrFilter }) => ({
				rows: roleOrFilter?.includes("claude_code")
					? [makeRow({ id: "art-narrative", title: "Narrative Note" })]
					: [],
				count: roleOrFilter?.includes("claude_code") ? 1 : 0,
			})),
		});
		const action = createKnowledgeSearchAction({
			search,
			config: {
				loadCapturePreferences: vi.fn(async () => ({
					...DEFAULT_CAPTURE_PREFERENCES,
					surface_role_map: { claude_code: "narrative" },
					default_role: "evidence",
				})),
			},
		});

		const out = await action.run({
			captured_after: "2026-08-01T00:00:00Z",
			rank_by_role: true,
		});
		expect(out.text).toContain("ranked by source role");
		expect(out.text).toContain("[art-narrative] Narrative Note");
	});

	it("filters ranked query results by effective synthesis role when roles is provided (#2229)", async () => {
		const search = makeSearchPort({
			ftsSearchArtifacts: vi.fn(async () => [
				makeRow({ id: "art-narr", title: "Narrative Hit", surface: "claude_code" }),
				makeRow({ id: "art-evid", title: "Evidence Hit", surface: "github" }),
				makeRow({ id: "art-met", title: "Metrics Hit", surface: "kpi_snapshot" }),
				makeRow({ id: "art-excl", title: "Excluded Robot", surface: "claude_code", tags: ["robot_authored"] }),
				makeRow({ id: "art-override", title: "Overridden Hit", surface: "github", tags: ["role:narrative"] }),
			]),
		});
		const action = createKnowledgeSearchAction({
			search,
			embeddings: null,
			config: {
				loadCapturePreferences: vi.fn(async () => DEFAULT_CAPTURE_PREFERENCES),
			},
		});

		const narrOut = await action.run({ query: "Hit", roles: ["narrative"] });
		expect(narrOut.text).toContain("[art-narr]");
		expect(narrOut.text).toContain("[art-override]");
		expect(narrOut.text).not.toContain("[art-evid]");
		expect(narrOut.text).not.toContain("[art-met]");
		expect(narrOut.text).not.toContain("[art-excl]");

		const metricsOut = await action.run({ query: "Hit", roles: ["metrics"] });
		expect(metricsOut.text).toContain("[art-met]");
		expect(metricsOut.text).not.toContain("[art-narr]");

		const exclOut = await action.run({ query: "Hit", roles: ["excluded"] });
		expect(exclOut.text).toContain("[art-excl]");
		expect(exclOut.text).not.toContain("[art-narr]");
	});

	it("passes excludeRobotAuthored: true to searchUnconsumedArtifacts and filterArtifacts when excluded is omitted (#2229)", async () => {
		const searchUnconsumedArtifacts = vi.fn(async () => ({
			rows: [makeRow({ id: "art-human", title: "Human Note", surface: "claude_code" })],
			timedOutCount: false,
		}));
		const filterArtifacts = vi.fn(async () => ({
			rows: [makeRow({ id: "art-human", title: "Human Note", surface: "claude_code" })],
			count: 1,
		}));
		const search = makeSearchPort({ searchUnconsumedArtifacts, filterArtifacts });
		const action = createKnowledgeSearchAction({
			search,
			config: {
				loadCapturePreferences: vi.fn(async () => DEFAULT_CAPTURE_PREFERENCES),
			},
		});

		await action.run({ not_consumed: true, roles: ["narrative"] });
		expect(searchUnconsumedArtifacts).toHaveBeenCalledWith(
			expect.objectContaining({
				excludeRobotAuthored: true,
			}),
		);

		await action.run({ captured_after: "2026-08-01T00:00:00Z", roles: ["evidence"] });
		expect(filterArtifacts).toHaveBeenCalledWith(
			expect.objectContaining({
				excludeRobotAuthored: true,
			}),
		);

		await action.run({ not_consumed: true, roles: ["excluded"] });
		expect(searchUnconsumedArtifacts).toHaveBeenLastCalledWith(
			expect.objectContaining({
				excludeRobotAuthored: false,
			}),
		);
	});

	it("preserves role:<role> tag overrides in SQL filters on unranked paths even when no surface maps to the requested role (#2229)", async () => {
		const searchUnconsumedArtifacts = vi.fn(async () => ({
			rows: [
				makeRow({
					id: "art-overridden-metrics",
					title: "Metrics Tag Override",
					surface: "github",
					tags: ["role:metrics"],
				}),
			],
			timedOutCount: false,
		}));
		const filterArtifacts = vi.fn(async () => ({
			rows: [
				makeRow({
					id: "art-overridden-metrics",
					title: "Metrics Tag Override",
					surface: "github",
					tags: ["role:metrics"],
				}),
			],
			count: 1,
		}));
		const search = makeSearchPort({ searchUnconsumedArtifacts, filterArtifacts });
		const action = createKnowledgeSearchAction({
			search,
			config: {
				loadCapturePreferences: vi.fn(async () => ({
					...DEFAULT_CAPTURE_PREFERENCES,
					surface_role_map: { claude_code: "narrative", github: "evidence", kpi_snapshot: "evidence" },
					default_role: "narrative",
				})),
			},
		});

		const unconsumedOut = await action.run({ not_consumed: true, roles: ["metrics"] });
		expect(searchUnconsumedArtifacts).toHaveBeenCalledWith(
			expect.objectContaining({
				roleHitKeys: [],
				roleDefaultHit: false,
				roleOverrideTags: ["role:metrics"],
			}),
		);
		expect(unconsumedOut.text).toContain("[art-overridden-metrics]");

		const filterOut = await action.run({ captured_after: "2026-08-01T00:00:00Z", roles: ["metrics"] });
		expect(filterArtifacts).toHaveBeenCalledWith(
			expect.objectContaining({
				roleOrFilter: expect.stringContaining('tags.ov.{"role:metrics"}'),
			}),
		);
		expect(filterOut.text).toContain("[art-overridden-metrics]");
	});
});

describe("not_consumed default narrative role (#2231)", () => {
	const mixedRows = [
		makeRow({ id: "art-narr", title: "Narrative Note", surface: "claude_code", effective_at: "2026-10-19T10:00:00Z" }),
		makeRow({ id: "art-gh", title: "GitHub PR", surface: "github", effective_at: "2026-10-19T09:00:00Z" }),
		makeRow({ id: "art-slack", title: "Slack Msg", surface: "slack", effective_at: "2026-10-19T08:00:00Z" }),
		makeRow({
			id: "art-receipt",
			title: "Act Receipt",
			surface: "act_receipt",
			content_subtype: "act_receipt",
			effective_at: "2026-10-19T07:00:00Z",
		}),
		makeRow({ id: "art-met", title: "KPI Snapshot", surface: "kpi_snapshot", effective_at: "2026-10-19T06:00:00Z" }),
		makeRow({
			id: "art-excl",
			title: "Robot Note",
			surface: "claude_code",
			tags: ["robot_authored"],
			effective_at: "2026-10-19T05:00:00Z",
		}),
	];

	it("defaults effectiveRoles to ['narrative'] when not_consumed: true and roles is omitted across RPC, fallback, query, and rank_by_role paths", async () => {
		const searchUnconsumedArtifacts = vi.fn(async () => ({
			rows: mixedRows,
			timedOutCount: false,
		}));
		const ftsSearchArtifacts = vi.fn(async () => mixedRows);
		const search = makeSearchPort({ searchUnconsumedArtifacts, ftsSearchArtifacts });
		const action = createKnowledgeSearchAction({
			search,
			embeddings: null,
			config: { loadCapturePreferences: vi.fn(async () => DEFAULT_CAPTURE_PREFERENCES) },
		});

		// 1. RPC path (filter-only not_consumed)
		const rpcOut = await action.run({
			not_consumed: true,
			captured_after: "2026-10-18T00:00:00Z",
		});
		expect(searchUnconsumedArtifacts).toHaveBeenCalledWith(
			expect.objectContaining({
				excludeRobotAuthored: true,
				excludeTitlePatterns: ["%auto-task%", "%scheduled routine%"],
				roleOverrideTags: ["role:narrative"],
				roleDefaultHit: true,
			}),
		);
		expect(rpcOut.text).toContain("[art-narr]");
		expect(rpcOut.text).not.toContain("[art-gh]");
		expect(rpcOut.text).not.toContain("[art-slack]");
		expect(rpcOut.text).not.toContain("[art-receipt]");
		expect(rpcOut.text).not.toContain("[art-met]");
		expect(rpcOut.text).not.toContain("[art-excl]");

		// 2. Query-bearing not_consumed path
		const queryOut = await action.run({
			query: "Note",
			not_consumed: true,
		});
		expect(queryOut.text).toContain("[art-narr]");
		expect(queryOut.text).not.toContain("[art-gh]");
		expect(queryOut.text).not.toContain("[art-met]");
		expect(queryOut.text).not.toContain("[art-excl]");

		// 3. rank_by_role + not_consumed without explicit roles
		const rankedOut = await action.run({
			not_consumed: true,
			rank_by_role: true,
			captured_after: "2026-10-18T00:00:00Z",
		});
		expect(rankedOut.text).toContain("evidence 0");
		expect(rankedOut.text).toContain("metrics 0");
		expect(rankedOut.text).toContain("excluded 0");

		// 4. filterArtifacts fallback path (no searchUnconsumedArtifacts)
		const filterArtifacts = vi.fn(async () => ({ rows: mixedRows, count: mixedRows.length }));
		const fallbackAction = createKnowledgeSearchAction({
			search: makeSearchPort({ filterArtifacts }),
			config: { loadCapturePreferences: vi.fn(async () => DEFAULT_CAPTURE_PREFERENCES) },
		});
		const fallbackOut = await fallbackAction.run({
			not_consumed: true,
			captured_after: "2026-10-18T00:00:00Z",
		});
		expect(filterArtifacts).toHaveBeenCalledWith(
			expect.objectContaining({
				excludeNarrativeRobotTitles: true,
				excludeRobotAuthored: true,
				roleOrFilter: expect.stringContaining('tags.ov.{"role:narrative"}'),
			}),
		);
		expect(fallbackOut.text).toContain("[art-narr]");
		expect(fallbackOut.text).not.toContain("[art-gh]");
		expect(fallbackOut.text).not.toContain("[art-met]");
		expect(fallbackOut.text).not.toContain("[art-excl]");
	});

	it("respects explicit roles override when not_consumed: true", async () => {
		const searchUnconsumedArtifacts = vi.fn(async ({ tierRole }: { tierRole?: string }) => {
			if (tierRole === "narrative") {
				return { rows: [mixedRows[0]], timedOutCount: false };
			}
			if (tierRole === "evidence") {
				return { rows: [mixedRows[1], mixedRows[2], mixedRows[3]], timedOutCount: false };
			}
			return { rows: mixedRows, timedOutCount: false };
		});
		const action = createKnowledgeSearchAction({
			search: makeSearchPort({ searchUnconsumedArtifacts }),
			config: { loadCapturePreferences: vi.fn(async () => DEFAULT_CAPTURE_PREFERENCES) },
		});

		const evidOut = await action.run({
			not_consumed: true,
			roles: ["evidence"],
			captured_after: "2026-10-18T00:00:00Z",
		});
		expect(evidOut.text).toContain("[art-gh]");
		expect(evidOut.text).toContain("[art-slack]");
		expect(evidOut.text).toContain("[art-receipt]");
		expect(evidOut.text).not.toContain("[art-narr]");
		expect(evidOut.text).not.toContain("[art-met]");

		const rankedBoth = await action.run({
			not_consumed: true,
			roles: ["narrative", "evidence"],
			rank_by_role: true,
			captured_before: "2026-10-20T00:00:00Z",
		});
		expect(rankedBoth.text).toContain("narrative 1 · evidence 3 · metrics 0 · excluded 0");
		expect(rankedBoth.text).toContain("[art-narr]");
		expect(rankedBoth.text).toContain("[art-gh]");
	});

	it("leaves reads without not_consumed: true unchanged across all roles", async () => {
		const ftsSearchArtifacts = vi.fn(async () => mixedRows);
		const filterArtifacts = vi.fn(async () => ({ rows: mixedRows, count: mixedRows.length }));
		const action = createKnowledgeSearchAction({
			search: makeSearchPort({ ftsSearchArtifacts, filterArtifacts }),
			embeddings: null,
			config: { loadCapturePreferences: vi.fn(async () => DEFAULT_CAPTURE_PREFERENCES) },
		});

		const queryOut = await action.run({ query: "roadmap" });
		expect(queryOut.text).toContain("[art-narr]");
		expect(queryOut.text).toContain("[art-gh]");
		expect(queryOut.text).toContain("[art-met]");

		const filterOut = await action.run({ captured_after: "2026-10-18T00:00:00Z" });
		expect(filterArtifacts).toHaveBeenCalledWith(
			expect.objectContaining({
				roleOrFilter: undefined,
				excludeRobotAuthored: false,
			}),
		);
		expect(filterOut.text).toContain("[art-narr]");
		expect(filterOut.text).toContain("[art-gh]");
		expect(filterOut.text).toContain("[art-met]");
	});
});


