import type { z } from "zod";
import type { GeminiFunctionDeclaration } from "../domain/geminiDeclarations.js";

/** Tool declaration accepted by `ChatModelPort`, supporting raw JSON schema, Zod schema, or pre-built Gemini declaration. */
export interface ChatToolDeclaration {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  inputSchema?: z.ZodTypeAny;
  declaration?: GeminiFunctionDeclaration;
}

/** Provider-neutral representation of a model-initiated tool call. */
export interface ChatToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** Tool execution result returned to the model in a follow-up turn. */
export interface ChatToolResponse {
  id?: string;
  name: string;
  response: Record<string, unknown>;
}

/** Speaker role in a multi-turn chat conversation. */
export type ChatRole = "user" | "assistant" | "model" | "tool";

/** Single conversational turn containing text, tool calls, or tool responses. */
export interface ChatMessage {
  role: ChatRole;
  content?: string;
  toolCalls?: ChatToolCall[];
  toolResponses?: ChatToolResponse[];
}

/** Incremental event yielded by `ChatModelPort.streamChat`. */
export type ChatStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; toolCall: ChatToolCall }
  | { type: "usage"; usage: { promptTokens?: number; candidatesTokens?: number; totalTokens?: number } };

/** Input payload for a streaming chat generation request. */
export interface ChatStreamRequest {
  messages: readonly ChatMessage[];
  systemInstruction?: string;
  tools?: readonly ChatToolDeclaration[];
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

/** Provider-neutral streaming chat port (ADR-100, ADR-101 §4). */
export interface ChatModelPort {
  streamChat(request: ChatStreamRequest): AsyncIterable<ChatStreamEvent>;
}
