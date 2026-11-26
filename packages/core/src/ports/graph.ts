export interface GraphEdgeRecord {
	from_entity_id: string;
	to_entity_id: string;
	relationship_type: string;
	valid_from?: string | null;
	valid_to?: string | null;
	archived?: boolean | null;
}

export interface GraphEntityNode {
	id: string;
	title: string;
	entity_type: string;
}

export interface ListGraphEdgesInput {
	userId: string;
	frontier: string[];
	direction: "out" | "in";
	edgeTypes?: string[];
	includeArchived?: boolean;
	asOf?: string;
}

export interface ListArtifactHopsInput {
	userId: string;
	frontier: string[];
}

export interface GetGraphEntitiesInput {
	userId: string;
	ids: string[];
}

export interface GraphEdgePort {
	listEdges(input: ListGraphEdgesInput): Promise<GraphEdgeRecord[]>;
	listArtifactHops(input: ListArtifactHopsInput): Promise<GraphEdgeRecord[]>;
	getEntities?(input: GetGraphEntitiesInput): Promise<GraphEntityNode[]>;
}

export function isGraphEdgeValidAt(
	validFrom: string | null | undefined,
	validTo: string | null | undefined,
	asOf: string,
): boolean {
	const asOfMs = new Date(asOf).getTime();
	if (validFrom !== null && validFrom !== undefined && new Date(validFrom).getTime() > asOfMs) {
		return false;
	}
	if (validTo !== null && validTo !== undefined && new Date(validTo).getTime() <= asOfMs) {
		return false;
	}
	return true;
}
