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

describe("drive_delete and drive_unshare migration (#1496)", () => {
	it("serves drive_delete and drive_unshare from the registry with dev's exact contract and removes them from legacy baseline and LEGACY_GATES", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		for (const id of ["drive_delete", "drive_unshare"]) {
			expect(manifest.actions[id]?.expose).toEqual({
				mcp: true,
				http: true,
				ui_agent: true,
				worker: true,
				cli: false,
				a2a: false,
			});
			expect(serverRegistry().get(id)).toBeDefined();
		}
		expect(serverRegistry().get("drive_delete")?.needsApproval).toBe(true);
		expect(serverRegistry().get("drive_unshare")?.needsApproval).toBeUndefined();
		expect("drive_delete" in LEGACY_GATES).toBe(false);

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("drive_delete");
		expect(baseline).not.toContain("drive_unshare");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const deleteTool = tools.find((t) => t.name === "drive_delete")!;
		expect(deleteTool?.description).toBe(
			"Permanently delete a Google Drive file/folder, bypassing Trash (not recoverable). Parks for the owner's approval on every agent call.",
		);
		expect(deleteTool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		const deleteProps = (deleteTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(deleteProps).sort()).toEqual(["account", "domain", "file_id"]);
		expect(deleteTool.inputSchema.required).toEqual(["file_id"]);
		expect(deleteProps.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "File or folder id to permanently delete.",
		});
		expect(deleteProps.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(deleteProps.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});

		const unshareTool = tools.find((t) => t.name === "drive_unshare")!;
		expect(unshareTool?.description).toBe(
			"Revoke a sharing permission from a Google Drive file/folder by permission id.",
		);
		expect(unshareTool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const unshareProps = (unshareTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(unshareProps).sort()).toEqual(["account", "domain", "file_id", "permission_id"]);
		expect(unshareTool.inputSchema.required).toEqual(["file_id", "permission_id"]);
		expect(unshareProps.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "File or folder id to revoke access on.",
		});
		expect(unshareProps.permission_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Permission id to remove (from drive_list_permissions).",
		});
	});

	it("parks drive_delete on MCP call and executes on approval, while drive_unshare executes immediately without parking", async () => {
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
				const idx = Number(decisionId.replace("dec-", "")) - 1;
				const req = parked[idx];
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

		const deleteCalls: Array<{ method: string; url: URL }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				deleteCalls.push({ method: String(init?.method ?? "GET"), url });
				return new Response(null, { status: 204 });
			}),
		);

		const { client } = await connectClient();
		const deleteMcpOut = await client.callTool({
			name: "drive_delete",
			arguments: { file_id: "f-99", confirm: true },
		});
		const unshareMcpOut = await client.callTool({
			name: "drive_unshare",
			arguments: { file_id: "f-99", permission_id: "perm-7", domain: "work" },
		});
		await client.close();

		expect(deleteMcpOut.isError).toBeUndefined();
		const deleteLines = ((deleteMcpOut.content as any)[0] as any).text.split("\n");
		expect(JSON.parse(deleteLines[0])).toEqual({
			status: "pending_approval",
			decision_id: "dec-1",
			action_id: "drive_delete",
		});
		expect(parked).toHaveLength(1);
		expect(parked[0]?.actionId).toBe("drive_delete");
		expect(parked[0]?.input).toEqual({ file_id: "f-99" });

		// Only drive_unshare has called the Drive API so far
		expect(deleteCalls).toHaveLength(1);
		expect(deleteCalls[0]?.method).toBe("DELETE");
		expect(deleteCalls[0]?.url.pathname).toBe("/drive/v3/files/f-99/permissions/perm-7");
		expect(deleteCalls[0]?.url.searchParams.get("supportsAllDrives")).toBe("true");
		expect(unshareMcpOut.isError).toBeUndefined();
		expect(((unshareMcpOut.content as any)[0] as any).text).toBe(
			"Revoked permission perm-7 on f-99.",
		);

		// Now execute the parked drive_delete via executeApproved
		const approvedOut = await executeApproved("dec-1", {
			store: lifecycleStore,
			resolve: inboxActionResolver,
			approvedBy: { userId: DEFAULT_USER_ID, via: "web_inbox" },
		});
		expect(approvedOut).toEqual({
			status: "executed",
			result: { domain: "angus", file_id: "f-99", deleted: true },
		});
		expect(deleteCalls).toHaveLength(2);
		expect(deleteCalls[1]?.method).toBe("DELETE");
		expect(deleteCalls[1]?.url.pathname).toBe("/drive/v3/files/f-99");
		expect(deleteCalls[1]?.url.searchParams.get("supportsAllDrives")).toBe("true");
		expect(serverRegistry().get("drive_delete")!.formatMcp!((approvedOut as any).result)).toBe(
			"Permanently deleted f-99 (not recoverable).",
		);
	});
});
