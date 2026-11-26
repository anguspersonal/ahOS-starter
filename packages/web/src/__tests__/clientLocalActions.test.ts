import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import actionManifest from "@ahkms/core/action-manifest.json";
import {
  bindLocalHandler,
  ClientActionRegistry,
  defaultClientActionRegistry,
  getBoundLocalIds,
} from "../lib/actionRegistry.js";
import {
  registerGraphFilterListener,
  runGraphFilter,
  type GraphFilterInput,
  type GraphFilterOutput,
} from "../lib/graphActions.js";
import { runViewScreen } from "../lib/viewScreenAction.js";
import { executeChatToolCall } from "../lib/chatAction.js";
import { resetScreenStateForTesting, setScreenTab } from "../lib/screenState.js";

vi.mock("../lib/supabase.js", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: "test-token",
            user: { id: "00000000-0000-4000-a000-000000000001" },
          },
        },
      })),
    },
  },
}));

interface ManifestEntry {
  description: string;
  expose: {
    mcp?: boolean;
    http?: boolean;
    ui_agent?: boolean;
    worker?: boolean;
    reason?: string;
  };
}

const manifestActions = (
  actionManifest as { actions: Record<string, ManifestEntry> }
).actions;

describe("client_local UI actions in web (#1557, ADR-105)", () => {
  beforeEach(() => {
    resetScreenStateForTesting();
    vi.clearAllMocks();
  });

  afterEach(() => {
    bindLocalHandler("graph_filter", runGraphFilter);
    bindLocalHandler("view_screen", runViewScreen);
    resetScreenStateForTesting();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("bindLocalHandler('graph_filter', h) and bindLocalHandler('view_screen', h) succeed", async () => {
    const customGraphHandler = vi.fn(
      async (input: GraphFilterInput): Promise<GraphFilterOutput> => ({
        success: true,
        filter: input,
        message: "custom handler ran",
      }),
    );

    const def = bindLocalHandler("graph_filter", customGraphHandler);
    expect(def.id).toBe("graph_filter");

    const res = await defaultClientActionRegistry.execute<
      GraphFilterInput,
      GraphFilterOutput
    >("graph_filter", { query: "custom" }, "ui_agent");
    expect(res).toEqual({
      success: true,
      filter: { query: "custom" },
      message: "custom handler ran",
    });
    expect(customGraphHandler).toHaveBeenCalledTimes(1);
  });

  it("throws when binding an id not marked client_local in action-manifest.json", () => {
    const noop = async () => ({ ok: true });

    // Server manifest actions without reason: "client_local"
    expect(() => bindLocalHandler("capture", noop)).toThrow(/not marked client_local/i);
    expect(() => bindLocalHandler("entity_crud", noop)).toThrow(/not marked client_local/i);
    expect(() => bindLocalHandler("approval_list", noop)).toThrow(/not marked client_local/i);

    // Non-manifest / invented actions
    expect(() => bindLocalHandler("invented_browser_action", noop)).toThrow(
      /not marked client_local/i,
    );
    expect(() => bindLocalHandler("navigate", noop)).toThrow(/not marked client_local/i);

    const isolated = new ClientActionRegistry();
    expect(() => isolated.bindLocalHandler("capture", noop)).toThrow(
      /not marked client_local/i,
    );
  });

  it("every bound local id in defaultClientActionRegistry is a client_local manifest id", () => {
    const boundIds = getBoundLocalIds().slice().sort();
    expect(boundIds).toEqual(["graph_filter", "view_screen"]);

    const manifestClientLocalIds = Object.entries(manifestActions)
      .filter(([, entry]) => entry.expose.reason === "client_local")
      .map(([id]) => id)
      .sort();

    for (const id of boundIds) {
      const entry = manifestActions[id];
      expect(entry, `bound id "${id}" missing from manifest`).toBeDefined();
      expect(entry.expose.reason).toBe("client_local");
      expect(entry.expose.ui_agent).toBe(true);
      expect(entry.expose.mcp).toBe(false);
      expect(entry.expose.http).toBe(false);
      expect(entry.expose.worker).toBe(false);
    }

    expect(boundIds).toEqual(manifestClientLocalIds);
  });

  it("an agent call to graph_filter and view_screen runs the local handler and never calls fetch", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("fetch must never be called for client_local actions");
    });
    vi.stubGlobal("fetch", fetchSpy);

    const seenFilters: GraphFilterInput[] = [];
    const unsubscribe = registerGraphFilterListener((f) => {
      seenFilters.push(f);
    });

    try {
      const filterResult = await executeChatToolCall<
        GraphFilterInput,
        GraphFilterOutput
      >("graph_filter", {
        query: "architecture",
        entity_types: ["project"],
      });

      expect(filterResult.success).toBe(true);
      expect(filterResult.filter).toEqual({
        query: "architecture",
        entity_types: ["project"],
      });
      expect(seenFilters).toEqual([
        {
          query: "architecture",
          entity_types: ["project"],
        },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();

      setScreenTab("graph");
      const screenResult = await executeChatToolCall("view_screen", {});
      expect(screenResult).toMatchObject({
        tab: "graph",
        path: "/graph",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });
});
