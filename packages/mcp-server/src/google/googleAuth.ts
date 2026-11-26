import type { Domain } from "@ahkms/core";
import type { GoogleTokenSourceConfig } from "@ahkms/core/adapters";
import { getCredential } from "../credentials.js";
import { DOMAIN_LEGACY_SCOPE } from "../domains.js";
import { env } from "../env.js";
import { GOOGLE_ACCOUNT_PROVIDER, type GoogleAccount } from "./accounts.js";

/**
 * Shared Google OAuth adapter configuration keyed by domain (ADR-101 §1, ADR-045, #1480).
 * Resolves credentials and env lazily per call; importing this module calls nothing.
 */
export const googleAuthConfig: GoogleTokenSourceConfig = {
	get clientId() {
		return env.googleClientId;
	},
	get clientSecret() {
		return env.googleClientSecret;
	},
	refreshToken: (d: Domain) =>
		getCredential(GOOGLE_ACCOUNT_PROVIDER[DOMAIN_LEGACY_SCOPE[d] as GoogleAccount]),
};
