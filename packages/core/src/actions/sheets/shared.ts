import { DOMAINS, type Domain } from "../../domain/domains.js";

/**
 * Encloses a sheet title in single quotes, doubling any embedded single quotes.
 */
export function quoteSheetTitle(title: string): string {
	return `'${title.replace(/'/g, "''")}'`;
}

/**
 * Accepts a bare spreadsheet id (`[A-Za-z0-9_-]+`) or a `docs.google.com/spreadsheets/d/<id>` URL.
 * Refuses anything else, naming the input.
 */
export function normaliseSpreadsheetId(input: string): string {
	const trimmed = input.trim();
	const urlMatch = trimmed.match(/docs\.google\.com\/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
	if (urlMatch?.[1]) return urlMatch[1];
	if (/^[A-Za-z0-9_-]+$/.test(trimmed)) return trimmed;
	throw new Error(
		`Invalid spreadsheet_id "${input}". Pass a bare spreadsheet id or a docs.google.com/spreadsheets/d/<id> URL.`,
	);
}

/**
 * Refuses a missing domain before any port call, naming both Google accounts (ADR-054 §9).
 */
export function requireSheetsDomain(domain: Domain | undefined, doing: string): Domain {
	if (!domain) {
		throw new Error(
			`\`domain\` is required to ${doing} — 'work' (the Work Google account) or 'angus' (the personal one). There is no default: each domain resolves its own Google refresh token, and the two accounts have disjoint Drive access.`,
		);
	}
	return domain;
}

function withStatus(message: string, status: number, cause: unknown): Error & { status: number } {
	const wrapped = new Error(message, { cause }) as Error & { status: number };
	wrapped.status = status;
	return wrapped;
}

/**
 * Explains Google Sheets port errors by numeric `status` and string `reason`, never by message.
 * Preserves `status` and sets `cause` on wrapped errors so `/api/actions` maps HTTP status codes.
 */
export function explainSheetsError(err: unknown, domain: Domain, tabs?: readonly string[]): never {
	const status =
		err !== null && typeof err === "object" && typeof (err as { status?: unknown }).status === "number"
			? (err as { status: number }).status
			: undefined;
	if (status === undefined) throw err;

	const reason =
		err !== null && typeof err === "object" && typeof (err as { reason?: unknown }).reason === "string"
			? (err as { reason: string }).reason
			: undefined;
	const other = DOMAINS.find((d) => d !== domain);

	if (status === 404 || (status === 403 && !reason)) {
		throw withStatus(
			`Spreadsheet not accessible in the '${domain}' Google account (HTTP ${status}). The two Google accounts have disjoint access — if this spreadsheet lives in the other account, retry with domain='${other}'.`,
			status,
			err,
		);
	}

	if (status === 403 && reason === "SERVICE_DISABLED") {
		throw withStatus(
			"Google Sheets API is disabled (SERVICE_DISABLED). An owner console step is required: enable the Google Sheets API in Google Cloud Console on the project behind GOOGLE_CLIENT_ID.",
			status,
			err,
		);
	}

	if (status === 403 && reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT") {
		throw withStatus(
			`Google token for '${domain}' lacks sufficient scope (ACCESS_TOKEN_SCOPE_INSUFFICIENT). Re-consent is a human step (ADR-045): re-mint the refresh token for '${domain}'.`,
			status,
			err,
		);
	}

	if (status === 400 && tabs && tabs.length > 0) {
		const quoted = tabs.map(quoteSheetTitle).join(", ");
		throw withStatus(
			`Invalid range or request (HTTP 400). Available tabs in this spreadsheet: ${quoted}.`,
			status,
			err,
		);
	}

	throw err;
}
