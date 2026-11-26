import { describe, expect, it, vi } from "vitest";
import type { GithubReadPort } from "../../ports/github.js";
import type { ActionContext } from "../types.js";
import type { GenericSupabaseClient } from "./issueCreate.js";
import {
	createGithubBranchGetAction,
	createGithubDirListAction,
	createGithubFileGetAction,
	createGithubRepoGetAction,
} from "./repoRead.js";

function createFakeSupabase(): GenericSupabaseClient {
	return {
		from() {
			return {
				select() {
					return {
						eq() {
							return {
								eq() {
									return {
										async maybeSingle() {
											return {
												data: {
													enabled: true,
													config: {
														read_repos: ["anguspersonal/*"],
														issue_repos: ["anguspersonal/ahOS"],
														pr_repos: ["anguspersonal/ahOS"],
													},
												},
												error: null,
											};
										},
									};
								},
							};
						},
					};
				},
			};
		},
	};
}

function createFakePort(overrides?: Partial<GithubReadPort>): GithubReadPort {
	return {
		getPull: vi.fn(),
		getPullDiff: vi.fn(),
		getRepository: vi.fn(async (repo) => ({
			full_name: repo,
			private: true,
			default_branch: "dev",
			description: "ahOS monorepo",
			archived: false,
			pushed_at: "2026-10-19T00:00:00Z",
			open_issues_count: 12,
			html_url: `https://github.com/${repo}`,
		})),
		getBranch: vi.fn(async (_repo, branch) => ({
			exists: true,
			name: branch,
			sha: "deadbeef",
			protected: true,
		})),
		getFile: vi.fn(async (_repo, path, ref) => ({
			path,
			ref: ref ?? "dev",
			sha: "cafebabe",
			size: 12,
			binary: false,
			text: "hello world\n",
		})),
		listDirectory: vi.fn(async () => []),
		...overrides,
	};
}

describe("github repo, branch, file, and directory read actions", () => {
	const context: ActionContext = {
		userId: "user-123",
		caller: "mcp",
		requestId: "req-1",
	};

	it("1. github_file_get over a 60,000-character file returns 50,000 characters with truncated: true and total_chars: 60000", async () => {
		const content = "x".repeat(60_000);
		const port = createFakePort({
			getFile: vi.fn(async (_repo, path, ref) => ({
				path,
				ref: ref ?? "dev",
				sha: "sha-60k",
				size: 60_000,
				binary: false,
				text: content,
			})),
		});
		const action = createGithubFileGetAction({
			port,
			supabase: createFakeSupabase(),
		});

		const res = await action.run(
			{ repo: "anguspersonal/ahOS", path: "docs/architecture/architecture.md", max_chars: 50_000 },
			context,
		);
		expect(res.text?.length).toBe(50_000);
		expect(res.truncated).toBe(true);
		expect(res.total_chars).toBe(60_000);
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("2. A file whose first bytes include NUL returns binary: true and no text", async () => {
		const port = createFakePort({
			getFile: vi.fn(async (_repo, path, ref) => ({
				path,
				ref: ref ?? "dev",
				sha: "sha-bin",
				size: 1024,
				binary: false,
				text: "PNG\r\n\x1a\n\0\0\0\rIHDR",
			})),
		});
		const action = createGithubFileGetAction({
			port,
			supabase: createFakeSupabase(),
		});

		const res = await action.run({ repo: "anguspersonal/ahOS", path: "assets/logo.png", max_chars: 50_000 }, context);
		expect(res.binary).toBe(true);
		expect(res.size).toBe(1024);
		expect(res.text).toBeUndefined();
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("3. github_file_get on a directory refuses and names github_dir_list; github_dir_list on a file refuses and names github_file_get", async () => {
		const port = createFakePort({
			getFile: vi.fn(async (_repo, path) => {
				throw new Error(`Path "${path}" is a directory; use github_dir_list instead.`);
			}),
			listDirectory: vi.fn(async (_repo, path) => {
				throw new Error(`Path "${path}" is a file; use github_file_get instead.`);
			}),
		});

		const fileAction = createGithubFileGetAction({ port, supabase: createFakeSupabase() });
		const dirAction = createGithubDirListAction({ port, supabase: createFakeSupabase() });

		await expect(
			fileAction.run({ repo: "anguspersonal/ahOS", path: "docs", max_chars: 50_000 }, context),
		).rejects.toThrow(/github_dir_list/);

		await expect(
			dirAction.run({ repo: "anguspersonal/ahOS", path: "docs/README.md" }, context),
		).rejects.toThrow(/github_file_get/);
	});

	it("4. path: 'docs/../.env' refuses before the port is called", async () => {
		const getFileSpy = vi.fn();
		const listDirSpy = vi.fn();
		const port = createFakePort({
			getFile: getFileSpy,
			listDirectory: listDirSpy,
		});

		const fileAction = createGithubFileGetAction({ port, supabase: createFakeSupabase() });
		const dirAction = createGithubDirListAction({ port, supabase: createFakeSupabase() });

		await expect(
			fileAction.run({ repo: "anguspersonal/ahOS", path: "docs/../.env", max_chars: 50_000 }, context),
		).rejects.toThrow(/\.\./);
		expect(getFileSpy).not.toHaveBeenCalled();

		await expect(
			dirAction.run({ repo: "anguspersonal/ahOS", path: "docs/../.env" }, context),
		).rejects.toThrow(/\.\./);
		expect(listDirSpy).not.toHaveBeenCalled();
	});

	it("5. github_branch_get on a missing branch resolves { exists: false }", async () => {
		const port = createFakePort({
			getBranch: vi.fn(async () => ({ exists: false })),
		});
		const branchAction = createGithubBranchGetAction({ port, supabase: createFakeSupabase() });

		const res = await branchAction.run({ repo: "anguspersonal/ahOS", branch: "no-such-branch" }, context);
		expect(res).toEqual({ exists: false });
		{
			const parsed = branchAction.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}

		const repoAction = createGithubRepoGetAction({ port, supabase: createFakeSupabase() });
		const repoRes = await repoAction.run({ repo: "anguspersonal/ahOS" }, context);
		expect(repoRes.full_name).toBe("anguspersonal/ahOS");
		{
			const parsed = repoAction.outputSchema.safeParse(repoRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("6. 1,000 directory entries set truncated: true", async () => {
		const entries = Array.from({ length: 1_000 }, (_, i) => ({
			name: `file-${i}.md`,
			path: `docs/file-${i}.md`,
			type: "file",
			size: 100,
		}));
		const port = createFakePort({
			listDirectory: vi.fn(async () => entries),
		});
		const dirAction = createGithubDirListAction({ port, supabase: createFakeSupabase() });

		const res = await dirAction.run({ repo: "anguspersonal/ahOS", path: "docs" }, context);
		expect(res.entries).toHaveLength(1_000);
		expect(res.truncated).toBe(true);
		{
			const parsed = dirAction.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});
});
