import { describe, expect, it } from "vitest";
import { mergeFiles, normaliseScriptFile } from "./mergeFiles.js";

describe("appsscript mergeFiles & normaliseScriptFile (#1637)", () => {
	it("1. normaliseScriptFile strips .gs/.js/.html/.json extensions and infers types", () => {
		expect(normaliseScriptFile({ name: "Code.gs", source: "a" })).toEqual({
			name: "Code",
			type: "SERVER_JS",
			source: "a",
		});
		expect(normaliseScriptFile({ name: "Helper.js", source: "b" })).toEqual({
			name: "Helper",
			type: "SERVER_JS",
			source: "b",
		});
		expect(normaliseScriptFile({ name: "Index.html", source: "<p/>" })).toEqual({
			name: "Index",
			type: "HTML",
			source: "<p/>",
		});
		expect(normaliseScriptFile({ name: "appsscript.json", source: "{}" })).toEqual({
			name: "appsscript",
			type: "JSON",
			source: "{}",
		});
		expect(normaliseScriptFile({ name: "appsscript", source: "{}" })).toEqual({
			name: "appsscript",
			type: "JSON",
			source: "{}",
		});
		expect(normaliseScriptFile({ name: "Bare", source: "c" })).toEqual({
			name: "Bare",
			type: "SERVER_JS",
			source: "c",
		});
	});

	it("2. merge mode preserves existing Code.gs and appsscript.json while adding incoming Util.gs, and replaces Code.gs on collision", () => {
		const existing = [
			{ name: "appsscript", type: "JSON", source: '{"runtimeVersion":"V8"}' },
			{ name: "Code", type: "SERVER_JS", source: "old" },
		];
		const added = mergeFiles({
			existing,
			incoming: [{ name: "Util.gs", source: "util" }],
		});
		expect(added).toEqual([
			{ name: "appsscript", type: "JSON", source: '{"runtimeVersion":"V8"}' },
			{ name: "Code", type: "SERVER_JS", source: "old" },
			{ name: "Util", type: "SERVER_JS", source: "util" },
		]);

		const replaced = mergeFiles({
			existing,
			incoming: [{ name: "Code.gs", source: "new" }],
		});
		expect(replaced).toEqual([
			{ name: "appsscript", type: "JSON", source: '{"runtimeVersion":"V8"}' },
			{ name: "Code", type: "SERVER_JS", source: "new" },
		]);
	});

	it("3. overwrite_all: true keeps existing manifest when none supplied, or adds minimal V8 manifest when none exists", () => {
		const existingWithManifest = [
			{ name: "appsscript", type: "JSON", source: '{"timeZone":"America/New_York"}' },
			{ name: "Legacy", type: "SERVER_JS", source: "gone" },
		];
		const kept = mergeFiles({
			existing: existingWithManifest,
			incoming: [{ name: "Fresh.gs", source: "fresh" }],
			overwriteAll: true,
		});
		expect(kept).toEqual([
			{ name: "appsscript", type: "JSON", source: '{"timeZone":"America/New_York"}' },
			{ name: "Fresh", type: "SERVER_JS", source: "fresh" },
		]);

		const addedDefault = mergeFiles({
			existing: [{ name: "Legacy", type: "SERVER_JS", source: "gone" }],
			incoming: [{ name: "Fresh.gs", source: "fresh" }],
			overwriteAll: true,
		});
		expect(addedDefault).toHaveLength(2);
		expect(addedDefault[0]?.name).toBe("appsscript");
		expect(addedDefault[0]?.type).toBe("JSON");
		expect(JSON.parse(addedDefault[0]!.source!)).toEqual({
			timeZone: "Etc/GMT",
			exceptionLogging: "STACKDRIVER",
			runtimeVersion: "V8",
		});
		expect(addedDefault[1]).toEqual({ name: "Fresh", type: "SERVER_JS", source: "fresh" });
	});
});
