import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  approvalApproveActionClient,
  approvalClientActions,
  approvalListActionClient,
  approvalRejectActionClient,
  listParkedCalls,
  noticeFromResolution,
  resolveParkedCall,
  type PendingApprovalInboxRow,
} from "../lib/approvalActions.js";
import { ApprovalsList } from "../components/approvals/ApprovalsCanvas.js";
import { defaultClientActionRegistry } from "../lib/actionRegistry.js";
import { getTabFromPathname, TAB_PATHS } from "../lib/router.js";
import { supabase } from "../lib/supabase.js";

vi.mock("../lib/supabase.js", () => ({
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
}));

const cleanRender = (el: React.ReactElement): string =>
  renderToString(el).replace(/<!-- -->/g, "");

describe("Approvals Inbox (#1423)", () => {
  const API_BASE = "https://api.ahos.internal/api/actions";
  const DECISION_ID = "11111111-1111-4111-a111-111111111111";
  const sampleRow: PendingApprovalInboxRow = {
    decision_id: DECISION_ID,
    action_id: "github_issue_create",
    input: { repo: "anguspersonal/ahOS", count: 2, xss: "<img src=x onerror=alert(1)>" },
    input_keys: ["repo", "count", "xss"],
    caller: "mcp",
    client_id: "claude-desktop",
    session_id: "sess-01",
    created_at: "2026-10-19T23:30:00.000Z",
    expires_at: "2026-10-26T23:30:00.000Z",
  };
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

  it("1. renders action id, JSON.stringify input values escaped, caller, client id, UTC ISO date, buttons, and empty state", () => {
    const html = cleanRender(<ApprovalsList rows={[sampleRow]} />);
    expect(html).toContain("github_issue_create");
    for (const [key, val] of Object.entries(sampleRow.input as Record<string, unknown>)) {
      expect(html).toContain(key);
      const escaped = JSON.stringify(val).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      expect(html).toContain(escaped);
    }
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("mcp");
    expect(html).toContain("claude-desktop");
    expect(html).toContain("2026-10-26");
    expect(html).toContain("Approve");
    expect(html).toContain("Reject");
    expect(cleanRender(<ApprovalsList rows={[]} />)).toContain("No agent calls are waiting for your approval.");
  });

  it("2. disables both buttons when busyId matches the row decision_id", () => {
    const html = cleanRender(<ApprovalsList rows={[sampleRow]} busyId={DECISION_ID} />);
    expect(html.match(/<button[^>]*disabled[^>]*>/g) ?? []).toHaveLength(2);
  });

  it("3. resolveParkedCall('approve', id) posts { decision_id } with bearer token and ui caller, and surfaces failed run or 409 message in notices without throwing", async () => {
    const mockFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "executed", result: { number: 99 } }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", mockFetch);

    expect(await resolveParkedCall("approve", DECISION_ID)).toEqual({ status: "executed", result: { number: 99 } });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] as [string, { method: string; headers: Record<string, string>; body: string }];
    expect(url).toBe(`${API_BASE}/approval_approve`);
    expect(init.method).toBe("POST");
    expect(init.headers["Authorization"]).toBe("Bearer test-auth-token-xyz-123");
    expect(init.headers["X-Action-Caller"]).toBe("ui");
    expect(JSON.parse(init.body)).toEqual({ decision_id: DECISION_ID });
    expect(supabase.from).not.toHaveBeenCalled();

    mockFetch.mockImplementationOnce(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "failed", error: "Downstream GitHub 502" }),
    }));
    const failedOut = await resolveParkedCall("approve", DECISION_ID);
    expect(cleanRender(<ApprovalsList rows={[sampleRow]} notices={[noticeFromResolution(failedOut) ?? ""]} />)).toContain("Downstream GitHub 502");

    const conflictMessage = `Decision ${DECISION_ID} is not pending (already resolved, expired or claimed)`;
    mockFetch.mockImplementationOnce(async () => ({
      ok: false,
      status: 409,
      statusText: "Conflict",
      json: async () => ({ message: conflictMessage }),
    }));
    const conflictOut = await resolveParkedCall("approve", DECISION_ID);
    expect(conflictOut).toBe(conflictMessage);
    expect(cleanRender(<ApprovalsList rows={[sampleRow]} notices={[conflictOut]} />)).toContain(conflictMessage);
  });

  it("4. resolveParkedCall('reject', id) posts { decision_id } to <base>/approval_reject and listParkedCalls reads via approval_list", async () => {
    const mockFetch = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith("/approval_list") ? { approvals: [sampleRow] } : { status: "rejected", decision_id: DECISION_ID }),
    })) as unknown as ReturnType<typeof vi.fn>;
    vi.stubGlobal("fetch", mockFetch);

    expect(await resolveParkedCall("reject", DECISION_ID)).toEqual({ status: "rejected", decision_id: DECISION_ID });
    const [rejectUrl, rejectInit] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string>; body: string }];
    expect(rejectUrl).toBe(`${API_BASE}/approval_reject`);
    expect(rejectInit.headers["X-Action-Caller"]).toBe("ui");
    expect(JSON.parse(rejectInit.body)).toEqual({ decision_id: DECISION_ID });

    expect(await listParkedCalls()).toEqual([sampleRow]);
    expect(mockFetch.mock.calls[1]?.[0]).toBe(`${API_BASE}/approval_list`);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it("5. never offers approval_list, approval_approve or approval_reject to the in-app agent", () => {
    const defs = [approvalListActionClient, approvalApproveActionClient, approvalRejectActionClient];
    expect(approvalClientActions).toHaveLength(3);
    expect(defs.map((d) => d.id)).toEqual(["approval_list", "approval_approve", "approval_reject"]);
    const declNames = new Set(defaultClientActionRegistry.toGeminiTools().flatMap((t) => t.functionDeclarations.map((d) => d.name)));
    for (const def of defs) {
      expect(def.run).toBeUndefined();
      expect(defaultClientActionRegistry.has(def.id)).toBe(false);
      expect(declNames.has(def.id)).toBe(false);
    }
  });

  it("6. maps /approvals in router", () => {
    expect(getTabFromPathname("/approvals")).toBe("approvals");
    expect(TAB_PATHS.approvals).toBe("/approvals");
  });
});
