/**
 * Pattern matching helper for system learning.
 *
 * This is intentionally simple for Phase 1:
 * - Case-insensitive keyword matching
 * - Flexible match: at least one meaningful keyword must appear
 */
export function patternMatches(pattern: string, contextDesc: string): boolean {
	const patternLower = (pattern || '').toLowerCase().replace(/_/g, ' ').trim();
	const contextLower = (contextDesc || '').toLowerCase();

	if (!patternLower) return false;

	// Split pattern into keywords (words longer than 3 characters)
	const patternKeywords = patternLower.split(/\s+/).filter(w => w.length > 3);

	// If no keywords after filtering, check if pattern is a substring
	if (patternKeywords.length === 0) {
		return contextLower.includes(patternLower);
	}

	// Check if at least one keyword matches (flexible, Phase 1 behavior)
	return patternKeywords.some(keyword => contextLower.includes(keyword));
}

