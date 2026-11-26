import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubPrCloseAction, createGithubPrCreateAction, createGithubPrUpdateAction } from "./prWrite.js";
import type { GithubPullsPort } from "../../ports/github.js";
import { createOctokitGithubPullsAdapter } from "../../adapters/github/pulls.js";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import { executeAction } from "../adapters/direct.js";
import { PendingApprovalError, setActionApprovalStore } from "../gate.js";
import type { ActionAuditRecord } from "../types.js";

describe("github_pr_create, github_pr_update, github_pr_close core actions (#1479)", () => {
	const validUserId = "11111111-1111-4111-8111-111111111111";
	const mockPort: GithubPullsPort = {
		findOpenPull: vi.fn(),
		createPull: vi.fn(),
		updatePull: vi.fn(),
		closePull: vi.fn(),
	};

	beforeEach(() => vi.clearAllMocks());
	afterEach(() => setActionApprovalStore(undefined));

	function createAllowlistedDb(config: Record<string, unknown> = { pr_repos: ["owner/repo"] }) {
		return createFakeSupabase(() => ({ data: { enabled: true, config }, error: null }));
	}

	it("case 1: caller 'mcp' parks each action with PendingApprovalError, outcome 'pending_approval', and does not call the port", async () => {
		const parkedRequests: unknown[] = [];
		setActionApprovalStore({
			async park(req) {
				parkedRequests.push({ decision_type: "action_approval", ...req });
				return { decisionId: `dec-${req.actionId}` };
			},
		});
		const fakeDb = createAllowlistedDb();
		const audits: ActionAuditRecord[] = [];
		const opts = { context: { caller: "mcp" as const, userId: validUserId }, auditSink: (r: ActionAuditRecord) => audits.push(r) };

		await expect(
			executeAction(createGithubPrCreateAction({ port: mockPort, supabase: fakeDb.client }), { repo: "owner/repo", title: "Docs", head: "feat/docs", base: "dev" }, opts),
		).rejects.toThrow(PendingApprovalError);
		await expect(
			executeAction(createGithubPrUpdateAction({ port: mockPort, supabase: fakeDb.client }), { repo: "owner/repo", number: 12, title: "Retitled" }, opts),
		).rejects.toThrow(PendingApprovalError);
		await expect(
			executeAction(createGithubPrCloseAction({ port: mockPort, supabase: fakeDb.client }), { repo: "owner/repo", number: 12 }, opts),
		).rejects.toThrow(PendingApprovalError);

		expect(parkedRequests).toHaveLength(3);
		expect(audits.map((a) => a.outcome)).toEqual(["pending_approval", "pending_approval", "pending_approval"]);
		expect(mockPort.findOpenPull).not.toHaveBeenCalled();
		expect(mockPort.createPull).not.toHaveBeenCalled();
		expect(mockPort.updatePull).not.toHaveBeenCalled();
		expect(mockPort.closePull).not.toHaveBeenCalled();
	});

	it("case 2: caller 'ui' runs github_pr_create with no draft as draft: true and appends provenance footer", async () => {
		const fakeDb = createAllowlistedDb();
		vi.mocked(mockPort.findOpenPull).mockResolvedValueOnce(null);
		vi.mocked(mockPort.createPull).mockResolvedValueOnce({
			number: 42,
			html_url: "https://github.com/owner/repo/pull/42",
			head_sha: "abc1234",
		});

		const action = createGithubPrCreateAction({ port: mockPort, supabase: fakeDb.client });
		const result = await executeAction(
			action,
			{ repo: "owner/repo", title: "docs: clarify setup", head: "docs/setup", base: "dev", body: "Updates README" },
			{ context: { caller: "ui", userId: validUserId } },
		);

		expect(mockPort.createPull).toHaveBeenCalledWith("owner/repo", {
			title: "docs: clarify setup",
			head: "docs/setup",
			base: "dev",
			body: "Updates README\n\n_Created via ahOS (ui)_",
			draft: true,
		});
		expect(result).toEqual({ number: 42, html_url: "https://github.com/owner/repo/pull/42", head_sha: "abc1234", created: true });
		{
			const parsed = action.outputSchema.safeParse(result);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 3: when an open PR for the same head and base exists, returns it with created: false and does not call createPull", async () => {
		const fakeDb = createAllowlistedDb();
		vi.mocked(mockPort.findOpenPull).mockResolvedValueOnce({
			number: 19,
			html_url: "https://github.com/owner/repo/pull/19",
			head_sha: "999aaaa",
		});

		const action = createGithubPrCreateAction({ port: mockPort, supabase: fakeDb.client });
		const result = await executeAction(
			action,
			{ repo: "owner/repo", title: "docs: clarify setup", head: "docs/setup", base: "dev" },
			{ context: { caller: "ui", userId: validUserId } },
		);

		expect(result).toEqual({ number: 19, html_url: "https://github.com/owner/repo/pull/19", head_sha: "999aaaa", created: false });
		{
			const parsed = action.outputSchema.safeParse(result);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
		expect(mockPort.createPull).not.toHaveBeenCalled();
	});

	it("case 4: github_pr_update with neither title nor body fails validation; updates and closes when valid", async () => {
		const fakeDb = createAllowlistedDb();
		const updateAction = createGithubPrUpdateAction({ port: mockPort, supabase: fakeDb.client });
		const closeAction = createGithubPrCloseAction({ port: mockPort, supabase: fakeDb.client });

		await expect(
			executeAction(updateAction, { repo: "owner/repo", number: 19 } as any, { context: { caller: "ui", userId: validUserId } }),
		).rejects.toThrow(/At least one of title or body must be provided/);
		expect(mockPort.updatePull).not.toHaveBeenCalled();

		vi.mocked(mockPort.updatePull).mockResolvedValueOnce({
			number: 19,
			title: "New title",
			state: "open",
			html_url: "https://github.com/owner/repo/pull/19",
		});
		const updateRes = await executeAction(
			updateAction,
			{ repo: "owner/repo", number: 19, title: "New title" },
			{ context: { caller: "ui", userId: validUserId } },
		);
		expect(updateRes).toEqual({ number: 19, title: "New title", state: "open", html_url: "https://github.com/owner/repo/pull/19" });
		{
			const parsed = updateAction.outputSchema.safeParse(updateRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}

		vi.mocked(mockPort.closePull).mockResolvedValueOnce({ number: 19, state: "closed" });
		const closeRes = await executeAction(
			closeAction,
			{ repo: "owner/repo", number: 19 },
			{ context: { caller: "ui", userId: validUserId } },
		);
		expect(closeRes).toEqual({ number: 19, state: "closed" });
		{
			const parsed = closeAction.outputSchema.safeParse(closeRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});

	it("case 5: a repo on issue_repos only refuses before the port is called", async () => {
		const fakeDb = createAllowlistedDb({ issue_repos: ["owner/issues-only"], pr_repos: ["owner/pr-allowed"] });
		const createAction = createGithubPrCreateAction({ port: mockPort, supabase: fakeDb.client });
		await expect(
			executeAction(createAction, { repo: "owner/issues-only", title: "Title", head: "feat/x", base: "dev" }, { context: { caller: "ui", userId: validUserId } }),
		).rejects.toThrow(/not in the allowed pr_repos/);
		expect(mockPort.findOpenPull).not.toHaveBeenCalled();
		expect(mockPort.createPull).not.toHaveBeenCalled();
	});

	it("case 6: when the github_pulls resolver returns null, rejects naming GITHUB_TOKEN_PULLS", async () => {
		const fakeDb = createAllowlistedDb();
		const realAdapter = createOctokitGithubPullsAdapter(() => null);
		const createAction = createGithubPrCreateAction({ port: realAdapter, supabase: fakeDb.client });
		await expect(
			executeAction(createAction, { repo: "owner/repo", title: "Title", head: "feat/x", base: "dev" }, { context: { caller: "ui", userId: validUserId } }),
		).rejects.toThrow(/GITHUB_TOKEN_PULLS/);
	});
});
