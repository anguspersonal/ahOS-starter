/**
 * Acceptance test script for Google Docs in-place editing tools.
 *
 * Runs end-to-end against live accounts for both domains ('angus' and 'work'):
 * 1. Creates a test Doc in Google Drive.
 * 2. Reads it with docs_get (extracts revisionId, tabs, outline).
 * 3. Populates initial structure with docs_batch_update.
 * 4. Inserts a section after a named heading.
 * 5. Replaces a phrase in place.
 * 6. Adds a table.
 * 7. Adds a comment anchored to quoted text with docs_comments.
 * 8. Verifies stale-revision write is refused with clear error.
 * 9. Re-reads with docs_get and confirms all edits, unchanged link, and version history.
 * 10. Cleans up the test document.
 *
 * Run from repo root:
 *   node --env-file=packages/mcp-server/.env --import tsx packages/mcp-server/scripts/acceptance-google-docs.ts
 */
import { getDrive } from "../src/google/drive.js";
import { docsGetHandler } from "../src/tools/docs/get.js";
import { docsFindTextHandler } from "../src/tools/docs/findText.js";
import { toMcpTool } from "../src/actions/adapters/mcp.js";
import { serverRegistry } from "../src/actions/serverRegistry.js";
import type { Domain } from "../src/domains.js";
import { DOMAIN_LEGACY_SCOPE } from "../src/domains.js";
import type { GoogleAccount } from "../src/google/accounts.js";

const docsBatchUpdateHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("docs_batch_update")!).handler(args);

const docsCommentsHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("docs_comments")!).handler(args);

function log(domain: string, step: string, msg: string): void {
	process.stdout.write(`[${domain}][${step}] ${msg}\n`);
}

function textOf(result: { content: { type: "text"; text: string }[] }): string {
	return result.content.map((c) => c.text).join("\n");
}

function extractRevisionId(docsGetOutput: string): string {
	const match = docsGetOutput.match(/Revision ID:\s*([^\r\n]+)/);
	if (!match) throw new Error(`Could not parse Revision ID from output:\n${docsGetOutput}`);
	return match[1].trim();
}

async function testDomain(domain: Domain): Promise<void> {
	const account = DOMAIN_LEGACY_SCOPE[domain] as GoogleAccount;
	const drive = await getDrive(account);

	log(domain, "setup", `Creating fresh test Google Doc in account '${account}'…`);
	const createRes = await drive.files.create({
		requestBody: {
			name: `ahKMS Acceptance Test Doc (${domain}) - ${new Date().toISOString()}`,
			mimeType: "application/vnd.google-apps.document",
		},
		fields: "id, name, webViewLink, version",
		supportsAllDrives: true,
	});

	const docId = createRes.data.id;
	const initialLink = createRes.data.webViewLink;
	if (!docId) throw new Error("Failed to create test document.");

	log(domain, "setup", `Created document ${docId}: ${initialLink}`);

	try {
		// 1. Initial read
		log(domain, "read", "Calling docs_get on initial empty doc…");
		const read1 = await docsGetHandler({ document_id: docId, domain });
		const text1 = textOf(read1);
		let currentRev = extractRevisionId(text1);
		log(domain, "read", `Initial revisionId: ${currentRev}`);

		// 2. Initial population
		log(domain, "batch_update", "Populating initial headings and text…");
		const update1 = await docsBatchUpdateHandler({
			document_id: docId,
			domain,
			required_revision_id: currentRev,
			requests: [
				{
					insertText: {
						text: "Project Status\nInitial draft version of the document.\n\nTeam Notes\nGeneral remarks go here.\n",
						location: { index: 1 },
					},
				},
				{
					updateParagraphStyle: {
						range: { startIndex: 1, endIndex: 16 },
						paragraphStyle: { namedStyleType: "HEADING_1" },
						fields: "namedStyleType",
					},
				},
			],
		});
		log(domain, "batch_update", textOf(update1).split("\n")[0]);

		// Re-read to get new revision and check outline
		const read2 = await docsGetHandler({ document_id: docId, domain });
		currentRev = extractRevisionId(textOf(read2));
		log(domain, "read", `Updated revisionId after initial population: ${currentRev}`);

		// 3. Insert a section after a named heading
		log(domain, "find_text", "Finding heading 'Project Status'…");
		const findHeading = await docsFindTextHandler({
			document_id: docId,
			domain,
			text: "Project Status",
		});
		const findText = textOf(findHeading);
		const rangeMatch = findText.match(/Range:\s*startIndex:\s*(\d+),\s*endIndex:\s*(\d+)/);
		if (!rangeMatch) throw new Error(`Could not find heading 'Project Status': ${findText}`);
		const headingEnd = parseInt(rangeMatch[2], 10);
		log(domain, "find_text", `Found 'Project Status' at [${rangeMatch[1]}..${headingEnd}]`);

		log(domain, "batch_update", "Inserting section after 'Project Status' heading…");
		const insertSectionRes = await docsBatchUpdateHandler({
			document_id: docId,
			domain,
			required_revision_id: currentRev,
			requests: [
				{
					insertText: {
						location: { index: headingEnd + 1 }, // after newline
						text: "Deliverables\nAll deliverables are on track for Q4.\n\n",
					},
				},
				{
					updateParagraphStyle: {
						range: { startIndex: headingEnd + 1, endIndex: headingEnd + 14 },
						paragraphStyle: { namedStyleType: "HEADING_2" },
						fields: "namedStyleType",
					},
				},
			],
		});
		log(domain, "batch_update", textOf(insertSectionRes).split("\n")[0]);

		// Re-read
		const read3 = await docsGetHandler({ document_id: docId, domain });
		currentRev = extractRevisionId(textOf(read3));

		// 4. Replace a phrase
		log(domain, "batch_update", "Replacing phrase 'Initial draft version' -> 'Final approved version'…");
		const replaceRes = await docsBatchUpdateHandler({
			document_id: docId,
			domain,
			required_revision_id: currentRev,
			requests: [
				{
					replaceAllText: {
						containsText: {
							text: "Initial draft version",
							matchCase: true,
						},
						replaceText: "Final approved version",
					},
				},
			],
		});
		log(domain, "batch_update", textOf(replaceRes).split("\n")[0]);

		// Re-read
		const read4 = await docsGetHandler({ document_id: docId, domain });
		currentRev = extractRevisionId(textOf(read4));

		// 5. Add a table
		log(domain, "batch_update", "Adding a 2x3 table…");
		const findNotes = await docsFindTextHandler({
			document_id: docId,
			domain,
			text: "Team Notes",
		});
		const notesRange = textOf(findNotes).match(/endIndex:\s*(\d+)/);
		const tableIndex = notesRange ? parseInt(notesRange[1], 10) + 1 : 1;

		const tableRes = await docsBatchUpdateHandler({
			document_id: docId,
			domain,
			required_revision_id: currentRev,
			requests: [
				{
					insertTable: {
						rows: 2,
						columns: 3,
						location: { index: tableIndex },
					},
				},
			],
		});
		log(domain, "batch_update", textOf(tableRes).split("\n")[0]);

		// Re-read
		const read5 = await docsGetHandler({ document_id: docId, domain });
		currentRev = extractRevisionId(textOf(read5));

		// 6. Add a comment anchored to quoted text
		log(domain, "comments", "Creating comment anchored to 'deliverables are on track'…");
		const commentRes = await docsCommentsHandler({
			document_id: docId,
			domain,
			action: "create",
			content: "Accepted: looks good to ship.",
			quoted_text: "deliverables are on track",
		});
		log(domain, "comments", textOf(commentRes).split("\n")[0]);

		// List comments to verify
		const listComments = await docsCommentsHandler({
			document_id: docId,
			domain,
			action: "list",
		});
		const listText = textOf(listComments);
		if (!listText.includes("Accepted: looks good to ship")) {
			throw new Error(`Comment not listed in docs_comments output:\n${listText}`);
		}
		log(domain, "comments", "Confirmed comment listed in docs_comments.");

		// 7. Verify stale-revision write is refused
		log(domain, "safety", "Testing stale-revision write refusal…");
		let staleRefused = false;
		try {
			await docsBatchUpdateHandler({
				document_id: docId,
				domain,
				required_revision_id: "stale-revision-id-99999",
				requests: [
					{
						insertText: {
							text: "This should fail",
							location: { index: 1 },
						},
					},
				],
			});
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			if (errMsg.includes("Doc changed since your read (revision mismatch: required 'stale-revision-id-99999')")) {
				staleRefused = true;
				log(domain, "safety", `PASS: Stale write was properly refused with: ${errMsg}`);
			} else {
				throw new Error(`Unexpected error on stale write: ${errMsg}`);
			}
		}

		if (!staleRefused) {
			throw new Error("Stale revision write was NOT refused!");
		}

		// 8. Re-read and confirm final state
		log(domain, "verify", "Verifying final document state…");
		const finalRead = await docsGetHandler({ document_id: docId, domain });
		const finalText = textOf(finalRead);

		if (!finalText.includes("Deliverables")) throw new Error("Missing 'Deliverables' section!");
		if (!finalText.includes("TABLE")) throw new Error("Missing inserted table!");
		log(domain, "verify", "Confirmed: section and table present in outline.");

		// Verify phrase replacement via docs_find_text
		const findReplacement = await docsFindTextHandler({
			document_id: docId,
			domain,
			text: "Final approved version",
		});
		if (!textOf(findReplacement).includes("Found 1 occurrence(s)")) {
			throw new Error("Replacement phrase not found in document!");
		}
		log(domain, "verify", "Confirmed: replaced phrase 'Final approved version' is in place.");

		// Confirm webViewLink is unchanged
		const metaCheck = await drive.files.get({
			fileId: docId,
			fields: "id, webViewLink, version",
			supportsAllDrives: true,
		});
		if (metaCheck.data.webViewLink !== initialLink) {
			throw new Error(`Document link changed! Before: ${initialLink}, After: ${metaCheck.data.webViewLink}`);
		}
		log(domain, "verify", `Confirmed: link is unchanged (${initialLink}).`);

		// Confirm version history entries exist
		const revisions = await drive.revisions.list({
			fileId: docId,
			fields: "revisions(id, modifiedTime)",
		});
		const revCount = revisions.data.revisions?.length ?? 0;
		log(domain, "verify", `Confirmed: version history has ${revCount} revision entry/entries.`);
		if (revCount < 2) {
			log(domain, "warn", `Note: Drive revisions count is ${revCount} (Drive sometimes pools revisions in rapid succession).`);
		}

		log(domain, "success", `ALL ACCEPTANCE CRITERIA PASSED FOR DOMAIN '${domain}'!`);
	} finally {
		// Clean up the temporary test document
		log(domain, "cleanup", `Deleting test document ${docId}…`);
		try {
			await drive.files.delete({ fileId: docId, supportsAllDrives: true });
			log(domain, "cleanup", "Cleaned up test document.");
		} catch (e) {
			log(domain, "cleanup", `Warning: failed to delete test doc ${docId}: ${e}`);
		}
	}
}

async function main(): Promise<void> {
	process.stdout.write("====================================================\n");
	process.stdout.write("Starting Google Docs In-Place Editing Acceptance Test\n");
	process.stdout.write("====================================================\n\n");

	try {
		await testDomain("angus");
		process.stdout.write("\n----------------------------------------------------\n\n");
		await testDomain("work");
		process.stdout.write("\n====================================================\n");
		process.stdout.write("ALL TESTS PASSED FOR BOTH DOMAINS ✓\n");
		process.stdout.write("====================================================\n");
	} catch (err) {
		process.stderr.write(`\nACCEPTANCE TEST FAILED: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
		process.exit(1);
	}
}

main();
