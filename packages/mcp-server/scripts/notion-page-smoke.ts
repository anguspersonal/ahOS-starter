/**
 * End-to-end check for the generic Notion page surface (#625 read / #818 write) against
 * REAL credentials — the gap the unit suite cannot close, since every Notion response
 * there is one this repo wrote. It found one on its first run: a database id fails with
 * 400, not the 404 the tolerant page-envelope path was written for.
 *
 * Read-only against Notion. The two write cases exercised are both REFUSALS, which the
 * handler decides before any network call — nothing here mutates a page.
 *
 *   npm run notion-page-smoke                 (packages/mcp-server, needs .env)
 *   railway run --service ahkms/mcp-server -- \
 *     node ../../node_modules/tsx/dist/cli.mjs scripts/notion-page-smoke.ts
 *
 * Page ids are read from user_integrations at runtime, never hard-coded: they are
 * non-secret but user-specific (the rule get_notion_config states).
 */
import { readNotionPageHandler } from "../src/tools/readNotionPage.js";
import { toMcpTool } from "../src/actions/index.js";
import { serverRegistry } from "../src/actions/serverRegistry.js";
import { loadIntegrationConfig, notionPersonalConfigSchema } from "../src/integrations.js";

const updateNotionPageHandler = toMcpTool(serverRegistry().get("notion_page_update")!).handler;

let failures = 0;

function indent(text: string, marker: string, lines = 12): string {
	const all = text.split("\n");
	const shown = all.slice(0, lines).join("\n");
	const rest = all.length > lines ? `\n   ${marker} … (+${all.length - lines} lines)` : "";
	return shown.replace(/^/gm, `   ${marker} `) + rest;
}

async function expectOk(
	name: string,
	run: () => Promise<{ content: { text: string }[] }>,
): Promise<void> {
	try {
		console.log(`PASS  ${name}`);
		console.log(indent((await run()).content[0].text, "|"));
	} catch (err) {
		failures++;
		console.log(`FAIL  ${name}`);
		console.log(indent(err instanceof Error ? err.message : String(err), "!"));
	}
	console.log("");
}

async function expectRefusal(name: string, pattern: RegExp, run: () => Promise<unknown>): Promise<void> {
	try {
		await run();
		failures++;
		console.log(`FAIL  ${name}\n   ! resolved; expected a refusal matching ${pattern}\n`);
		return;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (pattern.test(message)) {
			console.log(`PASS  ${name}`);
			console.log(indent(message, "|", 4));
		} else {
			failures++;
			console.log(`FAIL  ${name} — refused, but not matching ${pattern}`);
			console.log(indent(message, "!", 6));
		}
	}
	console.log("");
}

const config = await loadIntegrationConfig("notion_personal", notionPersonalConfigSchema);
const stateDoc = config?.state_doc_page_id;
const tasksDb = config?.tasks_database_id;
if (!stateDoc || !tasksDb) {
	throw new Error(
		"notion_personal config needs state_doc_page_id and tasks_database_id for this smoke — see get_notion_config.",
	);
}

console.log("=== read_notion_page / update_notion_page, real credentials ===\n");

await expectRefusal("read with no domain names both workspaces", /'work'.*'angus'|'angus'.*'work'/s, () =>
	readNotionPageHandler({ page_id: stateDoc }),
);

await expectOk("read a personal page with domain='angus'", () =>
	readNotionPageHandler({ domain: "angus", page_id: stateDoc }),
);

await expectRefusal("the same id under domain='work' names the retry", /retry with domain='angus'/, () =>
	readNotionPageHandler({ domain: "work", page_id: stateDoc }),
);

await expectOk("read a database container id (no page envelope, still lists children)", () =>
	readNotionPageHandler({ domain: "angus", page_id: tasksDb }),
);

await expectRefusal("a page-addressed write to the State Doc is refused", /update_state_doc/, () =>
	updateNotionPageHandler({ domain: "angus", op: "append", page_id: stateDoc, body: "- smoke test" }),
);

await expectRefusal("arguments that mean nothing for the op are refused", /does not accept \[text\]/, () =>
	updateNotionPageHandler({ domain: "angus", op: "append", page_id: tasksDb, text: "x" }),
);

console.log(failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
