import { z } from "zod";
import { DOMAINS, DOMAIN_DESCRIPTION } from "./domains.js";

/** `domain`, required. For writers, senders, and any destination that cannot be undone. */
export const domainInput = z
	.enum(DOMAINS)
	.describe(`${DOMAIN_DESCRIPTION} Required, with no default.`);

/**
 * `domain`, optional — for tools that already had a working default before the
 * axis existed, so that adding it changes nothing for a caller who ignores it.
 *
 * Deliberately NOT `.default()`: the tool's own existing default stays where it
 * is, and `undefined` here means "caller said nothing", which is the only way
 * `calendar_list_events`' "omit to read both" survives this change.
 */
export const optionalDomainInput = z
	.enum(DOMAINS)
	.optional()
	.describe(DOMAIN_DESCRIPTION);
