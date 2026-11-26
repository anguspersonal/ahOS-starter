import { describe, expect, it, vi } from "vitest";
import { SLACK_APPROVAL_APPROVE_ACTION_ID, SLACK_APPROVAL_REJECT_ACTION_ID, createSlackApprovalCardNotifier, updateSlackApprovalCard } from "./approvalCard.js";
import type { ApprovalRequest } from "../../actions/gate.js";

const REQ: ApprovalRequest = {
	actionId: "gmail_send_draft",
	input: {
		alert: "Ping <!channel> & run <script>alert(1)</script>",
		longField: "x".repeat(500),
	},
	inputSha256: "sha256-hash",
	caller: "mcp",
	requestId: "req-123",
	userId: "user-123",
	clientId: "claude-desktop",
	sessionId: "sess-456",
};

describe("createSlackApprovalCardNotifier (#1534, #1544)", () => {
	it("posts card to chat.postMessage, escapes Slack chars, truncates 500-char value to 200, renders decision_id-only Approve/Reject buttons, and renders link button when AHOS_WEB_URL is set", async () => {
		const stderrLines: string[] = [];
		const fetchMock = vi.fn(async () => ({
			ok: true,
			status: 200,
			statusText: "OK",
			text: async () => JSON.stringify({ ok: true, channel: "D999", ts: "1700000000.000100" }),
		})) as unknown as typeof fetch;

		const notifier = createSlackApprovalCardNotifier({
			botToken: "test-slack-b-token",
			ownerUserId: "U_OWNER_1",
			webUrl: "https://ahos.example.com/",
			now: () => new Date("2026-10-19T12:00:00.000Z"),
			fetch: fetchMock,
			writeStderr: (l) => stderrLines.push(l),
		});
		await notifier(REQ, "dec-42");

		const [url, init] = (fetchMock as any).mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://slack.com/api/chat.postMessage");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-slack-b-token");
		const body = JSON.parse(String(init.body));
		expect(body.channel).toBe("U_OWNER_1");

		const raw = JSON.stringify(body.blocks);
		expect(raw).toContain("Waiting for your approval");
		expect(raw).toContain("2026-10-26");
		expect(raw).not.toContain("<!channel>");
		expect(raw).not.toContain("<script>");
		expect(raw).toContain("&lt;!channel&gt;");
		expect(raw).toContain("&lt;script&gt;");
		expect(raw).toContain("&amp;");
		expect(raw).toContain("x".repeat(200));
		expect(raw).not.toContain("x".repeat(201));

		const buttons = body.blocks.filter((b: any) => b.type === "actions").flatMap((b: any) => b.elements ?? []);
		expect(buttons).toEqual([
			expect.objectContaining({ action_id: SLACK_APPROVAL_APPROVE_ACTION_ID, style: "primary", value: "dec-42" }),
			expect.objectContaining({ action_id: SLACK_APPROVAL_REJECT_ACTION_ID, style: "danger", value: "dec-42" }),
			expect.objectContaining({
				type: "button",
				text: expect.objectContaining({ text: "Open in Approvals" }),
				url: "https://ahos.example.com/approvals",
			}),
		]);
		expect(stderrLines[0]).toContain("dec-42");
		expect(stderrLines[0]).toContain("D999");
		expect(stderrLines[0]).not.toContain("alert(1)");
	});

	it("renders no URL button when AHOS_WEB_URL is unset, updates card without buttons, and logs stderr when owner_user_id is missing", async () => {
		const prev = process.env.AHOS_WEB_URL;
		delete process.env.AHOS_WEB_URL;
		try {
			const fetchMock = vi.fn(async () => ({
				ok: true,
				status: 200,
				statusText: "OK",
				json: async () => ({ ok: true }),
				text: async () => JSON.stringify({ ok: true, channel: "D999", ts: "1" }),
			})) as unknown as typeof fetch;
			await createSlackApprovalCardNotifier({
				botToken: "test-slack-b-token",
				ownerUserId: "U_OWNER_1",
				fetch: fetchMock,
				writeStderr: () => {},
			})(REQ, "dec-43");
			const body = JSON.parse(String((fetchMock as any).mock.calls[0][1].body));
			const buttons = body.blocks.filter((b: any) => b.type === "actions").flatMap((b: any) => b.elements ?? []);
			expect(buttons.map((b: any) => b.action_id)).toEqual([SLACK_APPROVAL_APPROVE_ACTION_ID, SLACK_APPROVAL_REJECT_ACTION_ID]);

			await updateSlackApprovalCard({
				botToken: "test-slack-b-token",
				channel: "D999",
				ts: "1",
				decisionId: "dec-43",
				outcomeText: "Rejected in Slack.",
				existingBlocks: body.blocks,
				fetch: fetchMock,
			});
			const updateBody = JSON.parse(String((fetchMock as any).mock.calls[1][1].body));
			expect(updateBody.blocks.filter((b: any) => b.type === "actions")).toEqual([]);

			const stderrLines: string[] = [];
			const noOwnerFetch = vi.fn() as unknown as typeof fetch;
			await createSlackApprovalCardNotifier({
				botToken: "test-slack-b-token",
				ownerUserId: () => null,
				fetch: noOwnerFetch,
				writeStderr: (l) => stderrLines.push(l),
			})(REQ, "dec-44");
			expect(noOwnerFetch).not.toHaveBeenCalled();
			expect(stderrLines[0]).toContain("approval cards off: no slack owner_user_id");
		} finally {
			if (prev !== undefined) process.env.AHOS_WEB_URL = prev;
		}
	});
});
