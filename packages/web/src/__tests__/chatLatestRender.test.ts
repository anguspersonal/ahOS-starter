import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { UseGeminiChatOptions } from "../lib/chatAction.js";

const slots: any[] = [];
let idx = 0;

vi.mock("react", () => ({
  useState: (init: any) => {
    const i = idx++;
    if (!(i in slots)) slots[i] = [typeof init === "function" ? init() : init];
    return [
      slots[i][0],
      (v: any) => {
        slots[i][0] = typeof v === "function" ? v(slots[i][0]) : v;
      },
    ];
  },
  useRef: (init: any) => {
    const i = idx++;
    if (!(i in slots)) slots[i] = { current: init };
    return slots[i];
  },
  useCallback: (fn: any, deps: any[]) => {
    const i = idx++;
    const p = slots[i];
    if (p && deps.length === p.deps.length && deps.every((d: any, k: number) => Object.is(d, p.deps[k]))) {
      return p.fn;
    }
    slots[i] = { fn, deps };
    return fn;
  },
}));

vi.mock("../lib/supabase.js", () => ({
  supabase: {},
}));

vi.mock("../lib/actionRegistry.js", () => ({
  defaultClientActionRegistry: {
    toGeminiTools: () => [],
    has: (n: string) => n === "entity_crud",
    execute: async (_n: string, args: any) => ({ entity: { id: args?.id } }),
  },
}));

import { useGeminiChat } from "../lib/chatAction.js";
import { setGeminiApiKey } from "../lib/gemini.js";

function render(opts?: UseGeminiChatOptions) {
  idx = 0;
  return useGeminiChat(undefined, opts);
}

describe("chatLatestRender", () => {
  beforeEach(() => {
    slots.length = 0;
    idx = 0;
    setGeminiApiKey("k");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the entity selected at send time", async () => {
    const entityA = { id: "entity-a-123", title: "Entity A", entity_type: "concept" };
    const entityB = { id: "entity-b-456", title: "Entity B", entity_type: "project" };

    render({ contextEntity: entityA });
    const { sendMessage } = render({ contextEntity: entityB });

    const mockResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Entity deleted" }],
          },
          finishReason: "STOP",
        },
      ],
    };

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendMessage("delete this entity", { stream: false });

    expect(fetchMock).toHaveBeenCalled();
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    const systemInstructionText = JSON.stringify(body.systemInstruction);
    expect(systemInstructionText).toContain(entityB.id);
    expect(systemInstructionText).not.toContain(entityA.id);
  });

  it("reports executed actions to the latest callback", async () => {
    const cbA = vi.fn();
    const cbB = vi.fn();

    render({ onActionExecuted: cbA });
    const { sendMessage } = render({ onActionExecuted: cbB });

    const toolResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "entity_crud",
                  args: { operation: "get", id: "entity-1" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const textResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Here is the entity" }],
          },
          finishReason: "STOP",
        },
      ],
    };

    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => (callCount === 1 ? toolResponse : textResponse),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendMessage("get entity", { stream: false });

    expect(cbB).toHaveBeenCalledTimes(1);
    expect(cbA).not.toHaveBeenCalled();
  });

  it("reports a tool call to the callback of a render that happened mid-turn", async () => {
    const cbB = vi.fn();
    const cbC = vi.fn();

    const { sendMessage } = render({ onActionExecuted: cbB });

    const toolResponseA = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "entity_crud",
                  args: { operation: "get", id: "entity-A" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const toolResponseB = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                functionCall: {
                  name: "entity_crud",
                  args: { operation: "get", id: "entity-B" },
                },
              },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };

    const textResponse = {
      candidates: [
        {
          content: {
            role: "model",
            parts: [{ text: "Done with both" }],
          },
          finishReason: "STOP",
        },
      ],
    };

    let fetchCount = 0;
    const fetchMock = vi.fn().mockImplementation(async () => {
      fetchCount++;
      if (fetchCount === 1) {
        return {
          ok: true,
          json: async () => toolResponseA,
        };
      }
      if (fetchCount === 2) {
        // Mid-turn re-render with new callback cbC before answering second request
        render({ onActionExecuted: cbC });
        return {
          ok: true,
          json: async () => toolResponseB,
        };
      }
      return {
        ok: true,
        json: async () => textResponse,
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendMessage("get A then get B", { stream: false });

    expect(cbB).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledWith(
      "entity_crud",
      expect.objectContaining({ id: "entity-A" }),
      expect.anything(),
    );
    expect(cbC).toHaveBeenCalledTimes(1);
    expect(cbC).toHaveBeenCalledWith(
      "entity_crud",
      expect.objectContaining({ id: "entity-B" }),
      expect.anything(),
    );
  });
});
