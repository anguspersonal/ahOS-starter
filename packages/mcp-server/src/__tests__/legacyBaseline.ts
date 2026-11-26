// The one reader of packages/mcp-server/legacy-tools-baseline.txt for tests (#2338).
// ADR-105 deletes the file once its last entry migrates, so an absent file reads as [].
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEGACY_BASELINE_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../legacy-tools-baseline.txt",
);

/** Trimmed, non-empty, non-comment lines of a baseline file, sorted. */
export function parseLegacyBaseline(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"))
		.sort();
}

/** Parsed baseline entries, or [] when the file does not exist. */
export function readLegacyBaseline(filePath: string = LEGACY_BASELINE_PATH): string[] {
	if (!fs.existsSync(filePath)) return [];
	return parseLegacyBaseline(fs.readFileSync(filePath, "utf8"));
}
