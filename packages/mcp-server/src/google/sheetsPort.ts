import type { SheetsPort } from "@ahkms/core";
import { createGoogleSheetsAdapter } from "@ahkms/core/adapters";
import { googleAuthConfig } from "./googleAuth.js";

/**
 * Single composition of `SheetsPort` shared by all `sheets_*` tools so read and
 * write resolve the same refresh token per domain (ADR-101 §1, ADR-045, #1434).
 * Resolves credentials and env lazily per call; importing this module calls nothing.
 */
export const sheetsPort: SheetsPort = createGoogleSheetsAdapter(googleAuthConfig);
