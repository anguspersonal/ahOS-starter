import {
	POSTHOG_FAMILY,
	type PostHogConnection,
	type ResultStamp,
} from "../../domain/posthog/contract.js";
import type { PostHogPort, PostHogQueryResult } from "../../ports/posthog.js";

/** Stamp first, then payload. Same order in every tool. */
export function withStamp(stamp: ResultStamp, body: string): string {
	const headerLines = [
		`connection:    ${stamp.connection}`,
		`project:       ${stamp.project_id}`,
		`region:        ${stamp.region}`,
		`filter policy: ${stamp.filter_policy}`,
		`pulled at:     ${stamp.pulled_at}`,
	];
	return `${headerLines.join("\n")}\n\n${body}`;
}

/** Flip `filterTestAccounts` on an otherwise-identical query. Same SQL string either way. */
export function withTestAccountsFlag(
	query: Record<string, unknown>,
	filterTestAccounts: boolean,
): Record<string, unknown> {
	const kind = typeof query.kind === "string" ? query.kind : "(no kind)";
	if (kind === "HogQLQuery") {
		const filters = (query.filters as Record<string, unknown> | undefined) ?? {};
		return { ...query, filters: { ...filters, filterTestAccounts } };
	}
	return { ...query, filterTestAccounts };
}

export function renderRows(result: PostHogQueryResult): string {
	const columns = result.columns ?? [];
	const rows = result.results ?? [];
	return rows.length
		? [
				columns.length ? columns.join(" | ") : "(no column names returned)",
				...rows.slice(0, 100).map((r) => r.map((c) => JSON.stringify(c)).join(" | ")),
				rows.length > 100 ? `... ${rows.length - 100} more row(s) not shown` : "",
			]
				.filter(Boolean)
				.join("\n")
		: "(no rows)";
}

export async function resolvePostHogConnection(
	port: PostHogPort,
	slug: string,
): Promise<PostHogConnection> {
	if (port.getConnection) {
		return port.getConnection(slug);
	}
	if (!port.listConnections) {
		throw new Error("PostHogPort.getConnection is not implemented by the configured adapter.");
	}
	const all = await port.listConnections();
	const found = all.find((c) => c.slug === slug);
	if (found) return found;
	const known = all.map((c) => c.slug);
	throw new Error(
		`No usable PostHog connection '${slug}'. ${
			known.length
				? `Configured connections: ${known.join(", ")}.`
				: "No PostHog connections are configured yet."
		} A connection is one user_integrations row with provider '${POSTHOG_FAMILY}:${slug}' and a config carrying host and project_id (ADR-060).`,
	);
}
