import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatGeminiContents,
  generateGeminiContent,
  streamGeminiContent,
  getGeminiApiKey,
  setGeminiApiKey,
  DEFAULT_GEMINI_MODEL,
  DEFAULT_API_VERSION,
} from "../lib/gemini.js";
import {
  geminiChatActionClient,
  executeGeminiChat,
  sanitizeToolOutputForGemini,
} from "../lib/chatAction.js";
import { defaultClientActionRegistry } from "../lib/actionRegistry.js";
import {
  entityCrudActionClient,
  executeEntityCrud,
  sanitizeEntityRow,
} from "../lib/entityActions.js";

interface TestEntityRecord {
  id: string;
  title: string;
  description?: string;
  entity_type?: string;
  domain?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
}

const getInitialEntities = (): TestEntityRecord[] => [
  {
    id: "11111111-2222-4333-8444-555555555551",
    title: "ahOS Core System",
    description: "Autonomous Personal AI Operating System",
    entity_type: "project",
    domain: "system",
    tags: ["core", "os"],
    created_at: new Date().toISOString(),
  },
  {
    id: "11111111-2222-4333-8444-555555555552",
    title: "Work Platform",
    description: "Agent fleet orchestration",
    entity_type: "project",
    domain: "work",
    tags: ["fleet", "agent"],
    created_at: new Date().toISOString(),
  },
  {
    id: "11111111-2222-4333-8444-555555555553",
    title: "Centralised Action Registry",
    description: "ADR-100 parity layer",
    entity_type: "project",
    domain: "car",
    tags: ["actions", "parity"],
    created_at: new Date().toISOString(),
  },
];

describe("Gemini Chat Feature & Agent-Native Tool Calling (@ahkms/web)", () => {
  let inTestEntities: TestEntityRecord[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    import.meta.env.VITE_ACTION_API_URL = "http://localhost:8080/api/actions";
    inTestEntities = getInitialEntities();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => {
        const urlStr = String(url);
        if (urlStr.includes("/api/actions/entity_crud")) {
          const body = init?.body ? JSON.parse(init.body as string) : {};
          const op = body.operation;

          if (op === "query") {
            let filtered = [...inTestEntities];
            if (body.domain) {
              filtered = filtered.filter((r) => r.domain === body.domain);
            }
            if (body.query) {
              const q = body.query.toLowerCase();
              filtered = filtered.filter(
                (r) =>
                  r.title.toLowerCase().includes(q) ||
                  (r.description || "").toLowerCase().includes(q),
              );
            }
            if (body.title) {
              filtered = filtered.filter((r) => r.title === body.title);
            }
            if (body.ids && body.ids.length > 0) {
              filtered = filtered.filter((r) => body.ids.includes(r.id));
            }
            if (body.tags && body.tags.length > 0) {
              filtered = filtered.filter((r) =>
                body.tags.some((t: string) => r.tags?.includes(t)),
              );
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({
                operation: "query",
                count: filtered.length,
                rows: filtered,
              }),
            };
          }

          if (op === "create") {
            const newId = body.id || crypto.randomUUID();
            const record: TestEntityRecord = {
              id: newId,
              title: body.title,
              description: body.description,
              entity_type: body.entity_type,
              domain: body.domain,
              tags: body.tags || [],
              metadata: body.metadata || {},
              created_at: new Date().toISOString(),
            };
            inTestEntities.push(record);
            return {
              ok: true,
              status: 200,
              json: async () => ({
                operation: "create",
                success: true,
                created: [newId],
              }),
            };
          }

          if (op === "delete") {
            const idx = inTestEntities.findIndex((r) => r.id === body.id);
            if (idx !== -1) inTestEntities.splice(idx, 1);
            return {
              ok: true,
              status: 200,
              json: async () => ({
                operation: "delete",
                success: true,
                deleted: [body.id],
                archiveOnly: Boolean(body.archive_only),
              }),
            };
          }

          if (op === "bulk_delete") {
            let matched = [...inTestEntities];
            if (body.tags && body.tags.length > 0) {
              matched = matched.filter((r) =>
                body.tags.some((t: string) => r.tags?.includes(t)),
              );
            }
            const wouldDeleteIds = matched.map((r) => r.id);
            if (!body.dry_run) {
              inTestEntities = inTestEntities.filter((r) => !wouldDeleteIds.includes(r.id));
            }
            return {
              ok: true,
              status: 200,
              json: async () => ({
                operation: "bulk_delete",
                success: true,
                dryRun: Boolean(body.dry_run),
                wouldDeleteIds,
              }),
            };
          }
        }
        return {
          ok: false,
          status: 404,
          json: async () => ({ message: "Not found" }),
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("formatGeminiContents", () => {
    it("formats user prompt into Gemini contents format", () => {
      const contents = formatGeminiContents("Hello Gemini");
      expect(contents).toEqual([
        {
          role: "user",
          parts: [{ text: "Hello Gemini" }],
        },
      ]);
    });

    it("formats multi-turn chat messages accurately", () => {
      const messages = [
        { role: "user" as const, content: "First question" },
        { role: "model" as const, content: "First answer" },
      ];
      const contents = formatGeminiContents("Follow-up question", messages);
      expect(contents).toHaveLength(3);
      expect(contents[0]).toEqual({ role: "user", parts: [{ text: "First question" }] });
      expect(contents[1]).toEqual({ role: "model", parts: [{ text: "First answer" }] });
      expect(contents[2]).toEqual({ role: "user", parts: [{ text: "Follow-up question" }] });
    });
  });

  describe("API Key Management", () => {
    it("sets and retrieves API key override via localStorage", () => {
      setGeminiApiKey("test-custom-api-key");
      expect(getGeminiApiKey()).toBe("test-custom-api-key");

      setGeminiApiKey("");
      expect(getGeminiApiKey()).toBe("");
    });
  });

  describe("generateGeminiContent", () => {
    it("throws error when API key is missing", async () => {
      await expect(
        generateGeminiContent({ prompt: "Hello", apiKey: "" }),
      ).rejects.toThrow("Gemini API key not found");
    });

    it("calls v1 models/gemini-2.5-flash:generateContent endpoint with payload", async () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Hello from Gemini 2.5 Flash!" }],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: {
          promptTokenCount: 12,
          candidatesTokenCount: 8,
          totalTokenCount: 20,
        },
        modelVersion: DEFAULT_GEMINI_MODEL,
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await generateGeminiContent({
        prompt: "Say hello",
        apiKey: "AIzaSyFakeKey123",
        systemInstruction: "You are an assistant",
        temperature: 0.5,
      });

      expect(result.text).toBe("Hello from Gemini 2.5 Flash!");
      expect(result.model).toBe("gemini-2.5-flash");
      expect(result.usage?.totalTokens).toBe(20);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledOptions] = mockFetch.mock.calls[0] as [string, { method: string; body: string }];

      expect(calledUrl).toContain(`/${DEFAULT_API_VERSION}/models/gemini-2.5-flash:generateContent?key=AIzaSyFakeKey123`);
      expect(calledOptions.method).toBe("POST");

      const body = JSON.parse(calledOptions.body);
      expect(body.contents).toEqual([
        { role: "user", parts: [{ text: "Say hello" }] },
      ]);
      expect(body.systemInstruction).toEqual({
        parts: [{ text: "You are an assistant" }],
      });
      expect(body.generationConfig).toEqual({
        temperature: 0.5,
        maxOutputTokens: undefined,
      });
    });

    it("extracts tool calling functionCalls from model candidates", async () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  functionCall: {
                    name: "entity_crud",
                    args: { operation: "query", domain: "angus", limit: 5 },
                  },
                },
              ],
            },
            finishReason: "STOP",
          },
        ],
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await generateGeminiContent({
        prompt: "Show me entities in the angus domain",
        apiKey: "AIzaSyFakeKey123",
        tools: defaultClientActionRegistry.toGeminiTools(),
      });

      expect(result.functionCalls).toBeDefined();
      expect(result.functionCalls).toHaveLength(1);
      expect(result.functionCalls?.[0]?.name).toBe("entity_crud");
      expect(result.functionCalls?.[0]?.args).toEqual({
        operation: "query",
        domain: "angus",
        limit: 5,
      });
      expect(result.modelParts).toBeDefined();
      expect(result.modelParts?.[0]?.functionCall?.name).toBe("entity_crud");
    });

    it("handles HTTP error response with descriptive message", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        statusText: "Bad Request",
        json: async () => ({
          error: {
            message: "API key not valid. Please pass a valid API key.",
            status: "INVALID_ARGUMENT",
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        generateGeminiContent({
          prompt: "Test error handling",
          apiKey: "invalid-key",
        }),
      ).rejects.toThrow("API key not valid");
    });

    it("surfaces actionable guidance when API_KEY_SERVICE_BLOCKED occurs", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        json: async () => ({
          error: {
            code: 403,
            message: "Requests to this API generativelanguage.googleapis.com method google.ai.generativelanguage.v1.GenerativeService.GenerateContent are blocked.",
            status: "PERMISSION_DENIED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "API_KEY_SERVICE_BLOCKED",
                domain: "googleapis.com",
                metadata: {
                  consumer: "projects/852300225101",
                  service: "generativelanguage.googleapis.com",
                },
              },
            ],
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      await expect(
        generateGeminiContent({
          prompt: "Test blocked key",
          apiKey: "blocked-key",
        }),
      ).rejects.toThrow("API Key Service Blocked: Generative Language API is blocked or disabled");
    });
  });

  describe("streamGeminiContent", () => {
    it("streams SSE response and invokes onChunk callback", async () => {
      const sseChunks = [
        'data: {"candidates":[{"content":{"parts":[{"text":"Hello "}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"world"}]}}]}\n\n',
        'data: {"candidates":[{"content":{"parts":[{"text":"!"}]}}]}\n\n',
        "data: [DONE]\n\n",
      ];

      const encoder = new TextEncoder();
      let chunkIdx = 0;

      const mockReadableStream = new ReadableStream({
        pull(controller) {
          if (chunkIdx < sseChunks.length) {
            controller.enqueue(encoder.encode(sseChunks[chunkIdx]));
            chunkIdx++;
          } else {
            controller.close();
          }
        },
      });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        body: mockReadableStream,
      });
      vi.stubGlobal("fetch", mockFetch);

      const chunkUpdates: string[] = [];
      const aggregatedUpdates: string[] = [];

      const result = await streamGeminiContent(
        {
          prompt: "Stream test",
          apiKey: "AIzaSyFakeKey123",
        },
        (chunk, aggregated) => {
          chunkUpdates.push(chunk);
          aggregatedUpdates.push(aggregated);
        },
      );

      expect(chunkUpdates).toEqual(["Hello ", "world", "!"]);
      expect(aggregatedUpdates).toEqual(["Hello ", "Hello world", "Hello world!"]);
      expect(result.text).toBe("Hello world!");
    });
  });

  describe("Agent-Native Action Execution (ADR-100 parity)", () => {
    it("executes entity_crud action directly for query, create, and delete", async () => {
      expect(entityCrudActionClient.id).toBe("entity_crud");
      expect(entityCrudActionClient.name).toBe("entity_crud");

      // 1. Query entities
      const queryResult = await executeEntityCrud({
        operation: "query",
        limit: 10,
      });
      expect(queryResult.operation).toBe("query");
      expect(queryResult.count).toBeGreaterThan(0);
      expect(queryResult.rows).toBeDefined();

      // 2. Create entity via action
      const createResult = await executeEntityCrud({
        operation: "create",
        title: "Test Companion Entity",
        entity_type: "project",
        tags: ["ai", "test"],
        domain: "work",
      });
      expect(createResult.operation).toBe("create");
      expect(createResult.success).toBe(true);
      expect(createResult.created).toHaveLength(1);
      const newEntityId = createResult.created?.[0];
      expect(newEntityId).toBeDefined();

      // 3. Query to verify created entity is found
      const verifyQuery = await executeEntityCrud({
        operation: "query",
        domain: "work",
      });
      expect(verifyQuery.rows?.some((r) => r.id === newEntityId)).toBe(true);

      // 4. Single delete (archive)
      if (newEntityId) {
        const deleteResult = await executeEntityCrud({
          operation: "delete",
          id: newEntityId,
          archive_only: true,
        });
        expect(deleteResult.operation).toBe("delete");
        expect(deleteResult.success).toBe(true);
        expect(deleteResult.archiveOnly).toBe(true);
      }

      // 5. Bulk delete dry-run preview
      const previewResult = await executeEntityCrud({
        operation: "bulk_delete",
        tags: ["ai"],
        dry_run: true,
      });
      expect(previewResult.operation).toBe("bulk_delete");
      expect(previewResult.dryRun).toBe(true);
      expect(previewResult.wouldDeleteIds).toBeDefined();
    });

    it("executes geminiChatActionClient with validated schema", async () => {
      const mockResponse = {
        candidates: [
          {
            content: {
              role: "model",
              parts: [{ text: "Action response text" }],
            },
          },
        ],
      };

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => mockResponse,
      });
      vi.stubGlobal("fetch", mockFetch);

      const response = await executeGeminiChat({
        prompt: "What is ahOS?",
        apiKey: "AIzaSyFakeKey123",
      });

      expect(response.text).toBe("Action response text");
      expect(response.model).toBe("gemini-2.5-flash");
    });

    it("rejects invalid input schema", async () => {
      await expect(
        geminiChatActionClient.schema.parseAsync({
          temperature: 5, // exceeds max: 2
        }),
      ).rejects.toThrow();
    });
  });

  describe("Token-Guard Sanitization & Query Filtering", () => {
    it("sanitizeEntityRow strips embedding vectors and truncates long text", () => {
      const mockRow = {
        id: "ent-123",
        title: "Test Entity",
        description: "A".repeat(800),
        embedding: [0.1, 0.2, 0.3, 0.4],
        search_vector: "'test':1",
        properties: {
          zoom_level: 5,
          long_note: "B".repeat(500),
        },
      };

      const clean = sanitizeEntityRow(mockRow);
      expect(clean.id).toBe("ent-123");
      expect(clean.title).toBe("Test Entity");
      expect(clean.embedding).toBeUndefined();
      expect(clean.search_vector).toBeUndefined();
      expect((clean.description as string).length).toBeLessThan(520);
      expect((clean.description as string).endsWith("... [truncated]")).toBe(true);

      const cleanProps = clean.properties as Record<string, unknown>;
      expect(cleanProps.zoom_level).toBe(5);
      expect((cleanProps.long_note as string).length).toBeLessThan(320);
    });

    it("sanitizeToolOutputForGemini cleans nested rows and strips vector payloads", () => {
      const toolOutput = {
        operation: "query",
        count: 2,
        rows: [
          {
            id: "1",
            title: "Row 1",
            embedding: Array(1536).fill(0.01),
            description: "Short desc",
          },
          {
            id: "2",
            title: "Row 2",
            search_vector: "'row':2",
            description: "C".repeat(600),
          },
        ],
      };

      const sanitized = sanitizeToolOutputForGemini(toolOutput) as Record<string, unknown>;
      expect(sanitized.operation).toBe("query");
      const sanitizedRows = sanitized.rows as Array<Record<string, unknown>>;
      expect(sanitizedRows).toHaveLength(2);
      expect(sanitizedRows[0].embedding).toBeUndefined();
      expect(sanitizedRows[1].search_vector).toBeUndefined();
      expect((sanitizedRows[1].description as string).endsWith("... [truncated]")).toBe(true);
    });

    it("entity_crud filters by query substring across title and description", async () => {
      const result = await executeEntityCrud({
        operation: "query",
        query: "Work",
      });
      expect(result.operation).toBe("query");
      expect(result.rows).toBeDefined();
      expect(result.rows?.length).toBeGreaterThan(0);
      expect(result.rows?.every((r) =>
        (r.title as string).toLowerCase().includes("work") ||
        ((r.description as string) || "").toLowerCase().includes("work")
      )).toBe(true);
    });

    it("entity_crud filters by exact/partial title and by ids", async () => {
      const titleResult = await executeEntityCrud({
        operation: "query",
        title: "ahOS Core System",
      });
      expect(titleResult.rows).toHaveLength(1);
      expect(titleResult.rows?.[0].title).toBe("ahOS Core System");

      const idResult = await executeEntityCrud({
        operation: "query",
        ids: ["11111111-2222-4333-8444-555555555552"],
      });
      expect(idResult.rows).toHaveLength(1);
      expect(idResult.rows?.[0].title).toBe("Work Platform");
    });
  });
});

