import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
	setActionApprovalStore,
	type ActionApprovalLifecycleStore,
	type ApprovalRequest,
} from "@ahkms/core";
import { executeApproved } from "@ahkms/core/actions";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { inboxActionResolver } from "../../actions/approvals.js";
import { LEGACY_GATES } from "../../actions/legacyGates.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000000";

afterEach(() => {
	setActionApprovalStore(undefined);
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

describe("drive_share migration (#1505)", () => {
	it("serves drive_share from the registry with dev's exact contract and removes it from legacy baseline and LEGACY_GATES", async () => {
		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const shareTool = tools.find((t) => t.name === "drive_share")!;
		expect(shareTool?.description).toBe(
			'Share a Google Drive file/folder: grant a role to a user, group, domain, or anyone. role: "owner" transfers ownership; type: "anyone" publishes to anyone with the link. Parks for the owner\'s approval when type is "anyone" or "domain", or role is "owner".',
		);
		expect(shareTool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: true,
		});
		const props = (shareTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"domain",
			"email_address",
			"file_id",
			"grantee_domain",
			"role",
			"send_notification",
			"type",
		]);
		expect(shareTool.inputSchema.required).toEqual(["file_id", "role", "type"]);
		expect(props.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "File or folder id to share.",
		});
		expect(props.role).toMatchObject({
			type: "string",
			enum: ["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"],
			description: "Access level to grant.",
		});
		expect(props.type).toMatchObject({
			type: "string",
			enum: ["user", "group", "domain", "anyone"],
			description: "Grantee type. Use 'anyone' for link sharing.",
		});
		expect(props.email_address).toMatchObject({
			type: "string",
			format: "email",
			description: "Required for type 'user' or 'group'.",
		});
		expect(props.grantee_domain).toMatchObject({
			type: "string",
			description:
				"Required for type 'domain' (e.g. 'example.com'). The Workspace domain to grant access TO \u2014 not `domain`, which selects the account acting.",
		});
		expect(props.send_notification).toMatchObject({
			type: "boolean",
			description: "Email the grantee (default false; ignored for anyone/domain).",
		});
		expect(props.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(props.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});

		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.drive_share?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("drive_share")).toBeDefined();
		expect(typeof serverRegistry().get("drive_share")?.needsApproval).toBe("function");
		expect("drive_share" in LEGACY_GATES).toBe(false);

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("drive_share");
	});

	it("executes user/reader immediately, refuses invalid domain/user calls before parking, and parks anyone/reader until approved", async () => {
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
				if (!req) return null;
				return {
					decisionId,
					actionId: req.actionId,
					input: req.input,
					inputSha256: req.inputSha256,
					caller: req.caller,
					userId: req.userId ?? DEFAULT_USER_ID,
				};
			}),
			finish: vi.fn(async () => {}),
			reject: vi.fn(async () => true),
		};
		setActionApprovalStore(lifecycleStore);

		const driveCalls: Array<{ method: string; url: URL; body: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				const body = String(init?.body ?? "{}");
				driveCalls.push({ method: String(init?.method ?? "GET"), url, body });
				const parsed = JSON.parse(body);
				return new Response(
					JSON.stringify({
						id: `perm-${driveCalls.length}`,
						role: parsed.role,
						type: parsed.type,
						emailAddress: parsed.emailAddress,
						domain: parsed.domain,
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const invalidDomain = await client.callTool({
			name: "drive_share",
			arguments: { file_id: "f-10", type: "domain", role: "reader" },
		});
		const userShare = await client.callTool({
			name: "drive_share",
			arguments: {
				file_id: "f-10",
				type: "user",
				role: "reader",
				email_address: "alice@example.com",
				domain: "work",
			},
		});
		const parkedAnyone = await client.callTool({
			name: "drive_share",
			arguments: { file_id: "f-10", type: "anyone", role: "reader" },
		});
		await client.close();

		expect(invalidDomain.isError).toBe(true);
		expect(((invalidDomain.content as any)[0] as any).text).toContain(
			"type 'domain' requires grantee_domain (the Workspace domain to grant access to, e.g. 'example.com').",
		);

		expect(userShare.isError).toBeFalsy();
		expect(((userShare.content as any)[0] as any).text).toBe(
			"Shared f-10: granted reader to alice@example.com (permission id perm-1).",
		);

		expect(parkedAnyone.isError).toBeUndefined();
		expect(JSON.parse(((parkedAnyone.content as any)[0] as any).text.split("\n")[0])).toEqual({
			status: "pending_approval",
			decision_id: "dec-1",
			action_id: "drive_share",
		});
		expect(parked).toHaveLength(1);
		expect(driveCalls).toHaveLength(1);

		const approvedOut = await executeApproved("dec-1", {
			store: lifecycleStore,
			resolve: inboxActionResolver,
			approvedBy: { userId: DEFAULT_USER_ID, via: "web_inbox" },
		});
		expect(approvedOut.status).toBe("executed");
		expect(driveCalls).toHaveLength(2);
		expect(serverRegistry().get("drive_share")!.formatMcp!((approvedOut as any).result)).toBe(
			"Shared f-10: granted reader to anyone (permission id perm-2).",
		);
	});
});
