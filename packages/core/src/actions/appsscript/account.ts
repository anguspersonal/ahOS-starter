import { z } from "zod";
import {
	DOMAIN_LEGACY_SCOPE,
	LEGACY_DOMAIN_VALUE,
	reconcileDomain,
	type Domain,
} from "../../domain/domains.js";

export type GoogleAccount = "personal" | "work";

export const DEFAULT_GOOGLE_ACCOUNT: GoogleAccount = "personal";

export const GOOGLE_ACCOUNTS = [
	"personal",
	"work",
] as const satisfies readonly GoogleAccount[];

export const googleAccountInput = z
	.enum(GOOGLE_ACCOUNTS)
	.optional()
	.describe(
		`Deprecated, use \`domain\` ('work' | 'angus'; 'angus' is this parameter's '${DEFAULT_GOOGLE_ACCOUNT}'). Which Google account to act as: ${GOOGLE_ACCOUNTS.join(" | ")}.`,
	);

export function resolveGoogleAccount(args: {
	account?: string;
	domain?: string;
}): GoogleAccount | undefined {
	const domain = reconcileDomain(args.domain, args.account, "account");
	return domain === undefined ? undefined : (DOMAIN_LEGACY_SCOPE[domain] as GoogleAccount);
}

export function resolveAppsScriptAccount(args: {
	account?: string;
	domain?: string;
}): { account: GoogleAccount; domain: Domain } {
	const account = resolveGoogleAccount(args) ?? DEFAULT_GOOGLE_ACCOUNT;
	const domain = LEGACY_DOMAIN_VALUE[account];
	return { account, domain };
}
