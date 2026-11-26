// Split a list into consecutive groups of at most `size` (the last may be shorter).
// Shared by the connector discover cadences to batch items for ingest_discover,
// which caps a single call at 200. Kept dependency-free so a cadence can import it
// without pulling in a sibling connector's module graph.
export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}
