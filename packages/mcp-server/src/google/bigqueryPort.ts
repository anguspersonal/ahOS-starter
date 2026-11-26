import { bigqueryConfigSchema, type BigQueryPort } from "@ahkms/core";
import { createGoogleBigQueryAdapter } from "@ahkms/core/adapters";
import { loadIntegrationConfig } from "../integrations.js";
import { googleAuthConfig } from "./googleAuth.js";

/** Shared BigQueryPort composition for bigquery_query (ADR-101 §1, ADR-045, #1650). */
export const bigqueryPort: BigQueryPort = createGoogleBigQueryAdapter({
	get clientId() {
		return googleAuthConfig.clientId;
	},
	get clientSecret() {
		return googleAuthConfig.clientSecret;
	},
	refreshToken: googleAuthConfig.refreshToken,
	loadConfig: () => loadIntegrationConfig("bigquery", bigqueryConfigSchema),
});
