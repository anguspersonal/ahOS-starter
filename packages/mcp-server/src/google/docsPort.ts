import type { DocsPort } from "@ahkms/core";
import { createGoogleDocsAdapter, type GoogleTokenSourceConfig } from "@ahkms/core/adapters";
import { googleAuthConfig } from "./googleAuth.js";

/** Shared DocsPort composition for docs_* tools (ADR-101 §1, ADR-045, #1514). */
export const docsPort: DocsPort = createGoogleDocsAdapter(googleAuthConfig);
export const buildDocsPort = (overrides: Partial<GoogleTokenSourceConfig> = {}): DocsPort =>
	createGoogleDocsAdapter({ ...googleAuthConfig, ...overrides });
