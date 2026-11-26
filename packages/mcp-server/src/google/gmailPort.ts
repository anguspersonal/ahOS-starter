import type { GmailPort } from "@ahkms/core";
import { createGoogleGmailAdapter, type GoogleGmailAdapterConfig } from "@ahkms/core/adapters";
import { googleAuthConfig } from "./googleAuth.js";

/** Shared GmailPort composition for gmail_* tools (ADR-101 §1, ADR-045, #1497). */
export const gmailPort: GmailPort = createGoogleGmailAdapter(googleAuthConfig);
export const buildGmailPort = (overrides: Partial<GoogleGmailAdapterConfig> = {}): GmailPort =>
	createGoogleGmailAdapter({ ...googleAuthConfig, ...overrides });
