import {
  viewScreenInputSchema,
  type ViewScreenInput,
} from "@ahkms/core";
import type { ClientActionDefinition } from "./actionClient.js";
import { executeEntityCrud } from "./entityActions.js";
import {
  getScreenState,
  type GraphScreenState,
} from "./screenState.js";
import type { ActiveTab } from "./router.js";

export { viewScreenInputSchema, type ViewScreenInput };

export interface ViewScreenOutput {
  tab: ActiveTab;
  path: string;
  graph: GraphScreenState | null;
  entity: Record<string, unknown> | null;
  captured_at: string;
}

export async function runViewScreen(input: ViewScreenInput): Promise<ViewScreenOutput> {
  const state = getScreenState();
  if (!state) {
    throw new Error("No screen state available. Workspace shell has not initialized.");
  }

  let entityRecord: Record<string, unknown> | null = null;

  if (input.include_record) {
    const selectedEntity = state.graph?.selected_entity;
    if (selectedEntity) {
      if (!state.graph?.live) {
        throw new Error("Cannot hydrate entity record while graph is in fallback mode (live: false).");
      }

      const crudResult = await executeEntityCrud({
        operation: "get",
        id: selectedEntity.id,
      });

      if (!crudResult || !crudResult.found || !crudResult.entity) {
        throw new Error(`Selected entity "${selectedEntity.id}" not found.`);
      }

      entityRecord = crudResult.entity as Record<string, unknown>;
    }
  }

  return {
    tab: state.tab,
    path: state.path,
    graph: state.graph,
    entity: entityRecord,
    captured_at: state.captured_at,
  };
}

export const viewScreenActionClient: ClientActionDefinition<
  ViewScreenInput,
  ViewScreenOutput
> = {
  id: "view_screen",
  name: "View Screen",
  description:
    "Inspect the user's current screen, active workspace tab, graph selection, and filters. Call this tool before acting on 'this' or 'the selected' entity or edge to understand what the user is looking at. Set include_record to true to fetch the full database record of the selected entity.",
  schema: viewScreenInputSchema,
  run: runViewScreen,
};

