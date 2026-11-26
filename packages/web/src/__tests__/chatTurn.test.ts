import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { useGeminiChat } from "../lib/chatAction.js";
import { setGeminiApiKey, streamGeminiContent } from "../lib/gemini.js";
import { registerGraphFilterListener } from "../lib/graphActions.js";

function createSseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

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

describe("chat turn cost and stop reasons", () => {
  beforeEach(() => {
    setGeminiApiKey("test-key-123");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("plain message costs one request", async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init?: { body?: unknown }) => {
        const parsedBody = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
        fetchCalls.push({ url, body: parsedBody });

        if (url.includes(":streamGenerateContent")) {
          return {
            ok: true,
            body: createSseStream([
              'data: {"candidates":[{"content":{"parts":[{"text":"Hello from stream"}]}}]}\n\n',
              "data: [DONE]\n\n",
            ]),
          };
        }
        throw new Error(`Unexpected url: ${url}`);
      }),
    );

    const sendMessage = renderProbeHook();
    const result = await sendMessage("hello");

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain(":streamGenerateContent");
    expect(fetchCalls[0].body?.tools).toBeDefined();
    expect((fetchCalls[0].body?.tools as unknown[]).length).toBeGreaterThan(0);
    expect(result).toEqual({
      stopReason: "answered",
      text: "Hello from stream",
    });
  });

  it("stream off", async () => {
    const fetchCalls: Array<{ url: string; body: Record<string, unknown> | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, init?: { body?: unknown }) => {
        const parsedBody = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;
        fetchCalls.push({ url, body: parsedBody });

        if (url.includes(":generateContent")) {
          return {
            ok: true,
            json: async () => ({
              candidates: [
                {
                  content: {
                    parts: [{ text: "Non-streamed response" }],
                  },
                },
              ],
            }),
          };
        }
        throw new Error(`Unexpected url: ${url}`);
      }),
    );

    const sendMessage = renderProbeHook();
    const result = await sendMessage("hello", { stream: false });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toContain(":generateContent");
    expect(result).toEqual({
      stopReason: "answered",
      text: "Non-streamed response",
    });
  });

  it("max rounds", async () => {
    let listenerRuns = 0;
    const unsubscribe = registerGraphFilterListener(() => {
      listenerRuns++;
    });

    try {
      let requestCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          requestCount++;
          const callIndex = requestCount;

          if (url.includes(":streamGenerateContent")) {
            return {
              ok: true,
              body: createSseStream([
                `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"graph_filter","args":{"query":"q${callIndex}"}}}]}}]}\n\n`,
                "data: [DONE]\n\n",
              ]),
            };
          }
          if (url.includes(":generateContent")) {
            return {
              ok: true,
              json: async () => ({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "graph_filter",
                            args: { query: `q${callIndex}` },
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            };
          }
          throw new Error(`Unexpected url: ${url}`);
        }),
      );

      const sendMessage = renderProbeHook();
      const result = await sendMessage("keep filtering");

      expect(listenerRuns).toBe(4);
      expect(requestCount).toBe(5);
      expect(result).toBeDefined();
      expect(result?.stopReason).toBe("max_rounds");
      expect(result?.text.startsWith("Stopped (max_rounds)")).toBe(true);
      expect(result?.text).toContain("graph_filter");
      expect(result?.text.startsWith("Completed")).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it("repeated call", async () => {
    let listenerRuns = 0;
    const unsubscribe = registerGraphFilterListener(() => {
      listenerRuns++;
    });

    try {
      let requestCount = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation(async (url: string) => {
          requestCount++;
          if (url.includes(":streamGenerateContent")) {
            return {
              ok: true,
              body: createSseStream([
                'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"graph_filter","args":{"query":"same"}}}]}}]}\n\n',
                "data: [DONE]\n\n",
              ]),
            };
          }
          if (url.includes(":generateContent")) {
            return {
              ok: true,
              json: async () => ({
                candidates: [
                  {
                    content: {
                      parts: [
                        {
                          functionCall: {
                            name: "graph_filter",
                            args: { query: "same" },
                          },
                        },
                      ],
                    },
                  },
                ],
              }),
            };
          }
          throw new Error(`Unexpected url: ${url}`);
        }),
      );

      const sendMessage = renderProbeHook();
      const result = await sendMessage("repeat filter");

      expect(listenerRuns).toBe(1);
      expect(requestCount).toBe(2);
      expect(result).toBeDefined();
      expect(result?.stopReason).toBe("repeated_call");
      expect(result?.text.startsWith("Stopped (repeated_call)")).toBe(true);
      expect(result?.text).toContain("graph_filter");
    } finally {
      unsubscribe();
    }
  });

  it("streamed function call", async () => {
    const sseChunks = [
      'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"graph_filter","args":{}},"thoughtSignature":"s"}]}}]}\n\n',
      "data: [DONE]\n\n",
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        body: createSseStream(sseChunks),
      }),
    );

    const result = await streamGeminiContent(
      {
        prompt: "Run filter",
        apiKey: "k",
      },
      () => {},
    );

    expect(result.functionCalls).toEqual([{ name: "graph_filter", args: {} }]);
    expect(result.modelParts).toEqual([
      {
        functionCall: { name: "graph_filter", args: {} },
        thoughtSignature: "s",
      },
    ]);
  });
});
