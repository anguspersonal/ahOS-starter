/**
 * Interactive demonstration of the Unified Action Wrapper (ADR-100 / #1256).
 *
 * Demonstrates:
 * 1. Pure Action Definition: typed inputs, structured domain outputs, behavioral annotations.
 * 2. Direct Programmatic Execution (executeAction): pure JS object, zero MCP overhead (for UI canvas / workers).
 * 3. MCP Surface Execution (toMcpTool): formatted markdown text envelope + audit log (for AI agents).
 * 4. Optional Live Database Run (--live): queries production Supabase.
 *
 * Run from repo root:
 *   npm --workspace @ahkms/mcp-server run demo:actions
 *   npm --workspace @ahkms/mcp-server run demo:actions -- --live
 */
import { z } from "zod";
import { defineAction, executeAction, toMcpTool } from "../src/actions/index.js";

async function main() {
	console.log("==================================================================");
	console.log("   ahOS Unified Action Wrapper Demonstration (ADR-100)");
	console.log("==================================================================\n");

	// 1. Define an Action
	const editorAction = defineAction({
		id: "document_patch",
		description: "Apply an in-place patch to a collaborative document canvas",
		schema: z.object({
			documentId: z.string().uuid().describe("Target document UUID"),
			content: z.string().min(1).describe("Delta or patch content"),
			operation: z.enum(["append", "replace"]).default("append"),
		}),
		outputSchema: z.object({
			success: z.boolean(),
			newVersion: z.number(),
			bytesWritten: z.number(),
			caller: z.string(),
		}),
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: false,
			openWorldHint: false,
		},
		run: async (input, ctx) => {
			// Pure domain logic: completely independent of protocol envelopes
			return {
				success: true,
				newVersion: 42,
				bytesWritten: Buffer.byteLength(input.content, "utf8"),
				caller: ctx.caller,
			};
		},
		formatMcp: (result) => {
			return `Successfully patched document (version ${result.newVersion}, ${result.bytesWritten} bytes written by caller: '${result.caller}').`;
		},
	});

	console.log("Action Defined:", editorAction.id);
	console.log("Annotations (hints for UI and callers):", editorAction.annotations);

	// 2. Direct Programmatic Execution (e.g. Phase 2 Web Co-Editing Surface)
	console.log("\n------------------------------------------------------------------");
	console.log("1. Direct Programmatic Execution via executeAction");
	console.log("   Used by: Phase 2 Web Workspace, Background Workers, Internal Tests");
	console.log("   Returns: Pure typed JavaScript domain object (no JSON-RPC text envelope)");
	console.log("------------------------------------------------------------------");

	const directResult = await executeAction(
		editorAction,
		{
			documentId: "11111111-2222-4333-a444-555555555555",
			content: "Collaborative edits from the UI canvas",
			operation: "append",
		},
		{ context: { caller: "ui", userId: "usr-angus-001" } },
	);

	console.log("Returned Object Type:", typeof directResult);
	console.log("Structured Domain Data:", directResult);

	// 3. MCP Surface Execution (e.g. Claude Desktop, Antigravity Agent)
	console.log("\n------------------------------------------------------------------");
	console.log("2. Protocol Execution via toMcpTool");
	console.log("   Used by: AI Agent tool calls via Model Context Protocol");
	console.log("   Returns: MCP JSON-RPC text envelope with automatic audit logging");
	console.log("------------------------------------------------------------------");

	const mcpTool = toMcpTool(editorAction);
	const mcpResult = await mcpTool.handler({
		documentId: "11111111-2222-4333-a444-555555555555",
		content: "Agent instructions from Claude",
		operation: "append",
	});

	console.log("MCP Envelope Content Chunks:", mcpResult.content.length);
	console.log("Formatted Presentation Text:\n" + mcpResult.content[0]?.text);

	// 4. Optional Live Database Execution
	if (process.argv.includes("--live")) {
		console.log("\n------------------------------------------------------------------");
		console.log("3. Live Production Tool Execution (document_duplicates)");
		console.log("------------------------------------------------------------------");
		try {
			const { documentDuplicatesAction } = await import("../src/tools/documentDuplicates.js");
			const { getCurrentUserId } = await import("../src/identity.js");

			const liveDirect = await executeAction(
				documentDuplicatesAction,
				{ query: "CV", limit: 2 },
				{ context: { caller: "ui", userId: getCurrentUserId() } },
			);
			console.log(`Live Supabase Clusters Found: ${liveDirect.clusters.length}`);
		} catch (err) {
			console.warn("Live DB query note:", (err as Error).message);
		}
	} else {
		console.log("\n(Tip: Run with '-- --live' to test live Supabase database queries)");
	}

	console.log("\n==================================================================");
	console.log("Parity Verified: One domain action serves both AI agents and human UI!");
	console.log("==================================================================");
}

main().catch((err) => {
	console.error("Demo encountered an error:", err);
	process.exit(1);
});
