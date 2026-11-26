/**
 * Canonical System Instructions (`system-instructions`, #1025 / #1601).
 *
 * Pure builder and freshness checker for the canonical "Instructions for <model>"
 * block pasted into non-MCP client surfaces (chat, Cowork, mobile), plus the
 * port interface consumed by `instructions_get` and `instructions_mark_pasted`.
 *
 * Lives in `@ahkms/core` (#1601) with zero Node-only or `@ahkms/mcp-server`
 * imports so `check-core-isomorphic.js` passes.
 */

import {
	DEFAULT_DOS_CONFIG,
	type DosConfig,
	loadDosConfig as loadDosConfigFromReader,
	renderDosConfigSections,
} from "../../domain/dosConfig.js";
import type { ConfigRepository, PastedInstructionsRecord } from "../../ports/config.js";

export type { PastedInstructionsRecord };

export const SYSTEM_INSTRUCTIONS_CAPABILITY_NAME = "system-instructions";
export const LEGACY_CLAUDE_INSTRUCTIONS_CAPABILITY_NAME = "claude-instructions";
export const SYSTEM_INSTRUCTIONS_SYNC_KEY = "system_instructions_sync";
export const LEGACY_CLAUDE_INSTRUCTIONS_SYNC_KEY = "claude_instructions_sync";
export const LEGACY_PASTED_INSTRUCTIONS_KEY = "pasted_instructions";

/** Hard cap on the rendered hot tier section, header lines included (ADR-092). */
export const HOT_TIER_MAX_LINES = 100;
const GLOSS_MAX_CHARS = 120;

export type HotTierRow = {
	id: string;
	entity_type: string;
	title: string | null;
	description: string | null;
	properties: Record<string, unknown> | null;
	aliases?: string[] | null;
};

export type RenderedHotTier = {
	text: string;
	lines: number;
	omitted: number;
};

function normalizeAliases(values: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		if (typeof value !== "string") continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	return out;
}

function collectAliases(row: {
	aliases?: readonly string[] | null;
	properties?: Record<string, unknown> | null;
}): string[] {
	const legacy = row.properties?.aliases;
	return normalizeAliases([...(row.aliases ?? []), ...(Array.isArray(legacy) ? legacy : [])]);
}

function cell(value: string): string {
	return value.replace(/\s*\n[\s\S]*$/, "").replace(/\|/g, "\\|").trim();
}

function firstLine(value: string | null | undefined): string {
	return (value ?? "").split("\n")[0]!.trim();
}

function clip(value: string): string {
	return value.length > GLOSS_MAX_CHARS ? `${value.slice(0, GLOSS_MAX_CHARS - 1)}…` : value;
}

function str(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function gloss(row: HotTierRow): string {
	const props = row.properties ?? {};
	const description = firstLine(row.description);
	if (row.entity_type === "people") {
		const roleOrg = [str(props.role), str(props.organization)].filter(Boolean).join(", ");
		return roleOrg || description;
	}
	if (row.entity_type === "term") {
		const expansion = str(props.expansion);
		const context = str(props.context);
		if (expansion) return context ? `${expansion} (${context})` : expansion;
		return description || "term";
	}
	return description ? `${row.entity_type}: ${description}` : row.entity_type;
}

function renderHotTierRow(row: HotTierRow): string {
	const aliases = collectAliases(row);
	return `| ${cell(row.title ?? "(untitled)")} | ${aliases.length ? cell(aliases.join(", ")) : "—"} | ${cell(clip(gloss(row))) || "—"} |`;
}

const HOT_TIER_PREAMBLE = [
	"Hot tier (source of truth: entities.hot — hand-curated, ADR-092). Decode shorthand in the user's requests with these tables BEFORE asking or searching: a nickname, acronym or codename in a request means the Name on its row.",
	'For more than the gloss, one call goes a hop deeper: entity_neighbourhood({ title_contains: "<Name>" }).',
];
const HOT_TIER_TABLE_HEAD = ["| Name | Aliases | Gloss |", "| --- | --- | --- |"];

/**
 * Pure renderer for the Hot Tier section, never exceeding `maxLines`.
 */
export function renderHotTier(
	rows: HotTierRow[],
	maxLines: number = HOT_TIER_MAX_LINES,
): RenderedHotTier {
	if (rows.length === 0) return { text: "", lines: 0, omitted: 0 };

	const people = rows.filter((row) => row.entity_type === "people");
	const others = rows.filter((row) => row.entity_type !== "people");
	others.sort((a, b) => Number(b.entity_type === "term") - Number(a.entity_type === "term"));

	const tableOverhead = (n: number) => (n > 0 ? 1 + HOT_TIER_TABLE_HEAD.length : 0);
	const fixed =
		HOT_TIER_PREAMBLE.length + tableOverhead(people.length) + tableOverhead(others.length);

	let budget = maxLines - fixed;
	const needsAll = people.length + others.length <= budget;
	if (!needsAll) budget -= 1;
	budget = Math.max(0, budget);

	let peopleSlots = Math.min(
		people.length,
		Math.max(Math.floor(budget / 2), budget - others.length),
	);
	const otherSlots = Math.min(others.length, budget - peopleSlots);
	peopleSlots = Math.min(people.length, budget - otherSlots);

	const shownPeople = people.slice(0, peopleSlots);
	const shownOthers = others.slice(0, otherSlots);
	const omitted = rows.length - shownPeople.length - shownOthers.length;

	const lines: string[] = [...HOT_TIER_PREAMBLE];
	if (people.length > 0) {
		lines.push("People:", ...HOT_TIER_TABLE_HEAD, ...shownPeople.map(renderHotTierRow));
	}
	if (others.length > 0) {
		lines.push("Terms and entities:", ...HOT_TIER_TABLE_HEAD, ...shownOthers.map(renderHotTierRow));
	}
	if (omitted > 0) {
		lines.push(
			`(${omitted} more hot rows omitted: the hot tier is capped at ${maxLines} lines. Unmark some with hot: false.)`,
		);
	}

	return { text: lines.join("\n"), lines: lines.length, omitted };
}

/**
 * Deprecated legacy MCP tool alias names excluded from the rendered canonical
 * tool table.
 */
export const DEPRECATED_TOOL_ALIAS_NAMES: ReadonlySet<string> = new Set([
	"search_knowledge",
	"get_artifact",
	"get_artifact_and_file",
	"extract_text",
	"backfill_embeddings",
	"describe_schema",
	"create_external_link",
	"entities_create",
	"entities_delete",
	"entities_get",
	"entities_query",
	"entities_update",
	"entities_upsert",
	"entities_unmerge",
	"unmerge_entities",
	"relate_entities",
	"promote_edge_to_node",
	"people_create",
	"people_delete",
	"people_get",
	"people_match",
	"people_query",
	"people_update",
	"people_upsert",
	"get_self_entity",
	"artifact_entity_link_create",
	"artifact_entity_link_delete",
	"artifact_entity_link_get",
	"artifact_entity_link_query",
	"artifact_entity_link_upsert",
	"artifact_entity_sync",
	"export_rdf",
	"discover",
	"enrich_next",
	"github_ingest",
	"slack_ingest",
	"drive_ingest",
	"meeting_notes_detect",
	"meeting_notes_ingest",
	"get_capabilities",
	"register_capability",
	"resolve_capability",
	"get_integrations",
	"set_integration_config",
	"get_capture_config",
	"get_user_preferences",
	"update_user_preferences",
	"create_binding",
	"update_binding",
	"delete_binding",
	"list_bindings",
	"get_dos_config",
	"check_dos_config_drift",
	"get_daily_log_queue",
	"get_synthesis_coverage",
	"search_notion",
	"read_notion_page",
	"query_notion_database",
	"get_notion_config",
	"update_notion_page",
	"create_task",
	"create_communication",
	"create_daily_log_entry",
	"update_state_doc",
	"create_event",
	"post_linkedin",
]);

const SHA256_K = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
	0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
	0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
	0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
	0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
	0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
	return (x >>> n) | (x << (32 - n));
}

function sha256Hex(input: string): string {
	const bytes = new TextEncoder().encode(input);
	const bitLen = bytes.length * 8;
	const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
	const padded = new Uint8Array(paddedLen);
	padded.set(bytes);
	padded[bytes.length] = 0x80;
	const view = new DataView(padded.buffer);
	view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
	view.setUint32(paddedLen - 4, bitLen >>> 0, false);

	let h0 = 0x6a09e667;
	let h1 = 0xbb67ae85;
	let h2 = 0x3c6ef372;
	let h3 = 0xa54ff53a;
	let h4 = 0x510e527f;
	let h5 = 0x9b05688c;
	let h6 = 0x1f83d9ab;
	let h7 = 0x5be0cd19;

	const w = new Uint32Array(64);

	for (let offset = 0; offset < paddedLen; offset += 64) {
		for (let i = 0; i < 16; i++) {
			w[i] = view.getUint32(offset + i * 4, false);
		}
		for (let i = 16; i < 64; i++) {
			const w15 = w[i - 15]!;
			const w2 = w[i - 2]!;
			const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
			const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
			w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
		}

		let a = h0;
		let b = h1;
		let c = h2;
		let d = h3;
		let e = h4;
		let f = h5;
		let g = h6;
		let h = h7;

		for (let i = 0; i < 64; i++) {
			const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
			const ch = (e & f) ^ (~e & g);
			const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
			const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
			const maj = (a & b) ^ (a & c) ^ (b & c);
			const temp2 = (S0 + maj) >>> 0;

			h = g;
			g = f;
			f = e;
			e = (d + temp1) >>> 0;
			d = c;
			c = b;
			b = a;
			a = (temp1 + temp2) >>> 0;
		}

		h0 = (h0 + a) >>> 0;
		h1 = (h1 + b) >>> 0;
		h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0;
		h4 = (h4 + e) >>> 0;
		h5 = (h5 + f) >>> 0;
		h6 = (h6 + g) >>> 0;
		h7 = (h7 + h) >>> 0;
	}

	return [h0, h1, h2, h3, h4, h5, h6, h7]
		.map((v) => (v >>> 0).toString(16).padStart(8, "0"))
		.join("");
}

export function canonicalize(text: string): string {
	return (
		text
			.replace(/\r\n/g, "\n")
			.replace(/[ \t]+$/gm, "")
			.replace(/^\n+/, "")
			.replace(/\n+$/, "") + "\n"
	);
}

export function hashBody(text: string): string {
	return sha256Hex(canonicalize(text));
}

let defaultToolCatalogProvider: () => ToolSummary[] = () => [];

export function setDefaultToolCatalogProvider(provider: () => ToolSummary[]): void {
	defaultToolCatalogProvider = provider;
}

export function getDefaultToolCatalog(): ToolSummary[] {
	return defaultToolCatalogProvider();
}

export type ToolSummary = {
	name: string;
	description: string;
};

export type InstructionsFreshness = {
	status: "ok" | "warn";
	detail: string;
	fix: string;
	canonicalHash: string;
	pastedHash: string | null;
	pastedAt: string | null;
	isDrifted: boolean;
};

/**
 * Clean a tool description for the markdown table:
 * - replace any em-dash or en-dash with hyphen or comma
 * - strip newlines and escape pipe characters
 * - take first sentence (up to ~100 chars)
 */
export function cleanToolDescription(desc: string): string {
	let s = desc.replace(/[\u2014\u2013]/g, " - ");
	s = s.replace(/\r?\n|\r/g, " ").replace(/\|/g, "\\|").trim();
	s = s.replace(/\s+/g, " ");
	const periodIdx = s.indexOf(". ");
	if (periodIdx !== -1 && periodIdx < 110) {
		s = s.slice(0, periodIdx + 1);
	} else if (s.length > 100) {
		s = `${s.slice(0, 97).trim()}...`;
	}
	return s;
}

/**
 * Generate the markdown table of active ahOS tools.
 * Excludes deprecated aliases and tools marked deprecated.
 */
export function renderToolTable(tools: ToolSummary[]): string {
	const rows = tools
		.filter(
			(t) => !DEPRECATED_TOOL_ALIAS_NAMES.has(t.name) && !t.description.startsWith("Deprecated, use"),
		)
		.map((t) => ({
			name: t.name,
			description: cleanToolDescription(t.description),
		}))
		.sort((a, b) => a.name.localeCompare(b.name));

	const lines: string[] = ["| Tool | Description |", "| --- | --- |"];
	for (const row of rows) {
		lines.push(`| ${row.name} | ${row.description} |`);
	}
	return lines.join("\n");
}

/**
 * Relative age formatter matching the grill resolution:
 * 'today', 'yesterday', 'N days ago', '1 week ago', 'N weeks ago'.
 */
export function formatAge(pastedAt: string | null | undefined, now: Date = new Date()): string {
	if (!pastedAt) return "";
	const date = new Date(pastedAt);
	if (Number.isNaN(date.getTime())) return "";
	const diffMs = now.getTime() - date.getTime();
	if (diffMs < 0) return "just now";
	const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
	if (diffDays === 0) return "today";
	if (diffDays === 1) return "yesterday";
	if (diffDays < 7) return `${diffDays} days ago`;
	const weeks = Math.floor(diffDays / 7);
	if (weeks === 1) return "1 week ago";
	return `${weeks} weeks ago`;
}

/**
 * Hand-written prose for the canonical instructions block.
 * Rule: ZERO em-dashes. First line is the capability fallback.
 */
export const CANONICAL_PROSE_PREFIX = `If you do not know a command, skill, or agent the user invokes, check ahOS for capabilities via capability_resolve or capability_get before giving up. Prefix routing: "ahos/<name>" or "ahkms/<name>" (e.g., "ahos/dos", "ahos/close", "ahkms/capture") forces the registry copy. If absent from the registry, say so and stop; do not invent a command.

ahkms is your knowledge backend and capability registry (ADR-019, ADR-031). The connector name is ahkms.

Skill governance and placement (Registry-Native by default, ADR-031 / #1027): cross-repo, workflow, and domain skills live 100% in kms-db via capability_register (storage_location "kms-db"), never in the ahOS repo's .claude/skills/ directory. Only skills coupled to ahOS repo paths, scripts, or CI workflows live in .claude/skills/ (marked with repo_mirror). Before creating or editing any skill, call capability_get({ name: "writing-for-agents" }) to apply the Capability Bar, Two-Bucket placement rule, and sibling disambiguation tables. When the user asks which skill or workflow fits their situation, call capability_get({ name: "which-skill" }) to recommend the right skill or sequence (distinct from route, which routes ingested Drive artifacts, and whats-next, which ranks repo backlog items).

Daily ritual: dos (ADR-054). It unifies the Work and personal domains. Load its configuration at runtime via dos_config_get (never invent property names, topics, or pillars; verify options exist in Notion before writing).

Priority scale (ADR-116): ahOS uses a universal 7-point priority scale where 1 is lowest and 7 is highest: 1 Trivial, 2 Minor, 3 Low, 4 Normal, 5 High (default focus cut-line >= 5), 6 Urgent, 7 Critical. External surfaces map deterministically via priority_surface_mappings (Personal Notion: 1..2 3 Low, 3..4 2 Medium, 5..7 1 High; Work Notion: 1..2 Low, 3..4 Medium, 5..7 High; work-mcp: 1..2 priority:4_low, 3..4 priority:3_medium, 5 priority:2_high, 6..7 priority:1_critical; GitHub issues: 1..2 priority:low, 3..4 priority:medium, 5..7 priority:high; Gmail triage: 1..7 1..7). Orthogonal task dimensions (ADR-117): priority_level measures strictly importance and urgency; tasks and actionable entities (project, arrangement, decision, event) carry five orthogonal dimensions stored by slug: status (proposed, someday, todo, in_progress, blocked, done, cancelled; default todo), task_type (one_off, recurring, habit, milestone; default one_off, plus optional recurrence_rule), effort (quick, small, medium, large), energy_mode (deep_work, admin, waiting_on, quick_win), and source (owner, agent_proposed, email_triage, meeting_sweep, ritual).

Model-behaviour changes (ADR-094): when the user requests a behaviour change ("stop doing X", "always Y", "I prefer Z"), evaluate three questions: (1) Is it durable? Standing corrections are durable; one-off feedback is not. When ambiguous, ask once: "Keep that as a standing rule?". (2) Scope defaults to global unless a project, surface, or task class is specified. (3) Implementation is single-home: tone/voice rules go to dos tone config via config_preferences_update; other preferences go to user_preferences; both mirrored via capture with tag "memory" so changes are dated and searchable across surfaces.

House style: NEVER use the em-dash; use commas, semicolons, parentheses, colons, or sentence breaks instead.

Capture and ingestion routes:
- Capture notes and thoughts via capture (or quick-capture).
- Ingest sources: ingest_github (GitHub PRs, issues, commits), ingest_slack (Slack conversations and threads), ingest_drive (Google Drive files and trees), and ingest_meeting_notes (meeting transcripts and audio).

Read and query routes across integrations:
- Email: gmail_search, gmail_read, gmail_labels, gmail_draft, gmail_send_draft, gmail_modify
- Calendar: calendar_list_events, calendar_get_event, calendar_update_event, calendar_delete_event, calendar_respond_to_event
- Google Drive and Docs: drive_list, drive_search, drive_get_metadata, drive_read_file, drive_comment_list, drive_comment_get, drive_comment_create, drive_comment_reply, drive_comment_update, drive_comment_delete, docs_get, docs_batch_update, docs_find_text, docs_comments
- Notion: notion_search, notion_page_get, notion_database_query, notion_database_get, notion_page_update, notion_page_create, notion_comment_list, notion_comment_create
- CRM (Dex): dex_search_contacts, dex_list_contacts, dex_get_contact, dex_create_note, dex_create_reminder
- Product analytics and Planning: posthog_query, planning_read, planning_edit
- Knowledge graph: knowledge_search, artifact_get, entity_query, entity_get, person_match, person_query, person_get, entity_neighbourhood, link_query
- System and capability config: capability_get, capability_resolve, capability_register, config_preferences_get, dos_config_get`;

/**
 * Resolve the canonical prose prefix from `user_preferences.dos_config` (using
 * vendor-neutral `system_instructions` / `system-instructions` / `canonical_instructions`
 * with backward-compatible read fallback for `claude_instructions` / `claude-instructions`),
 * falling back to `CANONICAL_PROSE_PREFIX` when absent (#1987).
 */
export function resolveCanonicalProsePrefix(
	dosConfig?: Partial<DosConfig> | Record<string, unknown> | null,
): string {
	if (dosConfig && typeof dosConfig === "object") {
		const raw = dosConfig as Record<string, unknown>;
		const candidates = [
			raw.system_instructions,
			raw[SYSTEM_INSTRUCTIONS_CAPABILITY_NAME],
			raw.canonical_instructions,
			raw.canonical_prose_prefix,
			raw.claude_instructions,
			raw[LEGACY_CLAUDE_INSTRUCTIONS_CAPABILITY_NAME],
		];
		for (const candidate of candidates) {
			if (typeof candidate === "string" && candidate.trim().length > 0) {
				return candidate.trim();
			}
		}
	}
	return CANONICAL_PROSE_PREFIX;
}

/**
 * Build the canonical instructions block.
 *
 * Combines the canonical prose prefix (from `user_preferences.dos_config` with code
 * fallback) with all `user_preferences.dos_config.*` sections (`tone`,
 * `operating_principles`, `handshake_instructions`, `types`, `audiences`, `by_domain`),
 * the generated tool table, and the optional hot tier table (#1025, #1987).
 * Enforces zero em-dashes across the entire rendered output.
 */
export function buildCanonicalInstructions(
	tools?: ToolSummary[],
	hotRows: HotTierRow[] = [],
	dosConfig?: Partial<DosConfig> | Record<string, unknown> | null,
): string {
	const toolList = tools ?? defaultToolCatalogProvider();
	const prosePrefix = resolveCanonicalProsePrefix(dosConfig);
	const sections: string[] = [prosePrefix];

	if (dosConfig) {
		const configSections = renderDosConfigSections(dosConfig as Partial<DosConfig>);
		sections.push(...configSections);

		const raw = dosConfig as Record<string, unknown>;
		const handshakeInstructions =
			typeof raw.handshake_instructions === "string" ? raw.handshake_instructions.trim() : "";
		if (handshakeInstructions.length > 0) {
			sections.push(
				`Handshake instructions (source of truth: user_preferences.dos_config.handshake_instructions):\n${handshakeInstructions}`,
			);
		}
	}

	if (toolList.length > 0) {
		sections.push(`## Registered ahOS Tools\n\n${renderToolTable(toolList)}`);
	}

	if (hotRows.length > 0) {
		const hot = renderHotTier(hotRows).text;
		if (hot) {
			sections.push(hot);
		}
	}

	const combined = sections.join("\n\n");
	// Strict safety: replace any em-dash that might have snuck in via tool descriptions or config
	return combined.replace(/[\u2014]/g, " - ");
}

/**
 * Hash the canonical instructions block.
 */
export function getCanonicalInstructionsHash(
	tools?: ToolSummary[],
	hotRows: HotTierRow[] = [],
	dosConfig?: Partial<DosConfig> | Record<string, unknown> | null,
	bodyHashFn: (body: string) => string = hashBody,
): string {
	return bodyHashFn(buildCanonicalInstructions(tools, hotRows, dosConfig));
}

/**
 * Check whether the pasted copy of system instructions has drifted from canonical.
 */
export function checkInstructionsFreshness(
	pastedHash?: string | null,
	pastedAt?: string | null,
	now: Date = new Date(),
	canonicalHash: string = getCanonicalInstructionsHash(),
): InstructionsFreshness {
	const canonicalShort = canonicalHash.slice(0, 8);
	const fixInstruction = `copy from capability_get({ name: '${SYSTEM_INSTRUCTIONS_CAPABILITY_NAME}' }) into your client system instructions and run instructions_mark_pasted`;
	if (!pastedHash) {
		return {
			status: "warn",
			detail: `custom instructions never recorded as pasted (canonical: ${canonicalShort})`,
			fix: fixInstruction,
			canonicalHash,
			pastedHash: null,
			pastedAt: null,
			isDrifted: true,
		};
	}

	const pastedShort = pastedHash.slice(0, 8);
	const ageStr = formatAge(pastedAt, now);

	if (pastedHash === canonicalHash) {
		return {
			status: "ok",
			detail: `pasted copy is up-to-date (sha256 ${canonicalShort}${ageStr ? `, last pasted ${ageStr}` : ""})`,
			fix: "",
			canonicalHash,
			pastedHash,
			pastedAt: pastedAt ?? null,
			isDrifted: false,
		};
	}

	return {
		status: "warn",
		detail: `pasted copy is behind, last pasted ${ageStr || "unknown"} (pasted: ${pastedShort}, canonical: ${canonicalShort})`,
		fix: fixInstruction,
		canonicalHash,
		pastedHash,
		pastedAt: pastedAt ?? null,
		isDrifted: true,
	};
}

/**
 * Extract the system instructions sync record from a raw `dos_config` object,
 * preferring `system_instructions_sync` with backward-compatible fallback to
 * `claude_instructions_sync` and `pasted_instructions` (#1987).
 */
export function extractSystemInstructionsSync(
	dosConfig: Record<string, unknown> | null | undefined,
): PastedInstructionsRecord | null {
	if (!dosConfig || typeof dosConfig !== "object") return null;
	const candidates = [
		dosConfig[SYSTEM_INSTRUCTIONS_SYNC_KEY],
		dosConfig[LEGACY_CLAUDE_INSTRUCTIONS_SYNC_KEY],
		dosConfig[LEGACY_PASTED_INSTRUCTIONS_KEY],
	];
	for (const candidate of candidates) {
		if (candidate && typeof candidate === "object") {
			const record = candidate as Record<string, unknown>;
			if (typeof record.sha256 === "string" && typeof record.pasted_at === "string") {
				return { sha256: record.sha256, pasted_at: record.pasted_at };
			}
		}
	}
	return null;
}

/**
 * Ports bundle accepted by `createInstructionsGetAction` and
 * `createInstructionsMarkPastedAction` (#1601).
 */
export interface InstructionsActionPorts {
	config?: Pick<
		ConfigRepository,
		"loadDosConfigRow" | "loadPastedInstructions" | "savePastedInstructions"
	>;
	toolCatalog?: () => ToolSummary[];
	bodyHash?: (body: string) => string;
	loadDosConfig?: () => Promise<DosConfig> | DosConfig;
	loadPastedInstructions?:
		| (() => Promise<PastedInstructionsRecord | null> | PastedInstructionsRecord | null);
	savePastedInstructions?: (
		sha256: string,
		pastedAt: string,
	) => Promise<PastedInstructionsRecord | void> | PastedInstructionsRecord | void;
}

export async function resolveInstructionsDosConfig(
	ports: InstructionsActionPorts,
): Promise<DosConfig> {
	if (ports.loadDosConfig) {
		return await ports.loadDosConfig();
	}
	if (ports.config?.loadDosConfigRow) {
		return await loadDosConfigFromReader(ports.config);
	}
	return DEFAULT_DOS_CONFIG;
}

export async function resolvePastedInstructionsFromPorts(
	ports: InstructionsActionPorts,
): Promise<PastedInstructionsRecord | null> {
	if (ports.loadPastedInstructions) {
		return await ports.loadPastedInstructions();
	}
	if (ports.config?.loadPastedInstructions) {
		return await ports.config.loadPastedInstructions();
	}
	return null;
}
