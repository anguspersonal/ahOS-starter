import { z } from "zod";
import { DEFAULT_GOOGLE_ACCOUNT, GOOGLE_ACCOUNTS, type GoogleAccount } from "../google/accounts.js";
import { DOMAIN_LEGACY_SCOPE, reconcileDomain } from "../domains.js";

// The `account` argument shared by every Google-backed tool (Drive, Gmail), so the
// caller-facing name, the credential provider and the config row all agree (issue
// #338). Declared once rather than per tool because ~20 tools take it: a divergent
// copy is how one tool ends up silently defaulting where its neighbours do not.
//
// Optional, defaulting to personal, because that is the account every Drive and
// Calendar call ran as before the account dimension existed. Omitting it must keep
// meaning exactly what it meant before.
export const googleAccountInput = z
	.enum(GOOGLE_ACCOUNTS)
	.optional()
	.describe(
		`Deprecated, use \`domain\` ('work' | 'angus'; 'angus' is this parameter's '${DEFAULT_GOOGLE_ACCOUNT}'). Which Google account to act as: ${GOOGLE_ACCOUNTS.join(" | ")}.`,
	);

/**
 * The same argument, REQUIRED, for tools that act outward as an identity.
 *
 * Reading as the wrong account returns the wrong answer. Sending as the wrong account
 * puts mail in someone's inbox from the wrong person, and cannot be taken back. On
 * 2026-09-05 a token swap made `work` resolve to the personal mailbox and every read
 * succeeded quietly for an hour (#1002); had a send tool existed and defaulted the same
 * way, that hour would have produced outbound mail from the wrong identity.
 *
 * So the compose and send tools (#1006) take no default. Making the caller name the
 * mailbox is cheap, and it means the account is a decision on every send rather than an
 * inherited one.
 */
export const requiredGoogleAccountInput = z
	.enum(GOOGLE_ACCOUNTS)
	.optional()
	.describe(
		`Deprecated, use \`domain\` ('work' | 'angus'). Which Google account to send AS: ${GOOGLE_ACCOUNTS.join(" | ")}.`,
	);

/**
 * Resolve the account a Google call runs as from either argument (#1062).
 *
 * Returns `undefined` when the caller named neither, which is what keeps this an
 * additive change: every tool's own default (or, for `calendar_list_events`,
 * "omit to read both") is untouched, and a caller who has not moved to `domain`
 * sees no difference at all.
 *
 * `domain: 'angus'` is `account: 'personal'`. The account values are NOT renamed:
 * `personal` is half of the `google_personal` credential provider key, which is a
 * `user_integrations` row and a stored secret's address, not a label.
 */
export function resolveGoogleAccount(args: {
	account?: string;
	domain?: string;
}): GoogleAccount | undefined {
	const domain = reconcileDomain(args.domain, args.account, "account");
	return domain === undefined ? undefined : (DOMAIN_LEGACY_SCOPE[domain] as GoogleAccount);
}

/**
 * The same, for the send tools, where naming no identity is itself the error.
 *
 * `requiredGoogleAccountInput` became optional at the zod layer in #1062 — it has
 * to be, or a caller who correctly passes only `domain` is rejected by the schema
 * before any of this runs. The requirement did not move, it just moved HERE, where
 * it can see both arguments at once. #1002: a token swap made `work` resolve to
 * the personal mailbox and every read succeeded quietly for an hour.
 */
export function requireGoogleAccount(args: { account?: string; domain?: string }): GoogleAccount {
	const account = resolveGoogleAccount(args);
	if (!account) {
		throw new Error(
			"`domain` is required to send — 'work' (the work.example.com Workspace account) or 'angus' (the personal one). There is no default: sending as the wrong identity cannot be taken back.",
		);
	}
	return account;
}
