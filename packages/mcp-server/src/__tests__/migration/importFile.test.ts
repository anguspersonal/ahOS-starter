import { afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
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
import { supabase } from "../../supabase.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const require = createRequire(import.meta.url);
const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000000";
const FIXED_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const origFrom = supabase.from;
const origStorageFrom = supabase.storage.from;

afterEach(() => {
	(supabase as any).from = origFrom;
	(supabase.storage as any).from = origStorageFrom;
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

describe("drive_import_file migration (#1613)", () => {
	it("serves drive_import_file from the registry with dev's exact contract and removes it from legacy baseline and LEGACY_GATES", async () => {
		const manifest = require("@ahkms/core/action-manifest.json");
		expect(manifest.actions.drive_import_file?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("drive_import_file")).toBeDefined();
		expect(typeof serverRegistry().get("drive_import_file")?.needsApproval).toBe("function");
		expect("drive_import_file" in LEGACY_GATES).toBe(false);

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("drive_import_file");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const tool = tools.find((t) => t.name === "drive_import_file")!;
		expect(tool?.description).toBe(
			"Import a Google Drive file into the knowledge store: downloads or exports it to Storage and " +
				"creates a searchable artifact (run artifact_extract_text afterwards for PDFs and images). Cleanup " +
				"on the Drive original runs only after the artifact is persisted. Parks for the owner's approval " +
				"when cleanup is 'delete'. Full notes: docs/guides/tools/drive_import_file.md",
		);
		expect(tool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		});
		const props = (tool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(props).sort()).toEqual([
			"account",
			"cleanup",
			"domain",
			"file_id",
			"tags",
			"title",
		]);
		expect(tool.inputSchema.required).toEqual(["file_id"]);
		expect(props.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Drive file id to import into the knowledge store.",
		});
		expect(props.title).toMatchObject({
			type: "string",
			description:
				"Optional human-friendly title for the artifact, e.g. the semantic rename 'YYYY-MM-DD Issuer What (ref)'. Defaults to the Drive file name. When cleanup is 'move' or 'delete', also renames the Drive file to this value before the cleanup action.",
		});
		expect(props.cleanup).toMatchObject({
			type: "string",
			enum: ["none", "move", "delete"],
			description:
				"What to do with the Drive original after the artifact is confirmed persisted. 'none' (default): leave untouched. 'move': move to a 'Sorted/' subfolder of the file's parent (creates it if missing). 'delete': permanently delete (bypasses Trash, not recoverable).",
		});
		expect(props.tags).toMatchObject({
			type: "array",
			items: { type: "string" },
			description: "Optional tags for the artifact.",
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
	});

	it("runs cleanup='none' immediately with byte-for-byte parity, and parks cleanup='delete' before any import until approved", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
		vi.stubEnv("KMS_USER_ID", DEFAULT_USER_ID);
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(FIXED_UUID);

		const uploads: string[] = [];
		const inserts: Record<string, unknown>[] = [];
		(supabase.storage as any).from = vi.fn(() => ({
			upload: vi.fn(async (path: string) => {
				uploads.push(path);
				return { error: null };
			}),
			remove: vi.fn(async () => ({ error: null })),
		}));
		(supabase as any).from = vi.fn((table: string) => {
			if (table !== "artifacts") throw new Error(`Unexpected table: ${table}`);
			return {
				insert: (row: Record<string, unknown>) => {
					inserts.push(row);
					return {
						select: () => ({
							single: async () => ({
								data: { id: row.id, title: row.title, created_at: "2026-08-22T00:00:00Z" },
								error: null,
							}),
						}),
					};
				},
			};
		});

		const driveCalls: Array<{ method: string; url: URL }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				const method = String(init?.method ?? "GET");
				driveCalls.push({ method, url });
				if (method === "DELETE") return new Response(null, { status: 204 });
				if (url.searchParams.get("alt") === "media") {
					return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200 });
				}
				return new Response(
					JSON.stringify({
						id: "f-42",
						name: "Receipt.pdf",
						mimeType: "application/pdf",
						webViewLink: "https://drive.google.com/file/d/f-42/view",
						parents: [],
						createdTime: "2025-01-15T12:00:00.000Z",
					}),
					{ status: 200 },
				);
			}),
		);

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

		const { client } = await connectClient();

		// 1) cleanup="delete" parks before any Drive, Storage, or DB call
		const parkedRes = await client.callTool({
			name: "drive_import_file",
			arguments: { file_id: "f-42", cleanup: "delete" },
		});
		expect(parkedRes.isError).toBeUndefined();
		expect(JSON.parse(((parkedRes.content as any)[0] as any).text.split("\n")[0])).toEqual({
			status: "pending_approval",
			decision_id: "dec-1",
			action_id: "drive_import_file",
		});
		expect(driveCalls).toHaveLength(0);
		expect(uploads).toHaveLength(0);
		expect(inserts).toHaveLength(0);

		// 2) cleanup omitted runs immediately
		const okRes = await client.callTool({
			name: "drive_import_file",
			arguments: { file_id: "f-42" },
		});
		await client.close();

		expect(okRes.isError).toBeFalsy();
		expect(((okRes.content as any)[0] as any).text).toBe(
			`Imported "Receipt.pdf" from Drive as artifact ${FIXED_UUID}.\n` +
				`Stored 4 bytes (application/pdf) at user-uploads/drive-imports/${DEFAULT_USER_ID}/${FIXED_UUID}.pdf.\n` +
				"Binary stored \u2014 call artifact_extract_text with this id to make it searchable.",
		);

		// 3) Approving dec-1 executes the parked import + delete
		const approvedOut = await executeApproved("dec-1", {
			store: lifecycleStore,
			resolve: inboxActionResolver,
			approvedBy: { userId: DEFAULT_USER_ID, via: "web_inbox" },
		});
		expect(approvedOut.status).toBe("executed");
		expect(driveCalls.some((c) => c.method === "DELETE" && c.url.pathname === "/drive/v3/files/f-42")).toBe(
			true,
		);
	});
});
