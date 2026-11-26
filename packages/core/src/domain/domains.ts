/**
 * Canonical domain definitions for ahOS (ADR-051, ADR-054, ADR-107).
 * Single source of truth across all packages, connectors, and workspaces.
 */

/** Every domain the dos ritual can run for, and physical third-party tenant accounts (Notion, Google). A flat set — no hierarchy, no default. */
export const DOMAINS = ["work", "angus"] as const;

/** One dos / execution domain. */
export type Domain = (typeof DOMAINS)[number];

/**
 * The canonical description of the execution domain axis across tools and surfaces (ADR-054 §5, #1062).
 */
export const DOMAIN_DESCRIPTION =
	"Which domain to act in: 'work' (the Work company workspace and account) or 'angus' (the personal one).";

/**
 * The three-value entity domain taxonomy across the Knowledge Graph (ADR-107).
 * Decouples semantic entity sphere from physical two-workspace SaaS routing.
 * System abstraction tier is tracked orthogonally via properties.level (meta/ontology per ADR-036).
 */
export const ENTITY_DOMAINS = ["work", "angus", "cross-domain"] as const;

/** One entity domain in the Knowledge Graph. */
export type EntityDomain = (typeof ENTITY_DOMAINS)[number];

/**
 * Canonical description of the Knowledge Graph entity domain axis (ADR-107).
 */
export const ENTITY_DOMAIN_DESCRIPTION =
	"Which semantic sphere the entity belongs to: 'work' (company/startup), 'angus' (personal/private life and personal projects/IP like ahOS), or 'cross-domain' (bridges both spheres, e.g. self-person Angus, prospective day planning, unified calendar). System abstraction (meta/ontology) is governed orthogonally by properties.level per ADR-036 and ADR-107.";

/**
 * Which `user_integrations` row (and therefore which Notion token) each domain resolves
 * to. ADR-054 Section 3 planned a rename of `notion_personal` -> `notion_angus`, but that
 * rename was dropped by owner decision on #681 (recorded in ADR-054 Amendment 4):
 * `notion_personal` is retained permanently to avoid a disruptive cross-store data migration,
 * and domain `angus` maps to it here.
 *
 * `provider` is part of `artifact_external_links`'s unique key, so markers remain under
 * `notion_personal` (createExternalLink.ts:13 states the same rule).
 */
export const DOMAIN_PROVIDER = {
	work: "notion_work",
	angus: "notion_personal",
} as const satisfies Record<Domain, string>;

/**
 * Legacy value vocabularies, and the domain each maps to.
 */
export const LEGACY_DOMAIN_VALUE: Record<string, Domain> = {
	// `account` (Google) and `scope` (bindings)
	personal: "angus",
	work: "work",
	// `workspace` (task_create)
	notion_personal: "angus",
	notion_work: "work",
};

/** The `account`/`scope` spelling of a domain, for the stores that still key on it. */
export const DOMAIN_LEGACY_SCOPE: Record<Domain, string> = {
	work: "work",
	angus: "personal",
};

/** Narrow an untrusted tool argument to a Domain, naming the alternatives on a typo. */
export function parseDomain(value: string): Domain {
	if ((DOMAINS as readonly string[]).includes(value)) return value as Domain;
	const mapped = LEGACY_DOMAIN_VALUE[value];
	if (mapped) return mapped;
	throw new Error(`Unknown domain '${value}'. Known domains: ${DOMAINS.join(", ")}.`);
}

/**
 * Reconcile the new `domain` argument with a legacy one during the migration window.
 */
export function reconcileDomain(
	domain: string | undefined,
	legacy: string | undefined,
	legacyName: "account" | "workspace" | "scope",
): Domain | undefined {
	const fromNew = domain === undefined || domain === "" ? undefined : parseDomain(domain);
	const fromOld = legacy === undefined || legacy === "" ? undefined : parseDomain(legacy);
	if (fromNew && fromOld && fromNew !== fromOld) {
		throw new Error(
			`\`domain: '${domain}'\` and \`${legacyName}: '${legacy}'\` name different domains. ` +
				`${legacyName} is deprecated — pass \`domain\` alone ('${DOMAINS.join("' or '")}').`,
		);
	}
	return fromNew ?? fromOld;
}

/**
 * Surface and envelope connection facts passed to {@link connectionDomain} (ADR-108 §6).
 */
export interface ConnectionDomainInput {
	surface?: string | null;
	source_channel?: string | null;
	tags?: readonly string[] | null;
	account?: string | null;
	provider?: string | null;
	repo?: string | null;
	parent?: ConnectionDomainInput | null;
}

const WORK_SURFACES: ReadonlySet<string> = new Set([
	"slack",
	"slack_dm",
	"discovered_gdrive_work",
	"discovered_gmail_attachment_work",
	"discovered_notion_meetings_work",
	"discovered_notion_pages_work",
]);

const ANGUS_SURFACES: ReadonlySet<string> = new Set([
	"discovered_gdrive",
	"discovered_google_drive",
	"discovered_drive",
	"discovered_gmail_attachment",
	"discovered_notion_meetings_personal",
	"discovered_notion_pages_personal",
]);

function surfaceDomain(surface: string | null | undefined): Domain | null {
	if (!surface) return null;
	const trimmed = surface.trim();
	if (WORK_SURFACES.has(trimmed)) return "work";
	if (ANGUS_SURFACES.has(trimmed)) return "angus";
	return null;
}

function repoDomain(rawRepo: string | null | undefined): Domain | null {
	if (!rawRepo) return null;
	const trimmed = rawRepo.trim().replace(/^repo:/i, "").toLowerCase();
	if (trimmed === "example-org" || trimmed.startsWith("example-org/")) return "work";
	if (trimmed === "anguspersonal" || trimmed.startsWith("anguspersonal/")) return "angus";
	return null;
}

function accountOrProviderDomain(raw: string | null | undefined): Domain | null {
	if (!raw) return null;
	const lower = raw.trim().toLowerCase();
	if (
		lower === "work" ||
		lower === "notion_work" ||
		lower === "google_work" ||
		lower === "owner@work.example.com" ||
		lower.endsWith("@work.example.com")
	) {
		return "work";
	}
	if (
		lower === "personal" ||
		lower === "google_personal" ||
		lower === "notion_personal"
	) {
		return "angus";
	}
	return null;
}

function resolveConnectionDomain(
	input: ConnectionDomainInput | null | undefined,
	depth: number,
): Domain | null {
	if (!input || depth > 16) return null;

	const surface = input.surface?.trim() || null;
	const channel = input.source_channel?.trim() || null;

	if (surface === "derived" || (!surface && channel === "derived")) {
		return input.parent ? resolveConnectionDomain(input.parent, depth + 1) : null;
	}

	const fromSurface = surfaceDomain(surface) ?? surfaceDomain(channel);
	if (fromSurface) return fromSurface;

	const fromRepo = repoDomain(input.repo);
	if (fromRepo) return fromRepo;

	const fromAccount = accountOrProviderDomain(input.account);
	if (fromAccount) return fromAccount;

	const fromProvider = accountOrProviderDomain(input.provider);
	if (fromProvider) return fromProvider;

	if (input.tags) {
		for (const rawTag of input.tags) {
			if (typeof rawTag !== "string") continue;
			const tag = rawTag.trim();
			if (/^repo:/i.test(tag)) {
				const mapped = repoDomain(tag.slice(5));
				if (mapped) return mapped;
			} else if (/^account:/i.test(tag)) {
				const mapped = accountOrProviderDomain(tag.slice(8));
				if (mapped) return mapped;
			}
		}
	}

	return null;
}

/**
 * Pure rulebook resolver mapping surface and envelope connection facts to an execution
 * domain (`'work' | 'angus' | null`) with zero database queries (ADR-108 §6).
 */
export function connectionDomain(input: ConnectionDomainInput): Domain | null {
	return resolveConnectionDomain(input, 0);
}
