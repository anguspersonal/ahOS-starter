/**
 * Structural exclusion for CV sweep evidence (#1246, ADR-099 §3, .claude/skills/cv/SKILL.md rule 2).
 *
 * The cv sweep must never read back one of the owner's own CVs as evidence.
 * Renders and job descriptions carry content_subtype cv_render / job_description,
 * but no read tool shows content_subtype.
 *
 * Relying solely on title ("CV render") and tags ("cv_render", "job_description") misses
 * two classes of atoms:
 * 1. Drive-discovered twins of renders: pointers created by Drive discover for the same
 *    underlying Drive files (they have no "CV render" in title and no tags).
 * 2. Copies of old CVs minted by duplication loops (#1219): fresh pointers with new capture
 *    timestamps inside the monthly sweep window.
 *
 * The exclusion is therefore structural (#1246):
 * - Any artifact whose Drive file ID matches a tracked CV document's canonical copy, rendition,
 *   or linked version.
 * - Any artifact tagged doc:<kind> for a tracked CV document (cv, cv_master) or linked to a
 *   tracked document of those kinds, even when its title does not say "CV render".
 * - Any artifact tagged cv_render or job_description, or with a title containing "CV render" or
 *   ending ": job description".
 */

export interface TrackedCvDocumentContext {
	/** Tracked document entity IDs (e.g. for cv, cv_master). */
	trackedEntityIds: Set<string>;
	/** Tracked document kinds (e.g. "cv", "cv_master"). */
	trackedDocKinds: Set<string>;
	/** Known Drive file IDs of canonical copies, renditions, and linked versions. */
	driveFileIds: Set<string>;
	/** Known artifact IDs of canonical copies, renditions, and linked versions. */
	linkedArtifactIds: Set<string>;
}

export interface CandidateArtifactForCvSweep {
	id: string;
	title?: string | null;
	tags?: string[] | null;
	linkedEntityIds?: string[] | null;
	sourceDriveFileId?: string | null;
	sourceUrl?: string | null;
	storageUrl?: string | null;
	source?: string | null;
	externalId?: string | null;
}

export interface CvSweepExclusionResult {
	excluded: boolean;
	reason?: string;
}

/** Extracts a Google Drive file ID from a URL or raw ID string. */
export function extractDriveFileId(str: string | null | undefined): string | null {
	if (!str) return null;
	const trimmed = str.trim();
	// Drive/Docs URL patterns:
	// https://drive.google.com/file/d/<id>/view
	// https://docs.google.com/document/d/<id>/edit
	// https://drive.google.com/open?id=<id>
	const matchD = trimmed.match(/\/d\/([a-zA-Z0-9_-]+)/);
	if (matchD) return matchD[1];
	const matchId = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
	if (matchId) return matchId[1];
	// Raw Drive ID: typically 28-44 chars alphanumeric, hyphens, underscores
	if (/^[a-zA-Z0-9_-]{20,}$/.test(trimmed)) {
		return trimmed;
	}
	return null;
}

/**
 * Evaluates whether an artifact candidate must be excluded from CV sweep evidence.
 */
export function isCvSweepEvidenceExcluded(
	candidate: CandidateArtifactForCvSweep,
	context: TrackedCvDocumentContext,
): CvSweepExclusionResult {
	// 1. Structural check: does the candidate match a known tracked CV artifact ID?
	if (context.linkedArtifactIds.has(candidate.id)) {
		return {
			excluded: true,
			reason: `Artifact ${candidate.id} is an existing canonical, rendition, or linked version of a tracked CV document`,
		};
	}

	// 2. Structural check: Drive file ID match (catches Drive-discovered twins).
	const candidateDriveIds = [
		candidate.sourceDriveFileId,
		extractDriveFileId(candidate.sourceDriveFileId),
		extractDriveFileId(candidate.sourceUrl),
		extractDriveFileId(candidate.storageUrl),
		extractDriveFileId(candidate.source),
		extractDriveFileId(candidate.externalId),
	].filter((id): id is string => Boolean(id));

	for (const driveId of candidateDriveIds) {
		if (context.driveFileIds.has(driveId)) {
			return {
				excluded: true,
				reason: `Drive file id ${driveId} matches a tracked CV's canonical or rendition artifact`,
			};
		}
	}

	// 3. Structural check: is it linked to a tracked CV entity?
	if (candidate.linkedEntityIds && candidate.linkedEntityIds.length > 0) {
		for (const entityId of candidate.linkedEntityIds) {
			if (context.trackedEntityIds.has(entityId)) {
				return {
					excluded: true,
					reason: `Artifact is linked to tracked CV document entity ${entityId}`,
				};
			}
		}
	}

	// 4. Structural tag check: tagged doc:<kind> for tracked CV doc kinds (cv, cv_master).
	const candidateTags = (candidate.tags ?? []).map((t) => t.toLowerCase().trim());
	for (const tag of candidateTags) {
		if (tag.startsWith("doc:")) {
			const kind = tag.slice(4);
			if (context.trackedDocKinds.has(kind) || kind === "cv" || kind === "cv_master") {
				return {
					excluded: true,
					reason: `Tagged ${tag} for a tracked CV document`,
				};
			}
		}
		if (tag === "cv_render" || tag === "job_description") {
			return {
				excluded: true,
				reason: `Tagged ${tag}`,
			};
		}
	}

	// Golden tag beside any doc:cv tag
	if (candidateTags.includes("golden") && candidateTags.some((t) => t.startsWith("doc:cv"))) {
		return {
			excluded: true,
			reason: "Tagged golden for a tracked CV document",
		};
	}

	// 5. Title marker checks: "CV render" in title or ending ": job description".
	const title = candidate.title ?? "";
	if (/cv\s*render/i.test(title)) {
		return {
			excluded: true,
			reason: `Title contains "CV render": "${title}"`,
		};
	}
	if (/:\s*job\s+description$/i.test(title.trim())) {
		return {
			excluded: true,
			reason: `Title ends with ": job description": "${title}"`,
		};
	}

	return { excluded: false };
}
