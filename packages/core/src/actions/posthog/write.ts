import { z } from "zod";
import {
	assertPathInProject,
	assertWriteAllowed,
	isRetroactiveWrite,
	stampFor,
} from "../../domain/posthog/contract.js";
import type { PostHogPort } from "../../ports/posthog.js";
import { defineAction } from "../defineAction.js";
import type { ActionDefinition } from "../types.js";
import { resolvePostHogConnection, withStamp } from "./render.js";

const WRITE_METHODS = ["POST", "PATCH", "PUT", "DELETE"] as const;

export const posthogWriteInput = {
	connection: z
		.string()
		.min(1)
		.describe("Connection slug, e.g. 'work'. Must declare write_policy 'allowed'."),
	method: z
		.enum(WRITE_METHODS)
		.describe("HTTP method. DELETE additionally requires acknowledge_destructive."),
	path: z
		.string()
		.min(1)
		.describe(
			"PostHog API path, starting '/api/'. When it names a project (/api/projects/<id>/...) " +
				"that id must match the connection's project, so a stamped result always describes " +
				"the project it claims. Example: '/api/projects/110015/cohorts/225061/'.",
		),
	body: z
		.record(z.string(), z.unknown())
		.optional()
		.describe("JSON request body, passed through verbatim. Omit for DELETE."),
	acknowledge_retroactive: z
		.boolean()
		.optional()
		.describe(
			"Required for cohort and project-filter edits. Those are applied at QUERY time to " +
				"all history, so saving one restates every past number rather than only changing " +
				"what happens next. Set true only when that is understood and intended.",
		),
	acknowledge_destructive: z
		.boolean()
		.optional()
		.describe("Required for DELETE. There is no undo."),
} as const;

export const posthogWriteSchema = z.object(posthogWriteInput);

export type PosthogWriteInput = z.infer<typeof posthogWriteSchema>;

export function createPosthogWriteAction(
	port: PostHogPort,
): ActionDefinition<typeof posthogWriteSchema, string> {
	return defineAction({
		id: "posthog_write",
		domain: "integrations",
		description:
			"Make one authenticated write against a PostHog connection (POST/PATCH/PUT/DELETE on an /api/ " +
			"path). Travels on a SEPARATE write credential, so reads keep a key that cannot mutate anything. " +
			"Refuses unless the connection declares write_policy 'allowed'; cohort and project-filter edits " +
			"need acknowledging, because they restate history. Full notes: docs/guides/tools/posthog_write.md",
		schema: posthogWriteSchema,
		annotations: {
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: true,
		},
		formatMcp: (out) => out,
		run: async (args) => {
			const conn = await resolvePostHogConnection(port, args.connection);

			// Every guard runs BEFORE the network call, for the same reason the read guard does:
			// a refused write should cost nothing and must never half-happen.
			assertWriteAllowed(conn);
			assertPathInProject(conn, args.path);

			if (args.method === "DELETE" && args.acknowledge_destructive !== true) {
				throw new Error(
					`DELETE ${args.path} refused: pass acknowledge_destructive: true. PostHog deletes are not recoverable from this surface, and no other guard here distinguishes a delete from an edit.`,
				);
			}

			const retroactive = isRetroactiveWrite(args.path);
			if (retroactive && args.acknowledge_retroactive !== true) {
				throw new Error(
					`${args.method} ${args.path} refused: this endpoint changes a cohort or the project's test-account filter, which PostHog applies at query time to ALL history. Saving it restates every past number, it does not merely change what happens next. On 2026-09-09 one cohort edit moved 3 September's recorded auth failures from 11 to 1, and an over-broad arm on the same cohort had been removing the entire United States install base from every house-filtered metric. Pass acknowledge_retroactive: true if that is intended.`,
				);
			}

			// Best-effort before-image on the changes that rewrite history, so the transcript
			// records what was overwritten. Non-fatal: the read key may not carry read scope for
			// this resource, and failing to show the old value is not a reason to refuse the
			// write the caller explicitly acknowledged.
			let before = "";
			if (retroactive && args.method !== "POST") {
				try {
					const current = await port.getRaw({ ref: conn.ref, host: conn.host }, args.path);
					before = `before:\n${JSON.stringify(current, null, 2).slice(0, 4000)}\n\n`;
				} catch (err) {
					before = `before: (could not be read on the read credential: ${
						err instanceof Error ? err.message.split("\n")[0] : String(err)
					})\n\n`;
				}
			}

			const result = await port.writeCall(
				{ ref: conn.ref, host: conn.host },
				args.path,
				args.method,
				args.body,
			);

			const body = [
				`${result.method} ${result.path} — ok`,
				"",
				before,
				`after:\n${JSON.stringify(result.body, null, 2).slice(0, 4000)}`,
				retroactive
					? "\nThis edit is retroactive: every historical number computed against it has just changed. Re-pull anything you quoted from before this point."
					: "",
			]
				.filter(Boolean)
				.join("\n");

			return withStamp(stampFor(conn), body);
		},
	});
}
