import type { CredentialProvider } from "../credentials.js";

// Which Google account a Drive / Calendar / Gmail call runs as (issue #338).
//
// The discriminator is the ACCOUNT, not the service. One Google refresh token
// covers every API the consent granted, so Drive, Calendar and Gmail for a given
// account all authenticate with the same secret. Splitting the discriminator by
// service (a `google_drive` credential separate from a `google_gmail` one) would
// invent a boundary Google does not have, and would make the scope-bundling trap
// in ADR-045 worse: re-minting for one service silently invalidates the others.
//
// This mirrors Notion's shape deliberately. There, two workspaces are two
// providers with two tokens and disjoint page access (see credentials.ts). Here,
// two Google accounts are two providers with two refresh tokens and disjoint
// Drive/Calendar/Gmail access. Same seam, same reasoning.
export type GoogleAccount = "personal" | "work";

/**
 * The account used when a caller does not name one.
 *
 * Personal, because it is the account every existing Drive and Calendar call has
 * always run as: the stored `GOOGLE_REFRESH_TOKEN_PERSONAL` was minted against
 * owner@example.com. Making the parameter optional with this default is what
 * keeps the ~20 existing `getDrive()` call sites working untouched while the
 * account dimension is introduced.
 */
export const DEFAULT_GOOGLE_ACCOUNT: GoogleAccount = "personal";

/**
 * Account to `user_integrations` provider name, which is also the key
 * `getCredential` resolves. Config routing and credential routing agree by
 * construction, the same property the Notion pair relies on.
 */
export const GOOGLE_ACCOUNT_PROVIDER: Record<GoogleAccount, CredentialProvider> =
	{
		personal: "google_personal",
		work: "google_work",
	};

// `as const` (a tuple, not a readonly array) so z.enum can consume it directly in
// tools/googleAccountInput.ts — that keeps the tool-facing enum and this list from
// drifting apart when a third account is added.
export const GOOGLE_ACCOUNTS = [
	"personal",
	"work",
] as const satisfies readonly GoogleAccount[];

/**
 * Narrow an untrusted string (a tool argument) to a GoogleAccount.
 *
 * Throws rather than falling back to the default: silently running a Work call
 * against the personal account is the Google-shaped version of the #424 defect,
 * and it fails as an opaque 404 from the API rather than as a naming error here.
 */
export function parseGoogleAccount(value: string | undefined): GoogleAccount {
	if (value === undefined) return DEFAULT_GOOGLE_ACCOUNT;
	if ((GOOGLE_ACCOUNTS as readonly string[]).includes(value)) {
		return value as GoogleAccount;
	}
	throw new Error(
		`Unknown Google account '${value}'. Known accounts: ${GOOGLE_ACCOUNTS.join(", ")}.`,
	);
}
