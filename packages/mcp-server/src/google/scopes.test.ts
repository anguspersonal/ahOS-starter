import { describe, expect, it } from "vitest";
import { BIGQUERY_READONLY_SCOPE, GOOGLE_MINT_SCOPES } from "./scopes.js";

describe("Google OAuth mint scopes (#1650)", () => {
	it("includes BIGQUERY_READONLY_SCOPE in GOOGLE_MINT_SCOPES", () => {
		expect(BIGQUERY_READONLY_SCOPE).toBe("https://www.googleapis.com/auth/bigquery.readonly");
		expect(GOOGLE_MINT_SCOPES).toContain(BIGQUERY_READONLY_SCOPE);
	});
});
