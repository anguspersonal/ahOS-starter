import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FILE_FIELDS, PERMISSION_FIELDS } from "@ahkms/core";
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

describe("drive_get_metadata and drive_list_permissions migration (#1587)", () => {
	it("serves drive_get_metadata and drive_list_permissions from the registry with dev's exact contract and removes them from legacy baseline", async () => {
		const manifest = JSON.parse(readFileSync(resolve(repoRoot, "packages/core/action-manifest.json"), "utf-8"));
		for (const id of ["drive_get_metadata", "drive_list_permissions"]) {
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

		const baseline = readLegacyBaseline();
		expect(baseline).not.toContain("drive_get_metadata");
		expect(baseline).not.toContain("drive_list_permissions");

		const { client } = await connectClient();
		const { tools } = await client.listTools();
		await client.close();

		const metaTool = tools.find((t) => t.name === "drive_get_metadata")!;
		expect(metaTool?.description).toBe(
			"Get metadata for one Google Drive file (name, type, size, parents, link, sharing).",
		);
		expect(metaTool.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const metaProps = (metaTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(metaProps).sort()).toEqual(["account", "domain", "file_id"]);
		expect(metaTool.inputSchema.required).toEqual(["file_id"]);
		expect(metaProps.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Drive file id to fetch metadata for.",
		});
		expect(metaProps.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(metaProps.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});

		const permsTool = tools.find((t) => t.name === "drive_list_permissions")!;
		expect(permsTool?.description).toBe(
			"List the sharing permissions on a Google Drive file or folder.",
		);
		expect(permsTool.annotations).toEqual({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		});
		const permsProps = (permsTool.inputSchema.properties ?? {}) as Record<string, any>;
		expect(Object.keys(permsProps).sort()).toEqual(["account", "domain", "file_id"]);
		expect(permsTool.inputSchema.required).toEqual(["file_id"]);
		expect(permsProps.file_id).toMatchObject({
			type: "string",
			minLength: 1,
			description: "Drive file id to list sharing permissions for.",
		});
		expect(permsProps.account).toMatchObject({
			type: "string",
			enum: ["personal", "work"],
			description:
				"Deprecated, use `domain` ('work' | 'angus'; 'angus' is this parameter's 'personal'). Which Google account to act as: personal | work.",
		});
		expect(permsProps.domain).toMatchObject({
			type: "string",
			enum: ["work", "angus"],
			description:
				"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).",
		});
	});

	it("executes drive_get_metadata and drive_list_permissions through MCP with byte-for-byte text parity, supportsAllDrives=true, and fields masks", async () => {
		vi.stubEnv("GOOGLE_CLIENT_ID", "cid-test");
		vi.stubEnv("GOOGLE_CLIENT_SECRET", "csecret-test");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_PERSONAL", "rt-personal-val");
		vi.stubEnv("GOOGLE_REFRESH_TOKEN_WORK", "rt-work-val");

		const getCalls: URL[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = new URL(String(input));
				if (url.href === "https://oauth2.googleapis.com/token") {
					return new Response(JSON.stringify({ access_token: "at-tok" }), { status: 200 });
				}
				getCalls.push(url);
				if (url.pathname.endsWith("/permissions")) {
					if (url.pathname.includes("f-empty")) {
						return new Response(JSON.stringify({ permissions: [] }), { status: 200 });
					}
					return new Response(
						JSON.stringify({
							permissions: [
								{
									id: "perm-1",
									type: "user",
									role: "owner",
									emailAddress: "owner@work.example.com",
								},
								{
									id: "perm-2",
									type: "domain",
									role: "reader",
									domain: "work.example.com",
								},
							],
						}),
						{ status: 200 },
					);
				}
				if (url.pathname.endsWith("/f-bare")) {
					return new Response(
						JSON.stringify({
							id: "f-bare",
							name: "Scratchpad",
							mimeType: "text/plain",
						}),
						{ status: 200 },
					);
				}
				return new Response(
					JSON.stringify({
						id: "f-shared",
						name: "Q4 Strategy.docx",
						mimeType: "application/vnd.google-apps.document",
						size: "4096",
						modifiedTime: "2026-10-12T10:00:00Z",
						createdTime: "2026-10-01T09:00:00Z",
						owners: [{ emailAddress: "owner@work.example.com" }],
						parents: ["folder-a", "folder-b"],
						webViewLink: "https://docs.google.com/document/d/f-shared/edit",
						shared: true,
					}),
					{ status: 200 },
				);
			}),
		);

		const { client } = await connectClient();
		const sharedMetaOut = await client.callTool({
			name: "drive_get_metadata",
			arguments: { file_id: "f-shared" },
		});
		const bareMetaOut = await client.callTool({
			name: "drive_get_metadata",
			arguments: { file_id: "f-bare", domain: "work" },
		});
		const emptyPermsOut = await client.callTool({
			name: "drive_list_permissions",
			arguments: { file_id: "f-empty" },
		});
		const twoPermsOut = await client.callTool({
			name: "drive_list_permissions",
			arguments: { file_id: "f-shared", account: "work" },
		});
		await client.close();

		expect([
			sharedMetaOut.isError,
			bareMetaOut.isError,
			emptyPermsOut.isError,
			twoPermsOut.isError,
		]).toEqual([undefined, undefined, undefined, undefined]);

		expect(
			getCalls.map((u) => [
				u.pathname,
				u.searchParams.get("supportsAllDrives"),
				u.searchParams.get("fields"),
			]),
		).toEqual([
			["/drive/v3/files/f-shared", "true", FILE_FIELDS],
			["/drive/v3/files/f-bare", "true", FILE_FIELDS],
			["/drive/v3/files/f-empty/permissions", "true", PERMISSION_FIELDS],
			["/drive/v3/files/f-shared/permissions", "true", PERMISSION_FIELDS],
		]);

		expect(((sharedMetaOut.content as any)[0] as any).text).toBe(
			[
				"• [f-shared] Q4 Strategy.docx (application/vnd.google-apps.document, 4096 bytes, modified 2026-10-12T10:00:00Z, owner owner@work.example.com)",
				"Link: https://docs.google.com/document/d/f-shared/edit",
				"Parents: folder-a, folder-b",
				"Created: 2026-10-01T09:00:00Z",
				"Shared: true",
			].join("\n"),
		);
		expect(((bareMetaOut.content as any)[0] as any).text).toBe(
			"• [f-bare] Scratchpad (text/plain)",
		);
		expect(((emptyPermsOut.content as any)[0] as any).text).toBe(
			"Drive returned no permissions.",
		);
		expect(((twoPermsOut.content as any)[0] as any).text).toBe(
			"2 permission(s):\n• [perm-1] owner — user owner@work.example.com\n• [perm-2] reader — domain work.example.com",
		);
	});
});
