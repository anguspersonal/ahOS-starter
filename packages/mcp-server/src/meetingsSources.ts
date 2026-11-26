import type { NotionConfig } from "./integrations.js";

/**
 * The three jobs the meetings pointers do, kept apart (#617, ADR-053 §6).
 *
 * - `read`        — every meetings data source dos-hl may query for its own reasoning.
 * - `project`     — the sources the State Doc's Recent Communications section may be
 *                   projected FROM. An allow-list, derived from the public key alone.
 * - `captureWrite`— the single destination captured meetings are written to. A meeting
 *                   can be read from two databases; it cannot be written to two, which
 *                   is why the private source is a second named key and not another
 *                   element of a list.
 */
export type MeetingsSources = {
	read: string[];
	project: string[];
	captureWrite: string | undefined;
};

type MeetingsPointers = Pick<
	NotionConfig,
	"meetings_source_data_source_id" | "private_meetings_source_data_source_id"
>;

/**
 * Split the configured meetings pointers into read / project / write roles.
 *
 * `project` is built from `meetings_source_data_source_id` ONLY. Adding a source to
 * `read` can never widen it — that asymmetry is the containment, and it is the reason
 * this lives in one function rather than being re-derived at each call site.
 *
 * Notion exposes no API for page-level sharing: a page's ACL can be neither set nor
 * even read programmatically, so no write to the State Doc can be preceded by a check
 * of who can see it. Read-but-never-project is the rule that survives not knowing the
 * answer. Note the rule binds the *ritual* (see `.claude/skills/dos/SKILL.md`); it
 * is a rule in a skill body, not an enforced permission, and nothing in Notion or this
 * server will block a write that breaks it.
 *
 * When only the private source is configured, `project` is empty rather than falling
 * back to it: no source is a better answer than the wrong source.
 */
export function meetingsSources(config: MeetingsPointers): MeetingsSources {
	const publicSource = config.meetings_source_data_source_id;
	const privateSource = config.private_meetings_source_data_source_id;

	return {
		read: [publicSource, privateSource].filter(
			(id): id is string => typeof id === "string" && id.length > 0,
		),
		project: publicSource ? [publicSource] : [],
		captureWrite: publicSource,
	};
}
