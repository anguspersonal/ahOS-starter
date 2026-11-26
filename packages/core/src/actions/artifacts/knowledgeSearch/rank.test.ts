import { describe, expect, it } from "vitest";
import {
	type DisplayRow,
	type Row,
	degradationNote,
	dropExcludedSubtypes,
	errDetail,
	excludeUnenrichedDiscovered,
	excludedSystemSubtypes,
	formatDisplayRows,
	fuseArms,
	graphArmsWanted,
	isNameExactMatch,
	isSynthesisWindow,
	mergeArms,
	rpcMigrationHint,
	snippet,
	subtypeOptIns,
	tagFilter,
	tagRpcParam,
	textArrayLiteral,
	toArtifactDisplayRows,
	toGraphDisplayRows,
} from "./rank.js";

function makeArtifactRow(overrides: Partial<Row> = {}): Row {
	return {
		id: "art-1",
		title: "Artifact One",
		plain_text: "Artifact body text",
		created_at: "2026-10-01T10:00:00Z",
		captured_at: "2026-10-01T10:00:00Z",
		effective_at: "2026-10-01T10:00:00Z",
		lifecycle_stage: "extracted",
		tags: null,
		content_subtype: null,
		...overrides,
	};
}

describe("knowledgeSearch rank & formatting helpers (#1619)", () => {
	it("fuseArms puts an exact-name graph hit (by title, alias, or term expansion) first ahead of higher-ranked artifacts", () => {
		const artifactHit: DisplayRow = {
			kind: "artifact",
			id: "art-top",
			title: "Project Atlas notes",
			note: " (captured 2026-10-01)",
			snippetText: "Atlas discussion",
		};
		const nonExactEntity: DisplayRow = {
			kind: "entity",
			id: "ent-other",
			title: "Atlas Roadmap",
			note: " [entity]",
			snippetText: "Roadmap",
		};
		const exactEntityByAlias: DisplayRow = {
			kind: "entity",
			id: "ent-exact",
			title: "Project Atlas",
			aliases: ["atlas"],
			note: " [entity]",
			snippetText: "Core project",
		};

		const fused = fuseArms(
			[
				{ kind: "artifact", rows: [artifactHit] },
				{ kind: "entity", rows: [nonExactEntity, exactEntityByAlias] },
			],
			"  ATLAS ",
		);

		expect(fused.map((r) => r.id)).toEqual(["ent-exact", "ent-other", "art-top"]);
		expect(
			isNameExactMatch(
				{
					kind: "entity",
					id: "term-1",
					title: "PSR",
					properties: { expansion: "Product Spec Review" },
					note: " [entity]",
					snippetText: "",
				},
				"product spec review",
			),
		).toBe(true);
	});

	it("excludedSystemSubtypes and dropExcludedSubtypes honour each opt-in flag independently", () => {
		expect(
			excludedSystemSubtypes({
				includeTaskRequests: false,
				includeEventRequests: false,
				includeDailyLogs: false,
				includeScaffolds: false,
				includeReflections: false,
			}),
		).toEqual(["task_request", "event_request", "daily_log", "scaffold", "reflection"]);

		expect(
			excludedSystemSubtypes({
				includeTaskRequests: true,
				includeEventRequests: false,
				includeDailyLogs: true,
				includeScaffolds: false,
				includeReflections: false,
			}),
		).toEqual(["event_request", "scaffold", "reflection"]);

		expect(
			excludedSystemSubtypes({
				includeTaskRequests: false,
				includeEventRequests: false,
				includeDailyLogs: false,
				includeScaffolds: false,
				includeReflections: true,
			}),
		).toEqual(["task_request", "event_request", "daily_log", "scaffold"]);

		const rows: Row[] = [
			makeArtifactRow({ id: "normal", content_subtype: null }),
			makeArtifactRow({ id: "tr", content_subtype: "task_request" }),
			makeArtifactRow({ id: "dl", content_subtype: "daily_log" }),
			makeArtifactRow({ id: "ref", content_subtype: "reflection" }),
		];
		const kept = dropExcludedSubtypes(
			rows,
			excludedSystemSubtypes(subtypeOptIns({ include_task_requests: true })),
		);
		expect(kept.map((r) => r.id)).toEqual(["normal", "tr"]);

		const keptReflections = dropExcludedSubtypes(
			rows,
			excludedSystemSubtypes(subtypeOptIns({ include_reflections: true })),
		);
		expect(keptReflections.map((r) => r.id)).toEqual(["normal", "ref"]);
	});

	it("textArrayLiteral quotes elements and escapes embedded quotes and backslashes", () => {
		expect(textArrayLiteral(["doc:cv", "a,b", 'quote"here', "back\\slash"])).toBe(
			'{"doc:cv","a,b","quote\\"here","back\\\\slash"}',
		);
	});

	it("tagFilter, tagRpcParam, graphArmsWanted, rpcMigrationHint, and isSynthesisWindow behave as on dev", () => {
		expect(tagFilter({})).toBeNull();
		expect(tagFilter({ tags: ["a", "b", "a"] })).toEqual(["a", "b"]);
		expect(tagRpcParam({})).toEqual({});
		expect(tagRpcParam({ tags: ["doc:cv"] })).toEqual({ filter_tags: ["doc:cv"] });
		expect(graphArmsWanted({})).toBe(true);
		expect(graphArmsWanted({ artifacts_only: true })).toBe(false);
		expect(graphArmsWanted({ tags: ["doc:cv"] })).toBe(false);
		expect(rpcMigrationHint({}, "migration 066")).toBe("migration 066");
		expect(rpcMigrationHint({ tags: ["x"] }, "migration 066")).toContain("migration 119");
		expect(isSynthesisWindow({})).toBe(false);
		expect(isSynthesisWindow({ not_consumed: true })).toBe(true);
	});

	it("excludeUnenrichedDiscovered, display rows, formatDisplayRows, mergeArms, snippet, degradationNote, and errDetail format results accurately", () => {
		const discovered = makeArtifactRow({
			id: "disc-1",
			lifecycle_stage: "discovered",
			effective_at: "2020-01-01T00:00:00Z",
		});
		const extracted = makeArtifactRow({ id: "ext-1", lifecycle_stage: "extracted" });
		expect(excludeUnenrichedDiscovered([discovered, extracted]).map((r) => r.id)).toEqual([
			"ext-1",
		]);

		const artDisplay = toArtifactDisplayRows([discovered]);
		expect(artDisplay[0]?.note).toBe(" [discovered] (captured 2026-10-01) (from 2020-01-01)");

		const graphDisplay = toGraphDisplayRows(
			[{ id: "g-1", title: "ACME", description: null, aliases: ["Acme Corp"] }],
			"entity",
		);
		expect(graphDisplay[0]?.snippetText).toBe("aka: Acme Corp");

		const merged = mergeArms(
			[{ kind: "artifact", rows: artDisplay, rpcRowCount: 3, ceiling: 3 }],
			"query",
			1,
			"full-text-only",
			{ reason: "provider-unavailable", detail: "429 rate limit" },
		);
		expect(merged.content[0]?.text).toContain("embedding provider unavailable: 429 rate limit");
		expect(merged.content[0]?.text).toContain("ranked-search ceiling was reached");
		expect(formatDisplayRows([]).content[0]?.text).toBe("No matches.");
		expect(snippet("a".repeat(210)).endsWith("…")).toBe(true);
		expect(degradationNote("no-key")).toContain("no OpenAI embedding key");
		expect(errDetail(new Error("x".repeat(200))).endsWith("…")).toBe(true);
	});
});
