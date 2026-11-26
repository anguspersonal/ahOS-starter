/**
 * Every literal `source_channel` a writer in packages/ can stamp must pass the
 * database's own `artifacts_source_channel_check` (#1208).
 *
 * drive_import_file / drive_ingest wrote `source_channel: "google-drive"` for as
 * long as they existed. The CHECK allows a short enumerated list or
 * `^[a-z_]+$`, so the hyphen rejected every insert and on-demand Drive import
 * never wrote a single row (migration 091's header counts zero). Nothing in CI
 * could see it: every test mocks Supabase, and a mock accepts any string.
 *
 * So this suite asks the question statically, the way check-artifact-surface-
 * writes.js does for `surface`: read the CHECK out of the committed migrations,
 * collect every string literal a `source_channel:` property can take across the
 * production sources of every package, and require each one to pass. A new
 * writer that invents a hyphenated or capitalised channel fails here, not in
 * production.
 */
import { createRequire } from "node:module";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { discoverInput } from "@ahkms/core";
import { DEFAULT_CAPTURE_PREFERENCES } from "../captureConfig.js";

const require = createRequire(import.meta.url);
const { readPackageFiles, isTestPath, PACKAGES_DIR } = require(
	"../../../../scripts/check-artifact-surface-writes.js",
) as {
	readPackageFiles: (dir: string) => { relPath: string; source: string }[];
	isTestPath: (relPosixPath: string) => boolean;
	PACKAGES_DIR: string;
};

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "../../../../supabase/migrations");

/**
 * The CHECK as the NEWEST migration that (re)adds it defines it, so a later
 * migration that widens or narrows the constraint moves this test with it.
 */
function loadSourceChannelCheck(): { allowed: string[]; pattern: RegExp; file: string } {
	const defining = readdirSync(migrationsDir)
		.filter((f) => f.endsWith(".sql"))
		.sort()
		.map((f) => ({ file: f, sql: readFileSync(join(migrationsDir, f), "utf8") }))
		.filter(({ sql }) => /add\s+constraint\s+"?artifacts_source_channel_check"?/i.test(sql));
	const latest = defining.at(-1);
	if (!latest) throw new Error("no migration defines artifacts_source_channel_check");

	const statement = latest.sql.match(
		/add\s+constraint\s+"?artifacts_source_channel_check"?\s+CHECK\s*\(([\s\S]*?)\)\s*(?:not\s+valid)?\s*;/i,
	);
	if (!statement) throw new Error(`could not parse the CHECK in ${latest.file}`);
	const body = statement[1];

	const array = body.match(/ARRAY\[([^\]]*)\]/i);
	const allowed = array ? [...array[1].matchAll(/'([^']*)'/g)].map((m) => m[1]) : [];
	const regex = body.match(/source_channel\s*~\s*'([^']*)'/i);
	if (!regex) throw new Error(`no regex arm in the CHECK in ${latest.file}`);
	return { allowed, pattern: new RegExp(regex[1]), file: latest.file };
}

/**
 * Every string literal a `source_channel:` object property can evaluate to, per
 * production file. The value is read from the property to the end of its line,
 * plus any continuation lines of a multi-line ternary (lines starting with `?` or
 * `:`), with `//` comments stripped. Only literals in RESULT position count — the
 * whole value, or a ternary branch after `?`/`:` — so the platform names a
 * ternary compares against (`=== 'ios'`) are not mistaken for channels.
 * `default_source_channel:` does not match (the lookbehind needs a non-word
 * character before `source`), and neither does a filter call like
 * `.eq("source_channel", ...)`, which has no colon.
 */
function collectSourceChannelLiterals(): { relPath: string; value: string }[] {
	const out: { relPath: string; value: string }[] = [];
	for (const { relPath, source } of readPackageFiles(PACKAGES_DIR)) {
		if (isTestPath(relPath)) continue;
		const lines = source.split(/\r?\n/);
		lines.forEach((line, i) => {
			const at = line.search(/(?<![\w.])source_channel\s*:/);
			if (at < 0) return;
			const expr = [line.slice(at).replace(/^source_channel\s*:/, "")];
			for (let j = i + 1; j < lines.length && /^\s*[?:]/.test(lines[j]); j += 1) {
				expr.push(lines[j]);
			}
			const code = expr.map((l) => l.replace(/\/\/.*$/, "")).join("\n");
			for (const m of code.matchAll(/(?:^|[?:])\s*(["'])([^"'\n]*)\1/gm)) {
				out.push({ relPath, value: m[2] });
			}
		});
	}
	return out;
}

describe("artifacts_source_channel_check vs the channels the code writes (#1208)", () => {
	const check = loadSourceChannelCheck();
	const passes = (value: string) => check.allowed.includes(value) || check.pattern.test(value);
	const literals = collectSourceChannelLiterals();

	it("reads a CHECK that can actually fail", () => {
		// Guards everything below: a parse that produced a match-anything regex would
		// make every assertion here pass vacuously.
		expect(check.pattern.source).toBe("^[a-z_]+$");
		expect(passes("google-drive")).toBe(false);
		expect(passes("Google_Drive")).toBe(false);
		expect(passes("google_drive")).toBe(true);
	});

	it("finds the known writers, so the scan is not vacuous", () => {
		const values = new Set(literals.map((l) => l.value));
		// drive_import_file (mcp-server), the worker upload path, the worker derivatives.
		for (const expected of ["google_drive", "web_upload", "phone_app", "api", "derived"]) {
			expect(values).toContain(expected);
		}
	});

	it("writes the Drive import channel as google_drive", () => {
		const coreDrive = literals.filter(
			(l) => l.relPath === "packages/core/src/actions/drive/importFile.ts",
		);
		expect(coreDrive.map((l) => l.value)).toEqual(["google_drive"]);

		const legacySharedDrive = literals.filter(
			(l) => l.relPath === "packages/mcp-server/src/tools/drive/shared.ts",
		);
		expect(legacySharedDrive.map((l) => l.value)).toEqual(["google_drive"]);
	});

	it("every literal source_channel in packages/ passes the CHECK", () => {
		const violations = literals.filter((l) => !passes(l.value)).map((l) => `${l.relPath}: "${l.value}"`);
		expect(violations).toEqual([]);
	});

	it("capture's default channel passes the CHECK", () => {
		expect(passes(DEFAULT_CAPTURE_PREFERENCES.default_source_channel)).toBe(true);
	});

	it("ingest_discover cannot build a channel that fails it (connector is pinned to [a-z_]+)", () => {
		const connector = z.object({ connector: discoverInput.connector });
		expect(connector.safeParse({ connector: "google-drive" }).success).toBe(false);
		expect(passes("discovered_gdrive_work")).toBe(true);
	});
});
