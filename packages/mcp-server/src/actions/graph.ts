import { createGraphNodeLevelAction } from "@ahkms/core/actions";
import { supabase } from "../supabase.js";
import { getCurrentUserId } from "../identity.js";

/**
 * Server-side CAR action definition for graph_node_level (#1448).
 * Wires the core action factory to the service-role Supabase client and owner identity seam.
 */
export const graphNodeLevelAction = createGraphNodeLevelAction({
	supabase,
	getUserId: () => getCurrentUserId(),
});
