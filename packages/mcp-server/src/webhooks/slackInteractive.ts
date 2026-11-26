import type { SupabaseClient } from "@supabase/supabase-js";
import express from "express";
import { getActionApprovalStore, type ActionApprovalLifecycleStore } from "@ahkms/core";
import { ApprovalConflictError, executeApproved, rejectApproval, type ApprovedRunner, type ExecuteApprovedDeps, type ExecuteApprovedResult } from "@ahkms/core/actions";
import { SLACK_APPROVAL_APPROVE_ACTION_ID, SLACK_APPROVAL_REJECT_ACTION_ID, resolveSlackOwnerUserId, updateSlackApprovalCard } from "@ahkms/core/adapters";
import { getConfiguredApprovalStore, inboxActionResolver } from "../actions/approvals.js";
import type { LoginRateLimiter } from "../auth/loginRateLimiter.js";
import { verifySlackSignature } from "../automations/slackSignature.js";
import { getCredential } from "../credentials.js";
import { env } from "../env.js";
import { getCurrentUserId } from "../identity.js";
import { supabase } from "../supabase.js";
import { createWebhookLimiter, recordAuthFailure, rejectIfLockedOut, webhookErrorHandler } from "./webhookGuards.js";

export type DecisionState = { status: string; expiresAt: string | null };
export interface SlackInteractivePayload {
	type?: string;
	team?: { id?: string };
	user?: { id?: string; team_id?: string };
	channel?: { id?: string };
	container?: { channel_id?: string; message_ts?: string };
	message?: { ts?: string; blocks?: Array<Record<string, unknown>> };
	response_url?: string;
	actions?: Array<{ action_id?: string; value?: string }>;
}
export interface SlackInteractiveOptions {
	signingSecret?: string | null;
	allowedTeamIds?: string[] | null;
	ownerId?: string;
	slackOwnerUserId?: string | null | ((userId: string) => string | null | Promise<string | null>);
	botToken?: string | null;
	store?: ActionApprovalLifecycleStore;
	resolve?: (actionId: string) => ApprovedRunner | undefined;
	executeApproved?: (decisionId: string, deps: ExecuteApprovedDeps) => Promise<ExecuteApprovedResult>;
	supabaseClient?: Pick<SupabaseClient, "from">;
	getDecisionState?: (decisionId: string, userId: string) => Promise<DecisionState | null>;
	nowSec?: () => number;
	rateLimiter?: LoginRateLimiter;
	fetch?: typeof globalThis.fetch;
}

async function queryDecisionState(client: Pick<SupabaseClient, "from">, id: string, userId: string): Promise<DecisionState | null> {
	const q = (client.from("system_decisions") as any)?.select?.("status, expires_at")?.eq?.("id", id)?.eq?.("decision_type", "action_approval")?.eq?.("user_id", userId);
	if (typeof q?.maybeSingle !== "function") return null;
	const { data, error } = await q.maybeSingle();
	return error || !data ? null : { status: String(data.status ?? ""), expiresAt: typeof data.expires_at === "string" ? data.expires_at : null };
}

export function slackInteractiveRouter(opts: SlackInteractiveOptions = {}): express.Router {
	const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
	const limiter = opts.rateLimiter ?? createWebhookLimiter();
	const router = express.Router();
	router.use(rejectIfLockedOut(limiter));
	type RawReq = express.Request & { rawBody?: Buffer };
	const saveRaw = (req: express.Request, _res: express.Response, buf: Buffer) => { (req as RawReq).rawBody = buf; };
	const replyEphemeral = async (res: express.Response, responseUrl: string | undefined, text: string) => {
		const body = { response_type: "ephemeral", replace_original: false, text };
		if (responseUrl?.startsWith("https://")) {
			await (opts.fetch ?? globalThis.fetch)(responseUrl, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, body: JSON.stringify(body) }).catch((e) => console.error("[approval:slack] response_url failed:", e));
		}
		res.status(200).json(body);
	};

	router.post("/", express.urlencoded({ extended: false, verify: saveRaw }), express.json({ verify: saveRaw }), async (req, res, next) => {
		try {
			const secret = opts.signingSecret !== undefined ? opts.signingSecret : env.slackSigningSecret;
			const rawBody = (req as RawReq).rawBody;
			if (!secret || !rawBody || !verifySlackSignature(secret, rawBody, req.header("x-slack-signature"), req.header("x-slack-request-timestamp"), nowSec())) {
				recordAuthFailure(limiter, req);
				return void res.status(401).json({ error: "invalid signature" });
			}
			let payload: SlackInteractivePayload;
			try { payload = typeof req.body?.payload === "string" ? JSON.parse(req.body.payload) : (req.body?.payload ?? req.body ?? {}); }
			catch { return void res.status(400).json({ error: "invalid payload" }); }

			const allowed = opts.allowedTeamIds !== undefined ? opts.allowedTeamIds : env.slackAllowedTeamIds;
			const teamId = payload.team?.id ?? payload.user?.team_id ?? "";
			if (!allowed?.length || !teamId || !allowed.includes(teamId)) return void res.status(403).json({ error: "team not allowed" });

			const ahosUserId = opts.ownerId ?? getCurrentUserId();
			const client = opts.supabaseClient ?? supabase;
			const slackOwnerId = opts.slackOwnerUserId !== undefined ? await (typeof opts.slackOwnerUserId === "function" ? opts.slackOwnerUserId(ahosUserId) : opts.slackOwnerUserId) : await resolveSlackOwnerUserId(client, ahosUserId);
			if (!slackOwnerId || payload.user?.id !== slackOwnerId) return await replyEphemeral(res, payload.response_url, "only the owner can approve or reject this request.");

			const action = Array.isArray(payload.actions) ? payload.actions[0] : undefined;
			if (action?.action_id !== SLACK_APPROVAL_APPROVE_ACTION_ID && action?.action_id !== SLACK_APPROVAL_REJECT_ACTION_ID) return void res.status(200).json({ ok: true });
			const decisionId = typeof action.value === "string" ? action.value.trim() : "";
			if (!decisionId) return void res.status(400).json({ error: "missing decision_id" });

			const active = getActionApprovalStore() as Partial<ActionApprovalLifecycleStore> | undefined;
			const store = opts.store ?? getConfiguredApprovalStore() ?? (typeof active?.claim === "function" ? (active as ActionApprovalLifecycleStore) : undefined);
			if (!store) return void res.status(503).json({ error: "no approval store is configured" });

			const updateCard = async (outcomeText: string) => {
				const channel = payload.channel?.id ?? payload.container?.channel_id ?? "";
				const ts = payload.message?.ts ?? payload.container?.message_ts ?? "";
				const botToken = opts.botToken !== undefined ? opts.botToken : await getCredential("slack_bot").catch(() => null);
				if (botToken && channel && ts) await updateSlackApprovalCard({ botToken, channel, ts, decisionId, outcomeText, existingBlocks: Array.isArray(payload.message?.blocks) ? payload.message.blocks : undefined, fetch: opts.fetch }).catch((e) => console.error("[approval:slack] chat.update failed:", e));
			};
			const checkState = opts.getDecisionState ?? ((id: string, uid: string) => queryDecisionState(client, id, uid));
			const isExpired = (st: DecisionState | null) => Boolean(st && (st.status === "expired" || (st.expiresAt && Date.parse(st.expiresAt) <= nowSec() * 1000)));
			const replyConflict = async (st: DecisionState | null) => {
				const msg = isExpired(st) ? "Decision already expired." : "Decision already claimed.";
				await updateCard(msg);
				await replyEphemeral(res, payload.response_url, msg);
			};
			const pre = await checkState(decisionId, ahosUserId);
			if (isExpired(pre) || (pre && pre.status !== "pending")) return await replyConflict(pre);

			try {
				if (action.action_id === SLACK_APPROVAL_APPROVE_ACTION_ID) {
					const out = await (opts.executeApproved ?? executeApproved)(decisionId, { store, resolve: opts.resolve ?? inboxActionResolver, approvedBy: { userId: ahosUserId, via: "slack" } });
					await updateCard(out.status === "executed" ? "Approved and executed in Slack." : `Approved in Slack (failed: ${out.error}).`);
					return void res.status(200).json({ ok: true, ...out, decision_id: decisionId });
				}
				await rejectApproval(decisionId, { store, userId: ahosUserId, notes: "rejected in slack" });
				await updateCard("Rejected in Slack.");
				res.status(200).json({ ok: true, status: "rejected", decision_id: decisionId });
			} catch (err) {
				if (err instanceof ApprovalConflictError) return await replyConflict(await checkState(decisionId, ahosUserId));
				throw err;
			}
		} catch (err) { next(err); }
	});
	router.use((err: unknown, req: express.Request, _res: express.Response, next: express.NextFunction) => { recordAuthFailure(limiter, req); next(err); });
	router.use(webhookErrorHandler);
	return router;
}
