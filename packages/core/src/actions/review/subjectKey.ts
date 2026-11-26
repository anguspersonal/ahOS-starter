export function pairKey(a: string, b: string): string {
	return a < b ? `${a}::${b}` : `${b}::${a}`;
}

export function relationshipSubjectKey(
	entityA: string,
	entityB: string,
	relationshipType: string,
): string {
	return `${pairKey(entityA, entityB)}::${relationshipType}`;
}

export function subjectKey(
	decisionType: string,
	payload: Record<string, unknown> | null | undefined,
): string {
	const p = payload ?? {};
	if (decisionType === "relationship_suggested") {
		const fromId =
			typeof p.fromEntityId === "string"
				? p.fromEntityId
				: typeof p.from_entity_id === "string"
					? p.from_entity_id
					: "";
		const toId =
			typeof p.toEntityId === "string"
				? p.toEntityId
				: typeof p.to_entity_id === "string"
					? p.to_entity_id
					: "";
		const relType =
			typeof p.relationshipType === "string"
				? p.relationshipType
				: typeof p.relationship_type === "string"
					? p.relationship_type
					: "";
		if (!fromId || !toId || !relType) {
			throw new Error("relationship_suggested decision is missing entity ids or relationship type");
		}
		return relationshipSubjectKey(fromId, toId, relType);
	}
	if (decisionType === "merge_suggested") {
		const winnerId =
			typeof p.winnerEntityId === "string"
				? p.winnerEntityId
				: typeof p.winner_entity_id === "string"
					? p.winner_entity_id
					: "";
		const loserId =
			typeof p.loserEntityId === "string"
				? p.loserEntityId
				: typeof p.loser_entity_id === "string"
					? p.loser_entity_id
					: "";
		if (!winnerId || !loserId) {
			throw new Error("merge_suggested decision is missing entity ids");
		}
		return pairKey(winnerId, loserId);
	}
	throw new Error(`no subject key for ${decisionType} yet`);
}
