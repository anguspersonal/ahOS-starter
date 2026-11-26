/**
 * `instructions_mark_pasted` core action (#1025 / #1601).
 */

import { z } from "zod";
import { defineAction } from "../defineAction.js";
import { DEFAULT_DOS_CONFIG } from "../../domain/dosConfig.js";
import {
	getCanonicalInstructionsHash,
	resolveInstructionsDosConfig,
	SYSTEM_INSTRUCTIONS_CAPABILITY_NAME,
	SYSTEM_INSTRUCTIONS_SYNC_KEY,
	type InstructionsActionPorts,
} from "./canonicalInstructions.js";

export const markInstructionsPastedInput = {
	sha256: z
		.string()
		.optional()
		.describe(
			`The sha256 hash of the ${SYSTEM_INSTRUCTIONS_CAPABILITY_NAME} block pasted into your client system instructions. Defaults to current canonical hash.`,
		),
	pasted_at: z
		.string()
		.optional()
		.describe("ISO timestamp when the instructions were pasted. Defaults to now."),
};

export const instructionsMarkPastedInput = markInstructionsPastedInput;

export const markInstructionsPastedSchema = z.object(markInstructionsPastedInput);
export const instructionsMarkPastedSchema = markInstructionsPastedSchema;

export type InstructionsMarkPastedInput = z.infer<typeof instructionsMarkPastedSchema>;

export interface InstructionsMarkPastedOutput {
	sha256: string;
	pasted_at: string;
	canonical_sha256: string;
	isMatch: boolean;
}

export function formatInstructionsMarkPastedMcp(output: InstructionsMarkPastedOutput): string {
	const lines = [
		`Pasted system instructions (${SYSTEM_INSTRUCTIONS_CAPABILITY_NAME}) marked in user_preferences (${SYSTEM_INSTRUCTIONS_SYNC_KEY}):`,
		`  sha256: ${output.sha256}`,
		`  pasted_at: ${output.pasted_at}`,
		`  canonical_sha256: ${output.canonical_sha256}`,
		`  status: ${output.isMatch ? "in sync with canonical instructions" : "DRIFT WARNING: differs from current canonical instructions"}`,
	];

	return lines.join("\n");
}

export function createInstructionsMarkPastedAction(ports: InstructionsActionPorts = {}) {
	return defineAction({
		id: "instructions_mark_pasted",
		domain: "ops",
		description:
			"Record that the canonical system instructions block (system-instructions) was pasted into a non-MCP client surface. Saves the pasted sha256 and timestamp in user_preferences under system_instructions_sync. Defaults to the current canonical hash and now.",
		annotations: {
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		schema: instructionsMarkPastedSchema,
		formatMcp: formatInstructionsMarkPastedMcp,
		run: async (args: InstructionsMarkPastedInput): Promise<InstructionsMarkPastedOutput> => {
			const tools = ports.toolCatalog ? ports.toolCatalog() : undefined;
			const dosConfig = await resolveInstructionsDosConfig(ports).catch(() => DEFAULT_DOS_CONFIG);
			const canonicalHash = getCanonicalInstructionsHash(tools, [], dosConfig, ports.bodyHash);
			const sha256 = args.sha256 ?? canonicalHash;
			const pasted_at = args.pasted_at ?? new Date().toISOString();

			if (ports.savePastedInstructions) {
				await ports.savePastedInstructions(sha256, pasted_at);
			} else if (ports.config?.savePastedInstructions) {
				await ports.config.savePastedInstructions(sha256, pasted_at);
			} else {
				throw new Error("Config repository savePastedInstructions is not wired");
			}

			const isMatch = sha256 === canonicalHash;
			return {
				sha256,
				pasted_at,
				canonical_sha256: canonicalHash,
				isMatch,
			};
		},
	});
}
