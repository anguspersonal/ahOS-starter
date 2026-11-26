import { createSheetsWriteAction, type SheetsWriteInput } from "@ahkms/core/actions";
import { toMcpTool } from "../actions/adapters/mcp.js";
import { sheetsPort } from "../google/sheetsPort.js";

export const sheetsWriteAction = createSheetsWriteAction(sheetsPort);
export const sheetsWriteTool = toMcpTool(sheetsWriteAction);
export const sheetsWriteHandler = sheetsWriteTool.handler;
export const sheetsWriteInput = (sheetsWriteAction.schema as any).shape;
export type SheetsWriteCall = Partial<SheetsWriteInput>;
