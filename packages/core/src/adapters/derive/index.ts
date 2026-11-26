/**
 * @ahkms/core/adapters/derive - composition helper wiring the derive ports.
 */

import type { EntityDerivePorts } from "../../actions/domain/derivePorts.js";
import { createDeriveLlmPort, type DeriveLlmClients, type DeriveLlmConfig } from "./llmDerivePort.js";
import { createSupabaseDerivePorts, type DeriveSupabaseClient } from "./supabaseDerivePorts.js";

export * from "./llmDerivePort.js";
export * from "./supabaseDerivePorts.js";

/**
 * Assembles the full port set from a Supabase client and explicit LLM config.
 * Throws at wiring time if no provider key is configured.
 */
export function createDerivePorts(
	client: DeriveSupabaseClient,
	llm: DeriveLlmConfig,
	llmClients?: DeriveLlmClients,
): EntityDerivePorts {
	return {
		...createSupabaseDerivePorts(client),
		generate: createDeriveLlmPort(llm, llmClients),
	};
}
