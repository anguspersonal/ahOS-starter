import type { HotTierRow } from "./hotTier.js";

/**
 * Timeout budget for each per-session handshake read (#1714).
 * Prevents a cold connection pooler or stalled Supabase query from
 * holding open the MCP initialize handshake past client connect timeouts (30s).
 */
export const HANDSHAKE_READ_TIMEOUT_MS = 3000;

export interface HandshakeLoaders {
	loadToneRules: () => Promise<string[]>;
	loadHotTier: () => Promise<HotTierRow[]>;
}

export interface LoadHandshakeReadsOptions {
	timeoutMs?: number;
	loaders?: Partial<HandshakeLoaders>;
}

export type HandshakeReadsResult = [string[], HotTierRow[]] & {
	toneRules: string[];
	hotRows: HotTierRow[];
	durationMs: number;
};

async function readWithTimeout<T>(
	name: string,
	loader: () => Promise<T[]>,
	timeoutMs: number,
): Promise<T[]> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeoutPromise = new Promise<"timed_out">((resolve) => {
		timer = setTimeout(() => resolve("timed_out"), timeoutMs);
	});

	try {
		const loadPromise = (async () => {
			try {
				return await loader();
			} catch (err) {
				console.error(`[mcp-http] handshake read '${name}' failed:`, err);
				return [] as T[];
			}
		})();

		const outcome = await Promise.race([loadPromise, timeoutPromise]);

		if (outcome === "timed_out") {
			console.error(
				`[mcp-http] handshake read '${name}' timed out after ${timeoutMs}ms; degrading to []`,
			);
			return [];
		}

		return outcome;
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

async function resolveLoaders(
	partialLoaders?: Partial<HandshakeLoaders>,
): Promise<HandshakeLoaders> {
	if (partialLoaders?.loadToneRules && partialLoaders?.loadHotTier) {
		return {
			loadToneRules: partialLoaders.loadToneRules,
			loadHotTier: partialLoaders.loadHotTier,
		};
	}

	const [{ loadToneRules }, { loadHotTier }] = await Promise.all([
		import("./dosConfig.js"),
		import("./hotTier.js"),
	]);

	return {
		loadToneRules: partialLoaders?.loadToneRules ?? loadToneRules,
		loadHotTier: partialLoaders?.loadHotTier ?? loadHotTier,
	};
}

/**
 * Execute the two per-session MCP handshake reads (tone rules and hot tier) in parallel,
 * bounding each read by HANDSHAKE_READ_TIMEOUT_MS (3000 ms).
 *
 * If either read times out or rejects, it degrades to [] and logs one [mcp-http] line to stderr.
 */
export async function loadHandshakeReads(
	options?: LoadHandshakeReadsOptions,
): Promise<HandshakeReadsResult> {
	const timeoutMs = options?.timeoutMs ?? HANDSHAKE_READ_TIMEOUT_MS;
	const loaders = await resolveLoaders(options?.loaders);

	const startTime = Date.now();
	const [toneRules, hotRows] = await Promise.all([
		readWithTimeout("loadToneRules", loaders.loadToneRules, timeoutMs),
		readWithTimeout("loadHotTier", loaders.loadHotTier, timeoutMs),
	]);
	const durationMs = Date.now() - startTime;

	const result = [toneRules, hotRows] as HandshakeReadsResult;
	result.toneRules = toneRules;
	result.hotRows = hotRows;
	result.durationMs = durationMs;

	return result;
}
