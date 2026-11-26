import type { z } from "zod";
import type { CapturePreferences } from "../domain/capturePreferences.js";
import type { MeetingNoteSource } from "../domain/ingest/meetingNoteEmails.js";
import type {
	IntegrationConfigResult,
	IntegrationRow,
	IntegrationSummary,
} from "../domain/integrations.js";

export type {
	CapturePreferences,
	IntegrationConfigResult,
	IntegrationRow,
	IntegrationSummary,
	MeetingNoteSource,
};

export type MeetingNoteSourcesOrigin = "stored" | "default" | "invalid-stored";

export interface MeetingNoteSourcesResult {
	sources: MeetingNoteSource[];
	origin: MeetingNoteSourcesOrigin;
}

export interface DosAtomType {
	key: string;
	description: string;
}

export type DosOperatingPrinciple =
	| string
	| {
			key: string;
			description: string;
	  };

export interface DosAudienceSpec {
	key: string;
	role?: string;
	domain?: string;
	register: string;
	standing_exclusions?: string[];
	examples?: string[];
	cadence?: string;
}

export interface DosPillarSpec {
	key: string;
	label: string;
	description: string;
	notion_option?: string;
	notion_property?: string;
}

export interface DosArtefactRegisterSpec {
	key: string;
	tone: string;
}

export interface DosDailyLogPropertySpec {
	name: string;
	notion_type: string;
	required: boolean;
	notes?: string;
	role?: string;
	options?: string[];
}

export interface DosDailyLogSchemaSpec {
	properties?: DosDailyLogPropertySpec[];
	body_sections?: string[];
}

export interface DosStateDocRulesSpec {
	max_words?: number;
	open_actions_cap?: number;
	communications_cap?: number;
}

export interface DosDomainConfig {
	topics?: string[];
	pillars?: DosPillarSpec[];
	domain_signals?: string[];
	artefact_registers?: DosArtefactRegisterSpec[];
	audiences?: DosAudienceSpec[];
	state_doc_rules?: DosStateDocRulesSpec;
	daily_log_schema?: DosDailyLogSchemaSpec;
	waiting_on_status?: string;
	[key: string]: unknown;
}

export interface DosPastedInstructions {
	sha256: string;
	pasted_at: string;
}

export type PastedInstructionsRecord = DosPastedInstructions;

export interface DosConfigRecord {
	tone?: string[];
	operating_principles?: DosOperatingPrinciple[];
	handshake_instructions?: string | string[];
	types?: DosAtomType[];
	audiences?: DosAudienceSpec[];
	by_domain?: Record<string, DosDomainConfig>;
	pasted_instructions?: DosPastedInstructions | null;
	[key: string]: unknown;
}

export interface UserPreferencesRow {
	user_id?: string;
	user_mode?: unknown;
	automation_level?: unknown;
	global_confidence_threshold?: unknown;
	show_lifecycle_details?: unknown;
	safe_mode?: unknown;
	has_completed_onboarding?: unknown;
	created_at?: unknown;
	updated_at?: unknown;
	confidence_thresholds?: unknown;
	notification_preferences?: unknown;
	capture_preferences?: unknown;
	meeting_note_sources?: unknown;
	dos_config?: DosConfigRecord | Record<string, unknown> | unknown;
	/** Owner identity-matching signals: `{ emails: string[], display_name: string }` (migration 053, #2415). */
	identity?: unknown;
	[key: string]: unknown;
}

export interface UserPreferencesWritePort {
	/**
	 * Partial-update the owner's `user_preferences` row with `patch` and return the updated row (#1988).
	 */
	updatePreferencesRow?(patch: Record<string, unknown>): Promise<UserPreferencesRow>;
}

export type ConfigPreferencesRepository = ConfigRepository & UserPreferencesWritePort;

export interface IntegrationConfigWriteRow {
	provider: string;
	enabled: boolean;
	config: Record<string, unknown>;
}

/**
 * Repository port for reading, listing, and updating the owner's `user_integrations` rows (ADR-101 §1, #1597).
 */
export interface ConfigRepository {
	/**
	 * Load a provider's config with detailed status, distinguishing DB read errors
	 * from genuinely unwired integrations (missing row, enabled=false, or schema parse failure).
	 */
	loadConfigDetailed<T>(provider: string, schema: z.ZodType<T>): Promise<IntegrationConfigResult<T>>;
	/**
	 * Load a provider's validated config for the owner, or null when unwired/disabled/invalid.
	 */
	loadConfig<T>(provider: string, schema: z.ZodType<T>): Promise<T | null>;
	/**
	 * Load a provider's full routing row (`routing`, `status`, `credential_ref`, raw `config`), or null when absent.
	 */
	loadIntegration(provider: string): Promise<IntegrationRow | null>;
	/**
	 * List all enabled connection rows belonging to a provider family (`<family>:*`, ADR-060).
	 */
	listByFamily(family: string): Promise<IntegrationRow[]>;
	/**
	 * Shallow-merge a non-secret config patch into a provider's `config` jsonb column.
	 */
	updateConfig(provider: string, patch: Record<string, unknown>): Promise<void>;
	/**
	 * List the owner's configured integrations with config key names only (never values).
	 */
	listIntegrations(): Promise<IntegrationSummary[]>;
	/**
	 * Read the owner's raw `{ config, enabled }` row for `provider`, or `null` if absent (#1598).
	 */
	readIntegrationConfig?(provider: string): Promise<{ config: Record<string, unknown>; enabled: boolean } | null>;
	/**
	 * Insert a new `user_integrations` row for `provider` (#1598).
	 */
	insertIntegrationConfig?(
		provider: string,
		row: { config: Record<string, unknown>; enabled: boolean },
	): Promise<IntegrationConfigWriteRow>;
	/**
	 * Update an existing `user_integrations` row for `provider` (#1598).
	 */
	updateIntegrationConfigRow?(
		provider: string,
		patch: { config: Record<string, unknown>; enabled?: boolean },
	): Promise<IntegrationConfigWriteRow>;
	/**
	 * Load the owner's raw `user_preferences` row, or `null` if none exists (#1599).
	 */
	loadPreferencesRow?(): Promise<UserPreferencesRow | null>;
	/**
	 * Load and validate the owner's persisted `capture_preferences` from `user_preferences`,
	 * falling back to `DEFAULT_CAPTURE_PREFERENCES` when absent or invalid (#1599).
	 */
	loadCapturePreferences?(): Promise<CapturePreferences>;
	/**
	 * Load the owner's raw `dos_config` JSONB value from `user_preferences`, or `null` when absent or unreadable (#1603).
	 */
	loadDosConfigRow?(): Promise<unknown>;
	/**
	 * Load the owner's system instructions sync record from `user_preferences.dos_config`
	 * (`system_instructions_sync`, falling back to `claude_instructions_sync` and `pasted_instructions`),
	 * or `null` when absent or unreadable (#1601).
	 */
	loadPastedInstructions?(): Promise<PastedInstructionsRecord | null>;
	/**
	 * Save the system instructions sync record into `user_preferences.dos_config.system_instructions_sync`
	 * (and mirror to `pasted_instructions` for backward compatibility) (#1601).
	 */
	savePastedInstructions?(
		sha256OrRecord: string | PastedInstructionsRecord,
		pastedAt?: string,
	): Promise<void>;
	/**
	 * Load the owner's meeting-note detection rules from `user_preferences.meeting_note_sources`,
	 * falling back to `DEFAULT_MEETING_NOTE_SOURCES` when absent or invalid (#1538).
	 */
	meetingNoteSources?(userId?: string): Promise<MeetingNoteSourcesResult>;
}
