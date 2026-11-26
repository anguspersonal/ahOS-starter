import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/supabase.js", () => ({
  supabase: {},
}));

vi.mock("../lib/entityActions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/entityActions.js")>();
  return {
    ...original,
    executeEntityCrud: vi.fn(),
  };
});

import { defaultClientActionRegistry } from "../lib/actionRegistry.js";
import {
  setScreenTab,
  setGraphScreen,
  resetScreenStateForTesting,
  type ScreenGraphFilters,
  type ScreenEntitySelection,
  type GraphScreenState,
} from "../lib/screenState.js";
import { executeEntityCrud } from "../lib/entityActions.js";
import type { ViewScreenInput, ViewScreenOutput } from "../lib/viewScreenAction.js";

const sampleFilters: ScreenGraphFilters = {
  query: "test query",
  entity_types: ["project", "person"],
  hierarchy_level: 2,
  show_archived: false,
  include_me: true,
  scope_tier: "standard",
  detail_strategy: "tiered",
  lod_mode: "auto",
  isolated: false,
};

const entityB: ScreenEntitySelection = {
  id: "entity-b-id",
  title: "Entity B",
  entity_type: "project",
};

const sampleGraph: GraphScreenState = {
  view: "default",
  live: true,
  selected_entity: entityB,
  selected_edge: null,
  filters: sampleFilters,
};

describe("viewScreen action", () => {
  beforeEach(() => {
    resetScreenStateForTesting();
    vi.clearAllMocks();
  });

  it("rejects with a message containing 'no screen state' when nothing has been written", async () => {
    await expect(defaultClientActionRegistry.execute("view_screen", {})).rejects.toThrow(
      /no screen state/i,
    );
  });

  it("resolves to { tab: 'chat', path: '/chat', graph: null, entity: null } after setScreenTab('chat')", async () => {
    setScreenTab("chat");
    const res = await defaultClientActionRegistry.execute<ViewScreenInput, ViewScreenOutput>(
      "view_screen",
      {},
    );
    expect(res.tab).toBe("chat");
    expect(res.path).toBe("/chat");
    expect(res.graph).toBeNull();
    expect(res.entity).toBeNull();
    expect(res.captured_at).toBeDefined();
    expect(new Date(res.captured_at).toISOString()).toBe(res.captured_at);
  });

  it("keeps graph screen set before setScreenTab", async () => {
    setGraphScreen(sampleGraph);
    setScreenTab("graph");
    const res = await defaultClientActionRegistry.execute<ViewScreenInput, ViewScreenOutput>(
      "view_screen",
      {},
    );
    expect(res.tab).toBe("graph");
    expect(res.path).toBe("/graph");
    expect(res.graph).not.toBeNull();
    expect(res.graph?.selected_entity).toEqual(entityB);
    expect(res.graph?.filters).toEqual(sampleFilters);
  });

  it("reads null selected_entity when set, and null graph when unmounted", async () => {
    setScreenTab("graph");
    setGraphScreen({ ...sampleGraph, selected_entity: null });
    let res = await defaultClientActionRegistry.execute<ViewScreenInput, ViewScreenOutput>(
      "view_screen",
      {},
    );
    expect(res.graph?.selected_entity).toBeNull();

    setGraphScreen(null);
    res = await defaultClientActionRegistry.execute<ViewScreenInput, ViewScreenOutput>(
      "view_screen",
      {},
    );
    expect(res.graph).toBeNull();
  });

  it("hydrates selected entity when include_record: true and live: true, or returns null when nothing selected", async () => {
    const mockEntityData = {
      id: entityB.id,
      title: "Entity B Hydrated",
      description: "Full record",
    };
    vi.mocked(executeEntityCrud).mockResolvedValueOnce({
      operation: "get",
      found: true,
      entity: mockEntityData,
    });

    setScreenTab("graph");
    setGraphScreen(sampleGraph);

    const res = await defaultClientActionRegistry.execute<ViewScreenInput, ViewScreenOutput>(
      "view_screen",
      { include_record: true },
    );

    expect(executeEntityCrud).toHaveBeenCalledTimes(1);
    expect(executeEntityCrud).toHaveBeenCalledWith({
      operation: "get",
      id: entityB.id,
    });
    expect(res.entity).toEqual(mockEntityData);

    // With nothing selected:
    vi.mocked(executeEntityCrud).mockClear();
    setGraphScreen({ ...sampleGraph, selected_entity: null });
    const resNoSel = await defaultClientActionRegistry.execute<ViewScreenInput, ViewScreenOutput>(
      "view_screen",
      { include_record: true },
    );
    expect(executeEntityCrud).not.toHaveBeenCalled();
    expect(resNoSel.entity).toBeNull();
  });

  it("rejects in three failure cases when include_record: true", async () => {
    setScreenTab("graph");

    // 1. live: false -> rejects with message containing "fallback", makes no call
    setGraphScreen({ ...sampleGraph, live: false });
    vi.mocked(executeEntityCrud).mockClear();
    await expect(
      defaultClientActionRegistry.execute("view_screen", { include_record: true }),
    ).rejects.toThrow(/fallback/i);
    expect(executeEntityCrud).not.toHaveBeenCalled();

    // 2. stub resolves { found: false, entity: null } -> rejects with "not found"
    setGraphScreen(sampleGraph);
    vi.mocked(executeEntityCrud).mockResolvedValueOnce({
      operation: "get",
      found: false,
      entity: null,
    });
    await expect(
      defaultClientActionRegistry.execute("view_screen", { include_record: true }),
    ).rejects.toThrow(/not found/i);

    // 3. stub rejects -> rejects
    vi.mocked(executeEntityCrud).mockRejectedValueOnce(new Error("Database connection error"));
    await expect(
      defaultClientActionRegistry.execute("view_screen", { include_record: true }),
    ).rejects.toThrow("Database connection error");
  });
});
