import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export interface LoadLegacyWorkerAppOptions {
	cwd?: string;
	exists?: (candidatePath: string) => boolean;
	load?: (candidatePath: string) => unknown;
}

export interface LoadLegacyWorkerAppResult {
	loaded: boolean;
	path: string | null;
}

const defaultRequire = createRequire(import.meta.url);

export function loadLegacyWorkerApp(
	options: LoadLegacyWorkerAppOptions = {},
): LoadLegacyWorkerAppResult {
	const cwd = options.cwd ?? process.cwd();
	const exists = options.exists ?? ((p: string) => fs.existsSync(p));
	const load = options.load ?? ((p: string) => defaultRequire(p));

	const candidates = [
		path.resolve(cwd, "packages/worker/app.js"),
		path.resolve(cwd, "app.js"),
	];

	for (const candidate of candidates) {
		if (!exists(candidate)) {
			continue;
		}
		console.log(`[ahOS Engine] Loading legacy worker routes from: ${candidate}`);
		try {
			load(candidate);
			return { loaded: true, path: candidate };
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`legacy worker app at ${candidate} failed to load: ${detail}`, {
				cause: err,
			});
		}
	}

	return { loaded: false, path: null };
}
