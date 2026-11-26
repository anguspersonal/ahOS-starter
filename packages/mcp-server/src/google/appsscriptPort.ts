import type { AppsScriptPort } from "@ahkms/core";
import { createGoogleAppsScriptAdapter } from "@ahkms/core/adapters";
import { googleAuthConfig } from "./googleAuth.js";

/** Shared AppsScriptPort composition for appsscript_* tools (ADR-101 §1, ADR-045, #1633). */
export const appsscriptPort: AppsScriptPort = createGoogleAppsScriptAdapter(googleAuthConfig);
