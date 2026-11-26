import {
	assertDuePropertyUsable,
	buildNotionProperties as coreBuildNotionProperties,
	type CreateTaskPropertiesInput,
	DEFAULT_PRIORITY_CANDIDATES,
	DEFAULT_PROPERTY_NAMES,
	type DefaultPriorityPick,
	formatAvailableProperties,
	type NotionDatabaseProperty,
	type NotionDatabaseSchema,
	pickDefaultPriority,
	PRIORITY_TIERS,
	type PriorityTier,
	type PriorityTierResolution,
	priorityLevelToLegacyTier,
	type RelationInput,
	resolvePriorityLevel,
	resolvePriorityTier,
	resolvePropertyName,
} from "@ahkms/core";
import { retrieveDatabaseSchema } from "../notion.js";

export {
	assertDuePropertyUsable,
	type CreateTaskPropertiesInput,
	DEFAULT_PRIORITY_CANDIDATES,
	DEFAULT_PROPERTY_NAMES,
	type DefaultPriorityPick,
	formatAvailableProperties,
	type NotionDatabaseProperty,
	type NotionDatabaseSchema,
	pickDefaultPriority,
	PRIORITY_TIERS,
	type PriorityTier,
	type PriorityTierResolution,
	priorityLevelToLegacyTier,
	type RelationInput,
	resolvePriorityLevel,
	resolvePriorityTier,
	resolvePropertyName,
};

export async function buildNotionProperties(opts: {
	tasksDatabaseId: string;
	propertyMap: Record<string, string>;
	properties: CreateTaskPropertiesInput;
	defaultOwnerPersonId?: string;
	schema?: NotionDatabaseSchema;
}): Promise<Record<string, unknown>> {
	return coreBuildNotionProperties({
		...opts,
		loadSchema: retrieveDatabaseSchema,
	});
}
