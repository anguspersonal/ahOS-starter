import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { supabase } from "../supabase.js";

const TABLE = "mcp_oauth_clients";

/**
 * Dynamic Client Registration store backed by Supabase (migration 053).
 *
 * MCP clients (claude.ai web/mobile, Cursor, …) register themselves at runtime via
 * RFC 7591 DCR; the SDK's register handler mints the `client_id`/`client_secret` and
 * hands us the full record to persist. Persisting in Supabase rather than in-memory is
 * what lets a registered client survive a Railway restart/redeploy without the user
 * having to re-pair — in-memory would silently break refresh after every deploy.
 *
 * Only non-secret OAuth client metadata lives here (the same "non-secret IDs in the DB"
 * rule as user_integrations). It carries no Supabase or provider credentials.
 */
export class SupabaseClientStore implements OAuthRegisteredClientsStore {
	async getClient(
		clientId: string,
	): Promise<OAuthClientInformationFull | undefined> {
		const { data, error } = await supabase
			.from(TABLE)
			.select("client")
			.eq("client_id", clientId)
			.maybeSingle();
		if (error) {
			throw new Error(`Failed to load OAuth client ${clientId}: ${error.message}`);
		}
		if (!data) return undefined;
		return data.client as OAuthClientInformationFull;
	}

	async registerClient(
		client: OAuthClientInformationFull,
	): Promise<OAuthClientInformationFull> {
		const { error } = await supabase.from(TABLE).upsert(
			{
				client_id: client.client_id,
				client,
				updated_at: new Date().toISOString(),
			},
			{ onConflict: "client_id" },
		);
		if (error) {
			throw new Error(
				`Failed to register OAuth client ${client.client_id}: ${error.message}`,
			);
		}
		return client;
	}
}
