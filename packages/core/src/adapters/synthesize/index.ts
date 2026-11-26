/**
 * @ahkms/core/adapters/synthesize - composition helper wiring the synthesize ports.
 */

import type { EntitySynthesizePorts } from "../../actions/domain/synthesizePorts.js";
import {
	createDeriveLlmPort,
	type DeriveLlmClients,
	type DeriveLlmConfig,
} from "../derive/llmDerivePort.js";
import {
	createSupabaseSynthesizePorts,
	type SynthesizeSupabaseClient,
} from "./supabaseSynthesizePorts.js";

export * from "./supabaseSynthesizePorts.js";

export type DeriveLlmConfigInput =
	| DeriveLlmConfig
	| (() => DeriveLlmConfig | Promise<DeriveLlmConfig>);

/**
 * Assembles the full entity synthesis port set from a Supabase client and explicit or lazy LLM config.
 */
export function createSynthesizePorts(
	client: SynthesizeSupabaseClient,
	llm: DeriveLlmConfigInput,
	llmClients?: DeriveLlmClients,
): EntitySynthesizePorts {
	const supabasePorts = createSupabaseSynthesizePorts(client);
	if (typeof llm === "function") {
		return {
			...supabasePorts,
			async generate(request) {
				const resolved = await llm();
				const port = createDeriveLlmPort(resolved, llmClients);
				return port(request);
			},
		};
	}
	return {
		...supabasePorts,
		generate: createDeriveLlmPort(llm, llmClients),
	};
}

