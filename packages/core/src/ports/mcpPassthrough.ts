export interface McpPassthroughToolSummary {
	name: string;
	description?: string;
	inputSchema?: unknown;
	annotations?: unknown;
}

export interface McpPassthroughTextContent {
	type: "text";
	text: string;
}

export interface McpPassthroughCallResult {
	content: McpPassthroughTextContent[];
	isError?: boolean;
}

export interface McpPassthroughPort {
	listTools(): Promise<McpPassthroughToolSummary[]>;
	callTool(
		name: string,
		args: Record<string, unknown>,
	): Promise<McpPassthroughCallResult>;
}
