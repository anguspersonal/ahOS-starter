import { createSheetsReadAction } from "@ahkms/core/actions";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { sheetsPort } from "../google/sheetsPort.js";

export const sheetsReadAction = createSheetsReadAction(sheetsPort);
export const sheetsReadTool = toMcpTool(sheetsReadAction);
export const sheetsReadHandler = sheetsReadTool.handler;
export const sheetsReadInput = (sheetsReadAction.schema as any).shape;
export type SheetsReadCall = any;
