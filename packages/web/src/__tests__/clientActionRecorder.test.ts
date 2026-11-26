import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inputSha256 } from "@ahkms/core";
import {
  bindLocalHandler,
  ClientActionRegistry,
} from "../lib/actionRegistry.js";
import {
  ClientActionRecorder,
  resetClientActionRecorderForTesting,
} from "../lib/clientActionRecorder.js";
import {
  registerGraphFilterListener,
  runGraphFilter,
} from "../lib/graphActions.js";
import {
  resetScreenStateForTesting,
  setScreenTab,
} from "../lib/screenState.js";
import { runViewScreen } from "../lib/viewScreenAction.js";

vi.mock("../lib/supabase.js", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({
        data: {
          session: {
            access_token: "test-recorder-token",
            user: { id: "00000000-0000-4000-a000-000000000001" },
          },
        },
      })),
    },
  },
}));

describe("clientActionRecorder in web (#1558, ADR-105 R9, §5)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let unsubscribeGraphListener: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    resetClientActionRecorderForTesting();
    resetScreenStateForTesting();
    setScreenTab("graph");
    unsubscribeGraphListener = registerGraphFilterListener(() => {});
    fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ recorded: 1 }),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    unsubscribeGraphListener();
    resetScreenStateForTesting();
    resetClientActionRecorderForTesting();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("1. three local runs by the agent flush as one POST after 5 s; input values never leave the browser", async () => {
    const recorder = new ClientActionRecorder({
      fetchImpl: fetchMock as unknown as typeof fetch,
      getEndpointUrl: () => "/api/actions/client_action_record",
    });
    const registry = new ClientActionRegistry(recorder);
    bindLocalHandler("graph_filter", runGraphFilter, registry);
    bindLocalHandler("view_screen", runViewScreen, registry);

    const secretInput1 = {
      query: "top-secret-search-term-alpha",
      entity_types: ["project", "person"],
    };
    const secretInput2 = {
      query: "confidential-query-beta",
      hierarchy_level: 2,
    };
    const secretInput3 = {
      include_record: false,
    };

    await registry.execute("graph_filter", secretInput1, "ui_agent");
    await registry.execute("graph_filter", secretInput2, "ui_agent");
    await registry.execute("view_screen", secretInput3, "ui_agent");

    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/actions/client_action_record");
    expect(init.method).toBe("POST");
    expect(init.headers["X-Action-Caller"]).toBe("ui_agent");
    expect(init.headers["Authorization"]).toBe("Bearer test-recorder-token");

    const rawBody = String(init.body);
    expect(rawBody).not.toContain("top-secret-search-term-alpha");
    expect(rawBody).not.toContain("confidential-query-beta");
    expect(rawBody).not.toContain("project");

    const parsedBody = JSON.parse(rawBody);
    expect(parsedBody.records).toHaveLength(3);
    expect(parsedBody.records[0]).toMatchObject({
      action_id: "graph_filter",
      outcome: "success",
      input_keys: ["entity_types", "query"],
      input_sha256: await inputSha256(secretInput1),
    });
    expect(parsedBody.records[0].request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(parsedBody.records[0].duration_ms).toBeGreaterThanOrEqual(0);

    expect(parsedBody.records[1]).toMatchObject({
      action_id: "graph_filter",
      outcome: "success",
      input_keys: ["hierarchy_level", "query"],
      input_sha256: await inputSha256(secretInput2),
    });
    expect(parsedBody.records[2]).toMatchObject({
      action_id: "view_screen",
      outcome: "success",
      input_keys: ["include_record"],
      input_sha256: await inputSha256(secretInput3),
    });
  });

  it("2. flushes immediately as one POST when 20 records are reached before 5 s", async () => {
    const recorder = new ClientActionRecorder({
      fetchImpl: fetchMock as unknown as typeof fetch,
      getEndpointUrl: () => "/api/actions/client_action_record",
    });
    const registry = new ClientActionRegistry(recorder);
    bindLocalHandler("view_screen", runViewScreen, registry);

    for (let i = 0; i < 19; i++) {
      await registry.execute("view_screen", { include_record: false }, "ui_agent");
    }
    expect(fetchMock).not.toHaveBeenCalled();

    await registry.execute("view_screen", { include_record: false }, "ui_agent");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, init] = fetchMock.mock.calls[0];
    const parsed = JSON.parse(String(init.body));
    expect(parsed.records).toHaveLength(20);

    // Timer was cleared on batch flush, so advancing 5 s does not send an empty POST
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("3. flushes on pagehide using fetch with keepalive: true", async () => {
    const target = new EventTarget();
    const recorder = new ClientActionRecorder({
      fetchImpl: fetchMock as unknown as typeof fetch,
      getEndpointUrl: () => "/api/actions/client_action_record",
      eventTarget: target,
    });
    const registry = new ClientActionRegistry(recorder);
    bindLocalHandler("graph_filter", runGraphFilter, registry);

    await registry.execute("graph_filter", { query: "test-1" }, "ui_agent");
    await registry.execute("graph_filter", { query: "test-2" }, "ui_agent");
    await registry.execute("graph_filter", { query: "test-3" }, "ui_agent");

    expect(fetchMock).not.toHaveBeenCalled();

    target.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/actions/client_action_record");
    expect(init.keepalive).toBe(true);
    const parsed = JSON.parse(String(init.body));
    expect(parsed.records).toHaveLength(3);
  });

  it("4. the owner's own clicks (caller ui) enqueue nothing", async () => {
    const target = new EventTarget();
    const recorder = new ClientActionRecorder({
      fetchImpl: fetchMock as unknown as typeof fetch,
      getEndpointUrl: () => "/api/actions/client_action_record",
      eventTarget: target,
    });
    const registry = new ClientActionRegistry(recorder);
    bindLocalHandler("graph_filter", runGraphFilter, registry);
    bindLocalHandler("view_screen", runViewScreen, registry);

    await registry.execute("graph_filter", { query: "owner-click-1" });
    await registry.execute("graph_filter", { query: "owner-click-2" }, "ui");
    await registry.execute("view_screen", { include_record: false }, { caller: "ui" });

    expect(recorder.getPendingRecords()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10_000);
    target.dispatchEvent(new Event("pagehide"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("5. records error and validation_error outcomes when a local run throws for ui_agent", async () => {
    const recorder = new ClientActionRecorder({
      fetchImpl: fetchMock as unknown as typeof fetch,
      getEndpointUrl: () => "/api/actions/client_action_record",
    });
    const registry = new ClientActionRegistry(recorder);
    bindLocalHandler(
      "graph_filter",
      async (input: { query?: string }) => {
        if (input.query === "boom") {
          throw new Error("local handler failed");
        }
        return runGraphFilter(input);
      },
      registry,
    );

    await expect(
      registry.execute("graph_filter", { query: "boom" }, "ui_agent"),
    ).rejects.toThrow("local handler failed");

    await expect(
      registry.execute(
        "graph_filter",
        { unknown_field: "bad" } as any,
        "ui_agent",
      ),
    ).rejects.toThrow();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0]).toMatchObject({
      action_id: "graph_filter",
      outcome: "error",
      input_keys: ["query"],
    });
    expect(parsed.records[1]).toMatchObject({
      action_id: "graph_filter",
      outcome: "validation_error",
      input_keys: ["unknown_field"],
    });
  });
});
