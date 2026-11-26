import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer } from "../server.js";
import { createRequire } from "node:module";
import { TOOL_ALIASES, TOOL_SUPERSEDED } from "../toolAliases.js";
import { readLegacyBaseline } from "./legacyBaseline.js";

const require = createRequire(import.meta.url);
const manifest = require("@ahkms/core/action-manifest.json") as {
	actions: Record<string, { expose?: { mcp?: boolean } }>;
};

// #1060. Two properties of the whole tool surface, asserted over the LIVE list the
// server advertises rather than over the source file — a test that greps server.ts
// would pass just as happily if the registration never reached a client.
//
// Both are the kind of rule that holds on the day it is written and rots quietly
// afterwards: the 160th tool is the one nobody annotates, and the description that
// grows back past sixty words does so one clause at a time. Neither failure has a
// symptom a person would notice, which is why they are checked here.

const WORD_CAP = 60;

async function listTools() {
	const server = createServer();
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
	await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
	const { tools } = await client.listTools();
	await client.close();
	return tools;
}

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

// A deprecated name's description is its replacement's description with a
// "Deprecated, use X." sentence in front (#1061). The cap is a budget on the
// PROSE, so the notice is stripped before counting — otherwise every alias whose
// target sits near sixty words fails for saying it is deprecated.
const withoutNotice = (s: string) => s.replace(/^Deprecated, use [^.]*\.\s*/, "");

describe("the MCP tool surface", () => {
	it("advertises a non-trivial number of tools", async () => {
		// Guards the two tests below: if listTools() ever returned [] they would both
		// pass vacuously, which is the failure mode this whole issue is about.
		const tools = await listTools();
		expect(tools.length).toBeGreaterThan(100);
	});

	it("declares all four annotations on every tool", async () => {
		const tools = await listTools();
		const missing = tools
			.map((t) => {
				const a = (t.annotations ?? {}) as Record<string, unknown>;
				const absent = (
					["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const
				).filter((k) => typeof a[k] !== "boolean");
				return absent.length > 0 ? `${t.name}: missing ${absent.join(", ")}` : null;
			})
			.filter(Boolean);

		// Named, not counted: a host reads these to decide what may run unattended, so
		// "3 tools are unannotated" is not an actionable failure message.
		expect(missing).toEqual([]);
	});

	it("keeps every description to sixty words or fewer", async () => {
		const tools = await listTools();
		const over = tools
			.filter((t) => words(withoutNotice(t.description ?? "")) > WORD_CAP)
			.map((t) => `${t.name}: ${words(withoutNotice(t.description ?? ""))} words`);

		expect(over).toEqual([]);
	});

	it("gives every tool a description", async () => {
		const tools = await listTools();
		expect(tools.filter((t) => !t.description?.trim()).map((t) => t.name)).toEqual([]);
	});

	it("never marks a read-only tool destructive", async () => {
		// Contradictory hints are worse than absent ones: a host that trusts
		// readOnlyHint and a host that trusts destructiveHint would behave differently
		// on the same tool.
		const tools = await listTools();
		const contradictory = tools
			.filter((t) => {
				const a = (t.annotations ?? {}) as Record<string, unknown>;
				return a.readOnlyHint === true && a.destructiveHint === true;
			})
			.map((t) => t.name);

		expect(contradictory).toEqual([]);
	});

	it("marks the irreversible tools destructive", async () => {
		// A spot-check with real names. The classifier that produced these annotations
		// worked from name patterns, and an earlier version of it read
		// `calendar_delete_event` as a NOUN match on `_event` and called it read-only —
		// telling a host a delete was safe to run unattended. These are the cases where
		// getting it wrong costs something that cannot be undone.
		const tools = await listTools();
		const byName = new Map(tools.map((t) => [t.name, (t.annotations ?? {}) as Record<string, unknown>]));

		for (const name of [
			"artifact_delete",
			"entity_delete",
			"person_delete",
			"drive_delete",
			"calendar_delete_event",
			"review_resolve",
			// dex_delete_contacts sits behind the passthrough since #1063, so the tool
			// that can reach it carries the hint.
			"dex_call_tool",
			"gmail_send_draft",
			"linkedin_post",
			// Transfers ownership or permanently publishes to anyone with the link.
			"drive_share",
			// Executes arbitrary code in an Apps Script project.
			"appsscript_run_function",
			// Overwrites/replaces code files in an Apps Script project.
			"appsscript_update_content",
			// Sends outward-facing campaign or transactional emails.
			"brevo_call_tool",
			// Performs irreversible writes or unrecoverable deletes on PostHog data.
			"posthog_write",
			// Applies in-place document edits including unrecoverable deleteContentRange.
			"docs_batch_update",
			// Overwrites every match of the find text.
			"docs_replace_text",
			// Permanently deletes original Drive file when cleanup='delete'.
			"drive_import_file",
			// Permanently deletes user tasks.
			"task_crud",
			// Permanently deletes entities when archive_only=false.
			"entity_crud",
			// Clear empties cells and update overwrites them; version history restores whole-file versions only.
			"sheets_write",
			"slack_message_delete",
		]) {
			expect(byName.get(name), `${name} is not registered`).toBeDefined();
			expect(byName.get(name)?.destructiveHint, `${name} should be destructive`).toBe(true);
			expect(byName.get(name)?.readOnlyHint, `${name} should not be read-only`).toBe(false);
		}
	});

	it("marks drive_export a write that creates, not a read and not destructive", async () => {
		// #1220. drive_export only READS its source Doc, which tempts a read-only
		// hint, but it writes a new file into Drive on every call. A host that trusted
		// readOnlyHint would run it unattended as if it changed nothing.
		const tools = await listTools();
		const byName = new Map(tools.map((t) => [t.name, t]));

		expect(byName.get("drive_export")?.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: true,
		});
		const uploadProps = (byName.get("drive_upload_file")?.inputSchema as {
			properties?: Record<string, { enum?: string[] }>;
		}).properties;
		expect(uploadProps?.convert_to?.enum).toEqual(["google_doc"]);
	});

	it("marks the obvious reads read-only", async () => {
		const tools = await listTools();
		const byName = new Map(tools.map((t) => [t.name, (t.annotations ?? {}) as Record<string, unknown>]));

		for (const name of [
			"knowledge_search",
			"artifact_get",
			"notion_page_get",
			"notion_database_query",
			"notion_database_get",
			"notion_user_list",
			"notion_comment_list",
			"store_schema",
			"config_capture_get",
			// #1230 / #1217: the document tools only read; golden-doc's HITL writes go
			// through artifact_update / entity_update, never through these.
			"document_resolve",
			"document_duplicates",
			"review_list",
			"sheets_read",
			"bigquery_query",
		]) {
			expect(byName.get(name), `${name} is not registered`).toBeDefined();
			expect(byName.get(name)?.readOnlyHint, `${name} should be read-only`).toBe(true);
		}
	});

	it("keeps the traps that were in the long descriptions", async () => {
		// #1060 names these five: the cut must not take the one sentence that stops a
		// caller doing the wrong thing. Cutting prose is safe; cutting a warning is not.
		const tools = await listTools();
		const desc = new Map(tools.map((t) => [t.name, t.description ?? ""]));

		expect(desc.get("knowledge_search")).toMatch(/at least one of/i);
		// #1230: the resolver must say it will not guess when nothing is tracked.
		expect(desc.get("document_resolve")).toMatch(/instead of guessing/);
		// #1217: no silent caps -- the member cap and its count are part of the contract.
		expect(desc.get("document_duplicates")).toMatch(/\+N more/);
		expect(desc.get("task_create")).toMatch(/single_task/);
		expect(desc.get("task_create")).toMatch(/required/i);
		expect(desc.get("notion_page_update")).toMatch(/required/i);
		expect(desc.get("daily_log_create")).toMatch(/required/i);
		expect(desc.get("capture")).toMatch(/captured_at/);
		expect(desc.get("drive_share")).toMatch(/owner/);
		expect(desc.get("sheets_read")).toMatch(/required/i);
		expect(desc.get("sheets_read")).toMatch(/truncated/);
		expect(desc.get("sheets_write")).toMatch(/required/i);
		expect(desc.get("sheets_write")).toMatch(/RAW/);
		expect(desc.get("sheets_write")).toMatch(/never values/);
	});

	it("points every shortened description at its long form", async () => {
		// The long text still exists; a description that cut it without saying where it
		// went would just be a shorter description.
		const tools = await listTools();
		for (const t of tools) {
			if (!/Full notes:/.test(t.description ?? "")) continue;
			// A deprecated name shares its replacement's config verbatim, so its link
			// names the replacement's file — which is the right file, and the reason
			// each guide was renamed alongside its tool.
			const owner = TOOL_ALIASES[t.name] ?? t.name;
			expect(t.description, `${t.name}`).toMatch(
				new RegExp(`docs/guides/tools/${owner}\\.md`),
			);
		}
	});

	it("names the approval gate instead of a self-set confirm", async () => {
		const server = createServer();
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		const { tools } = await client.listTools();

		const withConfirm = tools
			.filter((t) => {
				const props = (t.inputSchema.properties ?? {}) as Record<string, unknown>;
				return "confirm" in props;
			})
			.map((t) => t.name);
		expect(withConfirm).toEqual([]);

		const withConfirmProse = tools
			.filter((t) => /confirm with the user/i.test(t.description ?? ""))
			.map((t) => t.name);
		expect(withConfirmProse).toEqual([]);

		const descByName = new Map(tools.map((t) => [t.name, t.description ?? ""]));
		for (const name of [
			"drive_delete",
			"drive_share",
			"drive_import_file",
			"gmail_send_draft",
			"calendar_delete_event",
			"slack_post",
			"slack_message_update",
			"slack_message_delete",
			"slack_reaction_add",
			"linkedin_post",
			"brevo_call_tool",
			"entity_bulk_delete",
			"entity_crud",
			"entity_delete",
			"person_delete",
		]) {
			expect(descByName.get(name), `${name}`).toMatch(/Parks for the owner's approval/);
		}

		const res = await client.callTool({ name: "drive_delete", arguments: { file_id: "x" } });
		const text = ((res.content as Array<{ text?: string }>)?.[0]?.text ?? "");
		expect(text).toMatch(/approval/i);
		expect(text).not.toMatch(/confirm/i);

		await client.close();
	});
});

describe("the #1061 deprecated tool names", () => {
	it("stops advertising all TOOL_ALIASES and TOOL_SUPERSEDED names, leaving only manifest MCP ids and legacy tools (#1402, #2418)", async () => {
		const tools = await listTools();
		const names = new Set(tools.map((t) => t.name));

		// The expected surface is derived, not counted (#2418): every manifest action
		// with expose.mcp plus every legacy-tools-baseline.txt entry (none if the file
		// is gone, #2338), and no retired alias or superseded name among them.
		const retired = new Set([...Object.keys(TOOL_ALIASES), ...Object.keys(TOOL_SUPERSEDED)]);
		const expected = new Set(
			[
				...Object.entries(manifest.actions).filter(([, e]) => e.expose?.mcp === true).map(([id]) => id),
				...readLegacyBaseline(),
			].filter((name) => !retired.has(name)),
		);
		expect(tools.length).toBe(expected.size);
		expect(Object.keys(TOOL_ALIASES).filter((old) => names.has(old))).toEqual([]);
		expect(Object.keys(TOOL_SUPERSEDED).filter((old) => names.has(old))).toEqual([]);
	});

	it("points every retired alias in TOOL_ALIASES at a registered canonical replacement", async () => {
		const names = new Set((await listTools()).map((t) => t.name));
		const broken = Object.entries(TOOL_ALIASES)
			.filter(([, replacement]) => !names.has(replacement))
			.map(([old, replacement]) => `${old} -> ${replacement} (not registered)`);

		expect(broken).toEqual([]);
	});

	it("never reuses an old name as a new one", async () => {
		// The failure this blocks: some later rename picks a target that is already
		// somebody's deprecated name.
		const olds = new Set(Object.keys(TOOL_ALIASES));
		const collisions = Object.entries(TOOL_ALIASES)
			.filter(([, replacement]) => olds.has(replacement))
			.map(([old, replacement]) => `${old} -> ${replacement}, which is itself an old name`);

		expect(collisions).toEqual([]);
	});

	it("ensures every superseded tool points to a registered replacement without aliasing", async () => {
		// TOOL_SUPERSEDED records retired tools whose replacements take different
		// arguments or superseded them outright (#1568). Each replacement must be
		// registered and no superseded name may remain in TOOL_ALIASES.
		const names = new Set((await listTools()).map((t) => t.name));
		for (const [name, replacement] of Object.entries(TOOL_SUPERSEDED)) {
			expect(names.has(name), `${name} is retired and must not be registered`).toBe(false);
			expect(names.has(replacement), `${replacement} is not registered`).toBe(true);
			expect(TOOL_ALIASES[name], `${name} is superseded, not aliased`).toBeUndefined();
		}
	});
});

describe("retired names", () => {
	it("does not advertise artifact_sync_people or get_notion_tasks_schema", async () => {
		const names = new Set((await listTools()).map((t) => t.name));
		expect(names.has("artifact_sync_people")).toBe(false);
		expect(names.has("artifact_people_sync")).toBe(false);
		expect(names.has("get_notion_tasks_schema")).toBe(false);
	});
});


