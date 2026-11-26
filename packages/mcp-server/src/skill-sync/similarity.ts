import { canonicalize } from "./hash.js";

// Body-similarity scoring to SUGGEST mappings from upstream skills to local forks
// (#375). Only ever used to rank candidates for a human to confirm — never to decide
// — so a cheap token-set (Jaccard) similarity on canonicalised bodies is plenty. It
// need not be semantic, just good enough to float the obvious fork above the noise
// (e.g. to-tickets↔to-issues, grill-with-docs↔grill-with-docs) despite name drift.

/** Tokenise to lowercased word-ish runs, dropping fenced code (boilerplate skews similarity). */
export function tokens(text: string): Set<string> {
	return new Set(
		canonicalize(text)
			.toLowerCase()
			.replace(/```[\s\S]*?```/g, " ")
			.split(/[^a-z0-9]+/)
			.filter((t) => t.length > 2),
	);
}

/** Jaccard similarity of two bodies' token sets, in [0, 1]. */
export function bodySimilarity(a: string, b: string): number {
	const sa = tokens(a);
	const sb = tokens(b);
	if (sa.size === 0 && sb.size === 0) return 1;
	let inter = 0;
	for (const t of sa) if (sb.has(t)) inter++;
	const union = sa.size + sb.size - inter;
	return union === 0 ? 0 : inter / union;
}

export interface MappingSuggestion {
	/** Upstream skill identifier (name or path). */
	upstream: string;
	/** Best local fork over threshold, or null → treat as a new import. */
	local: string | null;
	score: number;
	/**
	 * How `local` was chosen: `"name"` for an exact (case-insensitive) name match — the
	 * decisive fork signal, taken regardless of body score — or `"body"` for a similarity
	 * match over `threshold`. Absent when `local` is null. Lets a caller show an honest
	 * reason beside a low `score`: a diverged same-named fork maps by name, not by overlap.
	 */
	matchedBy?: "name" | "body";
	runnerUp?: { local: string; score: number };
}

/**
 * For each upstream skill, suggest the best local fork. An exact (case-insensitive) name
 * match is the strongest signal and wins outright — a same-named local IS the fork even
 * when its body has drifted below `threshold` (a short upstream `grill-me` vs a long,
 * rewritten local `grill-me`). Otherwise the best body match over `threshold` wins, and a
 * weak best (below it) yields `local: null` — "probably a new skill to import". Returns
 * ranked suggestions for a human to confirm; it never writes a mapping. The `score` stays
 * the real body similarity even for a name match, so the caller can report it honestly.
 */
export function suggestMappings(
	upstream: { name: string; body: string }[],
	local: { name: string; body: string }[],
	threshold = 0.2,
): MappingSuggestion[] {
	return upstream.map((u) => {
		const uName = u.name.toLowerCase();
		const scored = local
			.map((l) => ({
				local: l.name,
				score: bodySimilarity(u.body, l.body),
				nameMatch: l.name.toLowerCase() === uName,
			}))
			// Name matches first (the decisive signal), then by descending body similarity.
			.sort((a, b) => Number(b.nameMatch) - Number(a.nameMatch) || b.score - a.score);
		const best = scored[0];
		// A name match is never demoted to an import, however far its body has drifted.
		if (!best || (!best.nameMatch && best.score < threshold)) {
			return { upstream: u.name, local: null, score: best?.score ?? 0 };
		}
		const runnerUp = scored[1] && { local: scored[1].local, score: scored[1].score };
		return {
			upstream: u.name,
			local: best.local,
			score: best.score,
			matchedBy: best.nameMatch ? "name" : "body",
			runnerUp,
		};
	});
}
