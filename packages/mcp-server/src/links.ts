import { createSupabaseExternalLinkRepository } from "@ahkms/core/adapters";
import { DOMAIN_PROVIDER } from "./domains.js";
import { supabase } from "./supabase.js";
import { getCurrentUserId } from "./identity.js";
import { externalItemWasCreated } from "./outwardWrite.js";

export {
	COVERAGE_ARTIFACT_PAGE_SIZE,
	COVERAGE_MAX_ATOMS_PER_DAY,
	PENDING_EXTERNAL_ID,
	computeStreak,
	enumerateDays,
	interruptedClaimMessage,
	isUncoveredDay,
	type ClaimResult,
	type DailyLogMarkers,
	type DailyLogQueueEntry,
	type DedupSlotState,
	type DosEvidenceAggregateDay,
	type DosEvidenceAggregateGroup,
	type DosEvidenceAggregateItem,
	type DosEvidenceAggregateLateArrival,
	type DosEvidenceAggregateParams,
	type DosEvidenceAggregateRow,
	type ExternalLink,
	type ExternalLinkRepository,
	type SynthesisCoverageDay,
	type SynthesisStreak,
} from "@ahkms/core/adapters";

export const externalLinks = createSupabaseExternalLinkRepository({
	client: {
		from: (table: string) => supabase.from(table),
		rpc: (fn: string, params?: Record<string, unknown>) => supabase.rpc(fn, params),
	},
	ownerId: getCurrentUserId,
	externalItemWasCreated,
	domainProvider: DOMAIN_PROVIDER,
});

export const {
	recordExternalLink,
	getArtifactContentSubtype,
	getExternalLinks,
	inspectDedupSlot,
	claimDedupSlot,
	finalizeExternalLink,
	releaseClaimForFailedWrite,
	scopeToDomain,
	getSynthesizedArtifactIds,
	getSynthesisCoverage,
	getStreak,
	getDailyLogQueue,
	getDosEvidenceAggregate,
} = externalLinks;
