import type { OpenApiDoc, SchemaIntrospectionPort } from "../../ports/schema.js";

/**
 * Fetch the schema description PostgREST publishes at the REST root.
 *
 * This endpoint is service-role only — an anon/publishable key gets
 * `401 {"message":"Invalid API key","hint":"Only the service_role API key can be used
 * for this endpoint."}`. The mcp-server already holds the service-role key (ADR-012,
 * single-owner Phase 0), which is exactly why schema introspection belongs here and not
 * in a browser-side caller.
 *
 * No DDL, no migration, no RPC function: the description is derived from the live
 * database by PostgREST itself, so it cannot drift from the database the way
 * `supabase/migrations/*.sql` has (#480).
 */
export const POSTGREST_FETCH_TIMEOUT_MS = 10_000;

export interface SupabaseSchemaIntrospectionAdapterOptions {
	supabaseUrl: string | (() => string);
	serviceRoleKey: string | (() => string);
}

function resolveValue(value: string | (() => string)): string {
	return typeof value === "function" ? value() : value;
}

export function createSupabaseSchemaIntrospectionAdapter(
	options: SupabaseSchemaIntrospectionAdapterOptions,
): SchemaIntrospectionPort {
	return {
		async fetchOpenApi(): Promise<OpenApiDoc> {
			const url = resolveValue(options.supabaseUrl);
			const key = resolveValue(options.serviceRoleKey);
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), POSTGREST_FETCH_TIMEOUT_MS);

			// The timer is cleared once the body has been consumed, not when `fetch` resolves.
			// `fetch` resolves on the response head, so clearing it there would leave the
			// `res.json()` below unbounded: a server that sends headers and then stalls the
			// body hangs the tool forever while the timeout still looks correct. Aborting
			// mid-body rejects the read, which the same handler below catches.
			try {
				const res = await fetch(`${url.replace(/\/+$/, "")}/rest/v1/`, {
					headers: { apikey: key, Authorization: `Bearer ${key}` },
					signal: controller.signal,
				});

				if (!res.ok) {
					const body = await res.text().catch(() => "");
					throw new Error(
						`store_schema: PostgREST returned ${res.status} ${res.statusText}${body ? `: ${body}` : ""}. This endpoint accepts the service_role key only, so check SUPABASE_SERVICE_ROLE_KEY.`,
					);
				}

				return (await res.json()) as OpenApiDoc;
			} catch (err) {
				if (err instanceof Error && err.name === "AbortError") {
					throw new Error(
						`store_schema: PostgREST did not respond within ${POSTGREST_FETCH_TIMEOUT_MS}ms, so the request was abandoned. Check SUPABASE_URL and network connectivity.`,
					);
				}
				throw err;
			} finally {
				clearTimeout(timer);
			}
		},
	};
}
