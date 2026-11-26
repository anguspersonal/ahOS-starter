import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { queryLedgerRows, queryLedgerSummary, queryLedgerTrace, shortenHash, type ActionLedgerRow } from "../lib/ledgerActions.js";
import { LedgerView } from "../components/ledger/LedgerView.js";
import { TraceView, flattenTraceTree } from "../components/ledger/TraceView.js";
import { getTabFromPathname, TAB_PATHS } from "../lib/router.js";

vi.mock("../lib/supabase.js", () => ({
  supabase: {
    from: vi.fn(),
    auth: {
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "test-ledger-token", user: { id: "00000000-0000-4000-a000-000000000001" } } },
      })),
    },
  },
}));

const cleanRender = (el: React.ReactElement): string => renderToString(el).replace(/<!-- -->/g, "");
const TRACE_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const HASH_1 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
const HASH_2 = "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const HASH_3 = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

const FIXTURE_ROWS: ActionLedgerRow[] = [
  {
    id: "row-1",
    created_at: "2026-11-08T10:00:00.000Z",
    action_id: "entity_crud",
    seam: "action",
    caller: "ui_agent",
    request_id: "req-root",
    parent_request_id: null,
    trace_id: TRACE_ID,
    user_id: "00000000-0000-4000-a000-000000000001",
    client_id: "web-workspace",
    client_name: "Web Workspace",
    session_id: "sess-1",
    outcome: "success",
    duration_ms: 42,
    error_message: null,
    input_keys: ["operation", "title"],
    input_sha256: HASH_1,
  },
  {
    id: "row-2",
    created_at: "2026-11-08T10:00:01.000Z",
    action_id: "relationship_crud",
    seam: "action",
    caller: "mcp",
    request_id: "req-child",
    parent_request_id: "req-root",
    trace_id: TRACE_ID,
    user_id: "00000000-0000-4000-a000-000000000001",
    client_id: "claude-desktop",
    client_name: "Claude Desktop",
    session_id: "sess-1",
    outcome: "error",
    duration_ms: 118,
    error_message: "Relation conflict",
    input_keys: ["from_id", "to_id"],
    input_sha256: HASH_2,
  },
  {
    id: "row-3",
    created_at: "2026-11-08T10:00:02.000Z",
    action_id: "github_issue_create",
    seam: "action",
    caller: "http",
    request_id: "req-grandchild",
    parent_request_id: "req-child",
    trace_id: TRACE_ID,
    user_id: "00000000-0000-4000-a000-000000000001",
    client_id: "claude-code",
    client_name: "Claude Code",
    session_id: "sess-2",
    outcome: "pending_approval",
    duration_ms: 15,
    error_message: null,
    input_keys: ["repo", "body"],
    input_sha256: HASH_3,
  },
];

describe("Web Ledger Tab & TraceView (#1485)", () => {
  const API_BASE = "https://api.ahos.internal/api/actions";
  let originalApiUrl: string | undefined;

  beforeEach(() => {
    originalApiUrl = import.meta.env.VITE_ACTION_API_URL;
    import.meta.env.VITE_ACTION_API_URL = API_BASE;
    vi.clearAllMocks();
  });

  afterEach(() => {
    import.meta.env.VITE_ACTION_API_URL = originalApiUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("1. renders three rows with action, caller, outcome, duration and time; changing outcome filter re-queries with outcome set", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
        const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        calls.push({ url, headers: init?.headers ?? {}, body });
        if (body.mode === "summary") {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              mode: "summary",
              by_action: [{ action_id: "entity_crud", outcome: "success", count: 1 }],
              row_estimate: 3,
              total_bytes: 16384,
            }),
          };
        }
        const filtered = body.outcome ? FIXTURE_ROWS.filter((r) => r.outcome === body.outcome) : FIXTURE_ROWS;
        return { ok: true, status: 200, json: async () => ({ mode: "rows", rows: filtered }) };
      }),
    );

    const initialRows = await queryLedgerRows();
    const summary = await queryLedgerSummary();
    expect(initialRows).toHaveLength(3);
    expect(calls[0]?.url).toBe(`${API_BASE}/ledger_query`);
    expect(calls[0]?.headers["X-Action-Caller"]).toBe("ui");

    const html = cleanRender(<LedgerView initialRows={initialRows} initialSummary={summary} />);
    for (const row of FIXTURE_ROWS) {
      expect(html).toContain(row.action_id);
      expect(html).toContain(`caller: ${row.caller}`);
      expect(html).toContain(`outcome: ${row.outcome}`);
      expect(html).toContain(`${row.duration_ms}ms`);
      expect(html).toContain(row.created_at);
    }
    expect(html).toContain("rows: 3");
    expect(html).toContain("bytes: 16384");

    const errorOnly = await queryLedgerRows({ outcome: "error" });
    expect(errorOnly).toHaveLength(1);
    expect(errorOnly[0]?.action_id).toBe("relationship_crud");
    expect(calls[2]?.body).toMatchObject({ mode: "rows", outcome: "error" });
  });

  it("2. selecting a trace_id queries by trace_id and indents children under their parent_request_id", async () => {
    const calls: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { body?: string }) => {
        calls.push(init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {});
        return { ok: true, status: 200, json: async () => ({ mode: "rows", rows: FIXTURE_ROWS }) };
      }),
    );

    const traceRows = await queryLedgerTrace(TRACE_ID);
    expect(calls[0]).toMatchObject({ mode: "rows", trace_id: TRACE_ID });
    expect(flattenTraceTree(traceRows).map((n) => ({ req: n.row.request_id, depth: n.depth }))).toEqual([
      { req: "req-root", depth: 0 },
      { req: "req-child", depth: 1 },
      { req: "req-grandchild", depth: 2 },
    ]);

    const traceHtml = cleanRender(<TraceView traceId={TRACE_ID} rows={traceRows} />);
    expect(traceHtml).toContain(`data-testid="trace-node-req-root"`);
    expect(traceHtml).toContain(`data-depth="0"`);
    expect(traceHtml).toContain(`data-parent-request-id="req-root"`);
    expect(traceHtml).toContain(`data-depth="1"`);
    expect(traceHtml).toContain(`padding-left:20px`);
    expect(traceHtml).toContain(`data-parent-request-id="req-child"`);
    expect(traceHtml).toContain(`data-depth="2"`);
    expect(traceHtml).toContain(`padding-left:40px`);
  });

  it("3. renders only input_keys and shortened input_sha256 (never full hash or input values) and maps /ledger route", () => {
    const html = cleanRender(<LedgerView initialRows={FIXTURE_ROWS} initialTraceId={TRACE_ID} initialTraceRows={FIXTURE_ROWS} />);
    expect(html).toContain("operation, title");
    expect(html).toContain(shortenHash(HASH_1));
    expect(html).toContain(shortenHash(HASH_2));
    expect(html).toContain(shortenHash(HASH_3));
    expect(html).not.toContain(HASH_1);
    expect(html).not.toContain(HASH_2);
    expect(html).not.toContain(HASH_3);
    expect(TAB_PATHS.ledger).toBe("/ledger");
    expect(getTabFromPathname("/ledger")).toBe("ledger");
  });
});
