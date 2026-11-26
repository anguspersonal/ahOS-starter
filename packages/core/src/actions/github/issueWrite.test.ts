import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createGithubCommentCreateAction,
	createGithubLabelAddAction,
	createGithubLabelRemoveAction,
} from "./issueWrite.js";
import type { GithubIssuesPort } from "../../ports/github.js";
import { createFakeSupabase } from "../../adapters/fakeSupabase.testkit.js";
import { executeAction } from "../adapters/direct.js";
import { PendingApprovalError, setActionApprovalStore } from "../gate.js";
import type { ActionAuditRecord } from "../types.js";

describe("github_comment_create, github_label_add, github_label_remove core actions (#1467)", () => {
	const validUserId = "11111111-1111-4111-8111-111111111111";

	const mockPort: GithubIssuesPort = {
		findOpenIssueByTitle: vi.fn(),
		createIssue: vi.fn(),
		createComment: vi.fn(),
		addLabels: vi.fn(),
		removeLabel: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		setActionApprovalStore(undefined);
	});

	function createAllowlistedDb(config: Record<string, unknown> = { issue_repos: ["owner/repo"] }) {
		return createFakeSupabase(() => ({
			data: {
				enabled: true,
				config,
			},
			error: null,
		}));
	}

	it("case 1: calling as caller 'mcp' with an approval store parks action_approval, records outcome 'pending_approval', and never calls the port", async () => {
		const parkedRequests: unknown[] = [];
		setActionApprovalStore({
			async park(req) {
				parkedRequests.push({ decision_type: "action_approval", ...req });
				return { decisionId: `dec-${req.actionId}` };
			},
		});

		const fakeDb = createAllowlistedDb();
		const audits: ActionAuditRecord[] = [];
		const auditSink = (rec: ActionAuditRecord) => {
			audits.push(rec);
		};

		const commentAction = createGithubCommentCreateAction({ port: mockPort, supabase: fakeDb.client });
		const addAction = createGithubLabelAddAction({ port: mockPort, supabase: fakeDb.client });
		const removeAction = createGithubLabelRemoveAction({ port: mockPort, supabase: fakeDb.client });

		await expect(
			executeAction(
				commentAction,
				{ repo: "owner/repo", number: 12, body: "Needs review" },
				{ context: { caller: "mcp", userId: validUserId }, auditSink },
			),
		).rejects.toThrow(PendingApprovalError);

		await expect(
			executeAction(
				addAction,
				{ repo: "owner/repo", number: 12, labels: ["qa:ready"] },
				{ context: { caller: "mcp", userId: validUserId }, auditSink },
			),
		).rejects.toThrow(PendingApprovalError);

		await expect(
			executeAction(
				removeAction,
				{ repo: "owner/repo", number: 12, label: "qa:ready" },
				{ context: { caller: "mcp", userId: validUserId }, auditSink },
			),
		).rejects.toThrow(PendingApprovalError);

		expect(parkedRequests).toHaveLength(3);
		expect(audits.map((a) => a.outcome)).toEqual([
			"pending_approval",
			"pending_approval",
			"pending_approval",
		]);
		expect(mockPort.createComment).not.toHaveBeenCalled();
		expect(mockPort.addLabels).not.toHaveBeenCalled();
		expect(mockPort.removeLabel).not.toHaveBeenCalled();
	});

	it("case 2: calling github_comment_create as caller 'ui' bypasses gate, appends provenance footer, returns { id, html_url }, and omits body from audit", async () => {
		const fakeDb = createAllowlistedDb();
		const audits: ActionAuditRecord[] = [];
		vi.mocked(mockPort.createComment!).mockResolvedValueOnce({
			id: 501,
			html_url: "https://github.com/owner/repo/issues/12#issuecomment-501",
		});

		const action = createGithubCommentCreateAction({ port: mockPort, supabase: fakeDb.client });
		const secretBody = "Sensitive comment text that must not appear in audit record";

		const result = await executeAction(
			action,
			{ repo: "owner/repo", number: 12, body: secretBody },
			{
				context: { caller: "ui", userId: validUserId },
				auditSink: (rec) => {
					audits.push(rec);
				},
			},
		);

		expect(mockPort.createComment).toHaveBeenCalledWith(
			"owner/repo",
			12,
			`${secretBody}\n\n_Posted via ahOS (ui)_`,
		);
		expect(result).toEqual({
			id: 501,
			html_url: "https://github.com/owner/repo/issues/12#issuecomment-501",
		});
		{
			const parsed = action.outputSchema.safeParse(result);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
		expect(JSON.stringify(result)).not.toContain(secretBody);
		expect(audits).toHaveLength(1);
		expect(audits[0].outcome).toBe("success");
		expect(JSON.stringify(audits[0])).not.toContain(secretBody);
	});

	it("case 3: calling github_label_add as caller 'ui' passes labels and returns { labels }; [] or 11 labels fails Zod validation before gate or port", async () => {
		const fakeDb = createAllowlistedDb();
		vi.mocked(mockPort.addLabels!).mockResolvedValueOnce({
			labels: ["bug", "qa:ready"],
		});

		const action = createGithubLabelAddAction({ port: mockPort, supabase: fakeDb.client });
		const result = await executeAction(
			action,
			{ repo: "owner/repo", number: 12, labels: ["bug", "qa:ready"] },
			{ context: { caller: "ui", userId: validUserId } },
		);

		expect(mockPort.addLabels).toHaveBeenCalledWith("owner/repo", 12, ["bug", "qa:ready"]);
		expect(result).toEqual({ labels: ["bug", "qa:ready"] });
		{
			const parsed = action.outputSchema.safeParse(result);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}

		const parkSpy = vi.fn();
		setActionApprovalStore({ park: parkSpy });

		await expect(
			executeAction(
				action,
				{ repo: "owner/repo", number: 12, labels: [] },
				{ context: { caller: "mcp", userId: validUserId } },
			),
		).rejects.toThrow();

		const elevenLabels = Array.from({ length: 11 }, (_, i) => `l-${i}`);
		await expect(
			executeAction(
				action,
				{ repo: "owner/repo", number: 12, labels: elevenLabels },
				{ context: { caller: "mcp", userId: validUserId } },
			),
		).rejects.toThrow();

		expect(parkSpy).not.toHaveBeenCalled();
		expect(mockPort.addLabels).toHaveBeenCalledTimes(1);
	});

	it("case 4: calling github_label_remove when label was absent returns { removed: false } with outcome 'success'", async () => {
		const fakeDb = createAllowlistedDb();
		const audits: ActionAuditRecord[] = [];
		vi.mocked(mockPort.removeLabel!).mockResolvedValueOnce({ removed: false });

		const action = createGithubLabelRemoveAction({ port: mockPort, supabase: fakeDb.client });
		const result = await executeAction(
			action,
			{ repo: "owner/repo", number: 12, label: "absent-label" },
			{
				context: { caller: "ui", userId: validUserId },
				auditSink: (rec) => {
					audits.push(rec);
				},
			},
		);

		expect(mockPort.removeLabel).toHaveBeenCalledWith("owner/repo", 12, "absent-label");
		expect(result).toEqual({ removed: false });
		{
			const parsed = action.outputSchema.safeParse(result);
			expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		}
		expect(audits).toHaveLength(1);
		expect(audits[0].outcome).toBe("success");
	});

	it("case 5: calling any of the three actions for a repo in read_repos or pr_repos but not issue_repos fails with allowlist error and does not call port", async () => {
		const fakeDb = createAllowlistedDb({
			read_repos: ["owner/read-only"],
			pr_repos: ["owner/pr-only"],
			issue_repos: ["owner/allowed"],
		});

		const commentAction = createGithubCommentCreateAction({ port: mockPort, supabase: fakeDb.client });
		const addAction = createGithubLabelAddAction({ port: mockPort, supabase: fakeDb.client });
		const removeAction = createGithubLabelRemoveAction({ port: mockPort, supabase: fakeDb.client });

		await expect(
			executeAction(
				commentAction,
				{ repo: "owner/read-only", number: 1, body: "hi" },
				{ context: { caller: "ui", userId: validUserId } },
			),
		).rejects.toThrow(/not in the allowed issue_repos/);

		await expect(
			executeAction(
				addAction,
				{ repo: "owner/pr-only", number: 1, labels: ["bug"] },
				{ context: { caller: "ui", userId: validUserId } },
			),
		).rejects.toThrow(/not in the allowed issue_repos/);

		await expect(
			executeAction(
				removeAction,
				{ repo: "owner/read-only", number: 1, label: "bug" },
				{ context: { caller: "ui", userId: validUserId } },
			),
		).rejects.toThrow(/not in the allowed issue_repos/);

		expect(mockPort.createComment).not.toHaveBeenCalled();
		expect(mockPort.addLabels).not.toHaveBeenCalled();
		expect(mockPort.removeLabel).not.toHaveBeenCalled();
	});
});
