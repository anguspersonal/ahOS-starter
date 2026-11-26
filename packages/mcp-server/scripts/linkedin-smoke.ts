/**
 * LIVE smoke test for the linkedin_post action (#1631 / #1632).
 *
 * WARNING: this PUBLISHES A REAL POST to your LinkedIn profile via the native
 * LinkedIn Posts API. Pass the text as an argument so you choose exactly what goes out;
 * it defaults to a dated test string. Visibility comes from the linkedin integration
 * config (default PUBLIC) unless you pass --connections.
 *
 * Prereqs:
 *   - the linkedin row in user_integrations is enabled with routing='native'
 *   - LINKEDIN_ACCESS_TOKEN is set in packages/mcp-server/.env
 *
 * Run from packages/mcp-server:
 *   npm run linkedin-smoke -- "Hello from ahOS"
 *   npm run linkedin-smoke -- --connections "Visible to connections only"
 */
import { serverRegistry } from "../src/actions/serverRegistry.js";
import { getCurrentUserId } from "../src/identity.js";

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const connections = args.includes("--connections");
	const text =
		args
			.filter((a) => a !== "--connections")
			.join(" ")
			.trim() || `ahOS connector smoke test - ${new Date().toISOString()}`;

	process.stdout.write(
		`[linkedin_post] Publishing a REAL LinkedIn post (${
			connections ? "CONNECTIONS" : "PUBLIC"
		}):\n  ${JSON.stringify(text)}\n`,
	);

	try {
		const action = serverRegistry().get("linkedin_post");
		if (!action) {
			throw new Error("linkedin_post action is not registered in serverRegistry");
		}
		const result = await action.run(
			{
				text,
				...(connections ? { visibility: "CONNECTIONS" as const } : {}),
			},
			{ userId: getCurrentUserId(), caller: "cli", requestId: "linkedin-smoke" },
		);
		process.stdout.write(
			`[linkedin_post] OK: ${action.formatMcp ? action.formatMcp(result) : JSON.stringify(result)}\n`,
		);
	} catch (e) {
		process.stderr.write(
			`[linkedin_post] FAIL: ${e instanceof Error ? e.message : String(e)}\n`,
		);
		process.exit(1);
	}
}

void main();
