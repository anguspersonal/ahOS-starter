import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeActionClient } from "../lib/actionClient.js";
import { entityCrudActionClient } from "../lib/entityActions.js";
import { taskCrudActionClient } from "../lib/taskActions.js";
import { decisionReviewActionClient } from "../lib/governanceActions.js";
import { graphNodeLevelActionClient } from "../lib/graphLevelActions.js";
import { relationshipCrudActionClient } from "../lib/relationshipActions.js";
import { supabase } from "../lib/supabase.js";

vi.mock("../lib/supabase.js", () => {
  return {
    supabase: {
      from: vi.fn(),
      auth: {
        getSession: vi.fn(async () => ({
          data: {
            session: {
              access_token: "test-auth-token-xyz-123",
              user: { id: "00000000-0000-4000-a000-000000000001" },
            },
          },
        })),
      },
    },
  };
});

describe("Client Action Dispatch to /api/actions (ADR-101 / #1325)", () => {
  const API_BASE = "https://api.ahos.internal/api/actions";
  const UUID_1 = "11111111-1111-4111-a111-111111111111";
  const UUID_2 = "22222222-2222-4222-a222-222222222222";
  const UUID_3 = "33333333-3333-4333-a333-333333333333";

  let originalApiUrl: string | undefined;

  beforeEach(() => {
    originalApiUrl = import.meta.env.VITE_ACTION_API_URL;
    import.meta.env.VITE_ACTION_API_URL = API_BASE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    import.meta.env.VITE_ACTION_API_URL = originalApiUrl;
    vi.restoreAllMocks();
  });

  it("ensures all mutating client action definitions have no local run handler", () => {
    expect(entityCrudActionClient.run).toBeUndefined();
    expect(taskCrudActionClient.run).toBeUndefined();
    expect(decisionReviewActionClient.run).toBeUndefined();
    expect(relationshipCrudActionClient.run).toBeUndefined();
    expect(graphNodeLevelActionClient.run).toBeUndefined();
  });

  it("graph_node_level client definition has no local run handler", () => {
    expect(graphNodeLevelActionClient.run).toBeUndefined();
  });

  const mutatingCases = [
    {
      action: entityCrudActionClient,
      name: "entity_crud (create)",
      input: {
        operation: "create" as const,
        title: "Test Entity",
        entity_type: "concept",
      },
    },
    {
      action: entityCrudActionClient,
      name: "entity_crud (delete)",
      input: {
        operation: "delete" as const,
        id: UUID_1,
      },
    },
    {
      action: taskCrudActionClient,
      name: "task_crud (create)",
      input: {
        operation: "create" as const,
        title: "Test Task",
      },
    },
    {
      action: taskCrudActionClient,
      name: "task_crud (complete)",
      input: {
        operation: "complete" as const,
        id: UUID_2,
      },
    },
    {
      action: decisionReviewActionClient,
      name: "decision_review (approve)",
      input: {
        operation: "approve" as const,
        id: UUID_3,
      },
    },
    {
      action: decisionReviewActionClient,
      name: "decision_review (reject)",
      input: {
        operation: "reject" as const,
        id: UUID_3,
      },
    },
    {
      action: relationshipCrudActionClient,
      name: "relationship_crud (create)",
      input: {
        operation: "create" as const,
        from_entity_id: UUID_1,
        to_entity_id: UUID_2,
        relationship_type: "contains",
      },
    },
    {
      action: relationshipCrudActionClient,
      name: "relationship_crud (delete)",
      input: {
        operation: "delete" as const,
        id: UUID_3,
      },
    },
    {
      action: graphNodeLevelActionClient,
      name: "graph_node_level (set)",
      input: {
        id: UUID_1,
        direction: "set" as const,
        target_level: 4,
      },
    },
  ];

  for (const { action, name, input } of mutatingCases) {
    it(`dispatches ${name} to POST <VITE_ACTION_API_URL>/${action.id} with bearer token and does not call supabase.from`, async () => {
      const mockFetch = vi.fn(async (_url: string, _init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            operation: (input as { operation?: string }).operation,
            id: "result-123",
          }),
        } as unknown as Response;
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await executeActionClient(action as any, input);

      expect(result).toBeDefined();
      expect(mockFetch).toHaveBeenCalledTimes(1);

      const [calledUrl, callInit] = mockFetch.mock.calls[0] as [
        string,
        { method?: string; headers?: Record<string, string>; body?: string },
      ];
      expect(calledUrl).toBe(`${API_BASE}/${action.id}`);
      expect(callInit.method).toBe("POST");

      const headers = callInit.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer test-auth-token-xyz-123");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["X-Action-Caller"]).toBe("ui");
      expect(headers["X-Request-Id"]).toBeDefined();

      const parsedBody = JSON.parse(callInit.body as string);
      expect(parsedBody).toMatchObject(input);

      // Mutating operation must NOT write directly to Supabase from the browser
      expect(supabase.from).not.toHaveBeenCalled();
    });
  }

  for (const { action, name, input } of mutatingCases) {
    it(`rejects with the server's error message when POST <VITE_ACTION_API_URL>/${action.id} fails for ${name}`, async () => {
      const serverErrorMessage = `CAR backend rejected ${action.id} with constraint violation`;
      const mockFetch = vi.fn(async () => {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          json: async () => ({
            message: serverErrorMessage,
            error: "ConstraintViolation",
          }),
        } as unknown as Response;
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(executeActionClient(action as any, input)).rejects.toThrow(serverErrorMessage);

      expect(supabase.from).not.toHaveBeenCalled();
    });
  }
});
