import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApprovalNotifierFn } from "../../actions/approvalNotify.js";
import type { ApprovalRequest } from "../../actions/gate.js";

const DEFAULT_SLACK_API = "https://slack.com/api";
const MAX_INPUT_VALUE_CHARS = 200;
const MS_PER_DAY = 86_400_000;

export const SLACK_APPROVAL_APPROVE_ACTION_ID = "ahos_approval_approve";
export const SLACK_APPROVAL_REJECT_ACTION_ID = "ahos_approval_reject";

export type ValueOrResolver<T, TArg = void> = T | ((arg: TArg) => T | Promise<T>);

export interface SlackApprovalCardOptions {
	botToken: ValueOrResolver<string | null | undefined>;
	ownerUserId: ValueOrResolver<string | null | undefined, string | null>;
	webUrl?: ValueOrResolver<string | null | undefined>;
	baseUrl?: string;
	ttlDays?: number;
	now?: () => Date;
	fetch?: typeof globalThis.fetch;
	writeStderr?: (line: string) => void;
}

function defaultWriteStderr(line: string): void {
	if (typeof process !== "undefined" && process.stderr?.write) {
		process.stderr.write(line.endsWith("\n") ? line : `${line}\n`);
	}
}

async function resolveValue<T, TArg = void>(source: ValueOrResolver<T, TArg> | undefined, arg: TArg): Promise<T | undefined> {
	return typeof source === "function" ? await (source as (a: TArg) => T | Promise<T>)(arg) : source;
}

export function escapeSlackMrkdwn(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function formatApprovalInputValue(value: unknown): string {
	const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
	return escapeSlackMrkdwn(raw.length > MAX_INPUT_VALUE_CHARS ? raw.slice(0, MAX_INPUT_VALUE_CHARS) : raw);
}

export function buildSlackApprovalCardBlocks(
	request: ApprovalRequest,
	decisionId: string,
	options: { expiresDateUtc: string; webUrl?: string | null },
): Array<Record<string, unknown>> {
	const entries =
		request.input !== null && typeof request.input === "object" && !Array.isArray(request.input)
			? Object.entries(request.input as Record<string, unknown>)
			: [];
	const inputLines =
		entries.length > 0
			? entries.map(([k, v]) => `• *${escapeSlackMrkdwn(k)}*: ${formatApprovalInputValue(v)}`).join("\n")
			: "_No input parameters_";

	const blocks: Array<Record<string, unknown>> = [
		{ type: "header", text: { type: "plain_text", text: "Waiting for your approval" } },
		{
			type: "section",
			text: {
				type: "mrkdwn",
				text: [
					`*Action:* \`${escapeSlackMrkdwn(request.actionId)}\``,
					`*Caller:* \`${escapeSlackMrkdwn(request.caller || "unknown")}\` (client: \`${escapeSlackMrkdwn(request.clientId ?? "none")}\`)`,
					`*Decision ID:* \`${escapeSlackMrkdwn(decisionId)}\``,
					`*Expires (UTC):* \`${escapeSlackMrkdwn(options.expiresDateUtc)}\``,
				].join("\n"),
			},
		},
		{ type: "section", text: { type: "mrkdwn", text: `*Input:*\n${inputLines}` } },
	];

	const elements: Array<Record<string, unknown>> = [
		{ type: "button", action_id: SLACK_APPROVAL_APPROVE_ACTION_ID, style: "primary", text: { type: "plain_text", text: "Approve" }, value: decisionId },
		{ type: "button", action_id: SLACK_APPROVAL_REJECT_ACTION_ID, style: "danger", text: { type: "plain_text", text: "Reject" }, value: decisionId },
	];
	const webUrl = (options.webUrl ?? "").trim().replace(/\/+$/, "");
	if (webUrl) {
		elements.push({ type: "button", text: { type: "plain_text", text: "Open in Approvals" }, url: `${webUrl}/approvals` });
	}
	blocks.push({ type: "actions", elements });
	return blocks;
}

export async function updateSlackApprovalCard(args: {
	botToken: string;
	channel: string;
	ts: string;
	decisionId: string;
	outcomeText: string;
	existingBlocks?: ReadonlyArray<Record<string, unknown>>;
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
}): Promise<void> {
	const kept = (args.existingBlocks ?? []).filter((b) => b.type !== "actions");
	const base =
		kept.length > 0
			? kept.map((b) => (b.type === "header" ? { type: "header", text: { type: "plain_text", text: "Approval resolved" } } : b))
			: [{ type: "section", text: { type: "mrkdwn", text: `*Decision ID:* \`${escapeSlackMrkdwn(args.decisionId)}\`` } }];
	const blocks = [...base, { type: "context", elements: [{ type: "mrkdwn", text: escapeSlackMrkdwn(args.outcomeText) }] }];
	const res = await (args.fetch ?? globalThis.fetch)(`${(args.baseUrl ?? DEFAULT_SLACK_API).replace(/\/+$/, "")}/chat.update`, {
		method: "POST",
		headers: { Authorization: `Bearer ${args.botToken}`, "Content-Type": "application/json; charset=utf-8" },
		body: JSON.stringify({ channel: args.channel, ts: args.ts, text: args.outcomeText, blocks }),
	});
	const parsed: { ok?: boolean; error?: string } = await res.json().catch(() => ({}));
	if (!res.ok || !parsed.ok) {
		throw new Error(`Slack chat.update failed: ${parsed.error || res.statusText || "unknown_error"}`);
	}
}

export async function resolveSlackOwnerUserId(
	client: Pick<SupabaseClient, "from">,
	userId?: string | null,
): Promise<string | null> {
	const uid = (userId ?? "").trim();
	if (!uid) return null;
	try {
		const q = (client.from("user_integrations") as any)?.select?.("config, enabled")?.eq?.("user_id", uid)?.eq?.("provider", "slack");
		if (typeof q?.maybeSingle !== "function") return null;
		const { data, error } = await q.maybeSingle();
		if (error || !data || data.enabled === false) return null;
		const owner = data.config?.owner_user_id;
		return typeof owner === "string" && owner.trim() ? owner.trim() : null;
	} catch {
		return null;
	}
}

export function createSlackApprovalCardNotifier(
	options: SlackApprovalCardOptions,
): ApprovalNotifierFn & { notify: ApprovalNotifierFn } {
	const baseUrl = (options.baseUrl ?? DEFAULT_SLACK_API).replace(/\/+$/, "");
	const ttlDays = options.ttlDays ?? 7;
	const now = options.now ?? (() => new Date());
	const writeStderr = options.writeStderr ?? defaultWriteStderr;

	const notify: ApprovalNotifierFn = async (request, decisionId) => {
		const token = ((await resolveValue(options.botToken, undefined)) ?? "").trim();
		if (!token) return;
		const ownerUserId = ((await resolveValue(options.ownerUserId, request.userId)) ?? "").trim();
		if (!ownerUserId) {
			writeStderr(`[approval:slack] decisionId=${decisionId} approval cards off: no slack owner_user_id\n`);
			return;
		}
		const webUrl = options.webUrl !== undefined ? await resolveValue(options.webUrl, undefined) : process.env.AHOS_WEB_URL;
		const expiresDateUtc = new Date(now().getTime() + ttlDays * MS_PER_DAY).toISOString().slice(0, 10);
		const blocks = buildSlackApprovalCardBlocks(request, decisionId, { expiresDateUtc, webUrl: webUrl ?? null });
		const res = await (options.fetch ?? globalThis.fetch)(`${baseUrl}/chat.postMessage`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
			body: JSON.stringify({
				channel: ownerUserId,
				text: `Waiting for your approval: ${request.actionId} (decision ${decisionId})`,
				blocks,
			}),
		});
		const bodyText = await res.text().catch(() => "");
		let parsed: { ok?: boolean; error?: string; channel?: string; ts?: string } = {};
		try {
			if (bodyText) parsed = JSON.parse(bodyText);
		} catch {
			// non-json
		}
		if (!res.ok || !parsed.ok) {
			throw new Error(`Slack chat.postMessage failed: ${parsed.error || res.statusText || "unknown_error"}`);
		}
		writeStderr(`[approval:slack] decisionId=${decisionId} channel=${parsed.channel ?? ownerUserId} ts=${parsed.ts ?? ""}\n`);
	};
	return Object.assign(notify, { notify });
}
