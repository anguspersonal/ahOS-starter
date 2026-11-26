/**
 * Isomorphic entity merge property union, validators, and record contract (#1663).
 * Source twin: packages/shared/src/constants/entityProperties.ts and types/entities.ts.
 */

const nonEmptyString = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export const ENTITY_PROPERTY_VALIDATORS: Record<
	string,
	Record<string, (val: unknown) => boolean>
> = {
	people: {
		email: nonEmptyString,
		phone: nonEmptyString,
		role: nonEmptyString,
		organization: nonEmptyString,
		relationship: nonEmptyString,
		last_contact: nonEmptyString,
		homepage: nonEmptyString,
	},
	organization: {
		legal_name: nonEmptyString,
		url: nonEmptyString,
		email: nonEmptyString,
		telephone: nonEmptyString,
		address: nonEmptyString,
	},
	place: {
		place_type: nonEmptyString,
		address: nonEmptyString,
		geo: nonEmptyString,
	},
	event: {
		date: nonEmptyString,
		attendees: nonEmptyString,
		start_date: nonEmptyString,
		end_date: nonEmptyString,
		location: nonEmptyString,
	},
	term: {
		expansion: nonEmptyString,
		context: nonEmptyString,
		local_name: nonEmptyString,
		namespace: nonEmptyString,
	},
};

export interface MergePropertiesResult {
	mergedProperties: Record<string, unknown>;
	carriedKeys: string[];
	skippedKeys: Record<string, string>;
}

export interface EntityMergeRecord {
	op_id: string;
	merged_at: string;
	winner_id: string;
	moved_edge_ids: string[];
	archived_edge_ids: string[];
	aliases_added: string[];
	properties_carried: string[];
	properties_skipped?: Record<string, string>;
	links_moved: string[];
	links_deleted: string[];
	demoted_edge_types?: Record<string, string>;
}

const SYSTEM_KEYS = new Set([
	"aliases",
	"merged_into",
	"merged_at",
	"archived_reason",
	"_merge",
]);

export function mergeEntityProperties(
	winnerType: string,
	winnerProps: Record<string, unknown> | null | undefined,
	loserProps: Record<string, unknown> | null | undefined,
): MergePropertiesResult {
	const winner = { ...(winnerProps || {}) };
	const loser = loserProps || {};
	const carriedKeys: string[] = [];
	const skippedKeys: Record<string, string> = {};

	for (const [key, val] of Object.entries(loser)) {
		if (!key || SYSTEM_KEYS.has(key) || key.startsWith("_")) {
			continue;
		}

		const winnerVal = winner[key];
		const winnerHasValue =
			winnerVal !== undefined &&
			winnerVal !== null &&
			!(typeof winnerVal === "string" && winnerVal.trim() === "");

		if (winnerHasValue) {
			skippedKeys[key] = "conflict_winner_preferred";
			continue;
		}

		const isScalar =
			typeof val === "string" || typeof val === "number" || typeof val === "boolean";

		if (!isScalar) {
			skippedKeys[key] = "non_scalar";
			continue;
		}

		const typeValidators = ENTITY_PROPERTY_VALIDATORS[winnerType];
		if (typeValidators && typeValidators[key] && !typeValidators[key](val)) {
			skippedKeys[key] = "schema_invalid";
			continue;
		}

		winner[key] = val;
		carriedKeys.push(key);
	}

	return {
		mergedProperties: winner,
		carriedKeys,
		skippedKeys,
	};
}
