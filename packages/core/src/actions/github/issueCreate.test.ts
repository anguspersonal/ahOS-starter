import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubIssueAction } from "./issueCreate.js";
import type { GithubIssuesPort } from "../../ports/github.js";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import { createActionContext } from "../defineAction.js";

describe("github_issue_create core action", () => {
	const validUserId = "11111111-1111-4111-8111-111111111111";

	const mockPort: GithubIssuesPort = {
		findOpenIssueByTitle: vi.fn(),
		createIssue: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("refuses when user_integrations row is missing or disabled, naming integration_set", async () => {
		const fakeDb = createFakeSupabase(() => ({
			data: null,
			error: null,
		}));

		const action = createGithubIssueAction({
			port: mockPort,
			supabase: fakeDb.client,
		});

		await expect(
			action.run(
				{ repo: "owner/repo", title: "Test issue" },
				createActionContext({ userId: validUserId }),
			),
		).rejects.toThrow(/integration_set/);

		expect(mockPort.findOpenIssueByTitle).not.toHaveBeenCalled();
		expect(mockPort.createIssue).not.toHaveBeenCalled();
	});

	it("refuses when issue_repos is empty or not configured, naming integration_set", async () => {
		const fakeDb = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: { issue_repos: [] },
			},
			error: null,
		}));

		const action = createGithubIssueAction({
			port: mockPort,
			supabase: fakeDb.client,
		});

		await expect(
			action.run(
				{ repo: "owner/repo", title: "Test issue" },
				createActionContext({ userId: validUserId }),
			),
		).rejects.toThrow(/integration_set/);

		expect(mockPort.findOpenIssueByTitle).not.toHaveBeenCalled();
	});

	it("refuses repo not present in allowed issue_repos", async () => {
		const fakeDb = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: { issue_repos: ["owner/allowed-repo"] },
			},
			error: null,
		}));

		const action = createGithubIssueAction({
			port: mockPort,
			supabase: fakeDb.client,
		});

		await expect(
			action.run(
				{ repo: "owner/disallowed-repo", title: "Test issue" },
				createActionContext({ userId: validUserId }),
			),
		).rejects.toThrow(/not in the allowed issue_repos/);

		expect(mockPort.findOpenIssueByTitle).not.toHaveBeenCalled();
	});

	it("resolves omitted repo to default_repo when allowed", async () => {
		const fakeDb = createFakeSupabase((call) => {
			if (call.table === "user_integrations") {
				return {
					data: {
						enabled: true,
						config: {
							default_repo: "owner/default-repo",
							issue_repos: ["owner/default-repo", "owner/other-repo"],
						},
					},
					error: null,
				};
			}
			return { data: null, error: null };
		});

		vi.mocked(mockPort.findOpenIssueByTitle).mockResolvedValueOnce(null);
		vi.mocked(mockPort.createIssue).mockResolvedValueOnce({
			number: 10,
			url: "https://github.com/owner/default-repo/issues/10",
		});

		const action = createGithubIssueAction({
			port: mockPort,
			supabase: fakeDb.client,
		});

		const res = await action.run(
			{ title: "Task for default repo" },
			createActionContext({ userId: validUserId, caller: "mcp" }),
		);

		expect(res).toEqual({
			number: 10,
			url: "https://github.com/owner/default-repo/issues/10",
			repo: "owner/default-repo",
			created: true,
		});
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
		expect(mockPort.createIssue).toHaveBeenCalledWith(
			"owner/default-repo",
			expect.objectContaining({ title: "Task for default repo" }),
		);
	});

	it("refuses omitted repo if default_repo is not in issue_repos", async () => {
		const fakeDb = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: {
					default_repo: "owner/unauthorized-repo",
					issue_repos: ["owner/allowed-repo"],
				},
			},
			error: null,
		}));

		const action = createGithubIssueAction({
			port: mockPort,
			supabase: fakeDb.client,
		});

		await expect(
			action.run(
				{ title: "Task for default repo" },
				createActionContext({ userId: validUserId }),
			),
		).rejects.toThrow(/not in the allowed issue_repos/);

		expect(mockPort.createIssue).not.toHaveBeenCalled();
	});

	it("duplicate guard: returns existing open issue with created: false and does not call createIssue", async () => {
		const fakeDb = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: {
					issue_repos: ["owner/repo"],
				},
			},
			error: null,
		}));

		vi.mocked(mockPort.findOpenIssueByTitle).mockResolvedValueOnce({
			number: 101,
			url: "https://github.com/owner/repo/issues/101",
		});

		const action = createGithubIssueAction({
			port: mockPort,
			supabase: fakeDb.client,
		});

		const res = await action.run(
			{ repo: "owner/repo", title: "Existing bug" },
			createActionContext({ userId: validUserId }),
		);

		expect(res).toEqual({
			number: 101,
			url: "https://github.com/owner/repo/issues/101",
			repo: "owner/repo",
			created: false,
		});
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
		expect(mockPort.createIssue).not.toHaveBeenCalled();
	});

	it("happy path: appends provenance footer, creates issue, and writes system_decisions audit row", async () => {
		let insertedDecision: any = null;
		const fakeDb = createFakeSupabase((call) => {
			if (call.table === "user_integrations") {
				return {
					data: {
						enabled: true,
						config: {
							issue_repos: ["owner/repo"],
						},
					},
					error: null,
				};
			}
			if (call.table === "system_decisions" && call.op === "insert") {
				insertedDecision = call.payload;
				return { data: null, error: null };
			}
			return { data: null, error: null };
		});

		vi.mocked(mockPort.findOpenIssueByTitle).mockResolvedValueOnce(null);
		vi.mocked(mockPort.createIssue).mockResolvedValueOnce({
			number: 77,
			url: "https://github.com/owner/repo/issues/77",
		});

		const action = createGithubIssueAction({
			port: mockPort,
			supabase: fakeDb.client,
		});

		const res = await action.run(
			{
				repo: "owner/repo",
				title: "Broken button",
				body: "The button fails to submit.",
				labels: ["bug", "frontend"],
			},
			createActionContext({ userId: validUserId, caller: "mcp" }),
		);

		expect(res).toEqual({
			number: 77,
			url: "https://github.com/owner/repo/issues/77",
			repo: "owner/repo",
			created: true,
		});
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}

		// Verify provenance footer
		expect(mockPort.createIssue).toHaveBeenCalledWith("owner/repo", {
			title: "Broken button",
			body: "The button fails to submit.\n\n_Created via ahOS (mcp)_",
			labels: ["bug", "frontend"],
		});

		// Verify system_decisions audit row
		expect(insertedDecision).toEqual({
			user_id: validUserId,
			decision_type: "github_issue_created",
			stage: "action",
			status: "resolved",
			user_visible: true,
			requires_user_action: false,
			payload: {
				repo: "owner/repo",
				number: 77,
				url: "https://github.com/owner/repo/issues/77",
				title: "Broken button",
				labels: ["bug", "frontend"],
			},
		});

		// Verify formatMcp output
		const formatted = action.formatMcp!(res);
		expect(formatted).toBe("Created issue #77 in owner/repo: https://github.com/owner/repo/issues/77");
	});

	it("allows repo when issue_repos matches via wildcard pattern (owner/*)", async () => {
		const fakeDb = createFakeSupabase(() => ({
			data: {
				enabled: true,
				config: { issue_repos: ["owner/*"] },
			},
			error: null,
		}));

		vi.mocked(mockPort.findOpenIssueByTitle).mockResolvedValue(null);
		vi.mocked(mockPort.createIssue).mockResolvedValue({
			number: 99,
			url: "https://github.com/owner/subproject/issues/99",
		});

		const action = createGithubIssueAction({
			port: mockPort,
			supabase: fakeDb.client,
		});

		const res = await action.run(
			{ repo: "owner/subproject", title: "Wildcard matched issue" },
			createActionContext({ userId: validUserId }),
		);

		expect(res.created).toBe(true);
		expect(res.number).toBe(99);
		{
			const parsed = action.outputSchema.safeParse(res);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});
});
