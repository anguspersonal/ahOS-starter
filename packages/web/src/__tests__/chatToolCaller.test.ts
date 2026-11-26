import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeActionClient } from "../lib/actionClient.js";
import { defaultClientActionRegistry } from "../lib/actionRegistry.js";
import { entityCrudActionClient } from "../lib/entityActions.js";
import { executeChatToolCall } from "../lib/chatAction.js";

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

describe("Chat tool caller & X-Action-Caller header (#1418)", () => {
  const API_BASE = "https://api.ahos.internal/api/actions";
  const UUID_1 = "11111111-1111-4111-a111-111111111111";

  let originalApiUrl: string | undefined;

  beforeEach(() => {
    originalApiUrl = import.meta.env.VITE_ACTION_API_URL;
    import.meta.env.VITE_ACTION_API_URL = API_BASE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    import.meta.env.VITE_ACTION_API_URL = originalApiUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts X-Action-Caller: ui_agent from executeChatToolCall and X-Action-Caller: ui from human callers", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: UUID_1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const input = { operation: "get" as const, id: UUID_1 };

    await executeChatToolCall("entity_crud", input);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `${API_BASE}/entity_crud`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Action-Caller": "ui_agent",
        }),
      }),
    );

    await defaultClientActionRegistry.execute("entity_crud", input);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `${API_BASE}/entity_crud`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Action-Caller": "ui",
        }),
      }),
    );

    await executeActionClient(entityCrudActionClient, input);
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `${API_BASE}/entity_crud`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Action-Caller": "ui",
        }),
      }),
    );
  });

  it("resolves 202 pending_approval body from executeChatToolCall and rejects 403 with server message", async () => {
    const pendingBody = {
      status: "pending_approval",
      decision_id: "dec-999",
      action_id: "entity_crud",
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        json: async () => pendingBody,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: async () => ({ message: "Action entity_crud requires approval; no store configured" }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const input = { operation: "delete" as const, id: UUID_1 };

    const res = await executeChatToolCall("entity_crud", input);
    expect(res).toEqual(pendingBody);

    await expect(executeChatToolCall("entity_crud", input)).rejects.toThrow(
      "Action entity_crud requires approval; no store configured",
    );
  });

  it("routes useGeminiChat tool calls exclusively through executeChatToolCall", () => {
    const chatActionPath = resolve(import.meta.dirname, "../lib/chatAction.ts");
    const source = readFileSync(chatActionPath, "utf8");

    const registryExecuteMatches = source.match(/defaultClientActionRegistry\.execute\b/g) ?? [];
    expect(registryExecuteMatches).toHaveLength(1);

    const fnStart = source.indexOf("export async function executeChatToolCall");
    expect(fnStart).toBeGreaterThan(-1);
    const fnSlice = source.slice(fnStart, fnStart + 400);
    expect(fnSlice).toContain("defaultClientActionRegistry.execute");

    const hookStart = source.indexOf("export function useGeminiChat");
    expect(hookStart).toBeGreaterThan(-1);
    const hookSlice = source.slice(hookStart);
    expect(hookSlice).toContain("executeChatToolCall(");
    expect(hookSlice).not.toContain("defaultClientActionRegistry.execute");
  });
});
