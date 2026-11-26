import {
  type ClientActionRecordItem,
  type ClientActionRecordOutcome,
  inputSha256,
} from "@ahkms/core";
import { supabase } from "./supabase.js";

export const CLIENT_ACTION_FLUSH_DELAY_MS = 5_000;
export const CLIENT_ACTION_FLUSH_BATCH_SIZE = 20;
export const CLIENT_ACTION_MAX_RECORDS_PER_POST = 50;

export function extractClientInputKeys(input: unknown): string[] {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return Object.keys(input as Record<string, unknown>).sort();
  }
  return [];
}

function defaultEndpointUrl(): string {
  const baseUrl = (
    import.meta.env?.VITE_ACTION_API_URL ?? "/api/actions"
  ).replace(/\/+$/, "");
  return `${baseUrl}/client_action_record`;
}

async function defaultGetAccessToken(): Promise<string | null> {
  const { data } = await supabase.auth.getSession();
  return data?.session?.access_token ?? null;
}

export interface ClientActionRecorderOptions {
  flushDelayMs?: number;
  batchSize?: number;
  maxBatchSize?: number;
  getEndpointUrl?: () => string;
  getAccessToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  eventTarget?: Pick<EventTarget, "addEventListener" | "removeEventListener"> | null;
}

export interface RecordClientLocalActionParams {
  action_id: string;
  request_id?: string;
  trace_id?: string;
  outcome: ClientActionRecordOutcome;
  duration_ms: number;
  input: unknown;
  caller?: "ui" | "ui_agent" | string;
}

export class ClientActionRecorder {
  private queue: ClientActionRecordItem[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private cachedAccessToken: string | null = null;
  private pagehideListenerBound = false;
  private readonly flushDelayMs: number;
  private readonly batchSize: number;
  private readonly maxBatchSize: number;
  private readonly getEndpointUrl: () => string;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly fetchImpl: typeof fetch;
  private readonly eventTarget: Pick<
    EventTarget,
    "addEventListener" | "removeEventListener"
  > | null;
  private readonly onPageHide = (): void => {
    void this.flush({ keepalive: true });
  };

  constructor(options?: ClientActionRecorderOptions) {
    this.flushDelayMs = options?.flushDelayMs ?? CLIENT_ACTION_FLUSH_DELAY_MS;
    this.batchSize = options?.batchSize ?? CLIENT_ACTION_FLUSH_BATCH_SIZE;
    this.maxBatchSize =
      options?.maxBatchSize ?? CLIENT_ACTION_MAX_RECORDS_PER_POST;
    this.getEndpointUrl = options?.getEndpointUrl ?? defaultEndpointUrl;
    this.getAccessToken = options?.getAccessToken ?? defaultGetAccessToken;
    this.fetchImpl =
      options?.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.eventTarget =
      options?.eventTarget !== undefined
        ? options.eventTarget
        : typeof window !== "undefined"
          ? window
          : null;
  }

  private ensurePageHideListener(): void {
    if (this.pagehideListenerBound || !this.eventTarget) return;
    this.eventTarget.addEventListener("pagehide", this.onPageHide);
    this.pagehideListenerBound = true;
  }

  private removePageHideListener(): void {
    if (!this.pagehideListenerBound || !this.eventTarget) return;
    this.eventTarget.removeEventListener("pagehide", this.onPageHide);
    this.pagehideListenerBound = false;
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private scheduleTimer(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.flushDelayMs);
    const maybeTimer = this.timer as unknown as { unref?: () => void };
    if (typeof maybeTimer?.unref === "function") {
      maybeTimer.unref();
    }
  }

  private async refreshAccessToken(): Promise<void> {
    try {
      this.cachedAccessToken = await this.getAccessToken();
    } catch (err) {
      console.warn("[clientActionRecorder] failed to resolve session token", err);
    }
  }

  async record(
    params: RecordClientLocalActionParams,
  ): Promise<ClientActionRecordItem | null> {
    const caller = params.caller ?? "ui_agent";
    if (caller !== "ui_agent") {
      return null;
    }

    const [digest] = await Promise.all([
      inputSha256(params.input),
      this.refreshAccessToken(),
    ]);

    const item: ClientActionRecordItem = {
      action_id: params.action_id,
      request_id: params.request_id ?? globalThis.crypto.randomUUID(),
      ...(params.trace_id ? { trace_id: params.trace_id } : {}),
      outcome: params.outcome,
      duration_ms: Math.max(0, Math.round(params.duration_ms)),
      input_keys: extractClientInputKeys(params.input),
      input_sha256: digest,
    };

    this.ensurePageHideListener();
    this.queue.push(item);

    if (this.queue.length >= this.batchSize) {
      this.clearTimer();
      await this.flush();
    } else {
      this.scheduleTimer();
    }

    return item;
  }

  enqueue(record: ClientActionRecordItem, caller: string = "ui_agent"): void {
    if (caller !== "ui_agent") return;
    void this.refreshAccessToken();
    this.ensurePageHideListener();
    this.queue.push(record);
    if (this.queue.length >= this.batchSize) {
      this.clearTimer();
      void this.flush();
    } else {
      this.scheduleTimer();
    }
  }

  async flush(options?: { keepalive?: boolean }): Promise<number> {
    this.clearTimer();
    if (this.queue.length === 0) {
      return 0;
    }

    let totalSent = 0;
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.maxBatchSize);
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Action-Caller": "ui_agent",
      };
      if (this.cachedAccessToken) {
        headers["Authorization"] = `Bearer ${this.cachedAccessToken}`;
      }

      const init: NonNullable<Parameters<typeof fetch>[1]> = {
        method: "POST",
        headers,
        body: JSON.stringify({ records: batch }),
        ...(options?.keepalive ? { keepalive: true } : {}),
      };

      try {
        const responsePromise = this.fetchImpl(this.getEndpointUrl(), init);
        await responsePromise;
        totalSent += batch.length;
      } catch (err) {
        console.warn("[clientActionRecorder] failed to flush batch", err);
      }
    }

    return totalSent;
  }

  getPendingRecords(): ClientActionRecordItem[] {
    return [...this.queue];
  }

  reset(): void {
    this.clearTimer();
    this.queue = [];
    this.cachedAccessToken = null;
    this.removePageHideListener();
  }
}

export const defaultClientActionRecorder = new ClientActionRecorder();

export async function recordClientLocalAction(
  params: RecordClientLocalActionParams,
  recorder: ClientActionRecorder = defaultClientActionRecorder,
): Promise<ClientActionRecordItem | null> {
  return recorder.record(params);
}

export function enqueueClientActionRecord(
  record: ClientActionRecordItem,
  caller: string = "ui_agent",
  recorder: ClientActionRecorder = defaultClientActionRecorder,
): void {
  recorder.enqueue(record, caller);
}

export async function flushClientActionRecords(
  options?: { keepalive?: boolean },
  recorder: ClientActionRecorder = defaultClientActionRecorder,
): Promise<number> {
  return recorder.flush(options);
}

export function getPendingClientActionRecords(
  recorder: ClientActionRecorder = defaultClientActionRecorder,
): ClientActionRecordItem[] {
  return recorder.getPendingRecords();
}

export function resetClientActionRecorderForTesting(
  recorder: ClientActionRecorder = defaultClientActionRecorder,
): void {
  recorder.reset();
}
