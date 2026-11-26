// MUST be first: Sentry patches http/express as they load, so init has to
// run before any of them are imported. See ./instrument.ts.
import "./instrument.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { loadToneRules } from "./dosConfig.js";
import { loadHotTier } from "./hotTier.js";
import { serverRegistry } from "./actions/serverRegistry.js";
import { configureLedger } from "./actions/ledger.js";
import { configureApprovals } from "./actions/approvals.js";
import { configureActionScope } from "./actions/scope.js";

// Local-dev / Phase 0 entry point: speak MCP over stdio (the client spawns this
// as a subprocess). The remote, authenticated HTTP surface lives in ./http.ts
// (ADR-019 follow-up #1 / issue #84); both share the same tool set via createServer().
async function main() {
	configureApprovals();
	configureLedger();
	configureActionScope();
	serverRegistry();
	if (process.env.CHECK_SMOKE === "1") {
		return;
	}
	// Tone rules (#819) and the hot tier (#1023) ride the initialize handshake; a DB
	// failure degrades either to none.
	const [toneRules, hotRows] = await Promise.all([loadToneRules(), loadHotTier()]);
	const server = createServer(toneRules, hotRows);
	const transport = new StdioServerTransport();
	await server.connect(transport);
	// stderr so it doesn't corrupt the stdio JSON-RPC stream.
	console.error("ahOS MCP server running on stdio");
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
