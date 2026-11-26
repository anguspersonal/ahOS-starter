/**
 * Google Gemini GenAI Client (v1 API).
 *
 * Implements the Gemini 2.5 Flash API corresponding to:
 * client = genai.Client(http_options=HttpOptions(api_version="v1"))
 * response = client.models.generate_content(model='gemini-2.5-flash', contents=...)
 */

export const DEFAULT_GEMINI_MODEL = "gemini-2.5-flash";
export const DEFAULT_API_VERSION = "v1";
export const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com";

export interface ToolCallExecution {
  name: string;
  args: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: "executing" | "success" | "error" | "pending_approval";
  error?: string;
}

export interface GeminiMessage {
  id?: string;
  role: "user" | "model";
  content: string;
  timestamp?: string;
  toolCalls?: ToolCallExecution[];
}

export interface GeminiFunctionCall {
  name: string;
  args: Record<string, unknown>;
}

export interface GeminiFunctionResponse {
  name: string;
  response: Record<string, unknown>;
}

export interface GeminiContentPart {
  text?: string;
  thoughtSignature?: string;
  functionCall?: GeminiFunctionCall;
  functionResponse?: GeminiFunctionResponse;
  [key: string]: unknown;
}

export interface GeminiContentItem {
  role: "user" | "model" | "system" | "function";
  parts: GeminiContentPart[];
}

export interface GeminiTool {
  functionDeclarations: Array<{
    name: string;
    description: string;
    parameters: {
      type: "OBJECT";
      properties: Record<string, unknown>;
      required?: string[];
    };
  }>;
}

export interface GenerateGeminiOptions {
  prompt?: string;
  messages?: GeminiMessage[];
  contents?: GeminiContentItem[];
  model?: string;
  apiKey?: string;
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  tools?: GeminiTool[];
  signal?: AbortSignal;
}

export interface GeminiGenerateResult {
  text: string;
  model: string;
  functionCalls?: GeminiFunctionCall[];
  modelParts?: GeminiContentPart[];
  usage?: {
    promptTokens?: number;
    candidatesTokens?: number;
    totalTokens?: number;
  };
  raw?: unknown;
}

const STORAGE_KEY = "ahos_gemini_key";

const inMemoryStorage = new Map<string, string>();

function getStorageValue(key: string): string | null {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage.getItem(key);
    }
    if (typeof localStorage !== "undefined" && localStorage.getItem) {
      return localStorage.getItem(key);
    }
  } catch {
    // Ignore restricted storage environments
  }
  return inMemoryStorage.get(key) || null;
}

function setStorageValue(key: string, value: string): void {
  try {
    if (typeof window !== "undefined" && window.localStorage) {
      if (value) {
        window.localStorage.setItem(key, value);
      } else {
        window.localStorage.removeItem(key);
      }
      return;
    }
    if (typeof localStorage !== "undefined" && localStorage.setItem) {
      if (value) {
        localStorage.setItem(key, value);
      } else {
        localStorage.removeItem(key);
      }
      return;
    }
  } catch {
    // Ignore restricted storage environments
  }

  if (value) {
    inMemoryStorage.set(key, value);
  } else {
    inMemoryStorage.delete(key);
  }
}

/**
 * Retrieve the active Gemini API key from local storage (per-user override typed into chat UI).
 * Public/environment key lookups are removed to prevent client-side key exposure (ADR-096, #1316).
 */
export function getGeminiApiKey(): string {
  // Check storage (for on-the-fly per-user key typed into the chat UI)
  const stored = getStorageValue(STORAGE_KEY);
  if (stored && stored.trim().length > 0) {
    return stored.trim();
  }

  return "";
}

/**
 * Save an API key override to local storage.
 */
export function setGeminiApiKey(key: string): void {
  setStorageValue(STORAGE_KEY, key.trim());
}

/**
 * Convert user/model chat messages into Gemini API contents payload format.
 */
export function formatGeminiContents(
  prompt?: string,
  messages?: GeminiMessage[],
): GeminiContentItem[] {
  const contents: GeminiContentItem[] = [];

  if (messages && messages.length > 0) {
    for (const msg of messages) {
      if (msg.content && msg.content.trim().length > 0) {
        contents.push({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content }],
        });
      }
    }
  }

  if (prompt && prompt.trim().length > 0) {
    contents.push({
      role: "user",
      parts: [{ text: prompt.trim() }],
    });
  }

  return contents;
}

export function parseGeminiError(
  status: number,
  statusText: string,
  errorJson: {
    error?: {
      message?: string;
      status?: string;
      details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
    };
  } | null,
): string {
  const isBlocked = errorJson?.error?.details?.some(
    (d) => d.reason === "API_KEY_SERVICE_BLOCKED",
  );

  if (isBlocked) {
    const consumer = errorJson?.error?.details?.find((d) => d.reason === "API_KEY_SERVICE_BLOCKED")?.metadata?.consumer;
    const projectInfo = consumer ? ` (${consumer})` : "";
    return `API Key Service Blocked: Generative Language API is blocked or disabled for this key/project${projectInfo}. Please enable 'Generative Language API' in Google Cloud Console or generate an unrestricted key at https://aistudio.google.com/app/apikey.`;
  }

  return (
    errorJson?.error?.message ||
    `Gemini request failed with HTTP ${status} (${statusText})`
  );
}

/**
 * Generate content using Google Gemini v1 REST API (model: gemini-2.5-flash).
 * Supports tools / function calling for agent-native capability execution.
 */
export async function generateGeminiContent(
  options: GenerateGeminiOptions,
): Promise<GeminiGenerateResult> {
  const model = options.model || DEFAULT_GEMINI_MODEL;
  const apiKey = options.apiKey || getGeminiApiKey();

  if (!apiKey) {
    throw new Error(
      "Gemini API key not found. Please set GEMINI_KEY in .env or provide an API key in the UI.",
    );
  }

  const contents =
    options.contents && options.contents.length > 0
      ? options.contents
      : formatGeminiContents(options.prompt, options.messages);

  if (contents.length === 0) {
    throw new Error("No prompt or message content provided to Gemini.");
  }

  const url = `${GEMINI_API_BASE_URL}/${DEFAULT_API_VERSION}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const bodyPayload: Record<string, unknown> = {
    contents,
  };

  if (options.systemInstruction) {
    bodyPayload.systemInstruction = {
      parts: [{ text: options.systemInstruction }],
    };
  }

  if (options.temperature !== undefined || options.maxOutputTokens !== undefined) {
    bodyPayload.generationConfig = {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxOutputTokens,
    };
  }

  if (options.tools && options.tools.length > 0) {
    bodyPayload.tools = options.tools;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyPayload),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorJson = (await response.json().catch(() => null)) as {
      error?: {
        message?: string;
        status?: string;
        details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
      };
    } | null;
    throw new Error(parseGeminiError(response.status, response.statusText, errorJson));
  }

  const data = (await response.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{
          text?: string;
          functionCall?: { name: string; args: Record<string, unknown> };
        }>;
        role?: string;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };

  const candidateParts = data.candidates?.[0]?.content?.parts || [];
  const text = candidateParts
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("");

  const functionCalls: GeminiFunctionCall[] = [];
  for (const part of candidateParts) {
    if (part.functionCall) {
      functionCalls.push(part.functionCall);
    }
  }

  return {
    text,
    model,
    functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
    modelParts: candidateParts.length > 0 ? (candidateParts as GeminiContentPart[]) : undefined,
    usage: {
      promptTokens: data.usageMetadata?.promptTokenCount,
      candidatesTokens: data.usageMetadata?.candidatesTokenCount,
      totalTokens: data.usageMetadata?.totalTokenCount,
    },
    raw: data,
  };
}

/**
 * Stream content using Google Gemini v1 REST API with SSE.
 */
export async function streamGeminiContent(
  options: GenerateGeminiOptions,
  onChunk: (chunkText: string, aggregatedText: string) => void,
): Promise<GeminiGenerateResult> {
  const model = options.model || DEFAULT_GEMINI_MODEL;
  const apiKey = options.apiKey || getGeminiApiKey();

  if (!apiKey) {
    throw new Error(
      "Gemini API key not found. Please set GEMINI_KEY in .env or provide an API key in the UI.",
    );
  }

  const contents =
    options.contents && options.contents.length > 0
      ? options.contents
      : formatGeminiContents(options.prompt, options.messages);

  if (contents.length === 0) {
    throw new Error("No prompt or message content provided to Gemini.");
  }

  const url = `${GEMINI_API_BASE_URL}/${DEFAULT_API_VERSION}/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const bodyPayload: Record<string, unknown> = {
    contents,
  };

  if (options.systemInstruction) {
    bodyPayload.systemInstruction = {
      parts: [{ text: options.systemInstruction }],
    };
  }

  if (options.temperature !== undefined || options.maxOutputTokens !== undefined) {
    bodyPayload.generationConfig = {
      temperature: options.temperature ?? 0.7,
      maxOutputTokens: options.maxOutputTokens,
    };
  }

  if (options.tools && options.tools.length > 0) {
    bodyPayload.tools = options.tools;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(bodyPayload),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorJson = (await response.json().catch(() => null)) as {
      error?: {
        message?: string;
        status?: string;
        details?: Array<{ reason?: string; metadata?: Record<string, string> }>;
      };
    } | null;
    throw new Error(parseGeminiError(response.status, response.statusText, errorJson));
  }

  if (!response.body) {
    throw new Error("Response body is not readable for streaming.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let aggregatedText = "";
  let buffer = "";
  const functionCalls: GeminiFunctionCall[] = [];
  const modelParts: GeminiContentPart[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data:")) continue;

        const dataStr = trimmed.replace(/^data:\s*/, "");
        if (dataStr === "[DONE]") continue;

        try {
          const parsed = JSON.parse(dataStr) as {
            candidates?: Array<{
              content?: {
                parts?: Array<GeminiContentPart>;
              };
            }>;
          };

          const parts = parsed.candidates?.[0]?.content?.parts || [];
          for (const part of parts) {
            modelParts.push(part);
            if (part.text) {
              aggregatedText += part.text;
              onChunk(part.text, aggregatedText);
            }
            if (part.functionCall) {
              functionCalls.push(part.functionCall);
            }
          }
        } catch {
          // Ignore partial SSE chunk parse failures
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return {
    text: aggregatedText,
    model,
    functionCalls: functionCalls.length > 0 ? functionCalls : undefined,
    modelParts: modelParts.length > 0 ? modelParts : undefined,
  };
}
