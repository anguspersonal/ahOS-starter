import { toMcpTool } from "../../actions/adapters/mcp.js";
import { serverRegistry } from "../../actions/serverRegistry.js";

export const docsGetHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("docs_get")!).handler(args);
