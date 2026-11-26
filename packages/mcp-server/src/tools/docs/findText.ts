import { toMcpTool } from "../../actions/adapters/mcp.js";
import { serverRegistry } from "../../actions/serverRegistry.js";

export const docsFindTextHandler = (args: Record<string, unknown>) =>
	toMcpTool(serverRegistry().get("docs_find_text")!).handler(args);
