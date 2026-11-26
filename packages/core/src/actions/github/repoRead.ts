import { z } from "zod";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { encodeRepoPathSegments } from "../../ports/github.js";
import type { GithubReadActionDependencies } from "./prRead.js";
import { assertGithubReadRepoAllowed } from "./repoAllowlist.js";

const repoSchema = z
	.string()
	.regex(/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/, "Repo must be in 'owner/repo' format")
	.describe("Target GitHub repository ('owner/repo').");

export const githubRepoGetInputSchema = z.object({
	repo: repoSchema,
});

export type GithubRepoGetInput = z.infer<typeof githubRepoGetInputSchema>;

export const githubRepoGetOutputSchema = z.object({
	full_name: z.string(),
	private: z.boolean(),
	default_branch: z.string(),
	description: z.string().nullable(),
	archived: z.boolean(),
	pushed_at: z.string().nullable(),
	open_issues_count: z.number(),
	html_url: z.string(),
});

export type GithubRepoGetOutput = z.infer<typeof githubRepoGetOutputSchema>;

export const githubBranchGetInputSchema = z.object({
	repo: repoSchema,
	branch: z.string().min(1).describe("Branch name to look up."),
});

export type GithubBranchGetInput = z.infer<typeof githubBranchGetInputSchema>;

export const githubBranchGetOutputSchema = z.object({
	exists: z.boolean(),
	name: z.string().optional(),
	sha: z.string().optional(),
	protected: z.boolean().optional(),
});

export type GithubBranchGetOutput = z.infer<typeof githubBranchGetOutputSchema>;

export const githubFileGetInputSchema = z.object({
	repo: repoSchema,
	path: z.string().min(1).describe("Repository-relative file path."),
	ref: z.string().min(1).optional().describe("Optional git ref (branch, tag, or commit SHA)."),
	max_chars: z
		.number()
		.int()
		.min(1)
		.max(200_000)
		.default(50_000)
		.describe("Maximum number of characters of file text to return (default 50,000, max 200,000)."),
});

export type GithubFileGetInput = z.infer<typeof githubFileGetInputSchema>;

export const githubFileGetOutputSchema = z.object({
	path: z.string(),
	ref: z.string().optional(),
	sha: z.string().optional(),
	size: z.number(),
	binary: z.boolean().optional(),
	text: z.string().optional(),
	truncated: z.boolean().optional(),
	total_chars: z.number().optional(),
});

export type GithubFileGetOutput = z.infer<typeof githubFileGetOutputSchema>;

export const githubDirListInputSchema = z.object({
	repo: repoSchema,
	path: z.string().default("").describe("Repository-relative directory path (empty string for root)."),
	ref: z.string().min(1).optional().describe("Optional git ref (branch, tag, or commit SHA)."),
});

export type GithubDirListInput = z.infer<typeof githubDirListInputSchema>;

export const githubDirListOutputSchema = z.object({
	entries: z.array(
		z.object({
			name: z.string(),
			path: z.string(),
			type: z.string(),
			size: z.number(),
		}),
	),
	truncated: z.boolean().optional(),
});

export type GithubDirListOutput = z.infer<typeof githubDirListOutputSchema>;

const MAX_READABLE_FILE_BYTES = 1_048_576;
const BINARY_SNIFF_BYTES = 8_192;
const GITHUB_DIR_LIST_CEILING = 1_000;

export function createGithubRepoGetAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubRepoGetInputSchema, GithubRepoGetOutput> {
	return defineAction({
		id: "github_repo_get",
		name: "github_repo_get",
		description:
			"Read a GitHub repository's metadata and default branch in an allowlisted repository using the read-only GitHub token.",
		domain: "integrations",
		schema: githubRepoGetInputSchema,
		outputSchema: githubRepoGetOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.getRepository) {
				throw new Error("GithubReadPort.getRepository is not implemented by the configured adapter.");
			}

			return deps.port.getRepository(input.repo);
		},
	});
}

export function createGithubBranchGetAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubBranchGetInputSchema, GithubBranchGetOutput> {
	return defineAction({
		id: "github_branch_get",
		name: "github_branch_get",
		description:
			"Read a GitHub branch's head SHA and protection state in an allowlisted repository, resolving exists: false when missing.",
		domain: "integrations",
		schema: githubBranchGetInputSchema,
		outputSchema: githubBranchGetOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context): Promise<GithubBranchGetOutput> {
			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.getBranch) {
				throw new Error("GithubReadPort.getBranch is not implemented by the configured adapter.");
			}

			try {
				const branch = await deps.port.getBranch(input.repo, input.branch);
				if (!branch.exists) {
					return { exists: false };
				}
				return {
					exists: true,
					name: branch.name,
					sha: branch.sha,
					protected: branch.protected,
				};
			} catch (err) {
				if ((err as any)?.status === 404) {
					return { exists: false };
				}
				throw err;
			}
		},
	});
}

export function createGithubFileGetAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubFileGetInputSchema, GithubFileGetOutput> {
	return defineAction({
		id: "github_file_get",
		name: "github_file_get",
		description:
			"Read a file from an allowlisted GitHub repository with truncation bounds and binary detection. Full notes: docs/guides/tools/github_file_get.md",
		domain: "integrations",
		schema: githubFileGetInputSchema,
		outputSchema: githubFileGetOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context): Promise<GithubFileGetOutput> {
			const { normalizedPath } = encodeRepoPathSegments(input.path);
			if (!normalizedPath) {
				throw new Error(`Path "${input.path}" is a directory; use github_dir_list instead.`);
			}

			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.getFile) {
				throw new Error("GithubReadPort.getFile is not implemented by the configured adapter.");
			}

			const file = await deps.port.getFile(input.repo, normalizedPath, input.ref);
			const isBinary =
				Boolean(file.binary) ||
				file.size > MAX_READABLE_FILE_BYTES ||
				(typeof file.text === "string" && file.text.slice(0, BINARY_SNIFF_BYTES).includes("\0"));

			if (isBinary) {
				return {
					path: file.path || normalizedPath,
					ref: file.ref,
					sha: file.sha,
					size: file.size,
					binary: true,
				};
			}

			const rawText = file.text ?? "";
			const maxChars = input.max_chars ?? 50_000;
			const totalChars = rawText.length;
			const truncated = totalChars > maxChars;
			const text = truncated ? rawText.slice(0, maxChars) : rawText;

			return {
				path: file.path || normalizedPath,
				ref: file.ref,
				sha: file.sha,
				size: file.size,
				text,
				truncated,
				total_chars: totalChars,
			};
		},
	});
}

export function createGithubDirListAction(
	deps: GithubReadActionDependencies,
): ActionDefinition<typeof githubDirListInputSchema, GithubDirListOutput> {
	return defineAction({
		id: "github_dir_list",
		name: "github_dir_list",
		description:
			"List entries in a directory of an allowlisted GitHub repository using the read-only GitHub token.",
		domain: "integrations",
		schema: githubDirListInputSchema,
		outputSchema: githubDirListOutputSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		async run(input, context) {
			const { normalizedPath } = encodeRepoPathSegments(input.path ?? "");

			const userId = context.userId ?? deps.getUserId?.();
			await assertGithubReadRepoAllowed(deps.supabase, userId, input.repo);

			if (!deps.port.listDirectory) {
				throw new Error("GithubReadPort.listDirectory is not implemented by the configured adapter.");
			}

			const entries = await deps.port.listDirectory(input.repo, normalizedPath, input.ref);
			const out: GithubDirListOutput = {
				entries,
			};
			if (entries.length >= GITHUB_DIR_LIST_CEILING) {
				out.truncated = true;
			}
			return out;
		},
	});
}
