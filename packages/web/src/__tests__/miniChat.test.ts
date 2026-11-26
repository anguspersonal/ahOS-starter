import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerGraphFilterListener,
  type GraphFilterInput,
  type GraphFilterOutput,
} from "../lib/graphActions.js";
import { defaultClientActionRegistry } from "../lib/actionRegistry.js";

describe("Shared Chat Module & Mini Chat (CAR Integration)", () => {
  const testEntities: Array<{ id: string; title: string; entity_type: string; tags?: string[] }> = [];

  beforeEach(() => {
    import.meta.env.VITE_ACTION_API_URL = "http://localhost:8080/api/actions";
    testEntities.length = 0;
    testEntities.push({
      id: "11111111-2222-4333-8444-555555555551",
      title: "Project Alpha",
      entity_type: "project",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        if (body.operation === "create") {
          const id = crypto.randomUUID();
          testEntities.push({ id, title: body.title, entity_type: body.entity_type, tags: body.tags });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              operation: "create",
              success: true,
              created: [id],
            }),
          };
        }
        if (body.operation === "delete") {
          const idx = testEntities.findIndex((e) => e.id === body.id);
          if (idx !== -1) testEntities.splice(idx, 1);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              operation: "delete",
              success: true,
              deleted: [body.id],
            }),
          };
        }
        if (body.operation === "query") {
          const rows = testEntities.filter(
            (e) => !body.entity_type || e.entity_type === body.entity_type,
          );
          return {
            ok: true,
            status: 200,
            json: async () => ({
              operation: "query",
              count: rows.length,
              rows,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({ operation: body.operation, success: true }),
        };
      }),
    );
  });

  describe("graphFilterActionClient", () => {
    it("is registered in defaultClientActionRegistry", () => {
      expect(defaultClientActionRegistry.has("graph_filter")).toBe(true);
      const action = defaultClientActionRegistry.get("graph_filter");
      expect(action).toBeDefined();
      expect(action?.id).toBe("graph_filter");
    });

    it("triggers registered graph filter listeners upon CAR execution", async () => {
      const receivedFilters: GraphFilterInput[] = [];
      const unsubscribe = registerGraphFilterListener((filter) => {
        receivedFilters.push(filter);
      });

      const result = (await defaultClientActionRegistry.execute("graph_filter", {
        entity_type: "project",
        query: "quantum",
      })) as GraphFilterOutput;

      expect(result.success).toBe(true);
      expect(receivedFilters).toHaveLength(1);
      expect(receivedFilters[0]).toEqual({
        entity_type: "project",
        query: "quantum",
      });

      unsubscribe();

      // After unsubscribe, execution rejects because no listener is registered
      await expect(
        defaultClientActionRegistry.execute("graph_filter", {
          query: "other",
        }),
      ).rejects.toThrow();
      expect(receivedFilters).toHaveLength(1);
    });

    it("supports multi-select entity_types and hierarchy_level grouping via CAR", async () => {
      const receivedFilters: GraphFilterInput[] = [];
      const unsubscribe = registerGraphFilterListener((filter) => {
        receivedFilters.push(filter);
      });

      const result = (await defaultClientActionRegistry.execute("graph_filter", {
        entity_types: ["project", "concept", "area"],
        hierarchy_level: 2,
      })) as GraphFilterOutput;

      expect(result.success).toBe(true);
      expect(receivedFilters).toHaveLength(1);
      expect(receivedFilters[0].entity_types).toEqual(["project", "concept", "area"]);
      expect(receivedFilters[0].hierarchy_level).toBe(2);

      unsubscribe();
    });
  });

  describe("CAR Entity CRUD Interactivity for Mini Chat", () => {
    it("creates an entity via CAR and returns created id", async () => {
      const result = (await defaultClientActionRegistry.execute("entity_crud", {
        operation: "create",
        title: "Copilot Test Entity",
        entity_type: "concept",
        tags: ["chat-created", "agent-native"],
      })) as { operation: string; created: string[] };

      expect(result.operation).toBe("create");
      expect(result.created).toBeDefined();
      expect(result.created.length).toBeGreaterThan(0);
      const createdId = result.created[0];

      // Clean up / delete entity
      const deleteResult = (await defaultClientActionRegistry.execute("entity_crud", {
        operation: "delete",
        id: createdId,
      })) as { operation: string; deleted: string[] };

      expect(deleteResult.operation).toBe("delete");
      expect(deleteResult.deleted).toBeDefined();
    });

    it("queries entities by entity_type filter via CAR", async () => {
      const queryResult = (await defaultClientActionRegistry.execute("entity_crud", {
        operation: "query",
        entity_type: "project",
        limit: 5,
      })) as { operation: string; rows: unknown[] };

      expect(queryResult.operation).toBe("query");
      expect(Array.isArray(queryResult.rows)).toBe(true);
    });
  });
});
