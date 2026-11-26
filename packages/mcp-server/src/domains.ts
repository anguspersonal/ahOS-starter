import type { CredentialProvider } from "./credentials.js";
import {
	DOMAINS,
	type Domain,
	DOMAIN_DESCRIPTION,
	DOMAIN_LEGACY_SCOPE,
	DOMAIN_PROVIDER as CORE_DOMAIN_PROVIDER,
	ENTITY_DOMAINS,
	type EntityDomain,
	ENTITY_DOMAIN_DESCRIPTION,
	LEGACY_DOMAIN_VALUE,
	parseDomain,
	reconcileDomain,
} from "@ahkms/core";

export {
	DOMAINS,
	type Domain,
	DOMAIN_DESCRIPTION,
	DOMAIN_LEGACY_SCOPE,
	ENTITY_DOMAINS,
	type EntityDomain,
	ENTITY_DOMAIN_DESCRIPTION,
	LEGACY_DOMAIN_VALUE,
	parseDomain,
	reconcileDomain,
};

export const DOMAIN_PROVIDER: Record<Domain, CredentialProvider> = CORE_DOMAIN_PROVIDER;
