import { describe, expect, it, vi } from "vitest";
import { defaultClientActionRegistry } from "../lib/actionRegistry.js";

vi.mock("../lib/supabase.js", () => {
  return {
    supabase: null,
  };
});

describe("graph_node_level CAR Action", () => {
  it("is registered in defaultClientActionRegistry", () => {
    expect(defaultClientActionRegistry.has("graph_node_level")).toBe(true);
    const action = defaultClientActionRegistry.get("graph_node_level");
    expect(action).toBeDefined();
    expect(action?.name).toBe("graph_node_level");
  });

  it("validates input via CAR schema", async () => {
    // Non-UUID id fails schema validation
    await expect(
      defaultClientActionRegistry.execute("graph_node_level", {
        id: "invalid-uuid",
        direction: "up",
      }),
    ).rejects.toThrow();

    // Invalid direction fails schema validation
    await expect(
      defaultClientActionRegistry.execute("graph_node_level", {
        id: "77777777-7777-4777-8777-777777777777",
        direction: "sideways" as any,
      }),
    ).rejects.toThrow();
  });
});

