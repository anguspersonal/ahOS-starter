import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod";
import {
  configPreferencesGetSchema,
  configPreferencesUpdateSchema,
  extractDosConfigFromPreferences,
  type ConfigPreferencesGetOutput,
  type ConfigPreferencesUpdateInput,
  type ConfigPreferencesUpdateOutput,
  type DosArtefactRegisterSpec,
  type DosAtomType,
  type DosAudienceSpec,
  type DosConfigRecord,
  type DosDomainConfig,
  type DosOperatingPrinciple,
  type DosPastedInstructions,
  type DosPillarSpec,
} from "@ahkms/core";
import {
  executeActionClient,
  type ClientActionDefinition,
} from "../../lib/actionClient.js";

export type ConfigPreferencesGetPayload = z.infer<
  typeof configPreferencesGetSchema
>;

export const dosConfigGetInputSchema = z
  .object({
    domain: z.enum(["work", "angus"]).optional(),
    audience: z.string().min(1).optional(),
  })
  .strict();

export type DosConfigGetInput = z.infer<typeof dosConfigGetInputSchema>;

export interface DosConfigGetResult {
  domain?: string | null;
  config?: DosDomainConfig | Record<string, DosDomainConfig>;
  types?: DosAtomType[];
  tone?: string[];
  audiences?: DosAudienceSpec[];
  content?: Array<{ type: string; text: string }>;
}

export const instructionsGetInputSchema = z.object({}).strict();

export type InstructionsGetInput = z.infer<typeof instructionsGetInputSchema>;

export interface InstructionsGetResult {
  sha256?: string;
  canonical_sha256?: string;
  pasted_sha256?: string | null;
  pasted_at?: string | null;
  status?: "fresh" | "stale" | "missing" | "drifted";
  detail?: string;
  fix?: string | null;
  instructions?: string;
  text?: string;
  content?: Array<{ type: string; text: string }>;
}

/**
 * Client action definitions dispatched over `POST /api/actions/<id>`.
 */
export const configPreferencesGetActionClient: ClientActionDefinition<
  ConfigPreferencesGetPayload,
  ConfigPreferencesGetOutput
> = {
  id: "config_preferences_get",
  name: "Get Config Preferences",
  description:
    "Read the owner's user_preferences row including dos_config via /api/actions/config_preferences_get.",
  schema: configPreferencesGetSchema,
};

export const configPreferencesUpdateActionClient: ClientActionDefinition<
  ConfigPreferencesUpdateInput,
  ConfigPreferencesUpdateOutput
> = {
  id: "config_preferences_update",
  name: "Update Config Preferences",
  description:
    "Update user_preferences and dos_config sections via /api/actions/config_preferences_update.",
  schema: configPreferencesUpdateSchema,
};

export const dosConfigGetActionClient: ClientActionDefinition<
  DosConfigGetInput,
  DosConfigGetResult
> = {
  id: "dos_config_get",
  name: "Get DOS Config",
  description:
    "Read domain-scoped DOS configuration slices via /api/actions/dos_config_get.",
  schema: dosConfigGetInputSchema,
};

export const instructionsGetActionClient: ClientActionDefinition<
  InstructionsGetInput,
  InstructionsGetResult
> = {
  id: "instructions_get",
  name: "Get Canonical System Instructions",
  description:
    "Fetch assembled canonical system instructions and paste freshness metadata via /api/actions/instructions_get.",
  schema: instructionsGetInputSchema,
};

export type PasteFreshnessStatus = "fresh" | "stale" | "missing";

export interface PasteFreshnessSummary {
  status: PasteFreshnessStatus;
  canonicalSha256: string | null;
  pastedSha256: string | null;
  pastedAt: string | null;
  label: string;
  detail: string;
}

export interface NormalizedOperatingPrinciple {
  key: string;
  description: string;
}

export const DEFAULT_DOS_CONFIG_RECORD: DosConfigRecord = {
  tone: [
    "British English spelling and punctuation across every surface.",
    "Direct, concise sentences with zero filler or hedging.",
  ],
  operating_principles: [
    {
      key: "verify_before_done",
      description: "Never claim completion without running verification commands.",
    },
    {
      key: "single_write_path",
      description: "Route every mutation through the unified action layer.",
    },
  ],
  handshake_instructions: [
    "Verify remote MCP server health before starting session rituals.",
    "Load active domain context from dos_config_get at session start.",
  ],
  types: [
    {
      key: "decision",
      description: "Durable architectural or operational choice with rationale.",
    },
    {
      key: "task",
      description: "Actionable work item with clear owner and completion bar.",
    },
  ],
  audiences: [
    {
      key: "board",
      role: "Board and investors",
      domain: "work",
      register: "executive_brief",
      cadence: "monthly",
      standing_exclusions: ["internal_tooling_noise"],
    },
    {
      key: "engineering",
      role: "Core product and platform team",
      domain: "work",
      register: "technical_spec",
      cadence: "weekly",
      standing_exclusions: [],
    },
  ],
  by_domain: {
    work: {
      topics: ["Retention", "Clinical Safety", "Voice Agent Latency"],
      pillars: [
        {
          key: "product_velocity",
          label: "Product Velocity",
          description: "Fast iteration on core member journeys.",
          notion_option: "Product Velocity",
          notion_property: "Pillar",
        },
        {
          key: "trust_and_safety",
          label: "Trust & Safety",
          description: "Clinical governance and safe escalation paths.",
          notion_option: "Trust & Safety",
          notion_property: "Pillar",
        },
      ],
      artefact_registers: [
        {
          key: "board_memo",
          tone: "Crisp, metric-backed executive prose.",
        },
        {
          key: "incident_review",
          tone: "Blameless, timeline-first root cause analysis.",
        },
      ],
    },
    angus: {
      topics: ["Personal Operations", "Knowledge Graph Curation"],
      pillars: [
        {
          key: "personal_ops",
          label: "Personal Ops",
          description: "Low-friction capture and weekly synthesis.",
          notion_option: "Personal Ops",
          notion_property: "Pillar",
        },
      ],
      artefact_registers: [
        {
          key: "journal_note",
          tone: "Candid, reflective first-person notes.",
        },
      ],
    },
  },
  pasted_instructions: {
    sha256: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
    pasted_at: "2026-10-30T09:00:00.000Z",
  },
};

const VALID_SHA256_RE = /^[a-f0-9]{64}$/i;
const ALL_ZERO_SHA256_RE = /^0{64}$/;

export function isValidCanonicalSha256(value: unknown): value is string {
  return (
    typeof value === "string" &&
    VALID_SHA256_RE.test(value.trim()) &&
    !ALL_ZERO_SHA256_RE.test(value.trim())
  );
}

export function normalizeHandshakeInstructions(
  raw: DosConfigRecord["handshake_instructions"],
): string[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => item.trim()).filter((item) => item.length > 0);
  }
  if (typeof raw === "string" && raw.trim().length > 0) {
    return [raw.trim()];
  }
  return [];
}

export function normalizeOperatingPrinciple(
  item: DosOperatingPrinciple,
  fallbackIndex = 0,
): NormalizedOperatingPrinciple {
  if (typeof item === "string") {
    const slug = item
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 32);
    return {
      key: slug || `principle_${fallbackIndex + 1}`,
      description: item,
    };
  }
  return {
    key: item.key,
    description: item.description,
  };
}

export function reorderList<T>(
  items: readonly T[],
  fromIndex: number,
  toIndex: number,
): T[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= items.length ||
    toIndex >= items.length ||
    fromIndex === toIndex
  ) {
    return [...items];
  }
  const copy = [...items];
  const [moved] = copy.splice(fromIndex, 1);
  if (moved !== undefined) {
    copy.splice(toIndex, 0, moved);
  }
  return copy;
}

function parseJsonTextFromMcpContent<T>(
  result: { content?: Array<{ type: string; text: string }> } | null | undefined,
): T | null {
  const firstText = result?.content?.[0]?.text;
  if (typeof firstText !== "string" || firstText.trim().length === 0) {
    return null;
  }
  const trimmed = firstText.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch (err) {
    return err instanceof Error ? null : null;
  }
}

/**
 * Parses `instructions_get` output from either structured JSON or the plain-text
 * markdown format returned by `packages/mcp-server/src/tools/instructionsGet.ts`
 * (`Canonical sha256: <hex>`, `Pasted sha256: <hex>`, `Pasted at: <iso>`, `Status: ...`).
 */
export function parseInstructionsGetResult(
  result: InstructionsGetResult | null | undefined,
): InstructionsGetResult | null {
  if (!result) {
    return null;
  }
  const parsedJson = parseJsonTextFromMcpContent<InstructionsGetResult>(result);
  if (parsedJson) {
    return { ...result, ...parsedJson };
  }

  const rawText =
    result.content?.[0]?.text ?? result.text ?? result.instructions ?? "";
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return result;
  }

  const extracted: InstructionsGetResult = { ...result };

  const canonicalMatch = rawText.match(
    /(?:Canonical\s+sha256|sha256)\s*:\s*([a-f0-9]{64})/i,
  );
  if (canonicalMatch?.[1]) {
    extracted.canonical_sha256 = canonicalMatch[1].toLowerCase();
  }

  const pastedShaMatch = rawText.match(/Pasted\s+sha256\s*:\s*([^\r\n]+)/i);
  if (pastedShaMatch?.[1]) {
    const candidate = pastedShaMatch[1].trim();
    extracted.pasted_sha256 = VALID_SHA256_RE.test(candidate)
      ? candidate.toLowerCase()
      : null;
  }

  const pastedAtMatch = rawText.match(/Pasted\s+at\s*:\s*([^\r\n]+)/i);
  if (pastedAtMatch?.[1]) {
    const candidate = pastedAtMatch[1].trim();
    extracted.pasted_at =
      candidate.startsWith("(") || candidate.toLowerCase() === "never"
        ? null
        : candidate;
  }

  const statusMatch = rawText.match(
    /Status\s*:\s*(FRESH|STALE|MISSING|DRIFTED)(?:\s*-\s*([^\r\n]+))?/i,
  );
  if (statusMatch?.[1]) {
    extracted.status = statusMatch[1].toLowerCase() as
      | "fresh"
      | "stale"
      | "missing"
      | "drifted";
    if (statusMatch[2]?.trim()) {
      extracted.detail = statusMatch[2].trim();
    }
  }

  const fixMatch = rawText.match(/Fix\s*:\s*([^\r\n]+)/i);
  if (fixMatch?.[1]?.trim()) {
    extracted.fix = fixMatch[1].trim();
  }

  return extracted;
}

export function evaluatePastedInstructionsFreshness(
  pastedInstructions: DosPastedInstructions | null | undefined,
  instructionsResult?: InstructionsGetResult | null,
): PasteFreshnessSummary {
  const effectiveInstructions = parseInstructionsGetResult(instructionsResult);

  const rawCanonical =
    effectiveInstructions?.canonical_sha256 ??
    effectiveInstructions?.sha256 ??
    null;
  const canonicalSha256 = isValidCanonicalSha256(rawCanonical)
    ? rawCanonical.trim().toLowerCase()
    : null;
  const rawPasted =
    pastedInstructions?.sha256 ??
    effectiveInstructions?.pasted_sha256 ??
    null;
  const pastedSha256 = isValidCanonicalSha256(rawPasted)
    ? rawPasted.trim().toLowerCase()
    : null;
  const pastedAt =
    pastedInstructions?.pasted_at ??
    effectiveInstructions?.pasted_at ??
    null;

  if (!pastedSha256) {
    return {
      status: "missing",
      canonicalSha256,
      pastedSha256: null,
      pastedAt: null,
      label: "Missing Paste Record",
      detail:
        effectiveInstructions?.detail ??
        "No pasted_instructions.sha256 is recorded in user_preferences.dos_config.",
    };
  }

  if (
    effectiveInstructions?.status === "stale" ||
    effectiveInstructions?.status === "drifted" ||
    (canonicalSha256 !== null && canonicalSha256 !== pastedSha256)
  ) {
    return {
      status: "stale",
      canonicalSha256,
      pastedSha256,
      pastedAt,
      label: "Stale Paste (Drift Detected)",
      detail:
        effectiveInstructions?.detail ??
        `Pasted SHA-256 (${pastedSha256.slice(0, 12)}) differs from canonical SHA-256 (${(canonicalSha256 ?? "unknown").slice(0, 12)}).`,
    };
  }

  return {
    status: "fresh",
    canonicalSha256: canonicalSha256 ?? pastedSha256,
    pastedSha256,
    pastedAt,
    label: "Canonical Paste Fresh",
    detail:
      effectiveInstructions?.detail ??
      `Pasted instructions match canonical SHA-256 (${pastedSha256.slice(0, 12)}).`,
  };
}

export interface DosConfigSettingsSnapshot {
  dosConfig: DosConfigRecord;
  domainSlice: DosConfigGetResult | null;
  instructions: InstructionsGetResult | null;
  freshness: PasteFreshnessSummary;
}

/**
 * Loads the current `user_preferences.dos_config`, domain slice from `dos_config_get`,
 * and canonical system instructions metadata from `instructions_get` via `/api/actions`.
 * Supplementary `dos_config_get` and `instructions_get` calls degrade gracefully to `null`
 * so `config_preferences_get` still hydrates the editor if legacy tools are unavailable.
 */
export async function loadDosConfigSettingsSnapshot(
  domain: "work" | "angus" = "work",
): Promise<DosConfigSettingsSnapshot> {
  const [prefsResult, domainResult, instructionsResult] = await Promise.all([
    executeActionClient(configPreferencesGetActionClient, {}),
    executeActionClient(dosConfigGetActionClient, { domain }).catch(() => null),
    executeActionClient(instructionsGetActionClient, {}).catch(() => null),
  ]);

  const extracted =
    extractDosConfigFromPreferences(prefsResult.row ?? null) ?? {};
  const parsedDomain = domainResult
    ? (parseJsonTextFromMcpContent<DosConfigGetResult>(domainResult) ??
      domainResult)
    : null;
  const parsedInstructions = parseInstructionsGetResult(instructionsResult);

  const mergedConfig: DosConfigRecord = {
    ...DEFAULT_DOS_CONFIG_RECORD,
    ...extracted,
    by_domain: {
      ...DEFAULT_DOS_CONFIG_RECORD.by_domain,
      ...(extracted.by_domain ?? {}),
    },
  };

  if (
    parsedDomain?.domain &&
    parsedDomain.config &&
    !Array.isArray(parsedDomain.config)
  ) {
    const domainKey = parsedDomain.domain;
    mergedConfig.by_domain = {
      ...(mergedConfig.by_domain ?? {}),
      [domainKey]: {
        ...(mergedConfig.by_domain?.[domainKey] ?? {}),
        ...(parsedDomain.config as DosDomainConfig),
      },
    };
  }

  const freshness = evaluatePastedInstructionsFreshness(
    mergedConfig.pasted_instructions,
    parsedInstructions,
  );

  return {
    dosConfig: mergedConfig,
    domainSlice: parsedDomain,
    instructions: parsedInstructions,
    freshness,
  };
}

/**
 * Applies a `config_preferences_update` mutation over `/api/actions/config_preferences_update`
 * and returns the updated `DosConfigRecord` together with the raw action output.
 */
export async function updateDosConfigPreferences(
  input: ConfigPreferencesUpdateInput,
): Promise<{
  output: ConfigPreferencesUpdateOutput;
  dosConfig: DosConfigRecord;
}> {
  const output = await executeActionClient(
    configPreferencesUpdateActionClient,
    input,
  );
  const dosConfig = extractDosConfigFromPreferences(output.row ?? null) ?? {};
  return { output, dosConfig };
}

/**
 * Applies an optimistic `dosConfig` state update and rolls back to `previousConfig`
 * if `updateDosConfigPreferences` rejects (e.g. when `allow_pillar_removal` is false).
 */
export async function applyDosConfigOptimisticUpdate(params: {
  previousConfig: DosConfigRecord;
  optimisticNext: DosConfigRecord;
  patch: ConfigPreferencesUpdateInput;
  summaryMessage: string;
  setDosConfig: (
    updater: DosConfigRecord | ((prev: DosConfigRecord) => DosConfigRecord),
  ) => void;
  setStatusBanner: (message: string | null) => void;
  setErrorBanner: (message: string | null) => void;
  setIsSaving?: (saving: boolean) => void;
}): Promise<boolean> {
  const {
    previousConfig,
    optimisticNext,
    patch,
    summaryMessage,
    setDosConfig,
    setStatusBanner,
    setErrorBanner,
    setIsSaving,
  } = params;
  setIsSaving?.(true);
  setErrorBanner(null);
  setDosConfig(optimisticNext);
  try {
    const { dosConfig: persisted } = await updateDosConfigPreferences(patch);
    if (Object.keys(persisted).length > 0) {
      setDosConfig((prev) => ({
        ...prev,
        ...persisted,
        by_domain: {
          ...(prev.by_domain ?? {}),
          ...(persisted.by_domain ?? {}),
        },
      }));
    }
    setStatusBanner(summaryMessage);
    return true;
  } catch (err) {
    setDosConfig(previousConfig);
    const message =
      err instanceof Error
        ? err.message
        : "Failed to persist DOS configuration update.";
    setErrorBanner(message);
    return false;
  } finally {
    setIsSaving?.(false);
  }
}

/**
 * Resolves the canonical system instructions SHA-256 from `instructions_get`
 * (or fallback instructions state) and persists `pasted_instructions`.
 * Refuses to persist when no valid 64-hex canonical SHA-256 is available.
 */
export async function syncCanonicalPastedInstructions(params: {
  currentConfig: DosConfigRecord;
  fallbackInstructions?: InstructionsGetResult | null;
  setInstructionsInfo: (info: InstructionsGetResult | null) => void;
  applyUpdate: (
    patch: ConfigPreferencesUpdateInput,
    optimisticNext: DosConfigRecord,
    summaryMessage: string,
  ) => Promise<void>;
}): Promise<DosPastedInstructions> {
  const latestRaw = await executeActionClient(
    instructionsGetActionClient,
    {},
  ).catch(() => null);
  const parsed =
    parseInstructionsGetResult(latestRaw) ??
    parseInstructionsGetResult(params.fallbackInstructions);
  if (parsed) {
    params.setInstructionsInfo(parsed);
  }

  const candidateSha = parsed?.canonical_sha256 ?? parsed?.sha256 ?? null;
  if (!isValidCanonicalSha256(candidateSha)) {
    throw new Error(
      "Cannot record canonical paste: no valid 64-character canonical SHA-256 available from instructions_get.",
    );
  }

  const nextPasted: DosPastedInstructions = {
    sha256: candidateSha.trim().toLowerCase(),
    pasted_at: new Date().toISOString(),
  };
  await params.applyUpdate(
    { dos_config: { pasted_instructions: nextPasted } },
    { ...params.currentConfig, pasted_instructions: nextPasted },
    "Recorded canonical system instructions paste SHA-256.",
  );
  return nextPasted;
}

interface RowActionButtonsProps {
  prefix: string;
  itemId: string | number;
  index: number;
  total: number;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function RowActionButtons({
  prefix,
  itemId,
  index,
  total,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: RowActionButtonsProps) {
  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        data-testid={`${prefix}-move-up-${itemId}`}
        disabled={index === 0}
        onClick={onMoveUp}
        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[11px] text-slate-300 rounded"
      >
        Up
      </button>
      <button
        type="button"
        data-testid={`${prefix}-move-down-${itemId}`}
        disabled={index === total - 1}
        onClick={onMoveDown}
        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-[11px] text-slate-300 rounded"
      >
        Down
      </button>
      <button
        type="button"
        data-testid={`${prefix}-edit-button-${itemId}`}
        onClick={onEdit}
        className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-[11px] text-indigo-300 rounded"
      >
        Edit
      </button>
      <button
        type="button"
        data-testid={`${prefix}-delete-button-${itemId}`}
        onClick={onDelete}
        className="px-2 py-1 bg-rose-950/80 hover:bg-rose-900 text-[11px] text-rose-300 rounded border border-rose-800/50"
      >
        Delete
      </button>
    </div>
  );
}

interface StringListEditorProps {
  prefix: string;
  items: string[];
  addPlaceholder: string;
  addButtonLabel: string;
  onAdd: (value: string) => Promise<void>;
  onUpdate: (index: number, existing: string, nextValue: string) => Promise<void>;
  onReorder: (fromIndex: number, toIndex: number) => Promise<void>;
  onDelete: (value: string) => Promise<void>;
}

function StringListEditor({
  prefix,
  items,
  addPlaceholder,
  addButtonLabel,
  onAdd,
  onUpdate,
  onReorder,
  onDelete,
}: StringListEditorProps) {
  const [newValue, setNewValue] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const handleAdd = async () => {
    const trimmed = newValue.trim();
    if (!trimmed) return;
    setNewValue("");
    await onAdd(trimmed);
  };

  const handleSave = async (index: number) => {
    const existing = items[index];
    const trimmed = editingValue.trim();
    if (!existing || !trimmed) return;
    setEditingIndex(null);
    setEditingValue("");
    await onUpdate(index, existing, trimmed);
  };

  return (
    <>
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li
            key={`${index}-${item}`}
            data-testid={`${prefix}-item-${index}`}
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg bg-slate-950/70 border border-slate-800"
          >
            {editingIndex === index ? (
              <div className="flex-1 flex items-center gap-2">
                <input
                  type="text"
                  data-testid={`${prefix}-edit-input-${index}`}
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-white"
                />
                <button
                  type="button"
                  data-testid={`${prefix}-save-button-${index}`}
                  onClick={() => void handleSave(index)}
                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-xs text-white rounded"
                >
                  Save
                </button>
                <button
                  type="button"
                  data-testid={`${prefix}-cancel-button-${index}`}
                  onClick={() => {
                    setEditingIndex(null);
                    setEditingValue("");
                  }}
                  className="px-2 py-1 bg-slate-800 text-xs text-slate-300 rounded"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <span className="text-xs text-slate-200 flex-1">{item}</span>
            )}

            <RowActionButtons
              prefix={prefix}
              itemId={index}
              index={index}
              total={items.length}
              onMoveUp={() => void onReorder(index, index - 1)}
              onMoveDown={() => void onReorder(index, index + 1)}
              onEdit={() => {
                setEditingIndex(index);
                setEditingValue(item);
              }}
              onDelete={() => void onDelete(item)}
            />
          </li>
        ))}
      </ul>

      <div className="flex items-center gap-2 pt-1">
        <input
          type="text"
          data-testid={`${prefix}-add-input`}
          placeholder={addPlaceholder}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white"
        />
        <button
          type="button"
          data-testid={`${prefix}-add-button`}
          onClick={() => void handleAdd()}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg"
        >
          {addButtonLabel}
        </button>
      </div>
    </>
  );
}

interface KeyValueEntry {
  key: string;
  value: string;
}

interface KeyValueListEditorProps {
  prefix: string;
  items: KeyValueEntry[];
  keyPlaceholder: string;
  valuePlaceholder: string;
  valueInputTestIdSuffix: string;
  addButtonLabel: string;
  onAdd: (key: string, value: string) => Promise<void>;
  onUpdate: (key: string, nextValue: string) => Promise<void>;
  onReorder: (fromIndex: number, toIndex: number) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
}

function KeyValueListEditor({
  prefix,
  items,
  keyPlaceholder,
  valuePlaceholder,
  valueInputTestIdSuffix,
  addButtonLabel,
  onAdd,
  onUpdate,
  onReorder,
  onDelete,
}: KeyValueListEditorProps) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState("");

  const handleAdd = async () => {
    const k = newKey.trim();
    const v = newValue.trim();
    if (!k || !v) return;
    setNewKey("");
    setNewValue("");
    await onAdd(k, v);
  };

  const handleSave = async (key: string) => {
    const v = editingValue.trim();
    if (!v) return;
    setEditingKey(null);
    setEditingValue("");
    await onUpdate(key, v);
  };

  return (
    <>
      <ul className="space-y-2">
        {items.map((entry, index) => (
          <li
            key={entry.key}
            data-testid={`${prefix}-item-${entry.key}`}
            className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg bg-slate-950/70 border border-slate-800"
          >
            {editingKey === entry.key ? (
              <div className="flex-1 flex items-center gap-2">
                <span className="font-mono text-xs text-indigo-300">
                  {entry.key}
                </span>
                <input
                  type="text"
                  data-testid={`${prefix}-edit-input-${entry.key}`}
                  value={editingValue}
                  onChange={(e) => setEditingValue(e.target.value)}
                  className="flex-1 bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-white"
                />
                <button
                  type="button"
                  data-testid={`${prefix}-save-button-${entry.key}`}
                  onClick={() => void handleSave(entry.key)}
                  className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-xs text-white rounded"
                >
                  Save
                </button>
                <button
                  type="button"
                  data-testid={`${prefix}-cancel-button-${entry.key}`}
                  onClick={() => {
                    setEditingKey(null);
                    setEditingValue("");
                  }}
                  className="px-2 py-1 bg-slate-800 text-xs text-slate-300 rounded"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex-1">
                <span className="font-mono text-xs text-indigo-300 mr-2">
                  {entry.key}
                </span>
                <span className="text-xs text-slate-200">{entry.value}</span>
              </div>
            )}

            <RowActionButtons
              prefix={prefix}
              itemId={entry.key}
              index={index}
              total={items.length}
              onMoveUp={() => void onReorder(index, index - 1)}
              onMoveDown={() => void onReorder(index, index + 1)}
              onEdit={() => {
                setEditingKey(entry.key);
                setEditingValue(entry.value);
              }}
              onDelete={() => void onDelete(entry.key)}
            />
          </li>
        ))}
      </ul>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 pt-1">
        <input
          type="text"
          data-testid={`${prefix}-add-key-input`}
          placeholder={keyPlaceholder}
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
        />
        <input
          type="text"
          data-testid={`${prefix}-add-${valueInputTestIdSuffix}-input`}
          placeholder={valuePlaceholder}
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white"
        />
        <button
          type="button"
          data-testid={`${prefix}-add-button`}
          onClick={() => void handleAdd()}
          className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg"
        >
          {addButtonLabel}
        </button>
      </div>
    </>
  );
}

interface SectionCardProps {
  testId: string;
  title: string;
  description: string;
  countLabel: string;
  children: ReactNode;
}

function SectionCard({
  testId,
  title,
  description,
  countLabel,
  children,
}: SectionCardProps) {
  return (
    <section
      data-testid={testId}
      className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-4"
    >
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-white">{title}</h3>
          <p className="text-xs text-slate-400">{description}</p>
        </div>
        <span className="text-xs font-mono text-slate-400">{countLabel}</span>
      </div>
      {children}
    </section>
  );
}

export interface DosConfigSettingsCanvasProps {
  initialConfig?: DosConfigRecord;
  initialInstructions?: InstructionsGetResult | null;
  initialDomain?: string;
  autoLoad?: boolean;
}

export function DosConfigSettingsCanvas({
  initialConfig = DEFAULT_DOS_CONFIG_RECORD,
  initialInstructions = null,
  initialDomain = "work",
  autoLoad = true,
}: DosConfigSettingsCanvasProps = {}) {
  const [dosConfig, setDosConfig] = useState<DosConfigRecord>(initialConfig);
  const [instructionsInfo, setInstructionsInfo] =
    useState<InstructionsGetResult | null>(initialInstructions);
  const [selectedDomain, setSelectedDomain] = useState<string>(initialDomain);
  const [allowPillarRemoval, setAllowPillarRemoval] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Audience form & inline-edit state
  const [newAudienceKey, setNewAudienceKey] = useState("");
  const [newAudienceRole, setNewAudienceRole] = useState("");
  const [newAudienceDomain, setNewAudienceDomain] = useState("work");
  const [newAudienceRegister, setNewAudienceRegister] = useState("");
  const [newAudienceCadence, setNewAudienceCadence] = useState("");
  const [editingAudienceKey, setEditingAudienceKey] = useState<string | null>(null);
  const [editingAudienceRegister, setEditingAudienceRegister] = useState("");
  const [editingAudienceRole, setEditingAudienceRole] = useState("");

  // Strategic Pillar form & inline-edit state
  const [newPillarKey, setNewPillarKey] = useState("");
  const [newPillarLabel, setNewPillarLabel] = useState("");
  const [newPillarDesc, setNewPillarDesc] = useState("");
  const [newPillarNotionOption, setNewPillarNotionOption] = useState("");
  const [editingPillarKey, setEditingPillarKey] = useState<string | null>(null);
  const [editingPillarLabel, setEditingPillarLabel] = useState("");
  const [editingPillarDesc, setEditingPillarDesc] = useState("");

  const refreshFromServer = async (domainOverride?: string) => {
    setIsLoading(true);
    setErrorBanner(null);
    const targetDomain =
      (domainOverride ?? selectedDomain) === "angus" ? "angus" : "work";
    try {
      const snapshot = await loadDosConfigSettingsSnapshot(targetDomain);
      setDosConfig(snapshot.dosConfig);
      setInstructionsInfo(snapshot.instructions);
      setStatusBanner("Synchronised DOS configuration and system instructions.");
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to load DOS configuration settings.";
      setErrorBanner(message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!autoLoad) {
      return;
    }
    void refreshFromServer(selectedDomain);
  }, [autoLoad]);

  const applyUpdate = async (
    patch: ConfigPreferencesUpdateInput,
    optimisticNext: DosConfigRecord,
    summaryMessage: string,
  ) => {
    const previousConfig = dosConfig;
    await applyDosConfigOptimisticUpdate({
      previousConfig,
      optimisticNext,
      patch,
      summaryMessage,
      setDosConfig,
      setStatusBanner,
      setErrorBanner,
      setIsSaving,
    });
  };

  const handleDomainSelect = async (domainKey: string) => {
    setSelectedDomain(domainKey);
    if (domainKey === "work" || domainKey === "angus") {
      try {
        const slice = await executeActionClient(dosConfigGetActionClient, {
          domain: domainKey,
        });
        const parsed =
          parseJsonTextFromMcpContent<DosConfigGetResult>(slice) ?? slice;
        if (parsed?.config && !Array.isArray(parsed.config)) {
          setDosConfig((prev) => ({
            ...prev,
            by_domain: {
              ...(prev.by_domain ?? {}),
              [domainKey]: {
                ...(prev.by_domain?.[domainKey] ?? {}),
                ...(parsed.config as DosDomainConfig),
              },
            },
          }));
        }
      } catch (err) {
        const message =
          err instanceof Error
            ? err.message
            : `Failed to fetch domain slice for ${domainKey}.`;
        setErrorBanner(message);
      }
    }
  };

  const handleSyncPastedInstructions = async () => {
    setIsSaving(true);
    setErrorBanner(null);
    try {
      await syncCanonicalPastedInstructions({
        currentConfig: dosConfig,
        fallbackInstructions: instructionsInfo,
        setInstructionsInfo,
        applyUpdate,
      });
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : "Failed to synchronise canonical system instructions.";
      setErrorBanner(message);
    } finally {
      setIsSaving(false);
    }
  };

  const toneList = dosConfig.tone ?? [];
  const principlesList = (dosConfig.operating_principles ?? []).map((item, idx) =>
    normalizeOperatingPrinciple(item, idx),
  );
  const handshakeList = normalizeHandshakeInstructions(
    dosConfig.handshake_instructions,
  );
  const typesList = dosConfig.types ?? [];
  const audiencesList = dosConfig.audiences ?? [];

  const configuredDomains = Array.from(
    new Set([
      "work",
      "angus",
      ...Object.keys(dosConfig.by_domain ?? {}),
    ]),
  );
  const activeDomainConfig: DosDomainConfig =
    dosConfig.by_domain?.[selectedDomain] ?? {};
  const domainTopics = activeDomainConfig.topics ?? [];
  const domainPillars = activeDomainConfig.pillars ?? [];
  const domainRegisters = activeDomainConfig.artefact_registers ?? [];

  const freshness = evaluatePastedInstructionsFreshness(
    dosConfig.pasted_instructions,
    instructionsInfo,
  );

  const updateDomainState = (patch: Partial<DosDomainConfig>): DosConfigRecord => ({
    ...dosConfig,
    by_domain: {
      ...(dosConfig.by_domain ?? {}),
      [selectedDomain]: {
        ...activeDomainConfig,
        ...patch,
      },
    },
  });

  // Audiences handlers
  const handleAddAudience = async () => {
    const key = newAudienceKey.trim();
    const register = newAudienceRegister.trim();
    if (!key || !register) return;
    const newEntry: DosAudienceSpec = {
      key,
      register,
      ...(newAudienceRole.trim() ? { role: newAudienceRole.trim() } : {}),
      ...(newAudienceDomain.trim() ? { domain: newAudienceDomain.trim() } : {}),
      ...(newAudienceCadence.trim() ? { cadence: newAudienceCadence.trim() } : {}),
    };
    setNewAudienceKey("");
    setNewAudienceRole("");
    setNewAudienceRegister("");
    setNewAudienceCadence("");
    const nextAudiences = [...audiencesList, newEntry];
    await applyUpdate(
      { dos_config: { audiences: { add: newEntry } } },
      { ...dosConfig, audiences: nextAudiences },
      `Added audience "${key}".`,
    );
  };

  const handleSaveAudienceEdit = async (key: string) => {
    const register = editingAudienceRegister.trim();
    if (!register) return;
    const role = editingAudienceRole.trim();
    const nextAudiences = audiencesList.map((item) =>
      item.key === key ? { ...item, register, ...(role ? { role } : {}) } : item,
    );
    setEditingAudienceKey(null);
    setEditingAudienceRegister("");
    setEditingAudienceRole("");
    await applyUpdate(
      {
        dos_config: {
          audiences: {
            update: { match: key, key, register, ...(role ? { role } : {}) },
          },
        },
      },
      { ...dosConfig, audiences: nextAudiences },
      `Updated audience "${key}".`,
    );
  };

  // Pillars handlers
  const handleAddPillar = async () => {
    const key = newPillarKey.trim();
    const label = newPillarLabel.trim();
    const description = newPillarDesc.trim();
    if (!key || !label || !description) return;
    const newPillar: DosPillarSpec = {
      key,
      label,
      description,
      notion_option: newPillarNotionOption.trim() || label,
      notion_property: "Pillar",
    };
    setNewPillarKey("");
    setNewPillarLabel("");
    setNewPillarDesc("");
    setNewPillarNotionOption("");
    const nextPillars = [...domainPillars, newPillar];
    await applyUpdate(
      {
        dos_config: {
          by_domain: { [selectedDomain]: { pillars: { add: newPillar } } },
        },
      },
      updateDomainState({ pillars: nextPillars }),
      `Added pillar "${label}" to ${selectedDomain}.`,
    );
  };

  const handleSavePillarEdit = async (key: string) => {
    const label = editingPillarLabel.trim();
    const description = editingPillarDesc.trim();
    if (!label || !description) return;
    const nextPillars = domainPillars.map((item) =>
      item.key === key ? { ...item, label, description } : item,
    );
    setEditingPillarKey(null);
    setEditingPillarLabel("");
    setEditingPillarDesc("");
    await applyUpdate(
      {
        dos_config: {
          by_domain: {
            [selectedDomain]: {
              pillars: { update: { match: key, key, label, description } },
            },
          },
        },
      },
      updateDomainState({ pillars: nextPillars }),
      `Updated pillar "${key}" in ${selectedDomain}.`,
    );
  };

  return (
    <div
      data-testid="dos-config-settings-canvas"
      className="space-y-6 text-slate-100 pb-12"
    >
      {/* Header Banner */}
      <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider bg-indigo-500/20 text-indigo-300 rounded border border-indigo-500/30">
              user_preferences.dos_config
            </span>
            <span className="text-xs font-mono text-slate-400">
              ADR-030 / ADR-094
            </span>
          </div>
          <h2 className="text-lg font-bold text-white mt-1">
            DOS Configuration &amp; System Instructions Settings
          </h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Interactive editor for standing tone rules, operating principles, session handshakes, atom types, audiences, domain taxonomies, and canonical instruction paste freshness.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <button
            type="button"
            data-testid="dos-config-refresh-button"
            disabled={isLoading || isSaving}
            onClick={() => void refreshFromServer(selectedDomain)}
            className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-medium text-slate-200 rounded-lg border border-slate-700 transition-colors"
          >
            {isLoading ? "Refreshing..." : "Reload Settings"}
          </button>
        </div>
      </div>

      {statusBanner && (
        <div
          data-testid="dos-config-status-banner"
          className="px-4 py-2.5 rounded-lg bg-emerald-950/60 border border-emerald-500/40 text-xs text-emerald-300 flex items-center justify-between"
        >
          <span>{statusBanner}</span>
          <button
            type="button"
            onClick={() => setStatusBanner(null)}
            className="text-emerald-400 hover:text-emerald-200 font-mono text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {errorBanner && (
        <div
          data-testid="dos-config-error-banner"
          className="px-4 py-2.5 rounded-lg bg-rose-950/60 border border-rose-500/40 text-xs text-rose-300 flex items-center justify-between"
        >
          <span>{errorBanner}</span>
          <button
            type="button"
            onClick={() => setErrorBanner(null)}
            className="text-rose-400 hover:text-rose-200 font-mono text-[11px]"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* 1. Canonical System Instructions & Paste Freshness */}
      <section
        data-testid="dos-section-pasted-instructions"
        className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Canonical System Instructions &amp; Paste Freshness (`pasted_instructions`)
            </h3>
            <p className="text-xs text-slate-400">
              Compares `user_preferences.dos_config.pasted_instructions` against the live SHA-256 from `instructions_get`.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span
              data-testid="pasted-instructions-status-badge"
              className={`px-2.5 py-1 rounded-full text-xs font-mono font-semibold border ${
                freshness.status === "fresh"
                  ? "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
                  : freshness.status === "stale"
                    ? "bg-amber-500/15 text-amber-300 border-amber-500/30"
                    : "bg-rose-500/15 text-rose-300 border-rose-500/30"
              }`}
            >
              {`${freshness.status.toUpperCase()}: ${freshness.label}`}
            </span>
            <button
              type="button"
              data-testid="stamp-canonical-paste-button"
              disabled={isSaving}
              onClick={() => void handleSyncPastedInstructions()}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white rounded-lg transition-colors"
            >
              Record Canonical Paste
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs font-mono">
          <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">
              Pasted SHA-256
            </span>
            <span
              data-testid="pasted-instructions-sha256"
              className="text-slate-200 break-all"
            >
              {freshness.pastedSha256 ?? "unrecorded"}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">
              Canonical SHA-256 (`instructions_get`)
            </span>
            <span
              data-testid="canonical-instructions-sha256"
              className="text-slate-200 break-all"
            >
              {freshness.canonicalSha256 ?? "pending"}
            </span>
          </div>
          <div className="p-3 rounded-lg bg-slate-950/70 border border-slate-800">
            <span className="text-slate-400 block text-[10px] uppercase">
              Last Pasted Timestamp (`pasted_at`)
            </span>
            <span
              data-testid="pasted-instructions-timestamp"
              className="text-slate-200"
            >
              {freshness.pastedAt ?? "never"}
            </span>
          </div>
        </div>

        <p className="text-xs text-slate-300 font-mono bg-slate-950/50 border border-slate-800/80 rounded-lg px-3 py-2">
          {freshness.detail}
        </p>
      </section>

      {/* 2. Global Tone Rules */}
      <SectionCard
        testId="dos-section-tone"
        title="Standing Tone Rules (`dos_config.tone`)"
        description="Voice, style, and formatting rules applied across all drafted artefacts."
        countLabel={`${toneList.length} rules`}
      >
        <StringListEditor
          prefix="tone"
          items={toneList}
          addPlaceholder="Add a new standing tone rule..."
          addButtonLabel="Add Tone Rule"
          onAdd={async (trimmed) => {
            const nextTone = [...toneList, trimmed];
            await applyUpdate(
              { dos_config: { tone: { add: trimmed } } },
              { ...dosConfig, tone: nextTone },
              "Added tone rule.",
            );
          }}
          onUpdate={async (index, existing, trimmed) => {
            const nextTone = toneList.map((item, idx) =>
              idx === index ? trimmed : item,
            );
            await applyUpdate(
              {
                dos_config: {
                  tone: { update: { match: existing, value: trimmed } },
                },
              },
              { ...dosConfig, tone: nextTone },
              "Updated tone rule.",
            );
          }}
          onReorder={async (fromIndex, toIndex) => {
            const nextTone = reorderList(toneList, fromIndex, toIndex);
            await applyUpdate(
              { dos_config: { tone: { replace: nextTone } } },
              { ...dosConfig, tone: nextTone },
              "Reordered tone rules.",
            );
          }}
          onDelete={async (rule) => {
            const nextTone = toneList.filter((item) => item !== rule);
            await applyUpdate(
              { dos_config: { tone: { remove: rule } } },
              { ...dosConfig, tone: nextTone },
              "Removed tone rule.",
            );
          }}
        />
      </SectionCard>

      {/* 3. Operating Principles */}
      <SectionCard
        testId="dos-section-operating-principles"
        title="Operating Principles (`dos_config.operating_principles`)"
        description="Standing decision and execution invariants enforced across agent workflows."
        countLabel={`${principlesList.length} principles`}
      >
        <KeyValueListEditor
          prefix="principle"
          items={principlesList.map((p) => ({
            key: p.key,
            value: p.description,
          }))}
          keyPlaceholder="Principle key (e.g. zero_drift)"
          valuePlaceholder="Principle description..."
          valueInputTestIdSuffix="desc"
          addButtonLabel="Add Principle"
          onAdd={async (key, description) => {
            const nextPrinciples = [...principlesList, { key, description }];
            await applyUpdate(
              {
                dos_config: {
                  operating_principles: { add: { key, description } },
                },
              },
              { ...dosConfig, operating_principles: nextPrinciples },
              `Added operating principle "${key}".`,
            );
          }}
          onUpdate={async (key, description) => {
            const nextPrinciples = principlesList.map((item) =>
              item.key === key ? { ...item, description } : item,
            );
            await applyUpdate(
              {
                dos_config: {
                  operating_principles: {
                    update: { match: key, key, description },
                  },
                },
              },
              { ...dosConfig, operating_principles: nextPrinciples },
              `Updated operating principle "${key}".`,
            );
          }}
          onReorder={async (fromIndex, toIndex) => {
            const nextPrinciples = reorderList(
              principlesList,
              fromIndex,
              toIndex,
            );
            await applyUpdate(
              {
                dos_config: {
                  operating_principles: { replace: nextPrinciples },
                },
              },
              { ...dosConfig, operating_principles: nextPrinciples },
              "Reordered operating principles.",
            );
          }}
          onDelete={async (key) => {
            const nextPrinciples = principlesList.filter(
              (item) => item.key !== key,
            );
            await applyUpdate(
              {
                dos_config: { operating_principles: { remove: key } },
              },
              { ...dosConfig, operating_principles: nextPrinciples },
              `Removed operating principle "${key}".`,
            );
          }}
        />
      </SectionCard>

      {/* 4. Session Handshake Instructions */}
      <SectionCard
        testId="dos-section-handshake-instructions"
        title="Session Handshake Instructions (`dos_config.handshake_instructions`)"
        description="Startup checks and context-loading steps executed at session initialisation."
        countLabel={`${handshakeList.length} instructions`}
      >
        <StringListEditor
          prefix="handshake"
          items={handshakeList}
          addPlaceholder="Add a session handshake instruction..."
          addButtonLabel="Add Handshake Step"
          onAdd={async (trimmed) => {
            const nextHandshake = [...handshakeList, trimmed];
            await applyUpdate(
              { dos_config: { handshake_instructions: { add: trimmed } } },
              { ...dosConfig, handshake_instructions: nextHandshake },
              "Added session handshake instruction.",
            );
          }}
          onUpdate={async (index, existing, trimmed) => {
            const nextHandshake = handshakeList.map((item, idx) =>
              idx === index ? trimmed : item,
            );
            await applyUpdate(
              {
                dos_config: {
                  handshake_instructions: {
                    update: { match: existing, value: trimmed },
                  },
                },
              },
              { ...dosConfig, handshake_instructions: nextHandshake },
              "Updated session handshake instruction.",
            );
          }}
          onReorder={async (fromIndex, toIndex) => {
            const nextHandshake = reorderList(
              handshakeList,
              fromIndex,
              toIndex,
            );
            await applyUpdate(
              {
                dos_config: {
                  handshake_instructions: { replace: nextHandshake },
                },
              },
              { ...dosConfig, handshake_instructions: nextHandshake },
              "Reordered session handshake instructions.",
            );
          }}
          onDelete={async (instruction) => {
            const nextHandshake = handshakeList.filter(
              (item) => item !== instruction,
            );
            await applyUpdate(
              {
                dos_config: {
                  handshake_instructions: { remove: instruction },
                },
              },
              { ...dosConfig, handshake_instructions: nextHandshake },
              "Removed session handshake instruction.",
            );
          }}
        />
      </SectionCard>

      {/* 5. Knowledge Atom Types */}
      <SectionCard
        testId="dos-section-types"
        title="Knowledge Atom Types (`dos_config.types`)"
        description="Canonical classification types used during capture and entity extraction."
        countLabel={`${typesList.length} types`}
      >
        <KeyValueListEditor
          prefix="type"
          items={typesList.map((t) => ({ key: t.key, value: t.description }))}
          keyPlaceholder="Atom type key (e.g. insight)"
          valuePlaceholder="Atom type description..."
          valueInputTestIdSuffix="desc"
          addButtonLabel="Add Atom Type"
          onAdd={async (key, description) => {
            const nextTypes: DosAtomType[] = [
              ...typesList,
              { key, description },
            ];
            await applyUpdate(
              { dos_config: { types: { add: { key, description } } } },
              { ...dosConfig, types: nextTypes },
              `Added atom type "${key}".`,
            );
          }}
          onUpdate={async (key, description) => {
            const nextTypes = typesList.map((item) =>
              item.key === key ? { ...item, description } : item,
            );
            await applyUpdate(
              {
                dos_config: {
                  types: { update: { match: key, key, description } },
                },
              },
              { ...dosConfig, types: nextTypes },
              `Updated atom type "${key}".`,
            );
          }}
          onReorder={async (fromIndex, toIndex) => {
            const nextTypes = reorderList(typesList, fromIndex, toIndex);
            await applyUpdate(
              { dos_config: { types: { replace: nextTypes } } },
              { ...dosConfig, types: nextTypes },
              "Reordered atom types.",
            );
          }}
          onDelete={async (key) => {
            const nextTypes = typesList.filter((item) => item.key !== key);
            await applyUpdate(
              { dos_config: { types: { remove: key } } },
              { ...dosConfig, types: nextTypes },
              `Removed atom type "${key}".`,
            );
          }}
        />
      </SectionCard>

      {/* 6. Audiences */}
      <SectionCard
        testId="dos-section-audiences"
        title="Audiences (`dos_config.audiences`)"
        description="Target communication audiences, registers, and cadence profiles."
        countLabel={`${audiencesList.length} audiences`}
      >
        <ul className="space-y-2">
          {audiencesList.map((audience, index) => (
            <li
              key={audience.key}
              data-testid={`audience-item-${audience.key}`}
              className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg bg-slate-950/70 border border-slate-800"
            >
              {editingAudienceKey === audience.key ? (
                <div className="flex-1 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-indigo-300">
                    {audience.key}
                  </span>
                  <input
                    type="text"
                    data-testid={`audience-edit-role-input-${audience.key}`}
                    placeholder="Role"
                    value={editingAudienceRole}
                    onChange={(e) => setEditingAudienceRole(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-white"
                  />
                  <input
                    type="text"
                    data-testid={`audience-edit-register-input-${audience.key}`}
                    placeholder="Register"
                    value={editingAudienceRegister}
                    onChange={(e) => setEditingAudienceRegister(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-white font-mono"
                  />
                  <button
                    type="button"
                    data-testid={`audience-save-button-${audience.key}`}
                    onClick={() => void handleSaveAudienceEdit(audience.key)}
                    className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-xs text-white rounded"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    data-testid={`audience-cancel-button-${audience.key}`}
                    onClick={() => setEditingAudienceKey(null)}
                    className="px-2 py-1 bg-slate-800 text-xs text-slate-300 rounded"
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="flex-1 flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-indigo-300">
                    {audience.key}
                  </span>
                  {audience.role && (
                    <span className="text-xs text-slate-200">
                      ({audience.role})
                    </span>
                  )}
                  <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-700 text-[11px] font-mono text-emerald-300">
                    {`register: ${audience.register}`}
                  </span>
                  {audience.domain && (
                    <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-400">
                      {`domain: ${audience.domain}`}
                    </span>
                  )}
                  {audience.cadence && (
                    <span className="px-2 py-0.5 rounded bg-slate-900 border border-slate-800 text-[11px] font-mono text-slate-400">
                      {`cadence: ${audience.cadence}`}
                    </span>
                  )}
                </div>
              )}

              <RowActionButtons
                prefix="audience"
                itemId={audience.key}
                index={index}
                total={audiencesList.length}
                onMoveUp={() => {
                  const nextAudiences = reorderList(
                    audiencesList,
                    index,
                    index - 1,
                  );
                  void applyUpdate(
                    { dos_config: { audiences: { replace: nextAudiences } } },
                    { ...dosConfig, audiences: nextAudiences },
                    "Reordered audiences.",
                  );
                }}
                onMoveDown={() => {
                  const nextAudiences = reorderList(
                    audiencesList,
                    index,
                    index + 1,
                  );
                  void applyUpdate(
                    { dos_config: { audiences: { replace: nextAudiences } } },
                    { ...dosConfig, audiences: nextAudiences },
                    "Reordered audiences.",
                  );
                }}
                onEdit={() => {
                  setEditingAudienceKey(audience.key);
                  setEditingAudienceRegister(audience.register);
                  setEditingAudienceRole(audience.role ?? "");
                }}
                onDelete={() => {
                  const nextAudiences = audiencesList.filter(
                    (item) => item.key !== audience.key,
                  );
                  void applyUpdate(
                    { dos_config: { audiences: { remove: audience.key } } },
                    { ...dosConfig, audiences: nextAudiences },
                    `Removed audience "${audience.key}".`,
                  );
                }}
              />
            </li>
          ))}
        </ul>

        <div className="grid grid-cols-1 sm:grid-cols-6 gap-2 pt-1">
          <input
            type="text"
            data-testid="audience-add-key-input"
            placeholder="Key (e.g. clinicians)"
            value={newAudienceKey}
            onChange={(e) => setNewAudienceKey(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
          />
          <input
            type="text"
            data-testid="audience-add-role-input"
            placeholder="Role description"
            value={newAudienceRole}
            onChange={(e) => setNewAudienceRole(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white"
          />
          <input
            type="text"
            data-testid="audience-add-domain-input"
            placeholder="Domain (work)"
            value={newAudienceDomain}
            onChange={(e) => setNewAudienceDomain(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
          />
          <input
            type="text"
            data-testid="audience-add-register-input"
            placeholder="Register (clinical_memo)"
            value={newAudienceRegister}
            onChange={(e) => setNewAudienceRegister(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
          />
          <input
            type="text"
            data-testid="audience-add-cadence-input"
            placeholder="Cadence (weekly)"
            value={newAudienceCadence}
            onChange={(e) => setNewAudienceCadence(e.target.value)}
            className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white"
          />
          <button
            type="button"
            data-testid="audience-add-button"
            onClick={() => void handleAddAudience()}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg"
          >
            Add Audience
          </button>
        </div>
      </SectionCard>

      {/* 7. Per-Domain Configuration (`by_domain`) */}
      <section
        data-testid="dos-section-by-domain"
        className="bg-slate-900/60 border border-slate-800 rounded-xl p-5 space-y-6"
      >
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <h3 className="text-sm font-semibold text-white">
              Per-Domain Taxonomy (`dos_config.by_domain.{selectedDomain}`)
            </h3>
            <p className="text-xs text-slate-400">
              Domain-scoped topics, strategic pillars, and artefact registers queried via `dos_config_get`.
            </p>
          </div>

          <div className="flex items-center gap-2">
            {configuredDomains.map((domainKey) => (
              <button
                key={domainKey}
                type="button"
                data-testid={`domain-tab-${domainKey}`}
                onClick={() => void handleDomainSelect(domainKey)}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono uppercase tracking-wider border transition-colors ${
                  selectedDomain === domainKey
                    ? "bg-indigo-600/20 text-indigo-300 border-indigo-500/40"
                    : "bg-slate-950 text-slate-400 border-slate-800 hover:text-slate-200"
                }`}
              >
                {domainKey}
              </button>
            ))}
          </div>
        </div>

        {/* 7a. Domain Topics */}
        <div data-testid="domain-subsection-topics" className="space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Domain Topics (`by_domain.{selectedDomain}.topics`)
            </h4>
            <span className="text-xs font-mono text-slate-400">
              {domainTopics.length} topics
            </span>
          </div>

          <StringListEditor
            prefix="domain-topic"
            items={domainTopics}
            addPlaceholder={`Add topic to ${selectedDomain}...`}
            addButtonLabel="Add Topic"
            onAdd={async (trimmed) => {
              const nextTopics = [...domainTopics, trimmed];
              await applyUpdate(
                {
                  dos_config: {
                    by_domain: {
                      [selectedDomain]: { topics: { add: trimmed } },
                    },
                  },
                },
                updateDomainState({ topics: nextTopics }),
                `Added topic "${trimmed}" to ${selectedDomain}.`,
              );
            }}
            onUpdate={async (index, existing, trimmed) => {
              const nextTopics = domainTopics.map((item, idx) =>
                idx === index ? trimmed : item,
              );
              await applyUpdate(
                {
                  dos_config: {
                    by_domain: {
                      [selectedDomain]: {
                        topics: { update: { match: existing, value: trimmed } },
                      },
                    },
                  },
                },
                updateDomainState({ topics: nextTopics }),
                `Updated topic in ${selectedDomain}.`,
              );
            }}
            onReorder={async (fromIndex, toIndex) => {
              const nextTopics = reorderList(domainTopics, fromIndex, toIndex);
              await applyUpdate(
                {
                  dos_config: {
                    by_domain: {
                      [selectedDomain]: { topics: { replace: nextTopics } },
                    },
                  },
                },
                updateDomainState({ topics: nextTopics }),
                `Reordered topics in ${selectedDomain}.`,
              );
            }}
            onDelete={async (topic) => {
              const nextTopics = domainTopics.filter((item) => item !== topic);
              await applyUpdate(
                {
                  dos_config: {
                    by_domain: {
                      [selectedDomain]: { topics: { remove: topic } },
                    },
                  },
                },
                updateDomainState({ topics: nextTopics }),
                `Removed topic "${topic}" from ${selectedDomain}.`,
              );
            }}
          />
        </div>

        {/* 7b. Domain Pillars */}
        <div
          data-testid="domain-subsection-pillars"
          className="space-y-3 border-t border-slate-800 pt-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Strategic Pillars (`by_domain.{selectedDomain}.pillars`)
              </h4>
              <p className="text-[11px] text-slate-400">
                Pillars are append-only by default (#692). Enable pillar removal below when retiring a pillar.
              </p>
            </div>
            <label className="flex items-center gap-2 text-xs text-amber-300 font-mono cursor-pointer">
              <input
                type="checkbox"
                data-testid="allow-pillar-removal-checkbox"
                checked={allowPillarRemoval}
                onChange={(e) => setAllowPillarRemoval(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900"
              />
              <span>allow_pillar_removal</span>
            </label>
          </div>

          <ul className="space-y-2">
            {domainPillars.map((pillar, index) => (
              <li
                key={pillar.key}
                data-testid={`domain-pillar-item-${pillar.key}`}
                className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 p-3 rounded-lg bg-slate-950/70 border border-slate-800"
              >
                {editingPillarKey === pillar.key ? (
                  <div className="flex-1 flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-indigo-300">
                      {pillar.key}
                    </span>
                    <input
                      type="text"
                      data-testid={`domain-pillar-edit-label-${pillar.key}`}
                      value={editingPillarLabel}
                      onChange={(e) => setEditingPillarLabel(e.target.value)}
                      className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-white"
                    />
                    <input
                      type="text"
                      data-testid={`domain-pillar-edit-desc-${pillar.key}`}
                      value={editingPillarDesc}
                      onChange={(e) => setEditingPillarDesc(e.target.value)}
                      className="flex-1 bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-white"
                    />
                    <button
                      type="button"
                      data-testid={`domain-pillar-save-button-${pillar.key}`}
                      onClick={() => void handleSavePillarEdit(pillar.key)}
                      className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-500 text-xs text-white rounded"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      data-testid={`domain-pillar-cancel-button-${pillar.key}`}
                      onClick={() => {
                        setEditingPillarKey(null);
                        setEditingPillarLabel("");
                        setEditingPillarDesc("");
                      }}
                      className="px-2 py-1 bg-slate-800 text-xs text-slate-300 rounded"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-indigo-300">
                        {pillar.key}
                      </span>
                      <span className="text-xs font-semibold text-white">
                        {pillar.label}
                      </span>
                      {pillar.notion_option && (
                        <span className="px-1.5 py-0.5 bg-slate-900 border border-slate-800 rounded text-[10px] font-mono text-slate-400">
                          Notion: {pillar.notion_option}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-slate-300 mt-0.5">
                      {pillar.description}
                    </p>
                  </div>
                )}

                <RowActionButtons
                  prefix="domain-pillar"
                  itemId={pillar.key}
                  index={index}
                  total={domainPillars.length}
                  onMoveUp={() => {
                    const nextPillars = reorderList(
                      domainPillars,
                      index,
                      index - 1,
                    );
                    void applyUpdate(
                      {
                        dos_config: {
                          by_domain: {
                            [selectedDomain]: {
                              pillars: { replace: nextPillars },
                            },
                          },
                        },
                      },
                      updateDomainState({ pillars: nextPillars }),
                      `Reordered pillars in ${selectedDomain}.`,
                    );
                  }}
                  onMoveDown={() => {
                    const nextPillars = reorderList(
                      domainPillars,
                      index,
                      index + 1,
                    );
                    void applyUpdate(
                      {
                        dos_config: {
                          by_domain: {
                            [selectedDomain]: {
                              pillars: { replace: nextPillars },
                            },
                          },
                        },
                      },
                      updateDomainState({ pillars: nextPillars }),
                      `Reordered pillars in ${selectedDomain}.`,
                    );
                  }}
                  onEdit={() => {
                    setEditingPillarKey(pillar.key);
                    setEditingPillarLabel(pillar.label);
                    setEditingPillarDesc(pillar.description);
                  }}
                  onDelete={() => {
                    const nextPillars = domainPillars.filter(
                      (item) => item.key !== pillar.key,
                    );
                    void applyUpdate(
                      {
                        dos_config: {
                          by_domain: {
                            [selectedDomain]: {
                              pillars: { remove: pillar.key },
                            },
                          },
                        },
                        ...(allowPillarRemoval
                          ? { allow_pillar_removal: true }
                          : {}),
                      },
                      updateDomainState({ pillars: nextPillars }),
                      `Removed pillar "${pillar.key}" from ${selectedDomain}.`,
                    );
                  }}
                />
              </li>
            ))}
          </ul>

          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
            <input
              type="text"
              data-testid="domain-pillar-add-key-input"
              placeholder="Key (e.g. klin_safety)"
              value={newPillarKey}
              onChange={(e) => setNewPillarKey(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white font-mono"
            />
            <input
              type="text"
              data-testid="domain-pillar-add-label-input"
              placeholder="Label"
              value={newPillarLabel}
              onChange={(e) => setNewPillarLabel(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white"
            />
            <input
              type="text"
              data-testid="domain-pillar-add-desc-input"
              placeholder="Description"
              value={newPillarDesc}
              onChange={(e) => setNewPillarDesc(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white"
            />
            <input
              type="text"
              data-testid="domain-pillar-add-notion-input"
              placeholder="Notion option (optional)"
              value={newPillarNotionOption}
              onChange={(e) => setNewPillarNotionOption(e.target.value)}
              className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-white"
            />
            <button
              type="button"
              data-testid="domain-pillar-add-button"
              onClick={() => void handleAddPillar()}
              className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white rounded-lg"
            >
              Add Pillar
            </button>
          </div>
        </div>

        {/* 7c. Domain Artefact Registers */}
        <div
          data-testid="domain-subsection-registers"
          className="space-y-3 border-t border-slate-800 pt-4"
        >
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Artefact Registers (`by_domain.{selectedDomain}.artefact_registers`)
            </h4>
            <span className="text-xs font-mono text-slate-400">
              {domainRegisters.length} registers
            </span>
          </div>

          <KeyValueListEditor
            prefix="domain-register"
            items={domainRegisters.map((r) => ({ key: r.key, value: r.tone }))}
            keyPlaceholder="Register key (e.g. investor_update)"
            valuePlaceholder="Register tone description..."
            valueInputTestIdSuffix="tone"
            addButtonLabel="Add Register"
            onAdd={async (key, tone) => {
              const newReg: DosArtefactRegisterSpec = { key, tone };
              const nextRegisters = [...domainRegisters, newReg];
              await applyUpdate(
                {
                  dos_config: {
                    by_domain: {
                      [selectedDomain]: {
                        artefact_registers: { add: newReg },
                      },
                    },
                  },
                },
                updateDomainState({ artefact_registers: nextRegisters }),
                `Added artefact register "${key}" to ${selectedDomain}.`,
              );
            }}
            onUpdate={async (key, tone) => {
              const nextRegisters = domainRegisters.map((item) =>
                item.key === key ? { ...item, tone } : item,
              );
              await applyUpdate(
                {
                  dos_config: {
                    by_domain: {
                      [selectedDomain]: {
                        artefact_registers: {
                          update: { match: key, key, tone },
                        },
                      },
                    },
                  },
                },
                updateDomainState({ artefact_registers: nextRegisters }),
                `Updated artefact register "${key}" in ${selectedDomain}.`,
              );
            }}
            onReorder={async (fromIndex, toIndex) => {
              const nextRegisters = reorderList(
                domainRegisters,
                fromIndex,
                toIndex,
              );
              await applyUpdate(
                {
                  dos_config: {
                    by_domain: {
                      [selectedDomain]: {
                        artefact_registers: { replace: nextRegisters },
                      },
                    },
                  },
                },
                updateDomainState({ artefact_registers: nextRegisters }),
                `Reordered artefact registers in ${selectedDomain}.`,
              );
            }}
            onDelete={async (key) => {
              const nextRegisters = domainRegisters.filter(
                (item) => item.key !== key,
              );
              await applyUpdate(
                {
                  dos_config: {
                    by_domain: {
                      [selectedDomain]: {
                        artefact_registers: { remove: key },
                      },
                    },
                  },
                },
                updateDomainState({ artefact_registers: nextRegisters }),
                `Removed artefact register "${key}" from ${selectedDomain}.`,
              );
            }}
          />
        </div>
      </section>
    </div>
  );
}

export default DosConfigSettingsCanvas;
