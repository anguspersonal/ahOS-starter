/**
 * Port for entity merge and reversal (`review_resolve` & `entity_unmerge`, #1498, #1663, ADR-101 §3).
 */

import type { EntityMergeRecord } from "../domain/entityMerge.js";

export interface EntityMergeRow {
	id?: string;
	entity_type: string;
	properties?: Record<string, unknown> | null;
}

export interface EntityMergeParams {
	winnerId: string;
	loserId: string;
	userId?: string;
	winnerRow: EntityMergeRow;
	loserRow: EntityMergeRow;
	finalWinnerProps: Record<string, unknown>;
	winnerAliases: string[];
	aliasesAdded: string[];
	propertiesCarried: string[];
	propertiesSkipped: Record<string, string>;
	decisionId?: string;
	resolutionNotes: string;
	survivorOverridden: boolean;
	decisionStatus?: string;
	resolvedBy?: string;
	payload?: Record<string, unknown>;
	nowIso?: string;
}

export interface EntityMergeMetadata {
	op_id?: string;
	merged_at?: string;
	winner_id?: string;
	moved_edge_ids?: string[];
	archived_edge_ids?: string[];
	aliases_added?: string[];
	properties_carried?: string[];
	properties_skipped?: Record<string, string>;
	links_moved?: string[];
	links_deleted?: string[];
	demoted_edge_types?: Record<string, string>;
}

export interface EntityMergeLoserRow {
	id: string;
	title?: string | null;
	description?: string | null;
	archived?: boolean | null;
	archived_at?: string | null;
	user_id?: string | null;
	properties?: (Record<string, unknown> & { _merge?: EntityMergeMetadata }) | null;
}

export interface UnmergeExecutionResult {
	success: boolean;
	loser_id: string;
	winner_id: string;
	loser_title: string | null;
	loser_description: string | null;
	loser_properties: Record<string, unknown>;
	winner_title: string | null;
	winner_description: string | null;
	winner_properties: Record<string, unknown>;
	moved_edge_ids?: string[];
	archived_edge_ids?: string[];
	type_restored_count?: number;
	links_moved?: string[];
	aliases_removed?: string[];
	properties_removed?: string[];
}

export interface EntityMergePort {
	findLoserById(id: string, userId: string): Promise<EntityMergeLoserRow | null>;
	findLoserByOpId(opId: string, userId: string): Promise<EntityMergeLoserRow | null>;
	unmerge(loserId: string, userId: string): Promise<UnmergeExecutionResult>;
	merge(params: EntityMergeParams): Promise<EntityMergeRecord | undefined>;
}
