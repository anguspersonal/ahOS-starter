/**
 * One-time setup for the meeting-note pipeline, per Google account.
 *
 * Two jobs:
 *   1. Ensure the Gmail label exists (idempotent — safe to re-run).
 *   2. Report where meeting notes ALREADY live in Drive, so the canonical folder is
 *      chosen from evidence rather than invented. Gemini files its notes somewhere by
 *      default, and creating a second folder next to the one Google already uses is how
 *      a pipeline ends up with notes in two places.
 *
 * Folder creation is deliberately opt-in via --create-folder, so the default run is
 * read-only apart from the label.
 *
 * Usage (from repo root):
 *   node --env-file=packages/mcp-server/.env --import tsx \
 *     packages/mcp-server/scripts/meeting-notes-setup.ts --account work [--doc <fileId>]
 *     [--label meeting_note] [--create-folder "Meeting notes"]
 */
import { ensureLabel } from "../src/google/gmail.js";
import { getDrive } from "../src/google/drive.js";
import { parseGoogleAccount, type GoogleAccount } from "../src/google/accounts.js";

function log(msg: string): void {
	process.stdout.write(`${msg}\n`);
}

function argValue(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i === -1 ? undefined : process.argv[i + 1];
}

/** Walk a file's parent chain to a readable path, so "which folder" has a real answer. */
async function folderPath(
	account: GoogleAccount,
	folderId: string,
): Promise<string> {
	const drive = await getDrive(account);
	const names: string[] = [];
	let current = folderId;
	for (let depth = 0; depth < 10; depth += 1) {
		const meta = await drive.files.get({
			fileId: current,
			fields: "id, name, parents",
			supportsAllDrives: true,
		});
		names.unshift(meta.data.name ?? current);
		const parent = meta.data.parents?.[0];
		if (!parent || parent === current) break;
		current = parent;
	}
	return names.join(" / ");
}

async function main(): Promise<void> {
	const account: GoogleAccount = parseGoogleAccount(argValue("--account"));
	const labelName = argValue("--label") ?? "meeting_note";
	const docId = argValue("--doc");
	const createFolder = argValue("--create-folder");

	log(`Meeting-note setup for the '${account}' Google account.`);

	log(`\n[gmail label '${labelName}']`);
	const { label, created } = await ensureLabel(account, labelName);
	log(`  ${created ? "CREATED" : "already existed"}: ${label.name} (id ${label.id})`);

	if (docId) {
		log("\n[where the notes doc already lives]");
		const drive = await getDrive(account);
		const meta = await drive.files.get({
			fileId: docId,
			fields: "id, name, parents, owners(emailAddress), webViewLink",
			supportsAllDrives: true,
		});
		log(`  doc:   ${meta.data.name}`);
		log(`  owner: ${meta.data.owners?.[0]?.emailAddress ?? "(unknown)"}`);
		const parent = meta.data.parents?.[0];
		if (parent) {
			log(`  folder: ${await folderPath(account, parent)}  [id ${parent}]`);
		} else {
			log("  folder: (no parent visible — the file is shared with you, not filed in your Drive)");
		}
	}

	log("\n[existing candidate folders]");
	const drive = await getDrive(account);
	const res = await drive.files.list({
		q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false and (name contains 'Meet' or name contains 'Notes' or name contains 'Meeting')",
		fields: "files(id, name, owners(emailAddress))",
		pageSize: 25,
		includeItemsFromAllDrives: true,
		supportsAllDrives: true,
	});
	const folders = res.data.files ?? [];
	if (folders.length === 0) log("  (none found)");
	for (const f of folders) log(`  • [${f.id}] ${f.name}`);

	if (createFolder) {
		log(`\n[creating folder '${createFolder}']`);
		const made = await drive.files.create({
			requestBody: {
				name: createFolder,
				mimeType: "application/vnd.google-apps.folder",
			},
			fields: "id, name, webViewLink",
			supportsAllDrives: true,
		});
		log(`  CREATED: ${made.data.name} (id ${made.data.id})`);
		log(`  ${made.data.webViewLink}`);
	} else {
		log("\n[folder creation] skipped — pass --create-folder \"<name>\" once a location is agreed.");
	}
}

main().catch((err) => {
	log(`Setup failed: ${err instanceof Error ? err.message : String(err)}`);
	process.exitCode = 1;
});
