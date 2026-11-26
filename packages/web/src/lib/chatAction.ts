import { useState, useCallback, useRef } from "react";
import { z } from "zod";
import {
  type ClientActionDefinition,
  executeActionClient,
  withActionTraceId,
} from "./actionClient.js";
import {
  DEFAULT_GEMINI_MODEL,
  generateGeminiContent,
  streamGeminiContent,
  getGeminiApiKey,
  setGeminiApiKey,
  formatGeminiContents,
  type GeminiMessage,
  type GeminiGenerateResult,
  type GeminiContentItem,
  type GeminiContentPart,
  type ToolCallExecution,
} from "./gemini.js";
import { defaultClientActionRegistry } from "./actionRegistry.js";

function mintTurnTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export const geminiMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "model"]),
  content: z.string(),
  timestamp: z.string().optional(),
});

export const geminiChatInputSchema = z.object({
  prompt: z.string().min(1).optional(),
  messages: z.array(geminiMessageSchema).optional(),
  model: z.string().default(DEFAULT_GEMINI_MODEL).optional(),
  systemInstruction: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  apiKey: z.string().optional(),
});

export type GeminiChatInput = z.infer<typeof geminiChatInputSchema>;

export interface GeminiChatOutput {
  text: string;
  model: string;
  usage?: {
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
  };
}

export type ChatStopReason = "answered" | "max_rounds" | "repeated_call" | "budget";

export interface ChatTurnResult {
  text: string;
  toolCalls?: ToolCallExecution[];
  stopReason: ChatStopReason;
}

/**
 * Client-side Action Definition for Gemini Chat (ADR-100).
 * Connects the web UI to Gemini 2.5 Flash via v1 endpoint.
 */
export const geminiChatActionClient: ClientActionDefinition<
  GeminiChatInput,
  GeminiChatOutput
> = {
  id: "gemini_chat",
  name: "gemini_chat",
  description: "Chat and content generation using Google Gemini 2.5 Flash",
  schema: geminiChatInputSchema,
  run: async (input: GeminiChatInput): Promise<GeminiChatOutput> => {
    const result: GeminiGenerateResult = await generateGeminiContent({
      prompt: input.prompt,
      messages: input.messages,
      model: input.model || DEFAULT_GEMINI_MODEL,
      systemInstruction: input.systemInstruction,
      temperature: input.temperature,
      apiKey: input.apiKey,
    });

    return {
      text: result.text,
      model: result.model,
      usage: result.usage,
    };
  },
};

/**
 * Direct execution helper for Gemini Chat.
 */
export async function executeGeminiChat(input: GeminiChatInput) {
  return await executeActionClient(geminiChatActionClient, input);
}

/**
 * Execute an in-app agent tool call through CAR with caller stamped as `ui_agent` (ADR-100 / ADR-104).
 */
export async function executeChatToolCall<TInput = unknown, TOutput = unknown>(
  name: string,
  args: TInput,
  traceId?: string,
): Promise<TOutput> {
  return await withActionTraceId(traceId, () =>
    defaultClientActionRegistry.execute<TInput, TOutput>(name, args, {
      caller: "ui_agent",
    }),
  );
}

/**
 * Sanitizes tool outputs before feeding them into Gemini's multi-turn message contents.
 * Strips heavy vector embeddings (vector(1536)), search vectors, and caps rows/text lengths
 * to prevent runaway prompt size and token quota exhaustion.
 */
export function sanitizeToolOutputForGemini(output: unknown): unknown {
  if (output === null || output === undefined) return output;
  if (typeof output !== "object") return output;

  if (Array.isArray(output)) {
    return output.slice(0, 20).map(sanitizeToolOutputForGemini);
  }

  const record = { ...(output as Record<string, unknown>) };
  delete record.embedding;
  delete record.search_vector;

  if (Array.isArray(record.rows)) {
    record.rows = record.rows.slice(0, 20).map((row) => {
      if (row && typeof row === "object") {
        const r = { ...(row as Record<string, unknown>) };
        delete r.embedding;
        delete r.search_vector;
        if (typeof r.description === "string" && r.description.length > 400) {
          r.description = r.description.slice(0, 400) + "... [truncated]";
        }
        return r;
      }
      return row;
    });
  }

  if (record.entity && typeof record.entity === "object") {
    const ent = { ...(record.entity as Record<string, unknown>) };
    delete ent.embedding;
    delete ent.search_vector;
    if (typeof ent.description === "string" && ent.description.length > 500) {
      ent.description = ent.description.slice(0, 500) + "... [truncated]";
    }
    record.entity = ent;
  }

  return record;
}

export interface UseGeminiChatOptions {
  initialSystemInstruction?: string;
  onActionExecuted?: (actionName: string, args: Record<string, unknown>, result: unknown) => void;
  contextEntity?: { id: string; title: string; entity_type?: string } | null;
}

/**
 * React hook to manage an interactive chat thread powered by Gemini 2.5 Flash.
 * Supports tool calling for Entity CRUD, streaming responses, and model switching.
 */
export function useGeminiChat(
  initialSystemInstruction?: string,
  chatOptions?: UseGeminiChatOptions,
) {
  const [messages, setMessages] = useState<GeminiMessage[]>([]);
  const [isGenerating, setIsGenerating] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);
  const [model, setModel] = useState<string>(DEFAULT_GEMINI_MODEL);
  const [apiKey, setApiKeyInternal] = useState<string>(() => getGeminiApiKey());

  const abortControllerRef = useRef<AbortController | null>(null);
  const chatOptionsRef = useRef<UseGeminiChatOptions | undefined>(chatOptions);
  chatOptionsRef.current = chatOptions;

  const updateApiKey = useCallback((newKey: string) => {
    setGeminiApiKey(newKey);
    setApiKeyInternal(newKey);
  }, []);

  const clearChat = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setMessages([]);
    setError(null);
    setIsGenerating(false);
  }, []);

  const stopGenerating = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsGenerating(false);
    }
  }, []);

  const sendMessage = useCallback(
    async (
      userPrompt: string,
      options?: {
        stream?: boolean;
        systemInstruction?: string;
        enableTools?: boolean;
      },
    ): Promise<ChatTurnResult | undefined> => {
      const trimmedPrompt = userPrompt.trim();
      if (!trimmedPrompt || isGenerating) {
        return undefined;
      }

      setError(null);

      const userMessage: GeminiMessage = {
        id: `user-${Date.now()}`,
        role: "user",
        content: trimmedPrompt,
        timestamp: new Date().toISOString(),
      };

      const modelMessageId = `model-${Date.now() + 1}`;
      const placeholderModelMessage: GeminiMessage = {
        id: modelMessageId,
        role: "model",
        content: "",
        timestamp: new Date().toISOString(),
      };

      const updatedHistory = [...messages, userMessage];
      setMessages([...updatedHistory, placeholderModelMessage]);
      setIsGenerating(true);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const contextEntitySnippet = chatOptionsRef.current?.contextEntity
        ? `\nActive Graph Selection: Entity "${chatOptionsRef.current.contextEntity.title}" (type: ${chatOptionsRef.current.contextEntity.entity_type || "unknown"}, id: "${chatOptionsRef.current.contextEntity.id}"). If the user asks to inspect, update, filter, or delete "this" or "the selected" entity, use this ID.`
        : "";

      const activeSystemInstruction =
        (options?.systemInstruction ||
        chatOptionsRef.current?.initialSystemInstruction ||
        initialSystemInstruction ||
        "You are an AI assistant in ahOS with access to the Centralised Action Registry (CAR) including entity_crud, task_crud, decision_review, and graph_filter. You can query, create, update, delete, and filter knowledge graph entities, PARA tasks, and system decisions. Always explain what actions you take. If an entity search returns no results, do not repeat the query in a loop; report to the user that no matching entity was found.") + contextEntitySnippet;

      const shouldStream = options?.stream !== false;
      const enableTools = options?.enableTools !== false;
      const activeTools = enableTools ? defaultClientActionRegistry.toGeminiTools() : undefined;

      try {
        // Step 1: Initial query with tools attached (streamed when streaming is on)
        const initialResult = shouldStream
          ? await streamGeminiContent(
              {
                messages: updatedHistory,
                model,
                apiKey,
                systemInstruction: activeSystemInstruction,
                tools: activeTools,
                signal: controller.signal,
              },
              (_chunk: string, aggregatedText: string) => {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === modelMessageId ? { ...m, content: aggregatedText } : m,
                  ),
                );
              },
            )
          : await generateGeminiContent({
              messages: updatedHistory,
              model,
              apiKey,
              systemInstruction: activeSystemInstruction,
              tools: activeTools,
              signal: controller.signal,
            });

        if (!shouldStream) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === modelMessageId ? { ...m, content: initialResult.text } : m,
            ),
          );
        }

        // Step 2: Handle tool calls if returned by Gemini (multi-turn tool execution loop)
        if (initialResult.functionCalls && initialResult.functionCalls.length > 0) {
          const turnTraceId = mintTurnTraceId();
          const executedToolCalls: ToolCallExecution[] = [];
          const executedSignatures = new Set<string>();
          let currentResult = initialResult;
          let currentContents: GeminiContentItem[] = formatGeminiContents(undefined, updatedHistory);
          let turn = 0;
          const MAX_TOOL_TURNS = 4;
          let stopReason: ChatStopReason = "answered";

          while (
            currentResult.functionCalls &&
            currentResult.functionCalls.length > 0 &&
            turn < MAX_TOOL_TURNS
          ) {
            turn++;
            const toolResults: Array<{ name: string; output: unknown }> = [];

            // Detect identical repetitive tool loop
            let isRepeatingLoop = false;
            for (const call of currentResult.functionCalls) {
              const sig = `${call.name}:${JSON.stringify(call.args)}`;
              if (executedSignatures.has(sig)) {
                isRepeatingLoop = true;
                break;
              }
              executedSignatures.add(sig);
            }
            if (isRepeatingLoop) {
              stopReason = "repeated_call";
              break;
            }

            for (const call of currentResult.functionCalls) {
              const toolExec: ToolCallExecution = {
                name: call.name,
                args: call.args,
                status: "executing",
              };
              executedToolCalls.push(toolExec);

              // Update UI with executing state
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === modelMessageId
                    ? { ...m, toolCalls: [...executedToolCalls] }
                    : m,
                ),
              );

              if (defaultClientActionRegistry.has(call.name)) {
                try {
                  const actionResult = await executeChatToolCall(
                    call.name,
                    call.args,
                    turnTraceId,
                  );
                  const isPendingApproval =
                    typeof actionResult === "object" &&
                    actionResult !== null &&
                    (actionResult as { status?: unknown }).status === "pending_approval";
                  toolExec.status = isPendingApproval ? "pending_approval" : "success";
                  toolExec.result = actionResult as Record<string, unknown>;
                  toolResults.push({ name: call.name, output: actionResult });
                  if (!isPendingApproval) {
                    try {
                      chatOptionsRef.current?.onActionExecuted?.(
                        call.name,
                        call.args as Record<string, unknown>,
                        actionResult,
                      );
                    } catch (cbErr) {
                      console.error("Error in onActionExecuted callback:", cbErr);
                    }
                  }
                } catch (toolErr: unknown) {
                  const errMsg = toolErr instanceof Error ? toolErr.message : String(toolErr);
                  toolExec.status = "error";
                  toolExec.error = errMsg;
                  toolResults.push({ name: call.name, output: { error: errMsg } });
                }
              } else {
                toolExec.status = "error";
                toolExec.error = `Unknown action: ${call.name}`;
                toolResults.push({ name: call.name, output: { error: toolExec.error } });
              }
            }

            // Update UI with completed tool executions
            setMessages((prev) =>
              prev.map((m) =>
                m.id === modelMessageId
                  ? { ...m, toolCalls: [...executedToolCalls] }
                  : m,
              ),
            );

            // In Gemini v1 REST API, model parts must preserve thoughtSignature if present
            const modelPartsToSend: GeminiContentPart[] =
              currentResult.modelParts && currentResult.modelParts.length > 0
                ? currentResult.modelParts
                : currentResult.functionCalls.map((fc) => ({
                    functionCall: fc,
                  }));

            // Crucial: In Gemini REST API, functionResponse MUST use role: "user" (role "function" is rejected with 400)
            currentContents = [
              ...currentContents,
              {
                role: "model",
                parts: modelPartsToSend,
              },
              {
                role: "user",
                parts: toolResults.map((tr) => ({
                  functionResponse: {
                    name: tr.name,
                    response: { output: sanitizeToolOutputForGemini(tr.output) },
                  },
                })),
              },
            ];

            // Token-budget circuit breaker: prevent prompt explosion from exhausting API quota
            const estimatedCharacters = JSON.stringify(currentContents).length;
            const estimatedTokens = Math.ceil(estimatedCharacters / 3.8);
            const MAX_TOKEN_BUDGET = 60_000;

            if (estimatedTokens > MAX_TOKEN_BUDGET || executedToolCalls.length >= 8) {
              console.warn(
                `[chatAction] Circuit breaker tripped: estimated tokens (${estimatedTokens}) or tool calls (${executedToolCalls.length}) reached safety limit.`,
              );
              stopReason = "budget";
              break;
            }

            currentResult = await generateGeminiContent({
              contents: currentContents,
              model,
              apiKey,
              systemInstruction: activeSystemInstruction,
              tools: activeTools,
              signal: controller.signal,
            });
          }

          if (
            stopReason === "answered" &&
            currentResult.functionCalls &&
            currentResult.functionCalls.length > 0 &&
            turn >= MAX_TOOL_TURNS
          ) {
            stopReason = "max_rounds";
          }

          // Build final response text
          let responseText = currentResult.text;
          const parkedCalls = executedToolCalls.filter(
            (t) => t.status === "pending_approval",
          );
          const parkedSuffix =
            parkedCalls.length > 0
              ? `Waiting for your approval: ${parkedCalls.map((t) => t.name).join(", ")}.`
              : "";
          if (stopReason !== "answered") {
            const unrunCalls = currentResult.functionCalls?.map((c) => c.name) || [];
            const unrunSnippet =
              unrunCalls.length > 0
                ? `: ${unrunCalls.join(", ")} requested but not run`
                : "";
            const stoppedText = `Stopped (${stopReason})${unrunSnippet}.`;
            responseText = parkedSuffix ? `${stoppedText} ${parkedSuffix}` : stoppedText;
          } else if (!responseText || responseText.trim().length === 0) {
            const succeededCalls = executedToolCalls.filter((t) => t.status === "success");
            const failedCalls = executedToolCalls.filter((t) => t.status === "error");
            const parts: string[] = [];
            if (failedCalls.length > 0 && succeededCalls.length === 0) {
              parts.push(
                `Operation failed: ${failedCalls.map((t) => t.error).filter(Boolean).join("; ")}`,
              );
            } else if (succeededCalls.length > 0) {
              parts.push(`Completed ${succeededCalls.map((t) => t.name).join(", ")}.`);
            }
            if (parkedSuffix) {
              parts.push(parkedSuffix);
            }
            responseText = parts.join(" ");
          }

          setMessages((prev) =>
            prev.map((m) =>
              m.id === modelMessageId
                ? {
                    ...m,
                    content: responseText,
                    toolCalls: [...executedToolCalls],
                  }
                : m,
            ),
          );

          return {
            text: responseText,
            toolCalls: executedToolCalls.length > 0 ? executedToolCalls : undefined,
            stopReason,
          };
        }

        // If no function calls were requested, turn completed with the first request
        return {
          text: initialResult.text,
          stopReason: "answered",
        };
      } catch (err: unknown) {
        if (controller.signal.aborted) {
          return undefined;
        }
        const errorObj = err instanceof Error ? err : new Error(String(err));
        setError(errorObj);
        setMessages((prev) =>
          prev.map((m) =>
            m.id === modelMessageId
              ? {
                  ...m,
                  content: `Error: ${errorObj.message}`,
                }
              : m,
          ),
        );
        return undefined;
      } finally {
        setIsGenerating(false);
        abortControllerRef.current = null;
      }
    },
    [messages, isGenerating, model, apiKey, initialSystemInstruction],
  );

  return {
    messages,
    isGenerating,
    error,
    model,
    setModel,
    apiKey,
    setApiKey: updateApiKey,
    sendMessage,
    stopGenerating,
    clearChat,
  };
}
