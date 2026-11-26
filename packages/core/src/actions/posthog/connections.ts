import { z } from "zod";
import type { PostHogPort } from "../../ports/posthog.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";

export const posthogConnectionsInput = {} as const;

export const posthogConnectionsSchema = z.object(posthogConnectionsInput);

export type PosthogConnectionsInput = z.infer<typeof posthogConnectionsSchema>;

export function createPosthogConnectionsAction(
	port: PostHogPort,
): ActionDefinition<typeof posthogConnectionsSchema, string> {
	return defineAction({
		id: "posthog_connections",
		domain: "integrations",
		description:
			"List the configured PostHog connections with their project id, region and test-account filter policy. Each connection is a separate PostHog project with its own contract, so their numbers are NOT comparable and must never be summed. A connection whose filter policy is UNDECLARED refuses reads until a policy is set.",
		schema: posthogConnectionsSchema,
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true,
		},
		formatMcp: (out) => out,
		run: async () => {
			if (!port.listConnections) {
				throw new Error("PostHogPort.listConnections is not implemented by the configured adapter.");
			}
			const conns = await port.listConnections();
			if (conns.length === 0) {
				return "No PostHog connections configured. A connection is one user_integrations row with provider 'posthog:<slug>' and a config carrying host and project_id (ADR-060).";
			}

			const lines = conns.map((c) => {
				// Undeclared is spelled out, and flagged, rather than shown as a blank cell.
				// A blank reads as "nothing to worry about", which is the exact inference that
				// makes an unlabelled number dangerous.
				const policy =
					c.filterPolicy ?? "UNDECLARED (reads are refused until this is set)";
				const scoping = c.platformScoping
					? `\n      scoping: ${Object.entries(c.platformScoping)
							.map(([k, v]) => `${k}=${v}`)
							.join("  ")}`
					: "";
				return `  • ${c.ref}\n      project: ${c.projectId}   region: ${c.host}\n      filter policy: ${policy}${scoping}`;
			});

			return `${conns.length} PostHog connection(s):\n\n${lines.join("\n\n")}\n\nNumbers from different connections are NOT comparable and must never be summed — each carries its own filter contract.`;
		},
	});
}
