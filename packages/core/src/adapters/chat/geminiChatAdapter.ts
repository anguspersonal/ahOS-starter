import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import {
  jsonSchemaToGeminiDeclaration,
  zodToGeminiDeclaration,
  type GeminiFunctionDeclaration,
} from "../../domain/geminiDeclarations.js";
import type {
  ChatMessage,
  ChatModelPort,
  ChatStreamEvent,
  ChatStreamRequest,
  ChatToolDeclaration,
} from "../../ports/chat.js";

/** Default Gemini model used when `ChatStreamRequest.model` is omitted. */
export const DEFAULT_GEMINI_CHAT_MODEL = "gemini-2.5-flash";
export const FALLBACK_GEMINI_CHAT_MODEL = "gemini-3.8-flash";

function isNewUserModelUnavailableError(err: unknown, model: string): boolean {
  if (model === FALLBACK_GEMINI_CHAT_MODEL) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("no longer available to new users") || msg.includes("gemini-3.8-flash");
}

/** Configuration options for `createGeminiChatAdapter`. */
export interface GeminiChatAdapterOptions {
  defaultModel?: string;
  createClient?: (apiKey: string) => GoogleGenAI;
}

/** Structured error thrown by the Gemini chat adapter with redacted provider messages. */
export class GeminiChatError extends Error {
  readonly code: "MISSING_API_KEY" | "PROVIDER_ERROR";
  constructor(code: "MISSING_API_KEY" | "PROVIDER_ERROR", message: string) {
    super(message);
    this.name = "GeminiChatError";
    this.code = code;
  }
}

/** Converts `ChatToolDeclaration` entries into cloned Gemini `FunctionDeclaration` payloads. */
export function buildGeminiFunctionDeclarations(
  tools: readonly ChatToolDeclaration[],
): GeminiFunctionDeclaration[] {
  return tools.map((tool) => {
    if (tool.declaration) {
      return {
        name: tool.declaration.name,
        description: tool.declaration.description,
        parameters: {
          ...tool.declaration.parameters,
          properties: { ...tool.declaration.parameters.properties },
          ...(tool.declaration.parameters.required
            ? { required: [...tool.declaration.parameters.required] }
            : {}),
        },
      };
    }
    if (tool.inputSchema) {
      return zodToGeminiDeclaration(tool.name, tool.description, tool.inputSchema);
    }
    return jsonSchemaToGeminiDeclaration(
      tool.name,
      tool.description,
      tool.parameters ?? { type: "object", properties: {} },
    );
  });
}

/** Maps provider-neutral `ChatMessage` history into Gemini `Content` turns without mutating caller arrays. */
export function formatGeminiChatHistory(messages: readonly ChatMessage[]): Content[] {
  const contents: Content[] = [];
  for (const msg of messages) {
    const parts: Part[] = [];
    if (typeof msg.content === "string" && msg.content.length > 0) {
      parts.push({ text: msg.content });
    }
    for (const tc of msg.toolCalls ?? []) {
      parts.push({
        functionCall: { ...(tc.id ? { id: tc.id } : {}), name: tc.name, args: { ...tc.args } },
      });
    }
    for (const tr of msg.toolResponses ?? []) {
      parts.push({
        functionResponse: { ...(tr.id ? { id: tr.id } : {}), name: tr.name, response: { ...tr.response } },
      });
    }
    if (parts.length > 0) {
      contents.push({ role: msg.role === "assistant" || msg.role === "model" ? "model" : "user", parts });
    }
  }
  return contents;
}

/** Creates a `ChatModelPort` adapter backed by `@google/genai` streaming generation. */
export function createGeminiChatAdapter(
  getApiKey: () => string | undefined | Promise<string | undefined>,
  options: GeminiChatAdapterOptions = {},
): ChatModelPort {
  const defaultModel = options.defaultModel ?? DEFAULT_GEMINI_CHAT_MODEL;
  const clientFactory = options.createClient ?? ((apiKey: string) => new GoogleGenAI({ apiKey }));

  return {
    async *streamChat(request: ChatStreamRequest): AsyncIterable<ChatStreamEvent> {
      const apiKey = ((await getApiKey()) ?? "").trim();
      if (!apiKey) throw new GeminiChatError("MISSING_API_KEY", "Gemini API key is not configured.");

      const contents = formatGeminiChatHistory(request.messages);
      const functionDeclarations =
        request.tools && request.tools.length > 0
          ? (buildGeminiFunctionDeclarations(request.tools) as unknown as FunctionDeclaration[])
          : undefined;

      try {
        const targetModel = request.model ?? defaultModel;
        const client = clientFactory(apiKey);
        const buildStreamRequest = (modelName: string) => ({
          model: modelName,
          contents,
          config: {
            ...(request.systemInstruction ? { systemInstruction: request.systemInstruction } : {}),
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
            ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
            ...(request.signal ? { abortSignal: request.signal } : {}),
            ...(functionDeclarations ? { tools: [{ functionDeclarations }] } : {}),
          },
        });
        let stream: Awaited<ReturnType<typeof client.models.generateContentStream>>;
        try {
          stream = await client.models.generateContentStream(buildStreamRequest(targetModel));
        } catch (err) {
          if (!isNewUserModelUnavailableError(err, targetModel)) {
            throw err;
          }
          stream = await client.models.generateContentStream(
            buildStreamRequest(FALLBACK_GEMINI_CHAT_MODEL),
          );
        }

        for await (const chunk of stream) {
          for (const part of chunk.candidates?.[0]?.content?.parts ?? []) {
            if (typeof part.text === "string" && part.text.length > 0) {
              yield { type: "text_delta", text: part.text };
            }
            if (part.functionCall?.name) {
              yield {
                type: "tool_call",
                toolCall: {
                  ...(part.functionCall.id ? { id: part.functionCall.id } : {}),
                  name: part.functionCall.name,
                  args: { ...(part.functionCall.args ?? {}) },
                },
              };
            }
          }
          if (chunk.usageMetadata) {
            yield {
              type: "usage",
              usage: {
                promptTokens: chunk.usageMetadata.promptTokenCount,
                candidatesTokens: chunk.usageMetadata.candidatesTokenCount,
                totalTokens: chunk.usageMetadata.totalTokenCount,
              },
            };
          }
        }
      } catch (err) {
        if (err instanceof GeminiChatError) throw err;
        const raw = err instanceof Error ? err.message : String(err);
        const safe = apiKey ? raw.split(apiKey).join("[REDACTED]") : raw;
        throw new GeminiChatError("PROVIDER_ERROR", `Gemini chat stream failed: ${safe}`);
      }
    },
  };
}
