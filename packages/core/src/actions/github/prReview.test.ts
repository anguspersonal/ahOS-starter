import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGithubBranchDeleteAction, createGithubReviewCreateAction } from "./prReview.js";
import type { GithubPullsPort, GithubReadPort } from "../../ports/github.js";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import { executeAction } from "../adapters/direct.js";
import { PendingApprovalError, setActionApprovalStore } from "../gate.js";
import type { ActionAuditRecord } from "../types.js";

describe("github_review_create and github_branch_delete core actions (#1507)", () => {
	const validUserId = "11111111-1111-4111-8111-111111111111";
	const mockPort: GithubPullsPort = {
		findOpenPull: vi.fn(),
		createPull: vi.fn(),
		updatePull: vi.fn(),
		closePull: vi.fn(),
		createReview: vi.fn(),
		listOpenPullsFromHead: vi.fn(),
		deleteBranch: vi.fn(),
		getRepository: vi.fn(),
	};
	const mockReadPort: Pick<GithubReadPort, "getRepository"> = {
		getRepository: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(mockReadPort.getRepository!).mockResolvedValue({
			full_name: "owner/repo",
			private: true,
			default_branch: "dev",
			description: null,
			archived: false,
			pushed_at: null,
			open_issues_count: 0,
			html_url: "https://github.com/owner/repo",
		});
	});
	afterEach(() => setActionApprovalStore(undefined));

	function createAllowlistedDb(config: Record<string, unknown> = { pr_repos: ["owner/repo"] }) {
		return createFakeSupabase(() => ({ data: { enabled: true, config }, error: null }));
	}

	it("case 1: caller 'mcp' parks both actions and does not call the port", async () => {
		const parkedRequests: unknown[] = [];
		setActionApprovalStore({
			async park(req) {
				parkedRequests.push({ decision_type: "action_approval", ...req });
				return { decisionId: `dec-${req.actionId}` };
			},
		});
		const fakeDb = createAllowlistedDb();
		const audits: ActionAuditRecord[] = [];
		const opts = {
			context: { caller: "mcp" as const, userId: validUserId },
			auditSink: (r: ActionAuditRecord) => audits.push(r),
		};

		await expect(
			executeAction(
				createGithubReviewCreateAction({ port: mockPort, readPort: mockReadPort, supabase: fakeDb.client }),
				{ repo: "owner/repo", number: 42, event: "COMMENT", body: "Looks good" },
				opts,
			),
		).rejects.toThrow(PendingApprovalError);

		await expect(
			executeAction(
				createGithubBranchDeleteAction({ port: mockPort, readPort: mockReadPort, supabase: fakeDb.client }),
				{ repo: "owner/repo", branch: "feat/old-branch" },
				opts,
			),
		).rejects.toThrow(PendingApprovalError);

		expect(parkedRequests).toHaveLength(2);
		expect(audits.map((a) => a.outcome)).toEqual(["pending_approval", "pending_approval"]);
		expect(mockPort.createReview).not.toHaveBeenCalled();
		expect(mockReadPort.getRepository).not.toHaveBeenCalled();
		expect(mockPort.listOpenPullsFromHead).not.toHaveBeenCalled();
		expect(mockPort.deleteBranch).not.toHaveBeenCalled();
	});

	it("case 2: caller 'ui', github_branch_delete on the default branch refuses before any delete call", async () => {
		const fakeDb = createAllowlistedDb();
		const action = createGithubBranchDeleteAction({
			port: mockPort,
			readPort: mockReadPort,
			supabase: fakeDb.client,
		});

		await expect(
			executeAction(action, { repo: "owner/repo", branch: "dev" }, { context: { caller: "ui", userId: validUserId } }),
		).rejects.toThrow(/default branch "dev"/i);

		expect(mockReadPort.getRepository).toHaveBeenCalledWith("owner/repo");
		expect(mockPort.listOpenPullsFromHead).not.toHaveBeenCalled();
		expect(mockPort.deleteBranch).not.toHaveBeenCalled();
	});

	it("case 3: a branch with an open PR refuses without force_open_pr; with it, deletes", async () => {
		const fakeDb = createAllowlistedDb();
		const action = createGithubBranchDeleteAction({
			port: mockPort,
			readPort: mockReadPort,
			supabase: fakeDb.client,
		});

		vi.mocked(mockPort.listOpenPullsFromHead!).mockResolvedValueOnce([
			{ number: 77, html_url: "https://github.com/owner/repo/pull/77", head_sha: "abc1234" },
		]);

		await expect(
			executeAction(
				action,
				{ repo: "owner/repo", branch: "feat/active" },
				{ context: { caller: "ui", userId: validUserId } },
			),
		).rejects.toThrow(/open pull request #77/i);
		expect(mockPort.deleteBranch).not.toHaveBeenCalled();

		vi.mocked(mockPort.deleteBranch!).mockResolvedValueOnce({ deleted: true });
		const deleteRes = await executeAction(
			action,
			{ repo: "owner/repo", branch: "feat/active", force_open_pr: true },
			{ context: { caller: "ui", userId: validUserId } },
		);
		expect(deleteRes).toEqual({ deleted: true });
		{
			const parsed = action.outputSchema.safeParse(deleteRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
		expect(mockPort.deleteBranch).toHaveBeenCalledWith("owner/repo", "feat/active");
	});

	it("case 4: GitHub 422 Reference does not exist resolves { deleted: false }; 422 Cannot delete protected branch rejects naming protection", async () => {
		const fakeDb = createAllowlistedDb();
		const action = createGithubBranchDeleteAction({
			port: mockPort,
			readPort: mockReadPort,
			supabase: fakeDb.client,
		});

		vi.mocked(mockPort.listOpenPullsFromHead!).mockResolvedValue([]);
		vi.mocked(mockPort.deleteBranch!).mockRejectedValueOnce(
			Object.assign(new Error("Reference does not exist"), { status: 422 }),
		);

		const goneRes = await executeAction(
			action,
			{ repo: "owner/repo", branch: "feat/already-gone" },
			{ context: { caller: "ui", userId: validUserId } },
		);
		expect(goneRes).toEqual({ deleted: false });
		{
			const parsed = action.outputSchema.safeParse(goneRes);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}

		vi.mocked(mockPort.deleteBranch!).mockRejectedValueOnce(
			Object.assign(new Error("Cannot delete protected branch"), { status: 422 }),
		);

		await expect(
			executeAction(
				action,
				{ repo: "owner/repo", branch: "release/v1" },
				{ context: { caller: "ui", userId: validUserId } },
			),
		).rejects.toThrow(/protected branch/i);
	});

	it("case 5: github_review_create with event 'COMMENT' and no body fails validation; a 422 on self-approval maps to the stated message", async () => {
		const fakeDb = createAllowlistedDb();
		const action = createGithubReviewCreateAction({
			port: mockPort,
			readPort: mockReadPort,
			supabase: fakeDb.client,
		});

		await expect(
			executeAction(
				action,
				{ repo: "owner/repo", number: 42, event: "COMMENT" },
				{ context: { caller: "ui", userId: validUserId } },
			),
		).rejects.toThrow(/Body is required unless event is APPROVE/i);
		expect(mockPort.createReview).not.toHaveBeenCalled();

		vi.mocked(mockPort.createReview!).mockRejectedValueOnce(
			Object.assign(new Error("Unprocessable Entity: Can not approve your own pull request"), { status: 422 }),
		);

		await expect(
			executeAction(
				action,
				{ repo: "owner/repo", number: 42, event: "APPROVE" },
				{ context: { caller: "ui", userId: validUserId } },
			),
		).rejects.toThrow("GitHub does not let the PR's author approve or request changes on it");

		vi.mocked(mockPort.createReview!).mockResolvedValueOnce({
			id: 501,
			html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-501",
			state: "APPROVED",
		});

		const result = await executeAction(
			action,
			{ repo: "owner/repo", number: 42, event: "APPROVE" },
			{ context: { caller: "ui", userId: validUserId } },
		);
		expect(result).toEqual({
			id: 501,
			html_url: "https://github.com/owner/repo/pull/42#pullrequestreview-501",
			state: "APPROVED",
		});
		{
			const parsed = action.outputSchema.safeParse(result);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
	});
});
