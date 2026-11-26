import { describe, expect, it } from "vitest";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import {
	assertGithubIssueRepoAllowed,
	assertGithubReadRepoAllowed,
	matchesRepoPattern,
} from "./repoAllowlist.js";

describe("repoAllowlist", () => {
	it("matches exact repos and owner/* wildcards", () => {
		expect(matchesRepoPattern("anguspersonal/ahOS", "anguspersonal/ahOS")).toBe(true);
		expect(matchesRepoPattern("anguspersonal/*", "anguspersonal/ahOS")).toBe(true);
		expect(matchesRepoPattern("anguspersonal/*", "anguspersonal/ahOS/sub")).toBe(false);
		expect(matchesRepoPattern("example-org/*", "anguspersonal/ahOS")).toBe(false);
	});

	it("matches exact repos and owner/* wildcards case-insensitively", () => {
		expect(matchesRepoPattern("anguspersonal/ahOS", "anguspersonal/ahos")).toBe(true);
		expect(matchesRepoPattern("anguspersonal/ahos", "anguspersonal/ahOS")).toBe(true);
		expect(matchesRepoPattern("AngusPersonal/*", "anguspersonal/ahOS")).toBe(true);
		expect(matchesRepoPattern("anguspersonal/*", "anguspersonal/ahOS/sub")).toBe(false);
	});

	it("admits mixed-case repo inputs across assertGithubReadRepoAllowed and assertGithubIssueRepoAllowed", async () => {
		const fake = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: {
					read_repos: ["AngusPersonal/*"],
					issue_repos: ["anguspersonal/ahOS", "example-org/ops"],
				},
			},
			error: null,
		}));

		await expect(assertGithubReadRepoAllowed(fake.client, "u-1", "anguspersonal/ahos")).resolves.toBeDefined();
		await expect(assertGithubReadRepoAllowed(fake.client, "u-1", "example-org/OPS")).resolves.toBeDefined();
		await expect(assertGithubIssueRepoAllowed(fake.client, "u-1", "anguspersonal/ahos")).resolves.toBe(
			"anguspersonal/ahos",
		);
		await expect(assertGithubIssueRepoAllowed(fake.client, "u-1", "example-org/ops")).resolves.toBe("example-org/ops");
	});

	it("admits a repo matching read_repos, issue_repos, or pr_repos", async () => {
		const fake = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: {
					read_repos: ["anguspersonal/*"],
					issue_repos: ["example-org/ops"],
					pr_repos: ["example-org/web-app"],
				},
			},
			error: null,
		}));

		await expect(assertGithubReadRepoAllowed(fake.client, "u-1", "anguspersonal/ahOS")).resolves.toBeDefined();
		await expect(assertGithubReadRepoAllowed(fake.client, "u-1", "example-org/ops")).resolves.toBeDefined();
		await expect(assertGithubReadRepoAllowed(fake.client, "u-1", "example-org/web-app")).resolves.toBeDefined();
	});

	it("rejects when repo is on none of read_repos, issue_repos, or pr_repos", async () => {
		const fake = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: {
					read_repos: ["anguspersonal/other"],
				},
			},
			error: null,
		}));

		await expect(assertGithubReadRepoAllowed(fake.client, "u-1", "anguspersonal/ahOS")).rejects.toThrow(
			/read_repos.*issue_repos.*pr_repos/,
		);
	});

	it("rejects when integration is disabled or missing", async () => {
		const fake = createFakeSupabase(() => ({
			data: { enabled: false, config: { read_repos: ["anguspersonal/*"] } },
			error: null,
		}));

		await expect(assertGithubReadRepoAllowed(fake.client, "u-1", "anguspersonal/ahOS")).rejects.toThrow(
			/not configured or disabled/,
		);
	});
});
