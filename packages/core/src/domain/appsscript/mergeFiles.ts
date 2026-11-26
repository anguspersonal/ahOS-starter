import type { ScriptFile } from "../../ports/appsscript.js";

export interface IncomingScriptFile {
	name: string;
	type?: "SERVER_JS" | "HTML" | "JSON" | string;
	source: string;
}

const DEFAULT_MANIFEST_SOURCE = JSON.stringify(
	{
		timeZone: "Etc/GMT",
		exceptionLogging: "STACKDRIVER",
		runtimeVersion: "V8",
	},
	null,
	2,
);

export function createDefaultManifest(): ScriptFile {
	return {
		name: "appsscript",
		type: "JSON",
		source: DEFAULT_MANIFEST_SOURCE,
	};
}

/**
 * Normalise file name and infer file type if missing.
 */
export function normaliseScriptFile(file: IncomingScriptFile): ScriptFile {
	let name = file.name;
	let type = file.type;

	if (name === "appsscript" || name === "appsscript.json") {
		name = "appsscript";
		type = "JSON";
	} else if (name.endsWith(".gs")) {
		name = name.slice(0, -3);
		type = type ?? "SERVER_JS";
	} else if (name.endsWith(".js")) {
		name = name.slice(0, -3);
		type = type ?? "SERVER_JS";
	} else if (name.endsWith(".html")) {
		name = name.slice(0, -5);
		type = type ?? "HTML";
	} else if (!type) {
		type = "SERVER_JS";
	}

	return {
		name,
		type,
		source: file.source,
	};
}

/**
 * Merge incoming script files with existing project files.
 * - When `overwriteAll` is false (default), overlays incoming files onto existing ones by name,
 *   preserving unmentioned files and ensuring an `appsscript` JSON manifest is present.
 * - When `overwriteAll` is true, keeps only incoming files plus the existing `appsscript` JSON
 *   manifest if no manifest was supplied (or a minimal V8 manifest if none exists).
 */
export function mergeFiles(params: {
	existing: ScriptFile[];
	incoming: IncomingScriptFile[];
	overwriteAll?: boolean;
}): ScriptFile[] {
	const normalisedIncoming = params.incoming.map(normaliseScriptFile);

	if (params.overwriteAll) {
		const finalFiles = [...normalisedIncoming];
		const hasManifest = finalFiles.some((f) => f.name === "appsscript" && f.type === "JSON");
		if (!hasManifest) {
			const manifest = params.existing.find((f) => f.name === "appsscript" && f.type === "JSON");
			finalFiles.unshift(manifest ?? createDefaultManifest());
		}
		return finalFiles;
	}

	const fileMap = new Map<string, ScriptFile>();
	for (const f of params.existing) {
		if (f.name) fileMap.set(f.name, f);
	}
	for (const f of normalisedIncoming) {
		if (f.name) fileMap.set(f.name, f);
	}
	if (!fileMap.has("appsscript")) {
		fileMap.set("appsscript", createDefaultManifest());
	}
	return Array.from(fileMap.values());
}
