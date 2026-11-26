import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FILE_FIELDS } from "@ahkms/core";
import { createServer } from "../../server.js";
import { serverRegistry } from "../../actions/serverRegistry.js";
import { readLegacyBaseline } from "../legacyBaseline.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");

afterEach(() => {
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

describe("drive_move migration (#1488)", () => {
	it("serves drive_move from the registry with dev's exact contract and removes it from legacy baseline", async () => {
		const manifest = JSON.parse(
			readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"),
		);
		expect(manifest.actions.drive_move?.expose).toEqual({
			mcp: true,
			http: true,
			ui_agent: true,
			worker: true,
			cli: false,
			a2a: false,
		});
		expect(serverRegistry().get("drive_move")).toBeDefined();

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("drive_move");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const moveTool = tools.find((t) => t.name === "drive_move")!;
		expect(moveTool?.description).toBe(
			"Move a Google Drive file or folder into a different parent folder.",
		);
		expect(moveTool.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const moveProps = (moveTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(moveProps).sort()).toEqual([
			"account",
			"domain",
			"file_id",
			"new_parent_id",
		]);
		expect(moveTool.inputSchema.required).toEqual(["file_id", "new_parent_id"]);
		expect(moveProps.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "File or folder id to move.",
		});
		expect(moveProps.new_parent_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Destination folder id.",
		});
		expect(moveProps.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(moveProps.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});
	});

	it("executes drive_move through MCP with byte-for-byte text parity, supportsAllDrives=true, and fields masks", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const driveCalls: Array<{ method: string; url: URL; body: string }> = [];
		let getCallIndex = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				const method = init?.method ?? "GET";
				const body = String(init?.body ?? "");
				driveCalls.push({ method, url, body });
				if (method === "GET") {
					getCallIndex += 1;
					const parents = getCallIndex === 1 ? ["old-parent-1"] : [];
					return new Response(JSON.stringify({ parents }), { status: 200 });
				}
				return new Response(
					JSON.stringify({
						id: "f-42",
						name: "Notes.md",
						mimeType: "text/markdown",
						size: "512",
						modifiedTime: "2026-10-12T08:00:00Z",
						parents: ["new-parent-2"],
						owners: [{ emailAddress: "owner@example.com" }],
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const moveWithParentOut = await client.callTool({
			name: "drive_move",
			arguments: { file_id: "f-42", new_parent_id: "new-parent-2" },
		});
		const moveWithoutParentOut = await client.callTool({
			name: "drive_move",
			arguments: { file_id: "f-42", new_parent_id: "new-parent-2", domain: "work" },
		});
		await client.close();

		expect([moveWithParentOut.isError, moveWithoutParentOut.isError]).toEqual([
			undefined,
			undefined,
		]);
		expect(
			driveCalls.map((c) => ({
				method: c.method,
				supportsAllDrives: c.url.searchParams.get("supportsAllDrives"),
				fields: c.url.searchParams.get("fields"),
				addParents: c.url.searchParams.get("addParents"),
				removeParents: c.url.searchParams.get("removeParents"),
			})),
		).toEqual([
			{
				method: "GET",
				supportsAllDrives: "true",
				fields: "parents",
				addParents: null,
				removeParents: null,
			},
			{
				method: "PATCH",
				supportsAllDrives: "true",
				fields: FILE_FIELDS,
				addParents: "new-parent-2",
				removeParents: "old-parent-1",
			},
			{
				method: "GET",
				supportsAllDrives: "true",
				fields: "parents",
				addParents: null,
				removeParents: null,
			},
			{
				method: "PATCH",
				supportsAllDrives: "true",
				fields: FILE_FIELDS,
				addParents: "new-parent-2",
				removeParents: null,
			},
		]);
		expect(((moveWithParentOut.content as any)[0] as any).text).toBe(
			"Moved:\n• [f-42] Notes.md (text/markdown, 512 bytes, modified 2026-10-12T08:00:00Z, owner owner@example.com)",
		);
		expect(((moveWithoutParentOut.content as any)[0] as any).text).toBe(
			"Moved:\n• [f-42] Notes.md (text/markdown, 512 bytes, modified 2026-10-12T08:00:00Z, owner owner@example.com)",
		);
	});
});
