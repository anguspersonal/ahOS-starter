/**
 * Ports for entity relationship management interactions (ADR-101 §1, §4, ADR-105 R1, R7).
 * Pure types only. No external SDKs, database, or environment dependencies.
 */

import type { ActionContext } from "../actions/types.js";
import type {
	RelationshipCrudInput,
	RelationshipCrudOutput,
} from "../actions/domain/relationships.js";

export type {
	RelationshipCrudOutput,
};

export interface RelationshipsPort {
	relationshipCrud(input: RelationshipCrudInput, ctx?: ActionContext): Promise<RelationshipCrudOutput>;
}
