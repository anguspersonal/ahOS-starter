import { afterEach, describe, expect, it, vi } from "vitest";
import { supabase } from "../supabase.js";
import {
	applyCaptureRouting,
	capturePreferencesSchema,
	DEFAULT_CAPTURE_PREFERENCES,
	DISCOVER_ROLE_SEED,
	MACHINE_INGEST_SURFACES,
	METRICS_SURFACES,
	effectiveSurfaceRoleMap,
	loadCapturePreferences,
	resolveTrust,
	resolveSynthesisRole,
} from "../captureConfig.js";

// The blob migration 035 installs as the column DEFAULT *and* backfills onto
// every pre-existing user_preferences row. This — not "no row" — is what a real
// owner's capture_preferences contains.
const MIGRATION_035_BLOB = { create_derived_artifacts: true };

const origFrom = supabase.from;
afterEach(() => {
	(supabase as any).from = origFrom;
	vi.restoreAllMocks();
});

const prefs = capturePreferencesSchema.parse({
	default_tags: ["inbox"],
	default_source_channel: "mcp",
	tag_rules: [
		{ match: "meeting|standup", in: "text", tags: ["work", "meeting"], source_channel: "calendar" },
		{ match: "github\\.com", in: "source_url", tags: ["code"], source_channel: "web" },
		{ match: "(unclosed", in: "text", tags: ["bad-regex"] },
	],
});

describe("applyCaptureRouting", () => {
	it("unions default tags, caller tags, and matched-rule tags; first rule sets the channel", () => {
		const r = applyCaptureRouting(prefs, {
			text: "Standup notes",
			title: "Standup",
			tags: ["q3"],
		});
		expect(r.tags.sort()).toEqual(["inbox", "meeting", "q3", "work"]);
		expect(r.source_channel).toBe("calendar");
	});

	it("matches rules against the chosen field (source_url)", () => {
		const r = applyCaptureRouting(prefs, {
			text: "cool repo",
			title: "repo",
			source_url: "https://github.com/x/y",
		});
		expect(r.tags.sort()).toEqual(["code", "inbox"]);
		expect(r.source_channel).toBe("web");
	});

	it("falls back to default tags + channel when no rule matches", () => {
		const r = applyCaptureRouting(prefs, { text: "random thought", title: "random" });
		expect(r.tags).toEqual(["inbox"]);
		expect(r.source_channel).toBe("mcp");
	});

	it("skips an invalid regex rule without throwing", () => {
		// The "(unclosed" rule must not crash or apply its tag.
		const r = applyCaptureRouting(prefs, { text: "(unclosed literal", title: "x" });
		expect(r.tags).not.toContain("bad-regex");
	});

	it("with no preferences row, returns only caller tags on the mcp channel (back-compat)", () => {
		const r = applyCaptureRouting(DEFAULT_CAPTURE_PREFERENCES, {
			text: "x",
			title: "x",
			tags: ["only"],
		});
		expect(r.tags).toEqual(["only"]);
		expect(r.source_channel).toBe("mcp");
	});
});

describe("resolveTrust", () => {
	// Precedence (ADR-026): trust_override -> surface_trust_map[surface] ->
	// surface_trust_map[source_channel] -> default_trust.
	const trustPrefs = capturePreferencesSchema.parse({
		surface_trust_map: { claude_desktop: "high", calendar: "perfect" },
		default_trust: "medium",
	});

	it("a valid explicit override wins over everything", () => {
		expect(
			resolveTrust(trustPrefs, {
				surface: "claude_desktop",
				source_channel: "calendar",
				trust_override: "low",
			}),
		).toBe("low");
	});

	it("ignores an invalid override and falls through to the surface map", () => {
		expect(
			resolveTrust(trustPrefs, { surface: "claude_desktop", trust_override: "bogus" }),
		).toBe("high");
	});

	it("maps a known surface to its tier", () => {
		expect(resolveTrust(trustPrefs, { surface: "claude_desktop" })).toBe("high");
	});

	it("falls back to source_channel in the same map when surface is unknown/absent", () => {
		expect(
			resolveTrust(trustPrefs, { surface: "unmapped_surface", source_channel: "calendar" }),
		).toBe("perfect");
	});

	it("falls back to default_trust when neither surface nor source_channel is mapped", () => {
		expect(resolveTrust(trustPrefs, { surface: "unknown", source_channel: "unknown" })).toBe(
			"medium",
		);
	});

	it("handles null/undefined fields without throwing, returning the default", () => {
		expect(
			resolveTrust(trustPrefs, { surface: null, source_channel: null, trust_override: null }),
		).toBe("medium");
		expect(resolveTrust(trustPrefs, {})).toBe("medium");
	});

	it("uses the user's default_trust (\"medium\" by default) on a fresh store", () => {
		expect(resolveTrust(DEFAULT_CAPTURE_PREFERENCES, { surface: "anything" })).toBe("medium");
	});
});

describe("resolveSynthesisRole (ADR-046 §3, #570)", () => {
	// Precedence mirrors resolveTrust: surface_role_map[surface] ->
	// surface_role_map[source_channel] -> default_role. No per-artifact override.
	const rolePrefs = capturePreferencesSchema.parse({
		surface_role_map: { claude_desktop: "narrative", rescuetime: "metrics" },
		default_role: "narrative",
	});

	it("maps a known surface to its role", () => {
		expect(resolveSynthesisRole(rolePrefs, { surface: "rescuetime" })).toBe("metrics");
	});

	it("falls back to source_channel in the same map when surface is unknown/absent", () => {
		expect(
			resolveSynthesisRole(rolePrefs, { surface: "unmapped_surface", source_channel: "rescuetime" }),
		).toBe("metrics");
	});

	it("falls back to default_role when neither surface nor source_channel is mapped", () => {
		expect(resolveSynthesisRole(rolePrefs, { surface: "unknown", source_channel: "unknown" })).toBe(
			"narrative",
		);
	});

	it("handles null/undefined fields without throwing, returning the default", () => {
		expect(resolveSynthesisRole(rolePrefs, { surface: null, source_channel: null })).toBe(
			"narrative",
		);
		expect(resolveSynthesisRole(rolePrefs, {})).toBe("narrative");
	});

	it("still resolves a captured atom (no discover surface) to the narrative default", () => {
		expect(resolveSynthesisRole(rolePrefs, { surface: "claude_code" })).toBe("narrative");
	});
});

// The load-bearing case for #570 — and the one round-1 review found was being
// tested against a code path production never takes.
//
// Migration 035 gave user_preferences.capture_preferences a non-null column
// DEFAULT and backfilled every existing row, so loadCapturePreferences() never
// reaches its `!data?.capture_preferences` branch for a real owner: it parses a
// stored blob. A role seed living only on DEFAULT_CAPTURE_PREFERENCES is
// therefore unreachable in production, and asserting against that constant
// reports success for behaviour that does not happen. Every test below goes
// through a REALISTIC STORED BLOB instead.
describe("Drive discover role floor on the live store (ADR-046 §3, #570)", () => {
	// Hardcoded rather than derived from ENRICHABLE_CONNECTORS on purpose: adding a
	// connector must be a conscious decision that its pointers deserve the evidence
	// floor, not something a list import grants silently. `discovered_gdrive_work`
	// is the Work Google account's sweep (#857) — same Drive estate, same kind of
	// artifact, so the same floor as the personal one.
	const DRIVE_SURFACES = [
		"discovered_gdrive",
		"discovered_gdrive_work",
		"discovered_google_drive",
		"discovered_drive",
		"discovered_onedrive",
	];
	// Hardcoded for the same reason (#1210). A mailbox's attachments are a bulk source,
	// and ADR-046 §4 rows 1.5/1.6 put email at evidence outright.
	const GMAIL_ATTACHMENT_SURFACES = [
		"discovered_gmail_attachment",
		"discovered_gmail_attachment_work",
	];
	const LOCAL_DISCOVER_SURFACES = [
		"discovered_local",
	];

	it("resolves local discover surface to 'evidence' from the stored blob (#1211)", () => {
		const stored = capturePreferencesSchema.parse(MIGRATION_035_BLOB);
		for (const surface of LOCAL_DISCOVER_SURFACES) {
			expect(resolveSynthesisRole(stored, { surface })).toBe("evidence");
			expect(resolveSynthesisRole(DEFAULT_CAPTURE_PREFERENCES, { surface })).toBe("evidence");
		}
	});

	it("resolves every Gmail attachment discover surface to 'evidence' from the stored blob", () => {
		const stored = capturePreferencesSchema.parse(MIGRATION_035_BLOB);
		for (const surface of GMAIL_ATTACHMENT_SURFACES) {
			expect(resolveSynthesisRole(stored, { surface })).toBe("evidence");
			expect(resolveSynthesisRole(DEFAULT_CAPTURE_PREFERENCES, { surface })).toBe("evidence");
		}
	});

	it("resolves every Drive discover surface to 'evidence' from the blob migration 035 actually stores", () => {
		const stored = capturePreferencesSchema.parse(MIGRATION_035_BLOB);
		// Preconditions that make this the production path, not the defaults path:
		// the parsed blob carries an EMPTY stored map and the narrative default.
		expect(stored.surface_role_map).toEqual({});
		expect(stored.default_role).toBe("narrative");

		for (const surface of DRIVE_SURFACES) {
			expect(resolveSynthesisRole(stored, { surface })).toBe("evidence");
		}
	});

	it("survives a stored map that configures unrelated surfaces", () => {
		// The regression a plain schema default would still allow: the owner maps
		// one unrelated surface, and the Drive floor vanishes with it.
		const stored = capturePreferencesSchema.parse({
			...MIGRATION_035_BLOB,
			surface_role_map: { slack: "evidence", rescuetime: "metrics" },
		});
		for (const surface of DRIVE_SURFACES) {
			expect(resolveSynthesisRole(stored, { surface })).toBe("evidence");
		}
		expect(resolveSynthesisRole(stored, { surface: "rescuetime" })).toBe("metrics");
	});

	it("is a floor, not a ceiling: an explicit stored entry still wins", () => {
		// ADR-046 §4 row 1.10a — once the connector is scoped to Gemini meeting
		// notes, the owner promotes it back to narrative by configuration.
		const stored = capturePreferencesSchema.parse({
			...MIGRATION_035_BLOB,
			surface_role_map: { discovered_gdrive: "narrative" },
		});
		expect(resolveSynthesisRole(stored, { surface: "discovered_gdrive" })).toBe("narrative");
		// Siblings the owner did not speak about keep the floor.
		expect(resolveSynthesisRole(stored, { surface: "discovered_drive" })).toBe("evidence");
	});

	it("resolves via the source_channel fallback when surface is still null (un-backfilled row)", () => {
		const stored = capturePreferencesSchema.parse(MIGRATION_035_BLOB);
		expect(
			resolveSynthesisRole(stored, { surface: null, source_channel: "discovered_gdrive" }),
		).toBe("evidence");
	});

	it("also holds on a fresh store with no preferences row at all", () => {
		for (const surface of DRIVE_SURFACES) {
			expect(resolveSynthesisRole(DEFAULT_CAPTURE_PREFERENCES, { surface })).toBe("evidence");
		}
	});

	it("leaves non-discover surfaces on the narrative default", () => {
		const stored = capturePreferencesSchema.parse(MIGRATION_035_BLOB);
		expect(resolveSynthesisRole(stored, { surface: "claude_code" })).toBe("narrative");
		expect(resolveSynthesisRole(stored, { surface: "discovered_notion" })).toBe("narrative");
	});

	it("DEFAULT_CAPTURE_PREFERENCES is the schema's own defaults, so the two load branches cannot diverge", () => {
		expect(DEFAULT_CAPTURE_PREFERENCES).toEqual(capturePreferencesSchema.parse({}));
		// And the floor deliberately does NOT depend on the defaults object
		// carrying it — that dependency is what made the seed unreachable.
		expect(DEFAULT_CAPTURE_PREFERENCES.surface_role_map).toEqual({});
	});

	it("effectiveSurfaceRoleMap layers stored entries over the shipped seed", () => {
		const stored = capturePreferencesSchema.parse({
			...MIGRATION_035_BLOB,
			surface_role_map: { discovered_gdrive: "narrative", slack: "evidence" },
		});
		expect(effectiveSurfaceRoleMap(stored)).toEqual({
			...DISCOVER_ROLE_SEED,
			discovered_gdrive: "narrative",
			slack: "evidence",
		});
	});

	it("the seed covers the Drive, Gmail attachment and local discover connectors plus the machine-ingest and metrics surfaces — Notion discover keeps ADR-046 §4 rows 1.1-1.3", () => {
		expect(Object.keys(DISCOVER_ROLE_SEED).sort()).toEqual(
			[...DRIVE_SURFACES, ...GMAIL_ATTACHMENT_SURFACES, ...LOCAL_DISCOVER_SURFACES, ...MACHINE_INGEST_SURFACES, ...METRICS_SURFACES].sort(),
		);
		expect(DISCOVER_ROLE_SEED).not.toHaveProperty("discovered_notion");
	});

	it("resolves every metrics surface to 'metrics' from the stored blob (ADR-046 §3)", () => {
		const stored = capturePreferencesSchema.parse(MIGRATION_035_BLOB);
		expect([...METRICS_SURFACES].sort()).toEqual(["kpi_snapshot"]);
		for (const surface of METRICS_SURFACES) {
			expect(resolveSynthesisRole(stored, { surface })).toBe("metrics");
			expect(resolveSynthesisRole(DEFAULT_CAPTURE_PREFERENCES, { surface })).toBe("metrics");
		}
	});

	// #1767, #1771: ADR-046 §3 and §4 rows 1.7/1.8 put Slack and GitHub at evidence, and
	// ADR-108 §4 floors act_receipt at evidence. The floor is what makes the
	// policy true on a real owner row, exactly as it did for Drive in #570.
	it("resolves every machine-ingest surface to 'evidence' from the stored blob (ADR-046 §3/§4, #1767, #1771)", () => {
		const stored = capturePreferencesSchema.parse(MIGRATION_035_BLOB);
		expect([...MACHINE_INGEST_SURFACES].sort()).toEqual(["act_receipt", "derived", "github", "gmail_ingest", "slack", "slack_dm", "whatsapp", "whatsapp_dm"]);
		for (const surface of MACHINE_INGEST_SURFACES) {
			expect(resolveSynthesisRole(stored, { surface })).toBe("evidence");
			expect(resolveSynthesisRole(DEFAULT_CAPTURE_PREFERENCES, { surface })).toBe("evidence");
		}
		// Still a floor: the owner's stored map wins per key.
		const promoted = capturePreferencesSchema.parse({ ...MIGRATION_035_BLOB, surface_role_map: { slack_dm: "excluded" } });
		expect(resolveSynthesisRole(promoted, { surface: "slack_dm" })).toBe("excluded");
		expect(resolveSynthesisRole(promoted, { surface: "slack" })).toBe("evidence");
	});
});

describe("loadCapturePreferences (end-to-end over a stored blob)", () => {
	function stubPrefsRow(capture_preferences: unknown) {
		(supabase as any).from = vi.fn(() => ({
			select: () => ({
				eq: () => ({
					maybeSingle: () => Promise.resolve({ data: { capture_preferences }, error: null }),
				}),
			}),
		}));
	}

	it("an owner row holding migration 035's blob still resolves Drive discover to evidence", async () => {
		stubPrefsRow(MIGRATION_035_BLOB);
		const prefs = await loadCapturePreferences();
		// This is the exact scenario round-1 flagged: real row, safeParse branch.
		expect(prefs.surface_role_map).toEqual({});
		expect(resolveSynthesisRole(prefs, { surface: "discovered_gdrive" })).toBe("evidence");
		expect(resolveSynthesisRole(prefs, { surface: "claude_code" })).toBe("narrative");
	});

	it("a malformed blob degrades to defaults and still holds the floor", async () => {
		stubPrefsRow({ default_role: "not-a-role" });
		const prefs = await loadCapturePreferences();
		expect(prefs).toEqual(DEFAULT_CAPTURE_PREFERENCES);
		expect(resolveSynthesisRole(prefs, { surface: "discovered_gdrive" })).toBe("evidence");
	});
});
