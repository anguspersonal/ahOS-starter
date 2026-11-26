/**
 * Read-only smoke test for the Google Drive tools.
 *
 * Verifies the OAuth refresh token works end-to-end by listing and searching
 * Drive. It does NOT create, modify, or delete anything, so it's safe to run
 * against a real account.
 *
 * Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN_PERSONAL (mint
 * the refresh token first with scripts/google-oauth.ts).
 *
 * Run from repo root:
 *   node --env-file=packages/mcp-server/.env --import tsx packages/mcp-server/scripts/drive-smoke.ts
 */
import { createDriveGetMetadataAction } from "@ahkms/core/actions";
import { toMcpTool } from "../src/actions/index.js";
import { serverRegistry } from "../src/actions/serverRegistry.js";
import { drivePort } from "../src/google/drivePort.js";

const driveListHandler = toMcpTool(serverRegistry().get("drive_list")!).handler;
const driveSearchHandler = toMcpTool(serverRegistry().get("drive_search")!).handler;

function log(stage: string, msg: string): void {
	process.stdout.write(`[${stage}] ${msg}\n`);
}

function fail(stage: string, err: unknown): never {
	process.stderr.write(`[${stage}] FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
	process.exit(1);
}

function textOf(result: { content: { type: "text"; text: string }[] }): string {
	return result.content.map((c) => c.text).join("\n");
}

async function main(): Promise<void> {
	try {
		log("list", "listing 5 most recently modified files…");
		const list = await driveListHandler({ page_size: 5 });
		const listText = textOf(list);
		log("list", listText.split("\n").slice(0, 6).join("\n  "));

		// Pull an id out of the listing and fetch its metadata to exercise files.get.
		const idMatch = listText.match(/\[([^\]]+)\]/);
		if (idMatch) {
			log("get", `fetching metadata for ${idMatch[1]}…`);
			const meta = await toMcpTool(createDriveGetMetadataAction(drivePort)).handler({
				file_id: idMatch[1],
			});
			log("get", textOf(meta).split("\n")[0]);
		} else {
			log("get", "skipped (no files to fetch)");
		}

		log("search", "searching for 'the'…");
		const search = await driveSearchHandler({ query: "the", page_size: 3 });
		log("search", textOf(search).split("\n")[0]);

		log("done", "DRIVE TOOLS REACHABLE ✓");
	} catch (err) {
		fail("error", err);
	}
}

main();
