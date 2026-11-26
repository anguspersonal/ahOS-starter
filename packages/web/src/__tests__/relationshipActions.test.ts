import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  executeRelationshipCrud,
  registerRelationshipListener,
  type RelationshipRecord,
} from "../lib/relationshipActions.js";
import { defaultClientActionRegistry } from "../lib/actionRegistry.js";

vi.mock("../lib/supabase.js", () => {
  return {
    supabase: null,
  };
});

describe("relationship_crud CAR Action", () => {
  const nodeA = "11111111-aaaa-4111-8111-111111111111";
  const nodeB = "22222222-bbbb-4222-8222-222222222222";
  const nodeC = "33333333-cccc-4333-8333-333333333333";

  // Tests that need fixtures own them under __tests__/ (#1325)
  const inTestRelationships: RelationshipRecord[] = [];

  beforeEach(() => {
    import.meta.env.VITE_ACTION_API_URL = "http://localhost:8080/api/actions";
    inTestRelationships.length = 0;
    inTestRelationships.push({
      id: "99999999-1111-4222-a333-444444444441",
      from_entity_id: nodeA,
      to_entity_id: nodeB,
      relationship_type: "contains",
      confidence_score: 1.0,
      metadata: {},
      created_at: new Date().toISOString(),
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const op = body.operation;

        if (op === "create") {
          const record: RelationshipRecord = {
            id: body.id || crypto.randomUUID(),
            from_entity_id: body.from_entity_id,
            to_entity_id: body.to_entity_id,
            relationship_type: body.relationship_type,
            confidence_score: body.confidence_score ?? 1.0,
            metadata: body.metadata || {},
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          };
          inTestRelationships.unshift(record);
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              operation: "create",
              id: record.id,
              count: 1,
              relationship: record,
              message: `Created relationship '${record.relationship_type}' between ${record.from_entity_id} and ${record.to_entity_id}`,
            }),
          };
        }

        if (op === "get") {
          const found = inTestRelationships.find((r) => r.id === body.id) || null;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: found !== null,
              operation: "get",
              id: body.id,
              count: found ? 1 : 0,
              relationship: found,
              message: found ? `Found relationship ${body.id}` : `Relationship ${body.id} not found`,
            }),
          };
        }

        if (op === "query") {
          const entityId = body.filter?.entity_id || body.from_entity_id || body.to_entity_id;
          const direction = body.filter?.direction || "both";
          const relType = body.filter?.relationship_type || body.relationship_type;
          const results = inTestRelationships.filter((r) => {
            if (entityId) {
              const matchesOut = r.from_entity_id === entityId;
              const matchesIn = r.to_entity_id === entityId;
              if (direction === "outgoing" && !matchesOut) return false;
              if (direction === "incoming" && !matchesIn) return false;
              if (direction === "both" && !matchesOut && !matchesIn) return false;
            }
            if (relType && r.relationship_type !== relType) return false;
            return true;
          });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              operation: "query",
              count: results.length,
              relationships: results,
              message: `Found ${results.length} relationship(s)`,
            }),
          };
        }

        if (op === "update") {
          const idx = inTestRelationships.findIndex((r) => r.id === body.id);
          let updated: RelationshipRecord | null = null;
          if (idx !== -1) {
            if (body.relationship_type)
              inTestRelationships[idx].relationship_type = body.relationship_type;
            if (body.confidence_score !== undefined)
              inTestRelationships[idx].confidence_score = body.confidence_score;
            if (body.metadata) inTestRelationships[idx].metadata = body.metadata;
            inTestRelationships[idx].updated_at = new Date().toISOString();
            updated = inTestRelationships[idx];
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: updated !== null,
              operation: "update",
              id: body.id,
              relationship: updated,
              message: updated
                ? `Updated relationship ${body.id}`
                : `Relationship ${body.id} not found`,
            }),
          };
        }

        if (op === "delete") {
          const idx = inTestRelationships.findIndex((r) => r.id === body.id);
          let deleted = false;
          if (idx !== -1) {
            inTestRelationships.splice(idx, 1);
            deleted = true;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: deleted,
              operation: "delete",
              id: body.id,
              deleted,
              message: deleted
                ? `Deleted relationship edge successfully`
                : `Relationship not found for deletion`,
            }),
          };
        }

        return {
          ok: false,
          status: 400,
          json: async () => ({ message: `Unsupported operation: ${op}` }),
        };
      }),
    );
  });

  it("is registered in defaultClientActionRegistry", () => {
    expect(defaultClientActionRegistry.has("relationship_crud")).toBe(true);
    const action = defaultClientActionRegistry.get("relationship_crud");
    expect(action).toBeDefined();
    expect(action?.name).toBe("relationship_crud");
  });

  it("creates a child relationship (focal node -> target node)", async () => {
    const result = await executeRelationshipCrud({
      operation: "create",
      from_entity_id: nodeA,
      to_entity_id: nodeB,
      role: "child",
      confidence_score: 0.95,
    });

    expect(result.success).toBe(true);
    expect(result.operation).toBe("create");
    expect(result.relationship).toBeDefined();
    expect(result.relationship?.from_entity_id).toBe(nodeA);
    expect(result.relationship?.to_entity_id).toBe(nodeB);
    expect(result.relationship?.relationship_type).toBe("contains");
    expect(result.relationship?.confidence_score).toBe(0.95);
  });

  it("creates a parent relationship (target node -> focal node)", async () => {
    // nodeA's parent is nodeC, so directed edge is from nodeC to nodeA
    const result = await executeRelationshipCrud({
      operation: "create",
      from_entity_id: nodeA,
      to_entity_id: nodeC,
      role: "parent",
      confidence_score: 1.0,
    });

    expect(result.success).toBe(true);
    expect(result.relationship).toBeDefined();
    expect(result.relationship?.from_entity_id).toBe(nodeC);
    expect(result.relationship?.to_entity_id).toBe(nodeA);
    expect(result.relationship?.relationship_type).toBe("contains");
  });

  it("creates a sibling relationship (focal node -> target node with siblingOf)", async () => {
    const result = await executeRelationshipCrud({
      operation: "create",
      from_entity_id: nodeB,
      to_entity_id: nodeC,
      role: "sibling",
    });

    expect(result.success).toBe(true);
    expect(result.relationship?.from_entity_id).toBe(nodeB);
    expect(result.relationship?.to_entity_id).toBe(nodeC);
    expect(result.relationship?.relationship_type).toBe("siblingOf");
  });

  it("creates a custom relationship with explicit type", async () => {
    const result = await executeRelationshipCrud({
      operation: "create",
      from_entity_id: nodeA,
      to_entity_id: nodeB,
      role: "custom",
      relationship_type: "authored_by",
    });

    expect(result.success).toBe(true);
    expect(result.relationship?.relationship_type).toBe("authored_by");
  });

  it("rejects self-referencing relationship", async () => {
    await expect(
      executeRelationshipCrud({
        operation: "create",
        from_entity_id: nodeA,
        to_entity_id: nodeA,
        role: "child",
      }),
    ).rejects.toThrow("self-referencing relationship");
  });

  it("retrieves a relationship by id", async () => {
    const created = await executeRelationshipCrud({
      operation: "create",
      from_entity_id: nodeA,
      to_entity_id: nodeB,
      role: "custom",
      relationship_type: "references",
    });

    const edgeId = created.relationship!.id;

    const fetched = await executeRelationshipCrud({
      operation: "get",
      id: edgeId,
    });

    expect(fetched.success).toBe(true);
    expect(fetched.relationship?.id).toBe(edgeId);
    expect(fetched.relationship?.relationship_type).toBe("references");
  });

  it("queries relationships by entity and direction", async () => {
    // Query outgoing relationships for nodeA
    const queryRes = await executeRelationshipCrud({
      operation: "query",
      filter: {
        entity_id: nodeA,
        direction: "outgoing",
      },
    });

    expect(queryRes.success).toBe(true);
    expect(queryRes.relationships).toBeDefined();
    expect(queryRes.count).toBeGreaterThan(0);
    for (const rel of queryRes.relationships!) {
      expect(rel.from_entity_id).toBe(nodeA);
    }
  });

  it("updates relationship confidence score and type", async () => {
    const created = await executeRelationshipCrud({
      operation: "create",
      from_entity_id: nodeA,
      to_entity_id: nodeB,
      role: "custom",
      relationship_type: "temp_rel",
      confidence_score: 0.5,
    });

    const updated = await executeRelationshipCrud({
      operation: "update",
      id: created.relationship!.id,
      relationship_type: "permanent_rel",
      confidence_score: 0.99,
    });

    expect(updated.success).toBe(true);
    expect(updated.relationship?.relationship_type).toBe("permanent_rel");
    expect(updated.relationship?.confidence_score).toBe(0.99);
  });

  it("deletes a relationship by id", async () => {
    const created = await executeRelationshipCrud({
      operation: "create",
      from_entity_id: nodeB,
      to_entity_id: nodeA,
      role: "custom",
      relationship_type: "will_delete",
    });

    const edgeId = created.relationship!.id;

    const delRes = await executeRelationshipCrud({
      operation: "delete",
      id: edgeId,
    });

    expect(delRes.success).toBe(true);
    expect(delRes.deleted).toBe(true);
    expect(delRes.id).toBe(edgeId);

    // Verify it is gone
    const getRes = await executeRelationshipCrud({
      operation: "get",
      id: edgeId,
    });
    expect(getRes.success).toBe(false);
    expect(getRes.relationship).toBeNull();
  });

  it("dispatches events to registered listeners", async () => {
    const listener = vi.fn();
    const unsubscribe = registerRelationshipListener(listener);

    const created = await executeRelationshipCrud({
      operation: "create",
      from_entity_id: nodeA,
      to_entity_id: nodeC,
      role: "child",
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "create",
        relationship: expect.objectContaining({
          from_entity_id: nodeA,
          to_entity_id: nodeC,
        }),
      }),
    );

    unsubscribe();
    listener.mockClear();

    await executeRelationshipCrud({
      operation: "delete",
      id: created.relationship!.id,
    });

    expect(listener).not.toHaveBeenCalled();
  });
});
