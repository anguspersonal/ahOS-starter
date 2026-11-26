import { describe, expect, it, vi } from "vitest";
import actionManifest from "@ahkms/core/action-manifest.json";
import {
  bindLocalHandler,
  defaultClientActionRegistry,
  ClientActionRegistry,
} from "../lib/actionRegistry.js";
import { ClientActionRecorder } from "../lib/clientActionRecorder.js";
import { z } from "zod";

vi.mock("../lib/supabase.js", () => {
  const chain: any = {
    select: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    single: vi.fn(async () => ({ data: { id: "test-id" }, error: null })),
    then: (resolve: any) => resolve({ data: [{ id: "test-id" }], error: null }),
  };
  return {
    supabase: {
      from: vi.fn(() => chain),
      auth: {
        getSession: vi.fn(async () => ({ data: { session: { user: { id: "test-user-id" } } } })),
      },
    },
  };
});

describe("ClientActionRegistry", () => {
  it("initializes default registry with built-in actions", () => {
    expect(defaultClientActionRegistry.has("entity_crud")).toBe(true);
    expect(defaultClientActionRegistry.has("decision_review")).toBe(true);
    expect(defaultClientActionRegistry.has("task_crud")).toBe(true);
    expect(defaultClientActionRegistry.has("graph_filter")).toBe(true);
    expect(defaultClientActionRegistry.has("graph_node_level")).toBe(true);
    expect(defaultClientActionRegistry.has("graph_recalibrate_lod")).toBe(false);
    expect(defaultClientActionRegistry.has("relationship_crud")).toBe(true);
    expect(defaultClientActionRegistry.has("view_screen")).toBe(true);
    expect(defaultClientActionRegistry.has("navigate")).toBe(true);
    expect(defaultClientActionRegistry.list()).toHaveLength(8);
  });

  it("exports Gemini function declarations for all registered and manifest ui_agent actions", () => {
    const tools = defaultClientActionRegistry.toGeminiTools();
    expect(tools).toHaveLength(1);
    const decls = tools[0].functionDeclarations;

    const names = decls.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("entity_crud");
    expect(names).toContain("decision_review");
    expect(names).toContain("task_crud");
    expect(names).toContain("graph_filter");
    expect(names).toContain("graph_node_level");
    expect(names).not.toContain("graph_recalibrate_lod");
    expect(names).toContain("relationship_crud");
    expect(names).toContain("view_screen");
    expect(names).toContain("navigate");

    for (const decl of decls) {
      expect(decl.description).toBeTruthy();
      expect(decl.parameters.type).toBe("OBJECT");
    }

    const viewScreenDecl = decls.find((d) => d.name === "view_screen");
    expect(viewScreenDecl?.parameters?.properties?.include_record).toBeDefined();
  });

  it("declarations match action schemas", () => {
    const tools = defaultClientActionRegistry.toGeminiTools();
    const decls = tools[0].functionDeclarations;
    const actions = defaultClientActionRegistry.list();
    const manifestActions = (
      actionManifest as {
        actions: Record<string, { description: string; expose: { ui_agent?: boolean } }>;
      }
    ).actions;

    for (const action of actions) {
      const decl = decls.find((d) => d.name === action.id);
      expect(decl).toBeDefined();
      const manifestEntry = manifestActions[action.id];
      const expectedDescription = manifestEntry?.expose?.ui_agent
        ? manifestEntry.description
        : action.description;
      expect(decl!.description).toBe(expectedDescription);

      const shape = (action.schema as z.ZodObject<any>).shape;
      const expectedKeys = Object.keys(shape).sort();
      const actualKeys = Object.keys(decl!.parameters.properties).sort();
      expect(actualKeys).toEqual(expectedKeys);

      const expectedRequired = Object.keys(shape)
        .filter((key) => shape[key].safeParse(undefined).success === false)
        .sort();
      const actualRequired = (decl!.parameters.required ?? []).slice().sort();
      expect(actualRequired).toEqual(expectedRequired);
    }

    const relDecl = decls.find((d) => d.name === "relationship_crud");
    const filterProp = relDecl?.parameters.properties.filter as any;
    const filterRequired = filterProp?.required ?? [];
    expect(filterRequired).not.toContain("direction");
    expect(filterRequired).not.toContain("limit");
  });

  it("executes custom client actions with validation", async () => {
    const registry = new ClientActionRegistry();

    registry.register({
      id: "math_mult",
      name: "Multiply",
      description: "Multiply two numbers",
      schema: z.object({ a: z.number(), b: z.number() }),
      run: async ({ a, b }: { a: number; b: number }) => ({ product: a * b }),
    });

    const result = await registry.execute<{ a: number; b: number }, { product: number }>(
      "math_mult",
      { a: 6, b: 7 },
    );
    expect(result).toEqual({ product: 42 });
  });

  it("throws when executing unregistered action", async () => {
    const registry = new ClientActionRegistry();
    await expect(registry.execute("non_existent", {})).rejects.toThrow(
      /Client action "non_existent" is not registered in CAR/,
    );
  });

  it("enqueues a client_local record when caller is ui_agent and enqueues nothing when caller is ui (#1558)", async () => {
    const recorder = new ClientActionRecorder({
      fetchImpl: vi.fn(async () => ({ ok: true } as Response)) as unknown as typeof fetch,
      eventTarget: null,
    });
    const registry = new ClientActionRegistry(recorder);
    bindLocalHandler(
      "graph_filter",
      async (input: { query?: string }) => ({
        success: true,
        filter: input,
        message: "ok",
      }),
      registry,
    );

    await registry.execute("graph_filter", { query: "owner-click" }, "ui");
    expect(recorder.getPendingRecords()).toHaveLength(0);

    await registry.execute("graph_filter", { query: "agent-call" }, "ui_agent");
    const pending = recorder.getPendingRecords();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      action_id: "graph_filter",
      outcome: "success",
      input_keys: ["query"],
    });
    recorder.reset();
  });
});
