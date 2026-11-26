import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { executeActionClient } from "../lib/actionClient.js";
import { defaultClientActionRegistry } from "../lib/actionRegistry.js";
import { entityCrudActionClient } from "../lib/entityActions.js";
import { taskCrudActionClient } from "../lib/taskActions.js";
import { executeChatToolCall, useGeminiChat } from "../lib/chatAction.js";
import { setGeminiApiKey } from "../lib/gemini.js";

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function renderProbeHook() {
  let capturedSendMessage: ReturnType<typeof useGeminiChat>["sendMessage"] | undefined;
  function Probe() {
    const chat = useGeminiChat();
    capturedSendMessage = chat.sendMessage;
    return React.createElement("div", null);
  }
  renderToString(React.createElement(Probe, null));
  return capturedSendMessage!;
}

describe("Web chat turn X-Action-Trace-Id correlation (#1468)", () => {
  const API_BASE = "https://api.ahos.internal/api/actions";
  const UUID_1 = "11111111-1111-4111-a111-111111111111";
  const UUID_2 = "22222222-2222-4222-a222-222222222222";

  let originalApiUrl: string | undefined;

  beforeEach(() => {
    originalApiUrl = import.meta.env.VITE_ACTION_API_URL;
    import.meta.env.VITE_ACTION_API_URL = API_BASE;
    setGeminiApiKey("test-key-123");
    vi.clearAllMocks();
  });

  afterEach(() => {
    import.meta.env.VITE_ACTION_API_URL = originalApiUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends the same X-Action-Trace-Id across two tool calls in one turn, a new one on the next turn, and none for owner clicks", async () => {
    const actionRequests: Array<{ url: string; headers: Record<string, string> }> = [];
    let geminiCallIndex = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
        if (url.includes(":generateContent")) {
          geminiCallIndex++;
          // Turn 1, Round 1: Gemini requests two tool calls in the same turn
          if (geminiCallIndex === 1) {
            return {
              ok: true,
              json: async () => ({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "entity_crud",
                            args: { operation: "get", id: UUID_1 },
                          },
                        },
                        {
                          functionCall: {
                            name: "task_crud",
                            args: { operation: "get", id: UUID_2 },
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            };
          }
          // Turn 1, Round 2: Gemini finishes Turn 1
          if (geminiCallIndex === 2) {
            return {
              ok: true,
              json: async () => ({
                candidates: [
                  {
                    content: {
                      parts: [{ text: "Turn 1 complete" }],
                    },
                  },
                ],
              }),
            };
          }
          // Turn 2, Round 1: Gemini requests one tool call in the next turn
          if (geminiCallIndex === 3) {
            return {
              ok: true,
              json: async () => ({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "entity_crud",
                            args: { operation: "get", id: UUID_2 },
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            };
          }
          // Turn 2, Round 2: Gemini finishes Turn 2
          return {
            ok: true,
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [{ text: "Turn 2 complete" }],
                  },
                },
              ],
            }),
          };
        }

        if (url.startsWith(API_BASE)) {
          actionRequests.push({
            url,
            headers: { ...(init?.headers ?? {}) },
          });
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true }),
          };
        }

        throw new Error(`Unexpected fetch URL: ${url}`);
      }),
    );

    const sendMessage = renderProbeHook();

    // Turn 1: two tool calls in one turn
    const turn1 = await sendMessage("Inspect entity and task", { stream: false });
    expect(turn1?.stopReason).toBe("answered");
    expect(actionRequests).toHaveLength(2);

    const turn1TraceA = actionRequests[0]?.headers["X-Action-Trace-Id"];
    const turn1TraceB = actionRequests[1]?.headers["X-Action-Trace-Id"];
    expect(turn1TraceA).toBeDefined();
    expect(turn1TraceA).toMatch(UUID_RE);
    expect(turn1TraceB).toBe(turn1TraceA);
    expect(actionRequests[0]?.headers["X-Action-Caller"]).toBe("ui_agent");
    expect(actionRequests[1]?.headers["X-Action-Caller"]).toBe("ui_agent");

    // Turn 2: next turn sends a new trace id
    const turn2 = await sendMessage("Inspect second entity", { stream: false });
    expect(turn2?.stopReason).toBe("answered");
    expect(actionRequests).toHaveLength(3);

    const turn2Trace = actionRequests[2]?.headers["X-Action-Trace-Id"];
    expect(turn2Trace).toBeDefined();
    expect(turn2Trace).toMatch(UUID_RE);
    expect(turn2Trace).not.toBe(turn1TraceA);
    expect(actionRequests[2]?.headers["X-Action-Caller"]).toBe("ui_agent");

    // Owner's own clicks send no X-Action-Trace-Id header
    await executeActionClient(entityCrudActionClient, { operation: "get", id: UUID_1 });
    await defaultClientActionRegistry.execute("task_crud", { operation: "get", id: UUID_2 });

    expect(actionRequests).toHaveLength(5);
    expect(actionRequests[3]?.headers["X-Action-Caller"]).toBe("ui");
    expect(actionRequests[3]?.headers["X-Action-Trace-Id"]).toBeUndefined();
    expect(actionRequests[4]?.headers["X-Action-Caller"]).toBe("ui");
    expect(actionRequests[4]?.headers["X-Action-Trace-Id"]).toBeUndefined();
  });

  it("passes explicit traceId through executeChatToolCall and executeActionClient", async () => {
    const actionRequests: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init?: { headers?: Record<string, string> }) => {
        actionRequests.push({ url, headers: { ...(init?.headers ?? {}) } });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
        };
      }),
    );

    const explicitTrace = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    await executeChatToolCall("entity_crud", { operation: "get", id: UUID_1 }, explicitTrace);
    await executeActionClient(
      taskCrudActionClient,
      { operation: "get", id: UUID_2 },
      { caller: "ui_agent", traceId: explicitTrace },
    );

    expect(actionRequests).toHaveLength(2);
    expect(actionRequests[0]?.headers["X-Action-Trace-Id"]).toBe(explicitTrace);
    expect(actionRequests[1]?.headers["X-Action-Trace-Id"]).toBe(explicitTrace);
  });
});
