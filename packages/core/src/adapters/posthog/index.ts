import type { ConfigRepository } from "../../ports/config.js";
import {
	getPostHogConnectionFromRepo,
	listPostHogConnectionsFromRepo,
	POSTHOG_REGIONS,
	resolveHost,
	type PostHogConnection,
	type PostHogConnectionRef,
	type PostHogCredentialResolver,
	type PostHogIdentity,
	type PostHogPort,
	type PostHogProject,
	type PostHogProjectDetail,
	type PostHogQueryResult,
	type PostHogRegion,
	type PostHogTarget,
	type PostHogWriteResult,
} from "../../ports/posthog.js";

export {
	POSTHOG_REGIONS,
	resolveHost,
	type PostHogConnectionRef,
	type PostHogCredentialResolver,
	type PostHogIdentity,
	type PostHogPort,
	type PostHogProject,
	type PostHogProjectDetail,
	type PostHogQueryResult,
	type PostHogRegion,
	type PostHogTarget,
	type PostHogWriteResult,
};

export interface PostHogAdapterConfig {
	getCredential: PostHogCredentialResolver;
	fetchFn?: typeof fetch;
	config?: Pick<ConfigRepository, "loadIntegration" | "listByFamily">;
}

export interface PostHogAdapterOptions {
	fetchFn?: typeof fetch;
	config?: Pick<ConfigRepository, "loadIntegration" | "listByFamily">;
}

function normalizeConfig(
	configOrGetCredential: PostHogAdapterConfig | PostHogCredentialResolver,
	options?: PostHogAdapterOptions,
): PostHogAdapterConfig {
	if (typeof configOrGetCredential === "function") {
		return {
			getCredential: configOrGetCredential,
			fetchFn: options?.fetchFn,
			config: options?.config,
		};
	}
	return configOrGetCredential;
}

/**
 * Fetch-based PostHog REST adapter satisfying `PostHogPort` (ADR-060, ADR-101 §1, #1628).
 *
 * The READ path is read-only by construction: `call` resolves the connection's read
 * credential (`{ write: false }`), while `writeCall` uses `{ write: true }`.
 */
export function createPostHogAdapter(
	configOrGetCredential: PostHogAdapterConfig | PostHogCredentialResolver,
	options?: PostHogAdapterOptions,
): PostHogPort {
	const config = normalizeConfig(configOrGetCredential, options);

	async function call<T>(
		target: PostHogTarget,
		path: string,
		init: { method?: string; body?: unknown; write?: boolean } = {},
	): Promise<T> {
		const key = await config.getCredential(target.ref, { write: init.write === true });
		const origin = resolveHost(target.host);
		const fetchImpl = config.fetchFn ?? globalThis.fetch;
		const res = await fetchImpl(`${origin}${path}`, {
			method: init.method ?? "GET",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
		});

		if (!res.ok) {
			const rawDetail = (await res.text().catch(() => "")).slice(0, 600);
			const detail = key ? rawDetail.replaceAll(key, "[REDACTED]") : rawDetail;
			throw new Error(
				`PostHog ${init.method ?? "GET"} ${path} failed for '${target.ref}' at ${origin}: ${res.status} ${res.statusText}${
					detail ? `\n  ${detail}` : ""
				}`,
			);
		}
		return (await res.json()) as T;
	}

	return {
		async getIdentity(target: PostHogTarget): Promise<PostHogIdentity> {
			const me = await call<{
				email?: string;
				organization?: { id?: string; name?: string } | null;
			}>(target, "/api/users/@me/");
			return {
				email: me.email ?? "(unknown)",
				organizationName: me.organization?.name ?? null,
				organizationId: me.organization?.id ?? null,
			};
		},

		async listProjects(target: PostHogTarget): Promise<PostHogProject[]> {
			const res = await call<{ results?: { id: number; name?: string }[] }>(
				target,
				"/api/organizations/@current/projects/",
			);
			return (res.results ?? []).map((p) => ({
				id: p.id,
				name: p.name ?? `(project ${p.id})`,
			}));
		},

		async getProject(target: PostHogTarget, projectId: number): Promise<PostHogProjectDetail> {
			const p = await call<{
				id: number;
				name?: string;
				test_account_filters?: unknown[] | null;
				test_account_filters_default_checked?: boolean | null;
			}>(target, `/api/projects/${projectId}/`);
			return {
				id: p.id,
				name: p.name ?? `(project ${p.id})`,
				testAccountFilters: p.test_account_filters ?? [],
				testAccountFiltersDefaultChecked: p.test_account_filters_default_checked ?? null,
			};
		},

		async runQuery(
			target: PostHogTarget,
			projectId: number,
			query: Record<string, unknown>,
		): Promise<PostHogQueryResult> {
			return call<PostHogQueryResult>(target, `/api/projects/${projectId}/query/`, {
				method: "POST",
				body: { query },
			});
		},

		async writeCall(
			target: PostHogTarget,
			path: string,
			method: string,
			body: unknown,
		): Promise<PostHogWriteResult> {
			const result = await call<unknown>(target, path, { method, body, write: true });
			return { status: "ok", method, path, body: result };
		},

		async getRaw(target: PostHogTarget, path: string): Promise<unknown> {
			return call<unknown>(target, path);
		},

		async listConnections(): Promise<PostHogConnection[]> {
			if (!config.config) {
				throw new Error("PostHog adapter was constructed without a ConfigRepository.");
			}
			return listPostHogConnectionsFromRepo(config.config);
		},

		async getConnection(slug: string): Promise<PostHogConnection> {
			if (!config.config) {
				throw new Error("PostHog adapter was constructed without a ConfigRepository.");
			}
			return getPostHogConnectionFromRepo(config.config, slug);
		},
	};
}
