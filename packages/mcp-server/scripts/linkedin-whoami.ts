/**
 * Read-only helper: resolve the authenticated member's LinkedIn author URN
 * (urn:li:person:<sub>) via GET https://api.linkedin.com/v2/userinfo (#1631 / #1632).
 *
 * Run from packages/mcp-server:  npm run linkedin-whoami
 */
import { createLinkedinAdapter } from "@ahkms/core/adapters";
import { getCredential } from "../src/credentials.js";

const adapter = createLinkedinAdapter(async () => getCredential("linkedin"));
const author = await adapter.resolveAuthor();
process.stdout.write(`${JSON.stringify({ author }, null, 2)}\n`);
