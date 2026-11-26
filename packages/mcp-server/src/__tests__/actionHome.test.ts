import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASELINE_PATH = path.resolve(__dirname, "../../actions-outside-core-baseline.txt");

export interface ActionOccurrence {
	id: string;
	filePath: string;
}

export function diffIds(
	found: Iterable<string>,
	baseline: Iterable<string>,
): { added: string[]; stale: string[] } {
	const foundSet = new Set(found);
	const baselineSet = new Set(baseline);
	const added = [...foundSet].filter((x) => !baselineSet.has(x)).sort();
	const stale = [...baselineSet].filter((x) => !foundSet.has(x)).sort();
	return { added, stale };
}

export function parseBaseline(content: string): string[] {
	return content
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.sort();
}

export function extractDefineActionIds(fileContent: string, filePath: string): ActionOccurrence[] {
	const ids: ActionOccurrence[] = [];
	const callRegex = /defineAction\s*\(\s*\{/g;
	let match: RegExpExecArray | null;

	while ((match = callRegex.exec(fileContent)) !== null) {
		const startIndex = match.index + match[0].length - 1; // index of '{'
		let depth = 0;
		let endIndex = -1;
		let inString: string | null = null;
		let escape = false;

		for (let i = startIndex; i < fileContent.length; i++) {
			const char = fileContent[i];
			if (inString) {
				if (escape) {
					escape = false;
				} else if (char === "\\") {
					escape = true;
				} else if (char === inString) {
					inString = null;
				}
			} else {
				if (char === '"' || char === "'" || char === "`") {
					inString = char;
				} else if (char === "{") {
					depth++;
				} else if (char === "}") {
					depth--;
					if (depth === 0) {
						endIndex = i;
						break;
					}
				}
			}
		}

		if (endIndex === -1) {
			throw new Error(`Unbalanced braces in defineAction call in ${filePath}`);
		}

		const objectBody = fileContent.slice(startIndex + 1, endIndex);
		const idMatch = objectBody.match(/(?:^|\n|\s)id\s*:\s*["']([^"']+)["']/);
		if (!idMatch) {
			throw new Error(`defineAction({ call in ${filePath} has no string-literal id`);
		}
		ids.push({ id: idMatch[1], filePath });
	}
	return ids;
}

export function collectSourceFiles(dir: string, fileList: string[] = []): string[] {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules" || entry.name === "dist") {
				continue;
			}
			collectSourceFiles(fullPath, fileList);
		} else if (entry.isFile()) {
			if (
				(entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) &&
				!entry.name.endsWith(".test.ts") &&
				!entry.name.endsWith(".test.tsx") &&
				!entry.name.endsWith(".spec.ts") &&
				!entry.name.endsWith(".spec.tsx")
			) {
				fileList.push(fullPath);
			}
		}
	}
	return fileList;
}

export function scanActionsOutsideCore(rootDir?: string): ActionOccurrence[] {
	const packagesDir = rootDir ?? path.resolve(__dirname, "../../..");
	if (!fs.existsSync(packagesDir)) {
		throw new Error(`Packages directory not found at ${packagesDir}`);
	}

	const packages = fs.readdirSync(packagesDir).filter((pkg) => {
		if (pkg === "core") return false;
		const fullPath = path.join(packagesDir, pkg);
		try {
			return fs.statSync(fullPath).isDirectory();
		} catch {
			return false;
		}
	});

	const allOccurrences: ActionOccurrence[] = [];

	for (const pkg of packages) {
		const srcDir = path.join(packagesDir, pkg, "src");
		if (!fs.existsSync(srcDir)) continue;

		const files = collectSourceFiles(srcDir);
		for (const file of files) {
			const content = fs.readFileSync(file, "utf8");
			if (!content.includes("defineAction")) continue;
			const occurrences = extractDefineActionIds(content, file);
			allOccurrences.push(...occurrences);
		}
	}

	return allOccurrences;
}

describe("action definitions outside @ahkms/core baseline ratchet (#1475 / ADR-105 R1)", () => {
	it("Case 1: scan finds no actions outside core in strict mode", () => {
		const found = scanActionsOutsideCore();
		expect(found.length).toBe(0);
	});

	it("Case 2: found minus baseline is empty (no new actions defined outside @ahkms/core)", () => {
		const found = scanActionsOutsideCore();
		const baseline = fs.existsSync(BASELINE_PATH)
			? parseBaseline(fs.readFileSync(BASELINE_PATH, "utf8"))
			: [];

		const foundIds = found.map((x) => x.id);
		const { added } = diffIds(foundIds, baseline);
		const foundMap = new Map(found.map((x) => [x.id, path.relative(path.resolve(__dirname, "../../.."), x.filePath).replace(/\\/g, "/")]));
		const details = added.map((id) => `${id} in ${foundMap.get(id)}`).join(", ");

		expect(
			added,
			`Unexpected action(s) defined outside @ahkms/core: ${details}. define new actions in packages/core/src/actions (ADR-105 R1); adding a baseline line is an architect decision.`,
		).toEqual([]);
	});

	it("Case 3: baseline minus found is empty (delete lines when actions move to core)", () => {
		const found = scanActionsOutsideCore();
		const baseline = fs.existsSync(BASELINE_PATH)
			? parseBaseline(fs.readFileSync(BASELINE_PATH, "utf8"))
			: [];

		const foundIds = found.map((x) => x.id);
		const { stale } = diffIds(foundIds, baseline);

		expect(
			stale,
			`delete these lines from actions-outside-core-baseline.txt, the action has moved to core: ${stale.join(", ")}`,
		).toEqual([]);
	});

	it("Case 4: if the baseline file holds no ids it must not exist; when it does not exist, found must be empty (strict mode)", () => {
		if (fs.existsSync(BASELINE_PATH)) {
			const raw = fs.readFileSync(BASELINE_PATH, "utf8");
			const parsed = parseBaseline(raw);
			expect(
				parsed.length,
				"actions-outside-core-baseline.txt holds no ids and must be deleted once empty",
			).toBeGreaterThan(0);
		} else {
			const found = scanActionsOutsideCore();
			expect(
				found,
				"strict mode: baseline file is deleted, so no defineAction calls are permitted outside @ahkms/core",
			).toEqual([]);
		}

		// Pure unit assertion for strict mode when baseline does not exist
		const simulatedFound = [{ id: "new_action", filePath: "packages/mcp-server/src/tools/new.ts" }];
		const emptyBaseline: string[] = [];
		const diff = diffIds(simulatedFound.map((x) => x.id), emptyBaseline);
		expect(diff.added).toEqual(["new_action"]);
	});

	it("Case 5: calls of core factories are not counted; only defineAction({ is", () => {
		const fixture = `
			import { createNotionSearchAction } from "@ahkms/core";
			import { createGithubIssueCreateActionWithDeps } from "@ahkms/core";
			export const notionSearch = createNotionSearchAction(notionAdapter);
			export const issueCreate = createGithubIssueCreateActionWithDeps();
		`;
		const results = extractDefineActionIds(fixture, "tools/searchNotion.ts");
		expect(results).toEqual([]);

		const searchNotionPath = path.resolve(__dirname, "../tools/searchNotion.ts");
		if (fs.existsSync(searchNotionPath)) {
			const content = fs.readFileSync(searchNotionPath, "utf8");
			const extracted = extractDefineActionIds(content, searchNotionPath);
			expect(extracted).toEqual([]);
		}
	});

	it("Case 6: pure diffIds returns added and stale; a fixture with one new and one stale id reports both", () => {
		const found = ["alpha", "beta"];
		const baseline = ["beta", "gamma"];
		const diff = diffIds(found, baseline);
		expect(diff).toEqual({
			added: ["alpha"],
			stale: ["gamma"],
		});
	});
});
