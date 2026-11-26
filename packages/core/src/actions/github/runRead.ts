import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import type { GithubReadActionDependencies } from "./prRead.js";
import { assertGithubReadRepoAllowed } from "./repoAllowlist.js";

const repoSchema = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
	.describe("Target GitHub repository ('owner/repo').");

const cursorSchema = z
	.string()
	.regex(/^[1-9]\d*$/, "cursor must be a positive integer page string")
	.optional()
	.describe("Pagination cursor returned as next_cursor from a previous call.");

export const githubRunListInputSchema = z
	.object({
		repo: repoSchema,
		head_sha: z.string().min(1).optional().describe("Filter workflow runs by head commit SHA."),
		branch: z.string().min(1).optional().describe("Filter workflow runs by branch name."),
		status: z.string().min(1).optional().describe("Optional workflow run status or conclusion filter."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.default(20)
			.describe("Maximum number of workflow runs to return per page (1-100, default 20)."),
		cursor: cursorSchema,
	})
	.refine((val) => Boolean(val.head_sha?.trim() || val.branch?.trim()), {
		message: "At least one of head_sha or branch is required",
		path: ["head_sha"],
	});

export type GithubRunListInput = z.infer<typeof githubRunListInputSchema>;

export const githubRunListOutputSchema = z.object({
	items: z.array(
		z.object({
			id: z.number(),
			name: z.string().nullable(),
			event: z.string(),
			status: z.string().nullable(),
			conclusion: z.string().nullable(),
			head_sha: z.string(),
			head_branch: z.string().nullable(),
			run_attempt: z.number(),
			created_at: z.string(),
			html_url: z.string(),
		}),
	),
	next_cursor: z.string().nullable(),
	total_count: z.number(),
});

export type GithubRunListOutput = z.infer<typeof githubRunListOutputSchema>;

export const githubRunJobListInputSchema = z.object({
	repo: repoSchema,
	run_id: z.number().int().positive().describe("Workflow run ID."),
	limit: z
		.number()
		.int()
		.min(1)
		.max(100)
		.default(30)
		.describe("Maximum number of jobs to return per page (1-100, default 30)."),
	cursor: cursorSchema,
});

export type GithubRunJobListInput = z.infer<typeof githubRunJobListInputSchema>;

export const githubRunJobListOutputSchema = z.object({
	items: z.array(
		z.object({
			id: z.number(),
			name: z.string(),
			status: z.string(),
			conclusion: z.string().nullable(),
			started_at: z.string().nullable(),
			completed_at: z.string().nullable(),
			steps: z.array(
				z.object({
					name: z.string(),
					number: z.number(),
					conclusion: z.string().nullable(),
				}),
			),
		}),
	),
	next_cursor: z.string().nullable(),
});

export type GithubRunJobListOutput = z.infer<typeof githubRunJobListOutputSchema>;

export const githubJobLogGetInputSchema = z.object({
	repo: repoSchema,
	job_id: z.number().int().positive().describe("GitHub Actions job ID."),
	tail_chars: z
		.number()
		.int()
		.min(1)
		.max(200_000)
		.default(20_000)
		.describe("Number of trailing characters of the job log to return (default 20,000, max 200,000)."),
});

export type GithubJobLogGetInput = z.infer<typeof githubJobLogGetInputSchema>;

export const githubJobLogGetOutputSchema = z.object({
	expired: z.boolean().optional(),
	log: z.string().optional(),
	truncated: z.boolean().optional(),
	total_chars: z.number().optional(),
});

export type GithubJobLogGetOutput = z.infer<typeof githubJobLogGetOutputSchema>;

function parsePageCursor(cursor?: string): number {
	if (!cursor) return 1;
	const parsed = Number.parseInt(cursor, 10);
	if (!Number.isFinite(parsed) || parsed < 1) {
		throw new Error(`Invalid pagination cursor "${cursor}"`);
	}
	return parsed;
}

export function createGithubRunListAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubRunListInputSchema, GithubRunListOutput> {
	return defineAction({
		id: "github_run_list",
		name: "github_run_list",
		description:
			"List GitHub Actions workflow runs for a branch or head SHA in an allowlisted repository. Full notes: docs/guides/tools/github_run_list.md",
		domain: "integrations",
		schema: githubRunListInputSchema,
		outputSchema: githubRunListOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context): Promise<GithubRunListOutput> {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.listWorkflowRuns) {
				throw new Error("GithubReadPort.listWorkflowRuns is not implemented by the configured adapter.");
			}

			const page = parsePageCursor(input.cursor);
			const limit = input.limit ?? 20;

			return deps.port.listWorkflowRuns(input.repo, {
				head_sha: input.head_sha,
				branch: input.branch,
				status: input.status,
				limit,
				page,
			});
		},
	});
}

export function createGithubRunJobListAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubRunJobListInputSchema, GithubRunJobListOutput> {
	return defineAction({
		id: "github_run_job_list",
		name: "github_run_job_list",
		description:
			"List jobs and failed steps for a GitHub Actions workflow run in an allowlisted repository using the read-only token.",
		domain: "integrations",
		schema: githubRunJobListInputSchema,
		outputSchema: githubRunJobListOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context): Promise<GithubRunJobListOutput> {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.listWorkflowRunJobs) {
				throw new Error("GithubReadPort.listWorkflowRunJobs is not implemented by the configured adapter.");
			}

			const page = parsePageCursor(input.cursor);
			const limit = input.limit ?? 30;

			return deps.port.listWorkflowRunJobs(input.repo, input.run_id, {
				limit,
				page,
			});
		},
	});
}

export function createGithubJobLogGetAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubJobLogGetInputSchema, GithubJobLogGetOutput> {
	return defineAction({
		id: "github_job_log_get",
		name: "github_job_log_get",
		description:
			"Read the trailing characters of a GitHub Actions job log in an allowlisted repository without forwarding credentials to the signed log host.",
		domain: "integrations",
		schema: githubJobLogGetInputSchema,
		outputSchema: githubJobLogGetOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context): Promise<GithubJobLogGetOutput> {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.getJobLog) {
				throw new Error("GithubReadPort.getJobLog is not implemented by the configured adapter.");
			}

			const res = await deps.port.getJobLog(input.repo, input.job_id);
			if (res.expired) {
				return { expired: true };
			}

			const rawLog = res.log ?? "";
			const tailChars = input.tail_chars ?? 20_000;
			const totalChars = rawLog.length;
			const truncated = totalChars > tailChars;
			const log = truncated ? rawLog.slice(-tailChars) : rawLog;

			return {
				log,
				truncated,
				total_chars: totalChars,
			};
		},
	});
}
