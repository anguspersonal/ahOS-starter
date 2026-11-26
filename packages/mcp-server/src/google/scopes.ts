import { DRIVE_SCOPE } from "./drive.js";
import { CALENDAR_SCOPE } from "./calendar.js";

// Gmail scopes, requested at mint time so the Gmail tools in #821 land against a
// token that already carries consent.
//
// Google has no "drafts but never send" scope. `gmail.compose` and `gmail.modify`
// both permit sending, and the only narrower option (`gmail.readonly`) cannot
// create a draft or move a label. So what may be sent has always been decided at
// the TOOL layer, not here: #821 shipped with no send tool at all, and #1006 added
// drafting plus send-an-existing-draft, still with no tool that composes and sends
// in one step. Anyone reading #821's "No send capability exposed" acceptance
// criterion should read it as a statement about the tool surface as it stood then;
// the granted scope was always broader, and now the tool surface has moved without
// this list changing. That is the point of the split.
//
// (An earlier version of this comment attributed the restriction to "the
// outwardWrite.ts human-gate convention". No such convention exists in that file;
// see the header of gmail.ts.)
export const GMAIL_READONLY_SCOPE =
	"https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";

// Apps Script scopes, requested at mint time to support project and deployment management
export const SCRIPT_PROJECTS_SCOPE =
	"https://www.googleapis.com/auth/script.projects";
export const SCRIPT_DEPLOYMENTS_SCOPE =
	"https://www.googleapis.com/auth/script.deployments";
export const SCRIPT_PROCESSES_SCOPE =
	"https://www.googleapis.com/auth/script.processes";

// Google Docs scope, for in-place document editing via documents.batchUpdate
export const DOCUMENTS_SCOPE = "https://www.googleapis.com/auth/documents";
export const BIGQUERY_READONLY_SCOPE =
	"https://www.googleapis.com/auth/bigquery.readonly";

/**
 * Every scope minted in one consent, for one account.
 *
 * This list exists as a single constant because of the trap recorded in ADR-045:
 * a Google refresh token is scope-bound at mint time, so re-running the consent
 * for one more scope REPLACES the previous token rather than adding to it. That
 * is how the Calendar activation in #126 broke Drive-scoped tokens. Requesting
 * every scope the server will ever need, in one go, is the only shape that does
 * not cost the owner a re-consent per feature.
 *
 * Adding a scope here means every account must be re-consented. That is a human
 * step (a browser flow), so it belongs in the issue that adds the scope, not in
 * a passing commit.
 */
export const GOOGLE_MINT_SCOPES: readonly string[] = [
	DRIVE_SCOPE,
	CALENDAR_SCOPE,
	GMAIL_READONLY_SCOPE,
	GMAIL_MODIFY_SCOPE,
	SCRIPT_PROJECTS_SCOPE,
	SCRIPT_DEPLOYMENTS_SCOPE,
	SCRIPT_PROCESSES_SCOPE,
	DOCUMENTS_SCOPE,
	BIGQUERY_READONLY_SCOPE,
];
