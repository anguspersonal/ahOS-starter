import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GoogleGenAI } from "@google/genai";
import type { ChatMessage, ChatStreamEvent } from "../../ports/chat.js";
import { createGeminiChatAdapter, formatGeminiChatHistory, GeminiChatError } from "./geminiChatAdapter.js";

async function collectEvents(iterable: AsyncIterable<ChatStreamEvent>): Promise<ChatStreamEvent[]> {
  const out: ChatStreamEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe("createGeminiChatAdapter", () => {
  it("builds Gemini function declarations via geminiDeclarations and yields text deltas and tool calls in order", async () => {
    const generateContentStream = vi.fn().mockImplementation(async function* () {
      yield { candidates: [{ content: { parts: [{ text: "Checking " }] } }] };
      yield {
        candidates: [{
          content: {
            parts: [
              { text: "entity..." },
              { functionCall: { id: "call-1", name: "entity_get", args: { id: "ent-1" } } },
            ],
          },
        }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 },
      };
    });

    const adapter = createGeminiChatAdapter(() => "secret-api-key", {
      createClient: () => ({ models: { generateContentStream } }) as unknown as GoogleGenAI,
    });

    const events = await collectEvents(
      adapter.streamChat({
        messages: [{ role: "user", content: "Look up ent-1" }],
        systemInstruction: "Be concise.",
        tools: [{
          name: "entity_get",
          description: "Fetch an entity by ID",
          inputSchema: z.object({ id: z.string().describe("Entity ID") }),
        }],
      }),
    );

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(generateContentStream.mock.calls[0]![0].config.tools).toEqual([{
      functionDeclarations: [{
        name: "entity_get",
        description: "Fetch an entity by ID",
        parameters: {
          type: "OBJECT",
          properties: { id: { type: "STRING", description: "Entity ID" } },
          required: ["id"],
        },
      }],
    }]);
    expect(events).toEqual([
      { type: "text_delta", text: "Checking " },
      { type: "text_delta", text: "entity..." },
      { type: "tool_call", toolCall: { id: "call-1", name: "entity_get", args: { id: "ent-1" } } },
      { type: "usage", usage: { promptTokens: 12, candidatesTokens: 8, totalTokens: 20 } },
    ]);
  });

  it("formats history messages (user text, assistant text, tool calls, tool responses) without mutating caller arrays", () => {
    const callArgs = { id: "ent-1" };
    const responsePayload = { ok: true, name: "Entity One" };
    const history: ChatMessage[] = [
      { role: "user", content: "Find ent-1" },
      { role: "assistant", content: "Calling tool", toolCalls: [{ id: "tc-1", name: "entity_get", args: callArgs }] },
      { role: "tool", toolResponses: [{ id: "tc-1", name: "entity_get", response: responsePayload }] },
    ];
    const snapshot = structuredClone(history);
    const formatted = formatGeminiChatHistory(history);

    expect(history).toEqual(snapshot);
    expect(formatted).toEqual([
      { role: "user", parts: [{ text: "Find ent-1" }] },
      {
        role: "model",
        parts: [{ text: "Calling tool" }, { functionCall: { id: "tc-1", name: "entity_get", args: { id: "ent-1" } } }],
      },
      {
        role: "user",
        parts: [{ functionResponse: { id: "tc-1", name: "entity_get", response: { ok: true, name: "Entity One" } } }],
      },
    ]);

    (formatted[1]!.parts![1]!.functionCall!.args as Record<string, unknown>).id = "mutated";
    expect(callArgs.id).toBe("ent-1");
  });

  it("rejects with a structured error on missing API key or provider failure without leaking the key string", async () => {
    const missingKeyAdapter = createGeminiChatAdapter(() => "   ");
    await expect(
      collectEvents(missingKeyAdapter.streamChat({ messages: [{ role: "user", content: "Hi" }] })),
    ).rejects.toMatchObject({ name: "GeminiChatError", code: "MISSING_API_KEY" });

    const leakedSecret = "AIzaSySecretKeyValue12345";
    const failingAdapter = createGeminiChatAdapter(() => leakedSecret, {
      createClient: () => ({
        models: {
          generateContentStream: vi.fn().mockRejectedValue(new Error(`HTTP 403 Invalid key ${leakedSecret}`)),
        },
      }) as unknown as GoogleGenAI,
    });

    let caughtError: unknown;
    try {
      await collectEvents(failingAdapter.streamChat({ messages: [{ role: "user", content: "Hi" }] }));
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(GeminiChatError);
    expect((caughtError as GeminiChatError).code).toBe("PROVIDER_ERROR");
    expect((caughtError as Error).message).not.toContain(leakedSecret);
    expect((caughtError as Error).message).toContain("[REDACTED]");
  });
});
