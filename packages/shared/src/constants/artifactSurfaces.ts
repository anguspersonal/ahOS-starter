// ---------------------------------------------------------------------------
// Artifact surface vocabulary — the values THIS REPO'S WRITERS STAMP
// (ADR-026 "surface", ADR-046 §2/§3; issues #570, #584)
//
// `artifacts.surface` names the app / agent / ingest path a row arrived
// through. Both read-time derivations key on it: ADR-026's trust derivation
// (`resolveTrust`) and ADR-046 §3's synthesis role ladder
// (`resolveSynthesisRole`), which stores ONE role PER SURFACE.
//
// WHY A NULL SURFACE IS THE BUG (#584): it is not "classified wrongly", it is
// UNADDRESSABLE. Both resolvers fall back to `source_channel` and then to a
// bare default, so a null-surface row still *resolves* — it just resolves to
// whatever the default happens to be, and no `surface_role_map` /
// `surface_trust_map` entry can ever reach it, because there is no key to
// write the entry against. The owner cannot demote a flooding path they cannot
// name. That is how a decade of Drive PDFs reached the day-window synthesis
// read (#567) and why #570 stamped the discover path.
//
// WHY THE VOCABULARY LIVES HERE AND NOT IN THE SCHEMA: the column is free
// `text` with no CHECK, deliberately — the vocabulary is OPEN, every new
// integration adds one (ADR-026). Exactly as with the synthesis markers next
// door, "no CHECK" means the values must be single-sourced in code or they
// drift. This module holds the subset that MORE THAN ONE PACKAGE has to agree
// on, or that no caller supplies and a writer must therefore invent:
// mcp-server's `vocab.ts` SURFACES stays the wider, human-facing suggestion
// list shown to `capture` callers, and a unit test pins that every value here
// appears in it.
//
// THE RULE FOR ADDING ONE: a surface is an ENVELOPE fact — where the row came
// in — never an interpretation of its content (ADR-018 keeps capture dumb,
// ADR-046 §2 makes envelope metadata the one thing a writer may stamp). If you
// cannot name the value from the call site alone, without reading the body,
// it is not a surface.
// ---------------------------------------------------------------------------

export const ARTIFACT_SURFACES = {
	/**
	 * `drive_import_file` — the explicit "bring this one Drive file into the
	 * store" tool. Distinct from the discover path's `discovered_gdrive`: that
	 * one inventories a whole account in bulk (and is seeded to the `evidence`
	 * role for exactly that reason), whereas this is the owner pointing at a
	 * single file by id. Same bytes, different intent, so they must stay
	 * separately addressable.
	 */
	driveImport: 'drive_import',

	/** Worker upload pipeline, browser client. */
	webApp: 'web_app',

	/** Worker upload pipeline, iOS / Android client. */
	mobileApp: 'mobile_app',

	/**
	 * Programmatic ingest that declared no finer surface — an MCP `capture`
	 * whose caller passed none and whose owner has configured no
	 * `default_surface`, or a worker upload whose `deviceInfo.platform` is
	 * absent or unrecognised.
	 *
	 * This is a FLOOR, not a bucket for anything unclassified: it is reached
	 * only where no finer envelope fact exists at the call site. Every writer
	 * that knows a better answer stamps the better answer. Naming the residual
	 * class is the whole point — `api` is a key the owner can put in
	 * `surface_role_map`; null is not.
	 */
	api: 'api',

	/**
	 * The provenance receipt the Act path auto-captures from the message that
	 * requested an artifact-less task or calendar event (`create_task` /
	 * `create_event`; issue #413, ADR-038 §4/§6).
	 *
	 * ONE surface for both tools, deliberately. ADR-046 §3 stores one role per
	 * surface, and the policy for both is identical — "a receipt of something I
	 * asked the system to do is not ingest". The finer task-vs-event
	 * distinction is not lost: it is already carried, and already acted on, by
	 * `content_subtype` (`task_request` / `event_request`), which is what
	 * `search_knowledge` excludes on.
	 */
	actReceipt: 'act_receipt',

	/**
	 * The worker's AI-cleaned derivative of another artifact.
	 *
	 * NOT the source artifact's surface, though inheriting one was available.
	 * ADR-046 §3 stores one role per surface, so inheriting would make derived
	 * artifacts unaddressable AS a class — the owner could never say "generated
	 * derivatives are `evidence`, never `narrative`", which is the single most
	 * likely rule to want about them. Provenance is not lost by declining to
	 * inherit: `processing_metadata.prov.derived_from` already carries the
	 * source id, and trust still degrades correctly because `source_channel` is
	 * also `'derived'`. This mirrors what the discover path does — surface is a
	 * field-copy of the channel, an envelope fact, not an interpretation.
	 */
	derived: 'derived',

	/**
	 * GitHub activity pulled in by `github_ingest`: issues and pull requests the
	 * owner authored or commented on, across every repo their token can see.
	 *
	 * Named separately from every other ingest because ADR-046 §3 already has a
	 * policy for it: GitHub sits at role `evidence`, corroborating a day and never
	 * narrating one alone. That is the whole reason `/close` writes a session
	 * summary (#565). A surface is the key that policy is written against, so
	 * without this value the rule cannot be expressed at all.
	 *
	 * It is also the flooding candidate of the two ingest surfaces added here: a
	 * week of active development is hundreds of rows. `surface_role_map` is how
	 * that gets demoted, and it needs a name to demote.
	 */
	github: 'github',

	/**
	 * Slack messages the owner sent in a channel, public or private, pulled in by
	 * `slack_ingest`.
	 */
	slack: 'slack',

	/**
	 * Slack messages the owner sent in a DIRECT MESSAGE or group DM.
	 *
	 * Split from `slack` deliberately, and this is the split most worth defending.
	 * ADR-046 §3 stores one role per surface, so pooling DMs with channel messages
	 * would make them unaddressable AS a class: the owner could never say "channel
	 * chatter is evidence, DMs never surface at all" without also demoting the
	 * channels. DMs are the most sensitive thing either ingest touches, because they
	 * carry other people's confidences and not only the owner's own words, so the
	 * one rule most likely to be wanted about them is a rule about DMs alone.
	 *
	 * Naming the class is what makes that rule expressible later WITHOUT re-ingesting
	 * (#584). The alternative, discovering afterwards that you cannot separate them,
	 * is the expensive one.
	 */
	slackDm: 'slack_dm',

	/**
	 * WhatsApp messages in a group chat pulled in by `whatsapp_ingest`.
	 */
	whatsapp: 'whatsapp',

	/**
	 * WhatsApp messages in a 1:1 direct chat or self-chat ("Message Yourself")
	 * pulled in by `whatsapp_ingest`. Split from `whatsapp` for the same ADR-046
	 * §3 reason as `slack_dm`: so 1:1 confidences and group chatter can be
	 * governed separately in `surface_role_map` without re-ingesting.
	 */
	whatsappDm: 'whatsapp_dm',

	/**
	 * Weekly KPI scorecard snapshots written by `weekly_kpi_snapshot`.
	 * Seeded to role `metrics` (ADR-046 §3) so EOD synthesis sees aggregates
	 * without narrating operational telemetry rows as personal notes, and skips
	 * LLM entity derivation (`reason: "role_metrics"`).
	 */
	kpiSnapshot: 'kpi_snapshot',
} as const;

/** A surface value written by code in this repo. */
export type ArtifactSurface = (typeof ARTIFACT_SURFACES)[keyof typeof ARTIFACT_SURFACES];
