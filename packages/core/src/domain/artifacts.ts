// Source: packages/shared/src/constants/artifactSurfaces.ts (twin deleted in ADR-101 §5 step 7).
export const ARTIFACT_SURFACES = {
	/** `drive_import_file` — explicit single-file Drive import, distinct from `discovered_gdrive`. */
	driveImport: "drive_import",
	/** Worker upload pipeline, browser client. */
	webApp: "web_app",
	/** Worker upload pipeline, iOS / Android client. */
	mobileApp: "mobile_app",
	/** Programmatic ingest floor when no finer surface or `default_surface` was declared (#584). */
	api: "api",
	/** Provenance receipt auto-captured by the Act path (`create_task` / `create_event`; #413, ADR-038 §4/§6). */
	actReceipt: "act_receipt",
	/** Worker AI-cleaned derivative of another artifact (`source_channel = 'derived'`). */
	derived: "derived",
	/** GitHub activity pulled in by `github_ingest` (ADR-046 §3 role `evidence`). */
	github: "github",
	/** Slack channel messages pulled in by `slack_ingest`. */
	slack: "slack",
	/** Slack direct or group DM messages pulled in by `slack_ingest` (#584). */
	slackDm: "slack_dm",
	/** WhatsApp group chat messages pulled in by `whatsapp_ingest`. */
	whatsapp: "whatsapp",
	/** WhatsApp 1:1 direct or self-chat messages pulled in by `whatsapp_ingest`. */
	whatsappDm: "whatsapp_dm",
	/** Weekly KPI scorecard snapshots written by `weekly_kpi_snapshot` (ADR-046 §3 role `metrics`). */
	kpiSnapshot: "kpi_snapshot",
} as const;

/** A surface value written by code in this repo. */
export type ArtifactSurface = (typeof ARTIFACT_SURFACES)[keyof typeof ARTIFACT_SURFACES];

// Source: packages/shared/src/utils/title.ts (twin deleted in ADR-101 §5 step 7).
const DEFAULT_MAX_TITLE_LENGTH = 120;

export function deriveTitleFromText(
	text: string | null | undefined,
	maxLength: number = DEFAULT_MAX_TITLE_LENGTH,
): string | null {
	if (!text) {
		return null;
	}

	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.length > 0) {
			return trimmed.slice(0, maxLength);
		}
	}

	return null;
}

export function deriveTitleFromFilename(filename: string | null | undefined): string | null {
	if (!filename) {
		return null;
	}

	const trimmed = filename.trim();
	if (trimmed.length === 0) {
		return null;
	}

	const stripped = trimmed.replace(/\.[^./\\]+$/, "");
	return stripped.length > 0 ? stripped : null;
}

export interface DeriveArtifactTitleInput {
	explicitTitle?: string | null;
	text?: string | null;
	filename?: string | null;
	maxLength?: number;
}

export function deriveArtifactTitle(input: DeriveArtifactTitleInput): string | null {
	const explicit = input.explicitTitle?.trim();
	if (explicit) {
		return explicit;
	}

	const fromText = deriveTitleFromText(input.text, input.maxLength);
	if (fromText) {
		return fromText;
	}

	const fromFilename = deriveTitleFromFilename(input.filename);
	return fromFilename || null;
}

// Source: packages/mcp-server/src/kms/artifacts.ts (moved to core per ADR-101 §5 step 7).
export function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "note"
	);
}
