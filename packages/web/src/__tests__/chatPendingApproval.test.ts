import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UseGeminiChatOptions } from "../lib/chatAction.js";
import type { GeminiMessage } from "../lib/gemini.js";

const slots: unknown[] = [];
let idx = 0;

vi.mock("react", () => ({
  useState: (init: unknown) => {
    const i = idx++;
    if (!(i in slots)) {
      slots[i] = [typeof init === "function" ? (init as () => unknown)() : init];
    }
    const cell = slots[i] as [unknown];
    return [
      cell[0],
      (v: unknown) => {
        cell[0] = typeof v === "function" ? (v as (prev: unknown) => unknown)(cell[0]) : v;
      },
    ];
  },
  useRef: (init: unknown) => {
    const i = idx++;
    if (!(i in slots)) slots[i] = { current: init };
    return slots[i];
  },
  useCallback: (fn: unknown, deps: unknown[]) => {
    const i = idx++;
    const p = slots[i] as { fn: unknown; deps: unknown[] } | undefined;
    if (
      p &&
      deps.length === p.deps.length &&
      deps.every((d: unknown, k: number) => Object.is(d, p.deps[k]))
    ) {
      return p.fn;
    }
    slots[i] = { fn, deps };
    return fn;
  },
}));

vi.mock("../lib/supabase.js", () => ({
  supabase: {},
}));

let actionResult: unknown = undefined;

vi.mock("../lib/actionRegistry.js", () => ({
  defaultClientActionRegistry: {
    toGeminiTools: () => [],
    has: (n: string) => n === "entity_crud",
    execute: async (_n: string, args: unknown) =>
      typeof actionResult === "function"
        ? (actionResult as (a: unknown) => unknown)(args)
        : actionResult,
  },
}));

import { useGeminiChat } from "../lib/chatAction.js";
import { setGeminiApiKey } from "../lib/gemini.js";

function render(opts?: UseGeminiChatOptions) {
  idx = 0;
  return useGeminiChat(undefined, opts);
}

function getMessagesFromSlots(): GeminiMessage[] {
  for (const s of slots) {
    if (Array.isArray(s) && Array.isArray(s[0])) {
      return s[0] as GeminiMessage[];
    }
  }
  return [];
}

function stubGeminiReplies(replies: Array<{ parts: unknown[] }>) {
  let i = 0;
  const fetchMock = vi.fn().mockImplementation(async () => {
    const reply = replies[i++] ?? { parts: [] };
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { role: "model", parts: reply.parts } }],
      }),
    };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("chatPendingApproval", () => {
  beforeEach(() => {
    slots.length = 0;
    idx = 0;
    actionResult = undefined;
    setGeminiApiKey("k");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks a parked 202 tool result as pending_approval, forwards it to the model, and skips onActionExecuted", async () => {
    const parkedBody = {
      status: "pending_approval",
      decision_id: "d-1",
      action_id: "entity_crud",
    };
    actionResult = parkedBody;
    const onActionExecuted = vi.fn();

    const fetchMock = stubGeminiReplies([
      {
        parts: [
          {
            functionCall: {
              name: "entity_crud",
              args: { operation: "bulk_delete", ids: ["e-1"] },
            },
          },
        ],
      },
      {
        parts: [{ text: "Waiting for approval in your inbox." }],
      },
    ]);

    const { sendMessage } = render({ onActionExecuted });
    await sendMessage("delete entities", { stream: false });

    const messages = getMessagesFromSlots();
    const lastModel = messages[messages.length - 1];
    expect(lastModel?.toolCalls?.[0]?.status).toBe("pending_approval");
    expect(lastModel?.toolCalls?.[0]?.result).toEqual(parkedBody);
    expect(onActionExecuted).not.toHaveBeenCalled();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondBody = String(fetchMock.mock.calls[1][1]?.body ?? "");
    expect(secondBody).toContain('"status":"pending_approval"');
  });

  it("keeps ordinary tool results as success and calls onActionExecuted once", async () => {
    actionResult = { operation: "get", entity: { id: "e-1" } };
    const onActionExecuted = vi.fn();

    stubGeminiReplies([
      {
        parts: [
          {
            functionCall: {
              name: "entity_crud",
              args: { operation: "get", id: "e-1" },
            },
          },
        ],
      },
      {
        parts: [{ text: "Fetched entity." }],
      },
    ]);

    const { sendMessage } = render({ onActionExecuted });
    await sendMessage("get e-1", { stream: false });

    const messages = getMessagesFromSlots();
    const lastModel = messages[messages.length - 1];
    expect(lastModel?.toolCalls?.[0]?.status).toBe("success");
    expect(onActionExecuted).toHaveBeenCalledTimes(1);
  });

  it("formats empty-text fallback for a parked call as Waiting for your approval without Completed", async () => {
    actionResult = {
      status: "pending_approval",
      decision_id: "d-1",
      action_id: "entity_crud",
    };

    stubGeminiReplies([
      {
        parts: [
          {
            functionCall: {
              name: "entity_crud",
              args: { operation: "bulk_delete", ids: ["e-1"] },
            },
          },
        ],
      },
      {
        parts: [],
      },
    ]);

    const { sendMessage } = render();
    await sendMessage("delete entities", { stream: false });

    const messages = getMessagesFromSlots();
    const lastModel = messages[messages.length - 1];
    expect(lastModel?.content).toContain("Waiting for your approval: entity_crud");
    expect(lastModel?.content).not.toContain("Completed");
  });

  it("formats empty-text fallback with Operation failed and Waiting for your approval when one call fails and one is parked", async () => {
    actionResult = (args: { operation?: string }) => {
      if (args?.operation === "update") {
        throw new Error("boom");
      }
      return {
        status: "pending_approval",
        decision_id: "d-1",
        action_id: "entity_crud",
      };
    };

    stubGeminiReplies([
      {
        parts: [
          {
            functionCall: {
              name: "entity_crud",
              args: { operation: "update", id: "e-1" },
            },
          },
          {
            functionCall: {
              name: "entity_crud",
              args: { operation: "bulk_delete", ids: ["e-1"] },
            },
          },
        ],
      },
      {
        parts: [],
      },
    ]);

    const { sendMessage } = render();
    await sendMessage("update and delete", { stream: false });

    const messages = getMessagesFromSlots();
    const lastModel = messages[messages.length - 1];
    expect(lastModel?.content.startsWith("Operation failed: boom")).toBe(true);
    expect(lastModel?.content).toContain("Waiting for your approval: entity_crud.");
  });
});
