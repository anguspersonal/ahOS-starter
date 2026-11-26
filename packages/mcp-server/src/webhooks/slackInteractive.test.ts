import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { inputSha256, type ActionApprovalLifecycleStore } from "@ahkms/core";
import { executeApproved } from "@ahkms/core/actions";
import { SLACK_APPROVAL_APPROVE_ACTION_ID, SLACK_APPROVAL_REJECT_ACTION_ID } from "@ahkms/core/adapters";
import { computeSlackSignature } from "../automations/slackSignature.js";
import { slackInteractiveRouter, type SlackInteractiveOptions, type SlackInteractivePayload } from "./slackInteractive.js";

const SECRET = "test_slack_interactive_secret";
const NOW = 1_760_000_000;
const OWNER_UUID = "00000000-0000-4000-8000-000000000001";

function makeFixture(expiresAt = new Date((NOW + 86_400) * 1000).toISOString()) {
	const row = { id: "dec-1", actionId: "slack_post", input: { channel: "C1", text: "Hi" }, inputSha256: "", status: "pending", expiresAt, notes: null as string | null };
	const claim = vi.fn(async (id: string, uid: string, notes?: string | null) => {
		if (id !== row.id || uid !== OWNER_UUID || row.status !== "pending" || Date.parse(row.expiresAt) <= NOW * 1000) return null;
		row.status = "approved";
		row.notes = notes ?? null;
		return { decisionId: row.id, actionId: row.actionId, input: row.input, inputSha256: row.inputSha256, caller: "mcp", userId: uid };
	});
	const finish = vi.fn(async (_id: string, res: any) => { row.status = typeof res === "string" ? res : (res.outcome ?? res.status ?? "executed"); });
	const reject = vi.fn(async (id: string, uid: string, notes?: string | null) => (id === row.id && uid === OWNER_UUID && row.status === "pending" ? ((row.status = "rejected"), (row.notes = notes ?? null), true) : false));
	const store: ActionApprovalLifecycleStore = { park: vi.fn(), claim, finish, reject };
	const fetchMock = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ ok: true }) })) as unknown as typeof fetch;
	const getDecisionState = async (id: string) => (id === row.id ? { status: row.status, expiresAt: row.expiresAt } : null);
	return { row, store, claim, reject, fetchMock, getDecisionState };
}

const makeApp = (opts: SlackInteractiveOptions) => express().use("/webhooks/slack/interactive", slackInteractiveRouter({ signingSecret: SECRET, allowedTeamIds: ["T_OK"], ownerId: OWNER_UUID, slackOwnerUserId: "U_OWNER_1", botToken: "test-slack-b-token", nowSec: () => NOW, ...opts }));
const post = (app: express.Express, payload: SlackInteractivePayload, sig?: string | null) => {
	const raw = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
	const req = request(app).post("/webhooks/slack/interactive").set("Content-Type", "application/x-www-form-urlencoded");
	return (sig === null ? req : req.set("X-Slack-Signature", sig ?? computeSlackSignature(SECRET, NOW, raw)).set("X-Slack-Request-Timestamp", String(NOW))).send(raw);
};
const card = (actionId: string, over: Partial<SlackInteractivePayload> = {}): SlackInteractivePayload => ({
	type: "block_actions", team: { id: "T_OK" }, user: { id: "U_OWNER_1" }, channel: { id: "D_DM" },
	message: { ts: "1760000000.1", blocks: [{ type: "header", text: { type: "plain_text", text: "Waiting" } }, { type: "actions", elements: [{ type: "button", action_id: actionId, value: "dec-1" }] }] },
	actions: [{ action_id: actionId, value: "dec-1" }], ...over,
});

describe("POST /webhooks/slack/interactive (#1544)", () => {
	it("1. returns HTTP 401 on missing or bad Slack signature and leaves store untouched", async () => {
		const fx = makeFixture();
		const app = makeApp({ store: fx.store, fetch: fx.fetchMock });
		expect((await post(app, card(SLACK_APPROVAL_APPROVE_ACTION_ID), null)).status).toBe(401);
		expect((await post(app, card(SLACK_APPROVAL_APPROVE_ACTION_ID), `v0=${"0".repeat(64)}`)).status).toBe(401);
		expect(fx.claim).not.toHaveBeenCalled();
	});

	it("2. refuses team outside SLACK_ALLOWED_TEAM_IDS or when SLACK_ALLOWED_TEAM_IDS is unset", async () => {
		const fx = makeFixture();
		expect((await post(makeApp({ store: fx.store, allowedTeamIds: ["T_OK"] }), card(SLACK_APPROVAL_APPROVE_ACTION_ID, { team: { id: "T_BAD" } }))).status).toBe(403);
		expect((await post(makeApp({ store: fx.store, allowedTeamIds: null }), card(SLACK_APPROVAL_APPROVE_ACTION_ID))).status).toBe(403);
		expect(fx.claim).not.toHaveBeenCalled();
	});

	it("3. answers 200 with ephemeral 'only the owner can approve' when clicking user is not owner_user_id", async () => {
		const fx = makeFixture();
		const res = await post(makeApp({ store: fx.store, fetch: fx.fetchMock }), card(SLACK_APPROVAL_APPROVE_ACTION_ID, { user: { id: "U_OTHER" } }));
		expect(res.status).toBe(200);
		expect(res.body).toMatchObject({ response_type: "ephemeral", text: expect.stringContaining("only the owner can approve") });
		expect(fx.claim).not.toHaveBeenCalled();
	});

	it("4. owner approve calls executeApproved once with decision_id and via: 'slack', updates card, and answers 'already claimed' on duplicate click", async () => {
		const fx = makeFixture();
		fx.row.inputSha256 = await inputSha256(fx.row.input);
		const runner = vi.fn(async () => ({ sent: true }));
		const execSpy = vi.fn(executeApproved);
		const app = makeApp({ store: fx.store, fetch: fx.fetchMock, executeApproved: execSpy, resolve: () => runner, getDecisionState: fx.getDecisionState });
		expect((await post(app, card(SLACK_APPROVAL_APPROVE_ACTION_ID))).status).toBe(200);
		expect(execSpy).toHaveBeenCalledWith("dec-1", expect.objectContaining({ approvedBy: { userId: OWNER_UUID, via: "slack" } }));
		expect(runner).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String((fx.fetchMock as any).mock.calls[0][1].body)).blocks.filter((b: any) => b.type === "actions")).toEqual([]);
		expect((await post(app, card(SLACK_APPROVAL_APPROVE_ACTION_ID))).body.text).toContain("already claimed");
		expect(execSpy).toHaveBeenCalledTimes(1);
	});

	it("5. owner reject calls store.reject once and updates card via chat.update with buttons removed", async () => {
		const fx = makeFixture();
		expect((await post(makeApp({ store: fx.store, fetch: fx.fetchMock, getDecisionState: fx.getDecisionState }), card(SLACK_APPROVAL_REJECT_ACTION_ID))).status).toBe(200);
		expect(fx.reject).toHaveBeenCalledWith("dec-1", OWNER_UUID, "rejected in slack");
		const [url, init] = (fx.fetchMock as any).mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://slack.com/api/chat.update");
		expect(JSON.parse(String(init.body)).blocks.filter((b: any) => b.type === "actions")).toEqual([]);
	});

	it("6. expired decision row answers 'already expired' and never runs", async () => {
		const fx = makeFixture(new Date((NOW - 60) * 1000).toISOString());
		const execSpy = vi.fn(executeApproved);
		const res = await post(makeApp({ store: fx.store, fetch: fx.fetchMock, executeApproved: execSpy, getDecisionState: fx.getDecisionState }), card(SLACK_APPROVAL_APPROVE_ACTION_ID));
		expect(res.body.text).toContain("already expired");
		expect(execSpy).not.toHaveBeenCalled();
		expect(fx.claim).not.toHaveBeenCalled();
	});
});
