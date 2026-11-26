import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { executeActionClient } from "../lib/actionClient.js";
import { taskCrudActionClient } from "../lib/taskActions.js";

vi.mock("../lib/supabase.js", () => {
  return {
    supabase: {
      from: vi.fn(),
      auth: {
        getSession: vi.fn(async () => ({
          data: {
            session: {
              access_token: "test-auth-token-xyz-123",
              user: { id: "00000000-0000-4000-a000-000000000001" },
            },
          },
        })),
      },
    },
  };
});

describe("Runtime Action API URL (ADR-100 / ADR-101 / #1440)", () => {
  let originalBuildApiUrl: string | undefined;

  const fetchMock = vi.fn(async (_url: string, _init?: Parameters<typeof fetch>[1]) => {
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ success: true, task: { id: "t1" } }),
    } as Response;
  });

  beforeEach(() => {
    originalBuildApiUrl = import.meta.env.VITE_ACTION_API_URL;
    delete (import.meta.env as Record<string, unknown>).VITE_ACTION_API_URL;
    vi.unstubAllGlobals();
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    if (originalBuildApiUrl !== undefined) {
      import.meta.env.VITE_ACTION_API_URL = originalBuildApiUrl;
    } else {
      delete (import.meta.env as Record<string, unknown>).VITE_ACTION_API_URL;
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("1. with window.__ENV__.VITE_ACTION_API_URL, the fetch URL uses the runtime action URL", async () => {
    vi.stubGlobal("window", {
      __ENV__: { VITE_ACTION_API_URL: "https://mcp.example.test/api/actions" },
    });
    await executeActionClient(taskCrudActionClient, { operation: "create", title: "x" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://mcp.example.test/api/actions/task_crud",
      expect.any(Object),
    );
  });

  it("2. with runtime and build-time both set, runtime wins and its trailing slash is stripped", async () => {
    vi.stubGlobal("window", {
      __ENV__: { VITE_ACTION_API_URL: "https://mcp.example.test/api/actions/" },
    });
    import.meta.env.VITE_ACTION_API_URL = "https://build.example.test/api/actions";
    await executeActionClient(taskCrudActionClient, { operation: "create", title: "x" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://mcp.example.test/api/actions/task_crud",
      expect.any(Object),
    );
  });

  it("3. with runtime value of '  ' and no build-time value, URL defaults to /api/actions/task_crud", async () => {
    vi.stubGlobal("window", {
      __ENV__: { VITE_ACTION_API_URL: "  " },
    });
    await executeActionClient(taskCrudActionClient, { operation: "create", title: "x" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/actions/task_crud",
      expect.any(Object),
    );
  });
});
