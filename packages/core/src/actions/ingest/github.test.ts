import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeAction } from "../adapters/direct.js";
import { createCaptureAction } from "../artifacts/capture.js";
import type { CaptureInput } from "../domain/capture.js";
import type { ActionContext } from "../types.js";
import type { CapturePort, CaptureResult } from "../../ports/artifacts.js";
import type { GithubActivityPort, GithubItem } from "../../ports/github.js";
import {
	createIngestGithubAction,
	GITHUB_ISSUE_CONTENT_SUBTYPE,
	GITHUB_PULL_REQUEST_CONTENT_SUBTYPE,
	githubIngestInput,
	INGEST_GITHUB_DESCRIPTION,
	itemBody,
} from "./github.js";

function item(over: Partial<GithubItem> = {}): GithubItem {
	return {
		url: "https://github.com/angus/ahOS/pull/42",
		number: 42,
		repo: "angus/ahOS",
		title: "Stop the ritual timing out on 80 rows",
		body: "Split the query in two.\n\nCloses #40.",
		state: "closed",
		isPullRequest: true,
		merged: true,
		author: "angus",
		labels: ["perf", "ritual"],
		createdAt: "2026-08-29T10:00:00Z",
		updatedAt: "2026-08-30T14:22:00Z",
		closedAt: "2026-08-30T14:22:00Z",
		comments: 3,
		involvement: ["authored", "commented"],
		...over,
	};
}

function fakeCaptureResult(input: CaptureInput): CaptureResult {
	return {
		id: "art-1",
		title: input.title ?? "Untitled",
		tags: input.tags ?? [],
		source_channel: "mcp",
		storage_bucket: "user-uploads",
		storage_path: "github/art-1.md",
		captured_at: "2026-08-31T00:00:00Z",
		captured_at_declared: false,
		deduplicated: false,
	};
}

describe("itemBody (#1531)", () => {
	it("renders a plain-text metadata header above the prose body so both land in plain_text", () => {
		const md = itemBody(item());
		expect(md).toContain("# angus/ahOS#42: Stop the ritual timing out on 80 rows");
		expect(md).toContain("- **Kind**: Pull Request (merged)");
		expect(md).toContain("- **Repository**: angus/ahOS");
		expect(md).toContain("- **URL**: https://github.com/angus/ahOS/pull/42");
		expect(md).toContain("- **Author**: @angus");
		expect(md).toContain("- **My involvement**: authored, commented");
		expect(md).toContain("- **Labels**: perf, ritual");
		expect(md).toContain("- **Closed**: 2026-08-30T14:22:00Z");
		expect(md).toContain("\n---\n\nSplit the query in two.\n\nCloses #40.");
	});

	it("omits Closed and Labels lines when absent and marks an empty body explicitly", () => {
		const md = itemBody(
			item({
				isPullRequest: false,
				merged: false,
				state: "open",
				closedAt: "",
				labels: [],
				body: "   ",
			}),
		);
		expect(md).toContain("- **Kind**: Issue (open)");
		expect(md).not.toContain("**Closed**");
		expect(md).not.toContain("**Labels**");
		expect(md).toContain("_(no description body)_");
	});
});

describe("createIngestGithubAction (#1531)", () => {
	it("preserves exact contract parity for id, schema, description, annotations, and default exposure", () => {
		const github: GithubActivityPort = {
			getViewerLogin: vi.fn(async () => "angus"),
			searchMyActivity: vi.fn(async () => []),
		};
		const artifacts = {
			findExistingSources: vi.fn(async () => new Set<string>()),
		};
		const capture: CapturePort = {
			capture: vi.fn(async (input) => fakeCaptureResult(input)),
		};

		const action = createIngestGithubAction({ github, artifacts, capture });

		expect(action.id).toBe("ingest_github");
		expect(z.toJSONSchema(action.schema)).toEqual(z.toJSONSchema(z.object(githubIngestInput)));
		expect(action.description).toBe(INGEST_GITHUB_DESCRIPTION);
		expect(action.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		expect(action.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
	});

	it("dry_run: true calls searchMyActivity and findExistingSources, writes nothing, and lists only fresh items", async () => {
		const prItem = item();
		const issueItem = item({
			url: "https://github.com/other/thing/issues/7",
			number: 7,
			repo: "other/thing",
			title: "Someone else's issue",
			state: "open",
			isPullRequest: false,
			merged: false,
			involvement: ["commented"],
		});

		const github: GithubActivityPort = {
			getViewerLogin: vi.fn(async () => "angus"),
			searchMyActivity: vi.fn(async () => [issueItem, prItem]),
		};
		const artifacts = {
			findExistingSources: vi.fn(
				async () => new Set<string>(["https://github.com/angus/ahOS/pull/42"]),
			),
		};
		const captureFn = vi.fn(async (input: CaptureInput) => fakeCaptureResult(input));

		const action = createIngestGithubAction({
			github,
			artifacts,
			capture: { capture: captureFn },
		});

		const result = await executeAction(
			action,
			{ since: "2026-08-25", until: "2026-09-01", repo: "other/thing", max_results: 25, dry_run: true },
			{ context: { caller: "test", userId: "owner-1" } },
		);

		expect(github.getViewerLogin).toHaveBeenCalledWith("other/thing");
		expect(github.searchMyActivity).toHaveBeenCalledWith({
			login: "angus",
			since: "2026-08-25",
			until: "2026-09-01",
			repo: "other/thing",
			perQuery: 25,
		});
		expect(artifacts.findExistingSources).toHaveBeenCalledWith([
			"https://github.com/other/thing/issues/7",
			"https://github.com/angus/ahOS/pull/42",
		]);
		expect(captureFn).not.toHaveBeenCalled();

		expect(result.dryRun).toBe(true);
		expect(result.matched).toBe(2);
		expect(result.fresh).toBe(1);
		expect(result.skipped).toBe(1);
		expect(result.ingested).toEqual([
			"other/thing#7 Someone else's issue (open issue, commented)",
		]);

		const text = action.formatMcp?.(result) ?? "";
		expect(text).toBe(
			[
				"@angus: 2 item(s) matched since 2026-08-25 until 2026-09-01 in other/thing (1 new, 1 already in store).",
				"",
				"DRY RUN, nothing written. Would ingest:",
				"  - other/thing#7 Someone else's issue (open issue, commented)",
			].join("\n"),
		);
	});

	it("live run captures each fresh item once via executeAction on the core capture action with caller 'internal' and ctx.userId", async () => {
		const prItem = item();
		const issueItem = item({
			url: "https://github.com/other/thing/issues/7",
			number: 7,
			repo: "other/thing",
			title: "Plain open issue",
			body: "Issue description here.",
			state: "open",
			isPullRequest: false,
			merged: false,
			author: "someone",
			labels: ["bug"],
			closedAt: "",
			comments: 1,
			involvement: ["commented"],
		});
		const alreadySeenItem = item({
			url: "https://github.com/angus/ahOS/issues/10",
			number: 10,
			title: "Old issue",
		});

		const github: GithubActivityPort = {
			getViewerLogin: vi.fn(async () => "angus"),
			searchMyActivity: vi.fn(async () => [prItem, issueItem, alreadySeenItem]),
		};
		const artifacts = {
			findExistingSources: vi.fn(
				async () => new Set<string>(["https://github.com/angus/ahOS/issues/10"]),
			),
		};

		const capturedCalls: Array<{ input: CaptureInput; ctx: ActionContext }> = [];
		const baseCaptureAction = createCaptureAction({
			capture: vi.fn(async (input) => fakeCaptureResult(input)),
		});
		const runSpy = vi.spyOn(baseCaptureAction, "run").mockImplementation(async (input, ctx) => {
			capturedCalls.push({ input, ctx });
			return fakeCaptureResult(input);
		});

		const action = createIngestGithubAction({
			github,
			artifacts,
			capture: baseCaptureAction,
		});

		const result = await executeAction(
			action,
			{ since: "2026-08-25" },
			{ context: { caller: "mcp", userId: "user-abc-123" } },
		);

		expect(runSpy).toHaveBeenCalledTimes(2);
		expect(capturedCalls[0]?.ctx.caller).toBe("internal");
		expect(capturedCalls[0]?.ctx.userId).toBe("user-abc-123");
		expect(capturedCalls[0]?.input).toEqual({
			title: "angus/ahOS#42: Stop the ritual timing out on 80 rows",
			text: itemBody(prItem),
			source_url: "https://github.com/angus/ahOS/pull/42",
			surface: "github",
			captured_by: "ingest_github",
			content_subtype: GITHUB_PULL_REQUEST_CONTENT_SUBTYPE,
			tags: ["github", "pr", "repo:angus/ahOS"],
		});

		expect(capturedCalls[1]?.ctx.caller).toBe("internal");
		expect(capturedCalls[1]?.ctx.userId).toBe("user-abc-123");
		expect(capturedCalls[1]?.input).toEqual({
			title: "other/thing#7: Plain open issue",
			text: itemBody(issueItem),
			source_url: "https://github.com/other/thing/issues/7",
			surface: "github",
			captured_by: "ingest_github",
			content_subtype: GITHUB_ISSUE_CONTENT_SUBTYPE,
			tags: ["github", "issue", "repo:other/thing"],
		});

		const text = action.formatMcp?.(result) ?? "";
		expect(text).toBe(
			[
				"@angus: 3 item(s) matched since 2026-08-25 (2 new, 1 already in store).",
				"",
				"Ingested 2:",
				"  - angus/ahOS#42 Stop the ritual timing out on 80 rows (merged PR, authored and commented)",
				"  - other/thing#7 Plain open issue (open issue, commented)",
				"",
				"Stamped surface 'github' (floors at synthesis role 'evidence' per ADR-046 §3).",
			].join("\n"),
		);
	});

	it("continues the sweep on partial failure and reports the failed item under 'FAILED 1, re-run to retry:'", async () => {
		const first = item({
			url: "https://github.com/angus/ahOS/pull/41",
			number: 41,
			title: "First PR",
		});
		const second = item({
			url: "https://github.com/angus/ahOS/pull/42",
			number: 42,
			title: "Second PR",
		});

		const github: GithubActivityPort = {
			getViewerLogin: vi.fn(async () => "angus"),
			searchMyActivity: vi.fn(async () => [first, second]),
		};
		const artifacts = {
			findExistingSources: vi.fn(async () => new Set<string>()),
		};
		const capture: CapturePort = {
			capture: vi.fn(async (input) => {
				if (input.source_url === "https://github.com/angus/ahOS/pull/41") {
					throw new Error("storage bucket rate limited");
				}
				return fakeCaptureResult(input);
			}),
		};

		const action = createIngestGithubAction({ github, artifacts, capture });
		const result = await executeAction(action, { since: "2026-08-25" });

		expect(result.ingested).toEqual([
			"angus/ahOS#42 Second PR (merged PR, authored and commented)",
		]);
		expect(result.failed).toEqual(["angus/ahOS#41: storage bucket rate limited"]);

		const text = action.formatMcp?.(result) ?? "";
		expect(text).toContain("Ingested 1:");
		expect(text).toContain("FAILED 1, re-run to retry:");
		expect(text).toContain("  - angus/ahOS#41: storage bucket rate limited");
	});
});
