import { z } from "zod";
import { ARTIFACT_SURFACES } from "../../domain/artifacts.js";
import type {
	ArtifactRepository,
	CapturePort,
	CaptureResult,
} from "../../ports/artifacts.js";
import {
	describeItem,
	type GithubActivityPort,
	type GithubItem,
} from "../../ports/github.js";
import { executeAction } from "../adapters/direct.js";
import { createCaptureAction } from "../artifacts/capture.js";
import { defineAction } from "../defineAction.js";
import type { captureSchema } from "../domain/capture.js";
import type { ActionDefinition } from "../types.js";

export { describeItem };

export const GITHUB_ISSUE_CONTENT_SUBTYPE = "github_issue" as const;
export const GITHUB_PULL_REQUEST_CONTENT_SUBTYPE = "github_pull_request" as const;

function daysAgo(n: number): string {
	return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Render one item as the Markdown body we store. The metadata header is plain text so it
 * lands inside `plain_text` and gets embedded alongside the author's prose; a search for
 * `"repo:angus/ahOS merged PR"` then works without needing structured filters.
 */
export function itemBody(i: GithubItem): string {
	const kind = i.isPullRequest
		? `Pull Request (${i.merged ? "merged" : i.state})`
		: `Issue (${i.state})`;
	const header = [
		`# ${i.repo}#${i.number}: ${i.title}`,
		"",
		`- **Kind**: ${kind}`,
		`- **Repository**: ${i.repo}`,
		`- **URL**: ${i.url}`,
		`- **Author**: @${i.author}`,
		`- **My involvement**: ${i.involvement.join(", ")}`,
		`- **Opened**: ${i.createdAt}`,
		`- **Updated**: ${i.updatedAt}`,
		...(i.closedAt ? [`- **Closed**: ${i.closedAt}`] : []),
		...(i.labels.length ? [`- **Labels**: ${i.labels.join(", ")}`] : []),
		`- **Comments**: ${i.comments}`,
	].join("\n");

	const body = i.body.trim();
	return body ? `${header}\n\n---\n\n${body}` : `${header}\n\n_(no description body)_`;
}

export const githubIngestInput = {
	since: z
		.string()
		.optional()
		.describe(
			"ISO date (YYYY-MM-DD) lower bound on last-updated. Defaults to 7 days ago. Re-running an overlapping window is safe: already-ingested items are skipped by URL.",
		),
	until: z
		.string()
		.optional()
		.describe("ISO date (YYYY-MM-DD) upper bound on last-updated. Defaults to open-ended."),
	repo: z
		.string()
		.optional()
		.describe(
			"Restrict to one 'owner/name'. Omitted, every repository the token can see, which is the point: the coverage gap is work done in repos you never open a Claude session in.",
		),
	max_results: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe(
			"Max items PER QUERY (default 30). Two queries run, authored and commented, so the ceiling on distinct items is roughly twice this.",
		),
	dry_run: z
		.boolean()
		.optional()
		.describe(
			"List what WOULD be ingested and write nothing. Worth using first on a wide window: this writes one artifact per item and a busy fortnight is hundreds.",
		),
};

export const githubIngestSchema = z.object(githubIngestInput);
export type GithubIngestInput = z.infer<typeof githubIngestSchema>;

export const INGEST_GITHUB_DESCRIPTION =
	"Pull the owner's own GitHub activity into the store as artifacts: issues and pull requests they " +
	"authored or commented on, across every repository the token can see, in a date window. " +
	"Deliberately not 'involves:', which would turn a record of what they did into a notifications " +
	"feed. Full notes: docs/guides/tools/ingest_github.md";

export interface IngestGithubResult {
	login: string;
	since: string;
	until?: string;
	repo?: string;
	dryRun: boolean;
	matched: number;
	fresh: number;
	skipped: number;
	ingested: string[];
	failed: string[];
}

export interface IngestGithubDeps {
	github: GithubActivityPort;
	artifacts: Pick<ArtifactRepository, "findExistingSources">;
	capture: CapturePort | ActionDefinition<typeof captureSchema, CaptureResult>;
}

export function formatIngestGithubMcp(result: IngestGithubResult): string {
	const header =
		`@${result.login}: ${result.matched} item(s) matched since ${result.since}` +
		(result.until ? ` until ${result.until}` : "") +
		(result.repo ? ` in ${result.repo}` : "") +
		` (${result.fresh} new, ${result.skipped} already in store).`;

	if (result.dryRun) {
		const lines = [
			header,
			"",
			"DRY RUN, nothing written. Would ingest:",
			...(result.ingested.length ? result.ingested.map((l) => `  - ${l}`) : ["  (none)"]),
		];
		return lines.join("\n");
	}

	if (result.fresh === 0) {
		return `${header}\nNothing new to ingest.`;
	}

	const lines = [
		header,
		"",
		`Ingested ${result.ingested.length}:`,
		...result.ingested.map((l) => `  - ${l}`),
		...(result.failed.length
			? [
					"",
					`FAILED ${result.failed.length}, re-run to retry:`,
					...result.failed.map((l) => `  - ${l}`),
				]
			: []),
		"",
		`Stamped surface '${ARTIFACT_SURFACES.github}' (floors at synthesis role 'evidence' per ADR-046 §3).`,
	];
	return lines.join("\n");
}

export function createIngestGithubAction(deps: IngestGithubDeps) {
	const captureAction: ActionDefinition<typeof captureSchema, CaptureResult> =
		typeof (deps.capture as ActionDefinition<typeof captureSchema, CaptureResult>).id === "string"
			? (deps.capture as ActionDefinition<typeof captureSchema, CaptureResult>)
			: createCaptureAction(deps.capture as CapturePort);

	return defineAction({
		id: "ingest_github",
		domain: "integrations",
		description: INGEST_GITHUB_DESCRIPTION,
		schema: githubIngestSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		},
		run: async (args, ctx): Promise<IngestGithubResult> => {
			const since = args.since ?? daysAgo(7);
			const perQuery = args.max_results ?? 30;

			const login = await deps.github.getViewerLogin(args.repo);
			const items = await deps.github.searchMyActivity({
				login,
				since,
				until: args.until,
				repo: args.repo,
				perQuery,
			});

			const seen = await deps.artifacts.findExistingSources(items.map((i) => i.url));
			const fresh = items.filter((i) => !seen.has(i.url));
			const skipped = items.length - fresh.length;

			if (args.dry_run) {
				return {
					login,
					since,
					until: args.until,
					repo: args.repo,
					dryRun: true,
					matched: items.length,
					fresh: fresh.length,
					skipped,
					ingested: fresh.map(describeItem),
					failed: [],
				};
			}

			if (fresh.length === 0) {
				return {
					login,
					since,
					until: args.until,
					repo: args.repo,
					dryRun: false,
					matched: items.length,
					fresh: 0,
					skipped,
					ingested: [],
					failed: [],
				};
			}

			const ingested: string[] = [];
			const failed: string[] = [];

			for (const i of fresh) {
				try {
					await executeAction(
						captureAction,
						{
							title: `${i.repo}#${i.number}: ${i.title}`,
							text: itemBody(i),
							source_url: i.url,
							surface: ARTIFACT_SURFACES.github,
							captured_by: "ingest_github",
							content_subtype: i.isPullRequest
								? GITHUB_PULL_REQUEST_CONTENT_SUBTYPE
								: GITHUB_ISSUE_CONTENT_SUBTYPE,
							tags: ["github", i.isPullRequest ? "pr" : "issue", `repo:${i.repo}`],
						},
						{ context: { caller: "internal", userId: ctx.userId } },
					);
					ingested.push(describeItem(i));
				} catch (e) {
					failed.push(`${i.repo}#${i.number}: ${e instanceof Error ? e.message : String(e)}`);
				}
			}

			return {
				login,
				since,
				until: args.until,
				repo: args.repo,
				dryRun: false,
				matched: items.length,
				fresh: fresh.length,
				skipped,
				ingested,
				failed,
			};
		},
		formatMcp: formatIngestGithubMcp,
	});
}
