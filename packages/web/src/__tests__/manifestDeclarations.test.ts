import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import actionManifest from "@ahkms/core/action-manifest.json";
import { defaultClientActionRegistry } from "../lib/actionRegistry.js";

vi.mock("../lib/supabase.js", () => {
  return {
    supabase: {
      from: vi.fn(),
      auth: {
        getSession: vi.fn(async () => ({
          data: {
            session: {
              access_token: "test-auth-token-manifest",
              user: { id: "00000000-0000-4000-a000-000000000001" },
            },
          },
        })),
      },
    },
  };
});

interface ManifestEntry {
  description: string;
  expose: { ui_agent?: boolean };
  input_schema: Record<string, unknown>;
}

const manifestActions = (actionManifest as { actions: Record<string, ManifestEntry> }).actions;

describe("Manifest-backed ui_agent Gemini declarations (#1556)", () => {
  const API_BASE = "https://api.ahos.internal/api/actions";
  let originalApiUrl: string | undefined;

  beforeEach(() => {
    originalApiUrl = import.meta.env.VITE_ACTION_API_URL;
    import.meta.env.VITE_ACTION_API_URL = API_BASE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    import.meta.env.VITE_ACTION_API_URL = originalApiUrl;
    vi.restoreAllMocks();
  });

  it("exposes the exact union of manifest expose.ui_agent actions and registered client actions without duplicates", () => {
    const tools = defaultClientActionRegistry.toGeminiTools();
    expect(tools).toHaveLength(1);
    const declarations = tools[0].functionDeclarations;
    const names = declarations.map((d) => d.name);

    expect(new Set(names).size).toBe(names.length);

    const manifestUiAgentIds = Object.entries(manifestActions)
      .filter(([, entry]) => entry.expose.ui_agent === true)
      .map(([id]) => id);
    const localClientIds = defaultClientActionRegistry.list().map((a) => a.id);
    const expectedUnion = Array.from(new Set([...manifestUiAgentIds, ...localClientIds])).sort();

    expect(names.slice().sort()).toEqual(expectedUnion);
  });

  it("matches manifest description and input_schema.properties keys for every manifest-backed declaration", () => {
    const declarations = defaultClientActionRegistry.toGeminiTools()[0].functionDeclarations;
    const declByName = new Map(declarations.map((d) => [d.name, d]));

    for (const [id, entry] of Object.entries(manifestActions)) {
      if (!entry.expose.ui_agent) continue;
      const decl = declByName.get(id);
      expect(decl, `missing declaration for ${id}`).toBeDefined();
      expect(decl!.description).toBe(entry.description);

      const schemaProps = (entry.input_schema.properties as Record<string, unknown> | undefined) ?? {};
      const expectedKeys = Object.keys(schemaProps).sort();
      const actualKeys = Object.keys(decl!.parameters.properties ?? {}).sort();
      expect(actualKeys, `property keys mismatch for ${id}`).toEqual(expectedKeys);
    }
  });

  it("dispatches manifest ui_agent actions without a local handler to POST /api/actions/<id> with X-Action-Caller header", async () => {
    const mockFetch = vi.fn(
      async (
        _url: string,
        _init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: "captured-1", ok: true }),
        } as unknown as Response;
      },
    );
    vi.stubGlobal("fetch", mockFetch);

    const captureResult = await defaultClientActionRegistry.execute(
      "capture",
      { content: "session note", tag: "note" },
      "ui_agent",
    );
    expect(captureResult).toEqual({ id: "captured-1", ok: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [captureUrl, captureInit] = mockFetch.mock.calls[0];
    expect(captureUrl).toBe(`${API_BASE}/capture`);
    expect(captureInit?.method).toBe("POST");
    expect(captureInit?.headers?.["X-Action-Caller"]).toBe("ui_agent");
    expect(captureInit?.headers?.["Authorization"]).toBe("Bearer test-auth-token-manifest");
    expect(JSON.parse(captureInit?.body ?? "{}")).toEqual({ content: "session note", tag: "note" });

    await defaultClientActionRegistry.execute(
      "github_issue_get",
      { issue_number: 1556 },
      "ui",
    );
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [issueUrl, issueInit] = mockFetch.mock.calls[1];
    expect(issueUrl).toBe(`${API_BASE}/github_issue_get`);
    expect(issueInit?.headers?.["X-Action-Caller"]).toBe("ui");
  });

  it("throws unregistered error for unknown ids and for manifest actions with expose.ui_agent: false", async () => {
    await expect(defaultClientActionRegistry.execute("non_existent", {})).rejects.toThrow(
      'Client action "non_existent" is not registered in CAR',
    );
    await expect(
      defaultClientActionRegistry.execute("drive_discover_sweep", {}, "ui_agent"),
    ).rejects.toThrow('Client action "drive_discover_sweep" is not registered in CAR');
    expect(defaultClientActionRegistry.has("drive_discover_sweep")).toBe(false);
  });

  it("contains no hardcoded : GeminiTool = { literal under packages/web/src/lib/", () => {
    const libDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../lib");
    const files = fs.readdirSync(libDir).filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"));
    for (const file of files) {
      const content = fs.readFileSync(path.join(libDir, file), "utf8");
      expect(content, `${file} contains hardcoded GeminiTool literal`).not.toContain(": GeminiTool = {");
      expect(content, `${file} still references ENTITY_CRUD_TOOL_DECLARATION`).not.toContain(
        "ENTITY_CRUD_TOOL_DECLARATION",
      );
    }
  });
});
