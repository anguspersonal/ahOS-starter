/**
 * `instructions_get` core action (#1025 / #1601).
 */

import { z } from "zod";
import { defineAction } from "../defineAction.js";
import { DEFAULT_DOS_CONFIG } from "../../domain/dosConfig.js";
import {
	buildCanonicalInstructions,
	checkInstructionsFreshness,
	getCanonicalInstructionsHash,
	getDefaultToolCatalog,
	resolveInstructionsDosConfig,
	resolvePastedInstructionsFromPorts,
	SYSTEM_INSTRUCTIONS_CAPABILITY_NAME,
	SYSTEM_INSTRUCTIONS_SYNC_KEY,
	type InstructionsActionPorts,
	type InstructionsFreshness,
	type PastedInstructionsRecord,
} from "./canonicalInstructions.js";

export const getInstructionsInput = {};
export const instructionsGetInput = getInstructionsInput;

export const getInstructionsSchema = z.object(getInstructionsInput);
export const instructionsGetSchema = getInstructionsSchema;

export type InstructionsGetInput = z.infer<typeof instructionsGetSchema>;

export interface InstructionsGetOutput {
	text: string;
	canonicalHash: string;
	pasted: PastedInstructionsRecord | null;
	freshness: InstructionsFreshness;
}

export function formatInstructionsGetMcp(output: InstructionsGetOutput): string {
	const header = [
		`# Canonical System Instructions (${SYSTEM_INSTRUCTIONS_CAPABILITY_NAME}, #1025)`,
		`Sync key: ${SYSTEM_INSTRUCTIONS_SYNC_KEY}`,
		`Canonical sha256: ${output.canonicalHash}`,
		`Pasted sha256: ${output.pasted?.sha256 ?? "(never pasted)"}`,
		`Pasted at: ${output.pasted?.pasted_at ?? "(never)"}`,
		`Status: ${output.freshness.status.toUpperCase()} - ${output.freshness.detail}`,
		...(output.freshness.fix ? [`Fix: ${output.freshness.fix}`] : []),
		"",
		"--- COPY BELOW THIS LINE INTO SYSTEM INSTRUCTIONS ---",
		"",
	];

	return header.join("\n") + output.text;
}

export function createInstructionsGetAction(ports: InstructionsActionPorts = {}) {
	return defineAction({
		id: "instructions_get",
		domain: "ops",
		description:
			"Fetch the canonical system instructions block (system-instructions) and its staleness / drift status. Copy the returned text into your client system instructions, then run instructions_mark_pasted.",
		annotations: {
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		},
		schema: instructionsGetSchema,
		formatMcp: formatInstructionsGetMcp,
		run: async (): Promise<InstructionsGetOutput> => {
			const tools = ports.toolCatalog ? ports.toolCatalog() : getDefaultToolCatalog();
			const [dosConfig, pastedFromDb] = await Promise.all([
				resolveInstructionsDosConfig(ports).catch(() => DEFAULT_DOS_CONFIG),
				resolvePastedInstructionsFromPorts(ports).catch(() => null),
			]);
			const text = buildCanonicalInstructions(tools, [], dosConfig);
			const canonicalHash = getCanonicalInstructionsHash(tools, [], dosConfig, ports.bodyHash);
			const pasted =
				pastedFromDb ??
				dosConfig.system_instructions_sync ??
				dosConfig.pasted_instructions ??
				null;
			const freshness = checkInstructionsFreshness(
				pasted?.sha256,
				pasted?.pasted_at,
				new Date(),
				canonicalHash,
			);

			return {
				text,
				canonicalHash,
				pasted,
				freshness,
			};
		},
	});
}
