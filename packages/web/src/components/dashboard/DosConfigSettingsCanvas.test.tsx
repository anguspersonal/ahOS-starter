import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("../../lib/supabase.js", () => ({
  supabase: {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "test-jwt-token" } },
      }),
    },
  },
}));

import {
  DEFAULT_DOS_CONFIG_RECORD,
  DosConfigSettingsCanvas,
  applyDosConfigOptimisticUpdate,
  configPreferencesGetActionClient,
  configPreferencesUpdateActionClient,
  dosConfigGetActionClient,
  evaluatePastedInstructionsFreshness,
  instructionsGetActionClient,
  isValidCanonicalSha256,
  loadDosConfigSettingsSnapshot,
  normalizeHandshakeInstructions,
  normalizeOperatingPrinciple,
  parseInstructionsGetResult,
  reorderList,
  syncCanonicalPastedInstructions,
  updateDosConfigPreferences,
} from "./DosConfigSettingsCanvas.js";
import type { DosConfigRecord } from "@ahkms/core";

describe("DosConfigSettingsCanvas (#1985)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders all user_preferences.dos_config sections and add, edit, reorder, and delete controls", () => {
    const html = renderToString(
      <DosConfigSettingsCanvas
        initialConfig={DEFAULT_DOS_CONFIG_RECORD}
        initialInstructions={{
          canonical_sha256:
            "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
          status: "fresh",
          detail: "Canonical instructions match pasted SHA-256.",
        }}
        initialDomain="work"
        autoLoad={false}
      />,
    );

    // Main canvas & sections
    expect(html).toContain('data-testid="dos-config-settings-canvas"');
    expect(html).toContain('data-testid="dos-section-pasted-instructions"');
    expect(html).toContain('data-testid="dos-section-tone"');
    expect(html).toContain('data-testid="dos-section-operating-principles"');
    expect(html).toContain('data-testid="dos-section-handshake-instructions"');
    expect(html).toContain('data-testid="dos-section-types"');
    expect(html).toContain('data-testid="dos-section-audiences"');
    expect(html).toContain('data-testid="dos-section-by-domain"');

    // Canonical paste freshness status
    expect(html).toContain("FRESH: Canonical Paste Fresh");
    expect(html).toContain('data-testid="stamp-canonical-paste-button"');

    // Tone controls (add, edit, reorder, delete)
    expect(html).toContain("British English spelling and punctuation");
    expect(html).toContain('data-testid="tone-move-up-0"');
    expect(html).toContain('data-testid="tone-move-down-0"');
    expect(html).toContain('data-testid="tone-edit-button-0"');
    expect(html).toContain('data-testid="tone-delete-button-0"');
    expect(html).toContain('data-testid="tone-add-input"');
    expect(html).toContain('data-testid="tone-add-button"');

    // Operating principles controls
    expect(html).toContain("verify_before_done");
    expect(html).toContain('data-testid="principle-move-up-verify_before_done"');
    expect(html).toContain('data-testid="principle-move-down-verify_before_done"');
    expect(html).toContain('data-testid="principle-edit-button-verify_before_done"');
    expect(html).toContain('data-testid="principle-delete-button-verify_before_done"');
    expect(html).toContain('data-testid="principle-add-button"');

    // Handshake instructions controls
    expect(html).toContain("Verify remote MCP server health");
    expect(html).toContain('data-testid="handshake-move-up-0"');
    expect(html).toContain('data-testid="handshake-move-down-0"');
    expect(html).toContain('data-testid="handshake-edit-button-0"');
    expect(html).toContain('data-testid="handshake-delete-button-0"');
    expect(html).toContain('data-testid="handshake-add-button"');

    // Atom types controls
    expect(html).toContain('data-testid="type-item-decision"');
    expect(html).toContain('data-testid="type-move-up-decision"');
    expect(html).toContain('data-testid="type-edit-button-decision"');
    expect(html).toContain('data-testid="type-delete-button-decision"');
    expect(html).toContain('data-testid="type-add-button"');

    // Audiences controls
    expect(html).toContain('data-testid="audience-item-board"');
    expect(html).toContain("register: executive_brief");
    expect(html).toContain('data-testid="audience-move-up-board"');
    expect(html).toContain('data-testid="audience-edit-button-board"');
    expect(html).toContain('data-testid="audience-delete-button-board"');
    expect(html).toContain('data-testid="audience-add-button"');

    // Per-domain by_domain controls (topics, pillars, artefact_registers)
    expect(html).toContain('data-testid="domain-tab-work"');
    expect(html).toContain('data-testid="domain-tab-angus"');
    expect(html).toContain('data-testid="domain-subsection-topics"');
    expect(html).toContain("Clinical Safety");
    expect(html).toContain('data-testid="domain-topic-add-button"');
    expect(html).toContain('data-testid="domain-subsection-pillars"');
    expect(html).toContain("Product Velocity");
    expect(html).toContain('data-testid="allow-pillar-removal-checkbox"');
    expect(html).toContain('data-testid="domain-pillar-add-button"');
    expect(html).toContain('data-testid="domain-subsection-registers"');
    expect(html).toContain("board_memo");
    expect(html).toContain('data-testid="domain-register-add-button"');
  });

  it("evaluates pasted_instructions canonical freshness across JSON and plain-text instructions_get outputs", () => {
    const fresh = evaluatePastedInstructionsFreshness(
      {
        sha256: "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
        pasted_at: "2026-10-31T10:00:00.000Z",
      },
      {
        canonical_sha256:
          "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
      },
    );
    expect(fresh.status).toBe("fresh");
    expect(fresh.label).toBe("Canonical Paste Fresh");

    // Plain-text MCP markdown response from packages/mcp-server/src/tools/instructionsGet.ts
    const plainTextMcp = {
      content: [
        {
          type: "text",
          text: [
            "# Canonical System Instructions (system-instructions, #1025)",
            "Sync key: system_instructions_sync",
            "Canonical sha256: ffffeeddddccccbbbbaaaa000099998888777766665555444433332222111100",
            "Pasted sha256: 1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
            "Pasted at: 2026-10-01T10:00:00.000Z",
            "Status: STALE - Pasted instructions hash does not match current canonical hash.",
            "Fix: Copy and run instructions_mark_pasted",
            "",
            "--- COPY BELOW THIS LINE INTO SYSTEM INSTRUCTIONS ---",
          ].join("\n"),
        },
      ],
    };

    const parsedPlain = parseInstructionsGetResult(plainTextMcp);
    expect(parsedPlain?.canonical_sha256).toBe(
      "ffffeeddddccccbbbbaaaa000099998888777766665555444433332222111100",
    );
    expect(parsedPlain?.pasted_sha256).toBe(
      "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
    );
    expect(parsedPlain?.status).toBe("stale");

    const staleFromPlain = evaluatePastedInstructionsFreshness(
      undefined,
      plainTextMcp,
    );
    expect(staleFromPlain.status).toBe("stale");
    expect(staleFromPlain.canonicalSha256).toBe(
      "ffffeeddddccccbbbbaaaa000099998888777766665555444433332222111100",
    );
    expect(staleFromPlain.detail).toContain(
      "Pasted instructions hash does not match current canonical hash.",
    );

    const missing = evaluatePastedInstructionsFreshness(null, {
      canonical_sha256:
        "ffffeeddddccccbbbbaaaa000099998888777766665555444433332222111100",
    });
    expect(missing.status).toBe("missing");
    expect(missing.label).toBe("Missing Paste Record");

    const staleHtml = renderToString(
      <DosConfigSettingsCanvas
        initialConfig={{
          ...DEFAULT_DOS_CONFIG_RECORD,
          pasted_instructions: {
            sha256:
              "1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff",
            pasted_at: "2026-10-01T10:00:00.000Z",
          },
        }}
        initialInstructions={plainTextMcp}
        autoLoad={false}
      />,
    );
    expect(staleHtml).toContain("STALE: Stale Paste (Drift Detected)");
  });

  it("loads DOS config snapshot via /api/actions and degrades gracefully if supplementary tools fail", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/api/actions/config_preferences_get")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            row: {
              user_id: "owner-1",
              dos_config: {
                tone: ["Keep sentences crisp and British."],
                pasted_instructions: {
                  sha256:
                    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
                  pasted_at: "2026-10-30T12:00:00.000Z",
                },
              },
            },
          }),
        };
      }
      if (url.endsWith("/api/actions/dos_config_get")) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ error: "Action dos_config_get not registered" }),
        };
      }
      if (url.endsWith("/api/actions/instructions_get")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: [
              {
                type: "text",
                text: "Canonical sha256: abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\nStatus: FRESH - Up to date",
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected action URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const snapshot = await loadDosConfigSettingsSnapshot("work");

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(snapshot.dosConfig.tone).toEqual(["Keep sentences crisp and British."]);
    expect(snapshot.domainSlice).toBeNull();
    expect(snapshot.freshness.status).toBe("fresh");
    expect(snapshot.freshness.canonicalSha256).toBe(
      "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
  });

  it("rolls back optimistic dosConfig state when config_preferences_update rejects", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        error:
          "Strategic pillars are append-only by default (#692); pass allow_pillar_removal: true to remove.",
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    let currentState: DosConfigRecord = DEFAULT_DOS_CONFIG_RECORD;
    let statusMessage: string | null = null;
    let errorMessage: string | null = null;
    const stateTransitions: DosConfigRecord[] = [];

    const optimisticWithoutPillar: DosConfigRecord = {
      ...DEFAULT_DOS_CONFIG_RECORD,
      by_domain: {
        ...DEFAULT_DOS_CONFIG_RECORD.by_domain,
        work: {
          ...DEFAULT_DOS_CONFIG_RECORD.by_domain?.work,
          pillars: [],
        },
      },
    };

    const ok = await applyDosConfigOptimisticUpdate({
      previousConfig: DEFAULT_DOS_CONFIG_RECORD,
      optimisticNext: optimisticWithoutPillar,
      patch: {
        dos_config: {
          by_domain: {
            work: {
              pillars: { remove: "product_velocity" },
            },
          },
        },
      },
      summaryMessage: 'Removed pillar "product_velocity" from work.',
      setDosConfig: (updater) => {
        currentState =
          typeof updater === "function" ? updater(currentState) : updater;
        stateTransitions.push(currentState);
      },
      setStatusBanner: (msg) => {
        statusMessage = msg;
      },
      setErrorBanner: (msg) => {
        errorMessage = msg;
      },
    });

    expect(ok).toBe(false);
    // First transition was the optimistic removal; second transition rolled back to previousConfig
    expect(stateTransitions).toHaveLength(2);
    expect(stateTransitions[0]?.by_domain?.work?.pillars).toEqual([]);
    expect(currentState.by_domain?.work?.pillars).toEqual(
      DEFAULT_DOS_CONFIG_RECORD.by_domain?.work?.pillars,
    );
    expect(statusMessage).toBeNull();
    expect(errorMessage).toContain("Action config_preferences_update failed");
  });

  it("refuses to persist a fabricated all-zero SHA-256 when canonical SHA-256 is unavailable", async () => {
    expect(isValidCanonicalSha256("0".repeat(64))).toBe(false);
    expect(
      isValidCanonicalSha256(
        "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
      ),
    ).toBe(true);

    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      json: async () => ({ error: "Action instructions_get not found" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const applyUpdateSpy = vi.fn();
    await expect(
      syncCanonicalPastedInstructions({
        currentConfig: DEFAULT_DOS_CONFIG_RECORD,
        fallbackInstructions: null,
        setInstructionsInfo: vi.fn(),
        applyUpdate: applyUpdateSpy,
      }),
    ).rejects.toThrow(/no valid 64-character canonical SHA-256/i);

    expect(applyUpdateSpy).not.toHaveBeenCalled();
  });

  it("dispatches config_preferences_update mutations for add, edit, reorder, and delete across sections", async () => {
    const capturedPayloads: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(
      async (url: string, init?: { body?: unknown }) => {
        const parsedBody = init?.body ? JSON.parse(String(init.body)) : {};
        capturedPayloads.push({ url, body: parsedBody });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            updated: true,
            changedKeys: ["dos_config"],
            row: {
              user_id: "owner-1",
              dos_config: {
                ...DEFAULT_DOS_CONFIG_RECORD,
                tone: ["Updated rule 1", "Rule 2"],
              },
            },
          }),
        };
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    // 1. Add tone rule + update operating principle + reorder handshake instructions
    const res1 = await updateDosConfigPreferences({
      dos_config: {
        tone: { add: "Use British spelling everywhere." },
        operating_principles: {
          update: {
            match: "verify_before_done",
            key: "verify_before_done",
            description: "Run full local verification before marking done.",
          },
        },
        handshake_instructions: {
          replace: ["Step B", "Step A"],
        },
      },
    });

    expect(res1.output.updated).toBe(true);
    expect(capturedPayloads[0]?.url).toContain(
      "/api/actions/config_preferences_update",
    );
    expect(capturedPayloads[0]?.body).toEqual({
      dos_config: {
        tone: { add: "Use British spelling everywhere." },
        operating_principles: {
          update: {
            match: "verify_before_done",
            key: "verify_before_done",
            description: "Run full local verification before marking done.",
          },
        },
        handshake_instructions: {
          replace: ["Step B", "Step A"],
        },
      },
    });

    // 2. Delete a domain pillar with allow_pillar_removal: true (#692)
    await updateDosConfigPreferences({
      allow_pillar_removal: true,
      dos_config: {
        by_domain: {
          work: {
            pillars: { remove: "trust_and_safety" },
            topics: { add: "Board Reporting" },
            artefact_registers: {
              update: {
                match: "board_memo",
                key: "board_memo",
                tone: "Concise board-level summary.",
              },
            },
          },
        },
      },
    });

    expect(capturedPayloads[1]?.body).toEqual({
      allow_pillar_removal: true,
      dos_config: {
        by_domain: {
          work: {
            pillars: { remove: "trust_and_safety" },
            topics: { add: "Board Reporting" },
            artefact_registers: {
              update: {
                match: "board_memo",
                key: "board_memo",
                tone: "Concise board-level summary.",
              },
            },
          },
        },
      },
    });
  });

  it("normalises handshake instructions, operating principles, and list reordering", () => {
    expect(normalizeHandshakeInstructions("Single step")).toEqual(["Single step"]);
    expect(normalizeHandshakeInstructions([" Step 1 ", "", "Step 2"])).toEqual([
      "Step 1",
      "Step 2",
    ]);
    expect(normalizeHandshakeInstructions(undefined)).toEqual([]);

    expect(normalizeOperatingPrinciple("Keep blasts small", 0)).toEqual({
      key: "keep_blasts_small",
      description: "Keep blasts small",
    });

    expect(reorderList(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
    expect(reorderList(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(reorderList(["a", "b", "c"], 1, 1)).toEqual(["a", "b", "c"]);

    expect(configPreferencesGetActionClient.id).toBe("config_preferences_get");
    expect(configPreferencesUpdateActionClient.id).toBe(
      "config_preferences_update",
    );
    expect(dosConfigGetActionClient.id).toBe("dos_config_get");
    expect(instructionsGetActionClient.id).toBe("instructions_get");
  });
});
