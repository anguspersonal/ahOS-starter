import {
	getPostHogConnectionFromRepo,
	listPostHogConnectionsFromRepo,
	POSTHOG_FAMILY,
	type PostHogConnection,
} from "@ahkms/core";
import { configRepository } from "../integrations.js";

// Loading half of the connection registry. Kept apart from contract.ts so the rules stay
// runnable without a database (setup scripts, tests), and so the only thing that touches
// Supabase is the thing that has to.

export { POSTHOG_FAMILY };

/** Every configured PostHog connection, in provider order. */
export async function listPostHogConnections(): Promise<PostHogConnection[]> {
	return listPostHogConnectionsFromRepo(configRepository);
}

/**
 * One connection by slug.
 *
 * Throws rather than returning null, and names the connections that DO exist. A typo'd
 * slug is the likeliest failure here (`posthog:work` vs `posthog:work-prod`), and
 * "not configured" without a list sends you to check the wrong thing.
 */
export async function getPostHogConnection(slug: string): Promise<PostHogConnection> {
	return getPostHogConnectionFromRepo(configRepository, slug);
}
