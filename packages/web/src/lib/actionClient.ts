import { useState, useCallback } from "react";
import type { z } from "zod";
import { supabase } from "./supabase.js";

export interface ClientActionContext {
  caller: "ui" | "ui_agent";
  requestId: string;
  traceId?: string;
  userId?: string;
  timestamp: string;
}

let activeChatTraceId: string | undefined;

/**
 * Scopes an in-app chat turn's trace ID across action dispatches without leaking to human UI clicks.
 */
export async function withActionTraceId<T>(
  traceId: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = activeChatTraceId;
  activeChatTraceId = traceId;
  try {
    return await fn();
  } finally {
    activeChatTraceId = previous;
  }
}

export interface ClientActionDefinition<
  TInput = unknown,
  TOutput = unknown,
> {
  id: string;
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  run?: (input: TInput, ctx: ClientActionContext) => Promise<TOutput>;
}

export interface ActionResult<TInput, TOutput> {
  data: TOutput | null;
  loading: boolean;
  error: Error | null;
  execute: (input: TInput) => Promise<TOutput>;
  reset: () => void;
}

/**
 * Execute an action from the UI client with strict authentication and caller tracing (ADR-100).
 */
export async function executeActionClient<TInput, TOutput>(
  action: ClientActionDefinition<TInput, TOutput>,
  input: TInput,
  options?: { caller?: "ui" | "ui_agent"; traceId?: string } | "ui" | "ui_agent",
): Promise<TOutput> {
  const scopedTraceId = activeChatTraceId;

  // 1. Client-side input validation against the shared Zod schema
  const parsedInput = action.schema.parse(input);

  // 2. Resolve authenticated user session safely (handles offline or mocked environments)
  let userId: string | undefined;
  let accessToken: string | undefined;
  if (supabase?.auth?.getSession) {
    try {
      const sessionResult = await supabase.auth.getSession();
      userId = sessionResult?.data?.session?.user?.id;
      accessToken = sessionResult?.data?.session?.access_token;
    } catch {
      // Ignore in offline or mock modes
    }
  }

  const resolvedCaller: "ui" | "ui_agent" =
    typeof options === "string" ? options : (options?.caller ?? "ui");
  const explicitTraceId =
    typeof options === "object" && options !== null ? options.traceId : undefined;
  const resolvedTraceId =
    explicitTraceId ?? (resolvedCaller === "ui_agent" ? scopedTraceId : undefined);

  const ctx: ClientActionContext = {
    caller: resolvedCaller,
    requestId: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `req-${Date.now()}`,
    ...(resolvedTraceId ? { traceId: resolvedTraceId } : {}),
    userId,
    timestamp: new Date().toISOString(),
  };

  // 3. If action defines a local client runner (or in mocked dev environment)
  if (action.run) {
    return await action.run(parsedInput, ctx);
  }

  // 4. Otherwise, dispatch to the backend authenticated action endpoint
  const runtimeActionUrl =
    typeof window !== "undefined"
      ? (window as unknown as { __ENV__?: Record<string, string | undefined> })?.__ENV__?.VITE_ACTION_API_URL?.trim()
      : undefined;
  const buildActionUrl =
    typeof import.meta.env.VITE_ACTION_API_URL === "string"
      ? import.meta.env.VITE_ACTION_API_URL.trim()
      : undefined;
  const backendBase = (runtimeActionUrl || buildActionUrl || "/api/actions").replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Request-Id": ctx.requestId,
    "X-Action-Caller": ctx.caller,
  };

  if (resolvedTraceId) {
    headers["X-Action-Trace-Id"] = resolvedTraceId;
  }

  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(`${backendBase}/${action.id}`, {
    method: "POST",
    headers,
    body: JSON.stringify(parsedInput),
  });

  if (!response.ok) {
    const errorBody = (await response.json().catch(() => ({ message: response.statusText }))) as { message?: string };
    throw new Error(errorBody.message || `Action ${action.id} failed with HTTP ${response.status}`);
  }

  const result = await response.json();
  return result as TOutput;
}

/**
 * React hook to consume an ActionDefinition with reactive loading, data, and error state.
 */
export function useAction<TInput, TOutput>(
  action: ClientActionDefinition<TInput, TOutput>,
): ActionResult<TInput, TOutput> {
  const [data, setData] = useState<TOutput | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const reset = useCallback(() => {
    setData(null);
    setError(null);
    setLoading(false);
  }, []);

  const execute = useCallback(
    async (input: TInput): Promise<TOutput> => {
      setLoading(true);
      setError(null);
      try {
        const result = await executeActionClient(action, input);
        setData(result);
        return result;
      } catch (err) {
        const normalizedError = err instanceof Error ? err : new Error(String(err));
        setError(normalizedError);
        throw normalizedError;
      } finally {
        setLoading(false);
      }
    },
    [action],
  );

  return { data, loading, error, execute, reset };
}
