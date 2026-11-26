import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";

let client: Anthropic | null = null;

export function getAnthropic(): Anthropic {
	if (!env.anthropicApiKey) {
		throw new Error(
			"ANTHROPIC_API_KEY is not set — required for artifact_extract_text. See packages/mcp-server/.env.example",
		);
	}
	if (!client) {
		client = new Anthropic({ apiKey: env.anthropicApiKey });
	}
	return client;
}
