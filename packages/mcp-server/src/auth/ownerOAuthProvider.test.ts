import { describe, it, expect, beforeEach } from "vitest";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { OwnerOAuthProvider, OWNER_SCOPE } from "./ownerOAuthProvider.js";
import type { HttpEnv } from "../env.js";

const ISSUER = "https://ahkms.example.com";
const USER_ID = "11111111-1111-1111-1111-111111111111";

const httpEnv: HttpEnv = {
	port: 8080,
	publicUrl: ISSUER,
	ownerPassword: "correct horse battery staple",
	jwtSecret: "test-secret-not-for-production-use-only",
	accessTokenTtl: 3600,
	refreshTokenTtl: 2592000,
};

// The token/code paths never touch the clients store, so a no-op stub is enough.
const noopClients: OAuthRegisteredClientsStore = {
	getClient: async () => undefined,
	registerClient: async (c) => c as OAuthClientInformationFull,
};

const client = {
	client_id: "client-abc",
	redirect_uris: ["https://client.example.com/callback"],
} as OAuthClientInformationFull;

const otherClient = {
	client_id: "client-xyz",
	redirect_uris: ["https://evil.example.com/callback"],
} as OAuthClientInformationFull;

function makeProvider() {
	return new OwnerOAuthProvider(httpEnv, noopClients, USER_ID);
}

function authorize(provider: OwnerOAuthProvider) {
	const url = provider.createAuthorizationRedirect({
		clientId: client.client_id,
		redirectUri: client.redirect_uris[0],
		codeChallenge: "challenge-123",
		scope: OWNER_SCOPE,
		state: "state-xyz",
	});
	const code = new URL(url).searchParams.get("code")!;
	return { url, code };
}

describe("OwnerOAuthProvider", () => {
	let provider: OwnerOAuthProvider;
	beforeEach(() => {
		provider = makeProvider();
	});

	it("gates on the owner password", () => {
		expect(provider.verifyOwnerPassword("correct horse battery staple")).toBe(true);
		expect(provider.verifyOwnerPassword("wrong")).toBe(false);
		expect(provider.verifyOwnerPassword("")).toBe(false);
	});

	it("builds a redirect carrying code + state", () => {
		const { url } = authorize(provider);
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe(
			"https://client.example.com/callback",
		);
		expect(parsed.searchParams.get("code")).toBeTruthy();
		expect(parsed.searchParams.get("state")).toBe("state-xyz");
	});

	it("returns the stored PKCE challenge for an issued code", async () => {
		const { code } = authorize(provider);
		expect(await provider.challengeForAuthorizationCode(client, code)).toBe(
			"challenge-123",
		);
	});

	it("exchanges a code for a usable access token, one time only", async () => {
		const { code } = authorize(provider);
		const tokens = await provider.exchangeAuthorizationCode(client, code);
		expect(tokens.token_type).toBe("Bearer");
		expect(tokens.access_token).toBeTruthy();
		expect(tokens.refresh_token).toBeTruthy();

		const info = await provider.verifyAccessToken(tokens.access_token);
		expect(info.clientId).toBe(client.client_id);
		expect(info.scopes).toContain(OWNER_SCOPE);
		expect(info.extra?.userId).toBe(USER_ID);

		// Code is single-use.
		await expect(
			provider.exchangeAuthorizationCode(client, code),
		).rejects.toThrow();
	});

	it("rejects a code redeemed by a different client", async () => {
		const { code } = authorize(provider);
		await expect(
			provider.exchangeAuthorizationCode(otherClient, code),
		).rejects.toThrow(/another client/i);
	});

	it("rejects an unknown / expired code", async () => {
		await expect(
			provider.challengeForAuthorizationCode(client, "nope"),
		).rejects.toThrow(/invalid or expired/i);
	});

	it("does not accept a refresh token as an access token", async () => {
		const { code } = authorize(provider);
		const tokens = await provider.exchangeAuthorizationCode(client, code);
		await expect(
			provider.verifyAccessToken(tokens.refresh_token!),
		).rejects.toThrow(/not an access token/i);
	});

	it("exchanges a refresh token for fresh tokens", async () => {
		const { code } = authorize(provider);
		const first = await provider.exchangeAuthorizationCode(client, code);
		const refreshed = await provider.exchangeRefreshToken(
			client,
			first.refresh_token!,
		);
		expect(refreshed.access_token).toBeTruthy();
		const info = await provider.verifyAccessToken(refreshed.access_token);
		expect(info.extra?.userId).toBe(USER_ID);
	});

	it("rejects a refresh token presented by the wrong client", async () => {
		const { code } = authorize(provider);
		const first = await provider.exchangeAuthorizationCode(client, code);
		await expect(
			provider.exchangeRefreshToken(otherClient, first.refresh_token!),
		).rejects.toThrow();
	});

	it("rejects a garbage access token", async () => {
		await expect(provider.verifyAccessToken("not.a.jwt")).rejects.toThrow();
	});
});
