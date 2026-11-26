import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	DRAFT_FIELDS,
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "@ahkms/core";
import { executeApproved } from "@ahkms/core/actions";

const captureMock = vi.hoisted(() =>
	vi.fn(async () => ({
		id: "artifact-123",
		storage_path: "u/email.md",
		content_type: "text",
		content_subtype: "email_sent",
		surface: "act_receipt",
		captured_at: "2026-10-12T00:00:00Z",
		captured_at_declared: false,
		embedded: false,
	})),
);

vi.mock("../../google/oauth.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../google/oauth.js")>();
	const { getCredential } = await import("../../credentials.js");
	const { GOOGLE_ACCOUNT_PROVIDER, DEFAULT_GOOGLE_ACCOUNT } = await import(
		"../../google/accounts.js"
	);
	return {
		...actual,
		getGoogleAccessToken: vi.fn(
			async (account: "personal" | "work" = DEFAULT_GOOGLE_ACCOUNT) => {
				const rt = await getCredential(GOOGLE_ACCOUNT_PROVIDER[account]);
				return `at-${rt}`;
			},
		),
	};
});

vi.mock("@ahkms/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ahkms/core")>();
	return {
		...actual,
		createCoreArtifactsPort: () => ({
			capture: captureMock,
			documentDuplicates: vi.fn(),
		}),
	};
});

import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { inboxActionResolver } from "../../actions/approvals.js";
import { LEGACY_GATES } from "../../actions/legacyGates.js";
import { resetOwnerAddressesForTests } from "../../google/gmail.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const require = createRequire(import.meta.url);
const b64url = (s: string) => Buffer.from(s, "utf-8").toString("base64url");
const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000000";

afterEach(() => {
	setActionApprovalStore(undefined);
	resetOwnerAddressesForTests();
	captureMock.mockClear();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

async function connectClient() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	return { client, server };
}

describe("gmail_send_draft migration (#1578)", () => {
	it("serves gmail_send_draft from the registry with dev's exact contract and removes it from legacy baseline and LEGACY_GATES", async () => {
		const manifest = require("@ahkms/core/action-manifest.json");
		expect(manifest.actions.gmail_send_draft?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("gmail_send_draft")).toBeDefined();
		expect(typeof serverRegistry().get("gmail_send_draft")?.needsApproval).toBe("function");
		expect("gmail_send_draft" in LEGACY_GATES).toBe(false);

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("gmail_send_draft");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "gmail_send_draft")!;
		expect(tool?.description).toBe(
			"Send an existing draft by id. Irreversible. Cannot compose; every send passes through a mailbox draft first (use gmail_draft to make one), and the sent message is captured. Parks for the owner's approval unless every recipient is one of the owner's own addresses. Full notes: docs/guides/tools/gmail_send_draft.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props).sort()).toEqual(["account", "domain", "draft_id"]);
		expect(tool.inputSchema.required).toEqual(["draft_id"]);
		expect(props.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'). Which Google account to send AS: personal | work.",
		});
		expect(props.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});
		expect(props.draft_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "The draft to send, from gmail_draft or from Gmail's own draft list.",
		});
	});

	it("sends owner-only drafts immediately with byte-for-byte text parity and parks outside recipients until approved", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const parked: ApprovalRequest[] = [];
		const lifecycleStore: ActionApprovalLifecycleStore = {
			park: vi.fn(async (req: ApprovalRequest) => {
				parked.push(req);
				return { decisionId: `dec-${parked.length}` };
			}),
			claim: vi.fn(async (decisionId: string) => {
				const req = parked[Number(decisionId.replace("dec-", "")) - 1];
				return req
					? {
							decisionId,
							actionId: req.actionId,
							input: req.input,
							inputSha256: req.inputSha256,
							caller: req.caller,
							userId: req.userId ?? DEFAULT_USER_ID,
						}
					: null;
			}),
			finish: vi.fn(async () => {}),
			reject: vi.fn(async () => true),
		};
		setActionApprovalStore(lifecycleStore);

		const seenCalls: { url: URL; method: string }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					const rt = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
					return new Response(JSON.stringify({ access_token: `at-${rt}` }), { status: 200 });
				}
				const method = init?.method ?? "GET";
				const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
				seenCalls.push({ url, method });
				if (url.pathname.endsWith("/profile")) {
					const emailAddress = auth.includes("rt-work-val")
						? "owner@work.example.com"
						: "owner@example.com";
					return new Response(JSON.stringify({ emailAddress, messagesTotal: 10 }), { status: 200 });
				}
				if (url.pathname.endsWith("/drafts/send") && method === "POST") {
					return new Response(JSON.stringify({ id: "m10", threadId: "t1" }), { status: 200 });
				}
				const to = url.pathname.endsWith("/drafts/d-ext") ? "her@example.com" : "owner@work.example.com";
				return new Response(
					JSON.stringify({
						id: url.pathname.split("/").pop(),
						message: {
							id: "m9",
							threadId: "t1",
							payload: {
								mimeType: "text/plain",
								headers: [
									{ name: "To", value: to },
									{ name: "Subject", value: "Budget" },
								],
								body: { data: b64url("sure") },
							},
						},
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const selfOut = await client.callTool({
			name: "gmail_send_draft",
			arguments: { account: "work", draft_id: "d1" },
		});
		expect(selfOut.isError).toBeFalsy();
		expect(parked).toHaveLength(0);
		expect(
			seenCalls.some(
				(c) =>
					c.url.pathname.endsWith("/drafts/d1") &&
					c.url.searchParams.get("format") === "metadata" &&
					c.url.searchParams.get("fields") === "id,message(id,threadId,payload(headers))",
			),
		).toBe(true);
		expect(
			seenCalls.some(
				(c) =>
					c.url.pathname.endsWith("/drafts/d1") &&
					c.url.searchParams.get("format") === "full" &&
					c.url.searchParams.get("fields") === DRAFT_FIELDS,
			),
		).toBe(true);
		expect(((selfOut.content as any)[0] as any).text).toBe(
			[
				"Sent draft d1 from the 'work' mailbox. This cannot be undone.",
				"To: owner@work.example.com",
				"Subject: Budget",
				"Message m10 in thread t1.",
				"Captured as artifact artifact-123 (content_subtype='email_sent').",
			].join("\n"),
		);

		seenCalls.length = 0;
		const extOut = await client.callTool({
			name: "gmail_send_draft",
			arguments: { account: "personal", draft_id: "d-ext" },
		});
		await client.close();

		expect(extOut.isError).toBeUndefined();
		expect(JSON.parse(((extOut.content as any)[0] as any).text.split("\n")[0])).toEqual({
			status: "pending_approval",
			decision_id: "dec-1",
			action_id: "gmail_send_draft",
		});
		expect(seenCalls.some((c) => c.url.pathname.endsWith("/drafts/send"))).toBe(false);

		const approved = await executeApproved("dec-1", {
			store: lifecycleStore,
			resolve: inboxActionResolver,
			approvedBy: { userId: DEFAULT_USER_ID, via: "web_inbox" },
		});
		expect(approved.status).toBe("executed");
		expect(seenCalls.some((c) => c.url.pathname.endsWith("/drafts/send"))).toBe(true);
	});
});
