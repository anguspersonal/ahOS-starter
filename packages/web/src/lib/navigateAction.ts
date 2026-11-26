import { z } from "zod";
import { type ClientActionDefinition, executeActionClient } from "./actionClient.js";
import {
  hasTabChangeListeners,
  navigateToTab,
  PATH_TO_TAB,
  TAB_PATHS,
  type ActiveTab,
} from "./router.js";
import {
  requestGraphEntitySelection,
  setScreenTab,
} from "./screenState.js";

export const ACTIVE_TABS = [
  "documents",
  "inbox",
  "decisions",
  "fresh",
  "dashboard",
  "chat",
  "visual-meaning",
  "graph",
  "job-hunt",
  "settings",
  "dos_config",
] as const;

export type NavigateTab = (typeof ACTIVE_TABS)[number];

const SETTINGS_TAB_PATHS: Record<string, string> = {
  settings: "/settings",
  dos_config: "/settings",
};

const SETTINGS_PATH_ALIASES: Record<string, string> = {
  "/settings": "settings",
  "/dos-config": "settings",
  "/dos_config": "settings",
};

/**
 * Registers the Settings / DOS Config routes into the workspace router tables.
 */
export function registerSettingsNavigationRoutes(): void {
  const tabPaths = TAB_PATHS as Record<string, string>;
  for (const [tab, path] of Object.entries(SETTINGS_TAB_PATHS)) {
    tabPaths[tab] = path;
  }
  const pathToTab = PATH_TO_TAB as Record<string, ActiveTab>;
  for (const [path, tab] of Object.entries(SETTINGS_PATH_ALIASES)) {
    pathToTab[path] = tab as ActiveTab;
  }
}

registerSettingsNavigationRoutes();

export const navigateInputSchema = z
  .object({
    tab: z
      .enum(ACTIVE_TABS)
      .describe("Target workspace tab to switch to"),
    entity_id: z
      .string()
      .min(1)
      .optional()
      .describe("Optional entity UUID to select in the knowledge graph"),
  })
  .strict();

export type NavigateInput = z.infer<typeof navigateInputSchema>;

export interface NavigateOutput {
  success: boolean;
  tab: NavigateTab;
  path: string;
  entity_id?: string;
  error?: string;
  message: string;
}

export const navigateActionClient: ClientActionDefinition<
  NavigateInput,
  NavigateOutput
> = {
  id: "navigate",
  name: "Navigate",
  description:
    "Switch the active workspace tab in the web UI and optionally select an entity on the knowledge graph canvas.",
  schema: navigateInputSchema,
  run: async (input: NavigateInput): Promise<NavigateOutput> => {
    registerSettingsNavigationRoutes();
    const tabPaths = TAB_PATHS as Record<string, string>;
    const targetPath = tabPaths[input.tab] ?? `/${input.tab}`;

    if (!hasTabChangeListeners()) {
      return {
        success: false,
        tab: input.tab,
        path: targetPath,
        ...(input.entity_id !== undefined ? { entity_id: input.entity_id } : {}),
        error: "No active workspace tab listener is mounted.",
        message: "Cannot navigate because no workspace shell is currently mounted.",
      };
    }

    if (input.entity_id !== undefined) {
      requestGraphEntitySelection(input.entity_id);
    }

    navigateToTab(input.tab as ActiveTab);
    setScreenTab(input.tab as ActiveTab);

    return {
      success: true,
      tab: input.tab,
      path: targetPath,
      ...(input.entity_id !== undefined ? { entity_id: input.entity_id } : {}),
      message: input.entity_id
        ? `Navigated to ${input.tab} tab and queued entity ${input.entity_id}`
        : `Navigated to ${input.tab} tab`,
    };
  },
};

export async function executeNavigate(input: NavigateInput): Promise<NavigateOutput> {
  return await executeActionClient(navigateActionClient, input);
}
