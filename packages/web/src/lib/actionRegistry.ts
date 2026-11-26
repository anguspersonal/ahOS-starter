import {
  ActionRegistry as CoreActionRegistry,
  type ActionRegistryFilter,
  graphFilterInputSchema,
  jsonSchemaToGeminiDeclaration,
  viewScreenInputSchema,
  zodToGeminiDeclaration,
} from "@ahkms/core";
import actionManifest from "@ahkms/core/action-manifest.json";
import { z } from "zod";
import {
  type ClientActionContext,
  type ClientActionDefinition,
  executeActionClient,
} from "./actionClient.js";
import { entityCrudActionClient } from "./entityActions.js";
import { decisionReviewActionClient } from "./governanceActions.js";
import { taskCrudActionClient } from "./taskActions.js";
import { runGraphFilter } from "./graphActions.js";
import { graphNodeLevelActionClient } from "./graphLevelActions.js";
import { relationshipCrudActionClient } from "./relationshipActions.js";
import { runViewScreen } from "./viewScreenAction.js";
import { navigateActionClient } from "./navigateAction.js";
import {
  ClientActionRecorder,
  defaultClientActionRecorder,
} from "./clientActionRecorder.js";
import type { GeminiTool } from "./gemini.js";

interface ManifestActionEntry {
  description: string;
  expose: {
    mcp?: boolean;
    http?: boolean;
    ui_agent?: boolean;
    worker?: boolean;
    reason?: string;
    note?: string;
  };
  input_schema: Record<string, unknown>;
}

const manifestActions = (
  actionManifest as { actions: Record<string, ManifestActionEntry> }
).actions;

const CLIENT_LOCAL_SCHEMAS: Record<string, z.ZodType<any>> = {
  graph_filter: graphFilterInputSchema,
  view_screen: viewScreenInputSchema,
};

export type LocalActionHandler<TInput = any, TOutput = any> =
  | ((input: TInput, ctx: ClientActionContext) => Promise<TOutput> | TOutput)
  | ClientActionDefinition<TInput, TOutput>;

function isClientLocalManifestEntry(entry?: ManifestActionEntry): boolean {
  return Boolean(
    entry &&
      entry.expose?.reason === "client_local" &&
      entry.expose?.ui_agent === true &&
      !entry.expose?.mcp &&
      !entry.expose?.http &&
      !entry.expose?.worker,
  );
}

async function postActionToServer<TInput = unknown, TOutput = unknown>(
  id: string,
  description: string,
  input: TInput,
  caller: "ui" | "ui_agent",
): Promise<TOutput> {
  return (await executeActionClient(
    {
      id,
      name: id,
      description,
      schema: z.unknown(),
    },
    input,
    { caller },
  )) as TOutput;
}

/**
 * Client-side Centralised Action Registry ("CAR") for the Web UI.
 * Extends the canonical CAR from @ahkms/core, managing capability definitions,
 * direct client execution, and compiling function declarations for in-app Gemini agents.
 */
export class ClientActionRegistry extends CoreActionRegistry {
  private localHandlers = new Map<string, ClientActionDefinition<any, any>>();
  private readonly recorder: ClientActionRecorder;

  constructor(recorder: ClientActionRecorder = defaultClientActionRecorder) {
    super();
    this.recorder = recorder;
  }

  override register<TInput = any, TOutput = any>(
    action: ClientActionDefinition<TInput, TOutput> | any,
  ): void {
    if (!action || !action.id) {
      throw new Error("Action must have a valid id");
    }
    if (isClientLocalManifestEntry(manifestActions[action.id])) {
      this.bindLocalHandler(action.id, action);
      return;
    }
    super.register(action);
  }

  bindLocalHandler<TInput = any, TOutput = any>(
    id: string,
    handler: LocalActionHandler<TInput, TOutput>,
  ): ClientActionDefinition<TInput, TOutput> {
    const manifestEntry = manifestActions[id];
    if (!manifestEntry || !isClientLocalManifestEntry(manifestEntry)) {
      throw new Error(
        `Cannot bind local handler for "${id}": action is not marked client_local in action-manifest.json`,
      );
    }
    const runner = typeof handler === "function" ? handler : handler?.run;
    if (typeof runner !== "function") {
      throw new Error(`Local handler for "${id}" must provide a run function`);
    }
    const schema =
      (typeof handler === "object" && handler !== null && "schema" in handler && handler.schema) ||
      CLIENT_LOCAL_SCHEMAS[id] ||
      z.unknown();
    const definition: ClientActionDefinition<TInput, TOutput> = {
      id,
      name: typeof handler === "object" && handler?.name ? handler.name : id,
      description: manifestEntry.description,
      schema: schema as z.ZodType<TInput>,
      run: async (input: TInput, ctx: ClientActionContext) => await runner(input, ctx),
    };
    this.localHandlers.set(id, definition);
    return definition;
  }

  getBoundLocalIds(): string[] {
    return Array.from(this.localHandlers.keys());
  }

  get boundLocalIds(): string[] {
    return this.getBoundLocalIds();
  }

  override get(id: string): any {
    return this.localHandlers.get(id) ?? super.get(id);
  }

  override has(id: string): boolean {
    return (
      this.localHandlers.has(id) ||
      super.has(id) ||
      Boolean(manifestActions[id]?.expose.ui_agent)
    );
  }

  override list(filter?: ActionRegistryFilter): any[] {
    const base = super.list(filter);
    const seen = new Set(base.map((a) => a.id));
    const extras: ClientActionDefinition<any, any>[] = [];
    for (const def of this.localHandlers.values()) {
      if (!seen.has(def.id)) {
        extras.push(def);
      }
    }
    return [...base, ...extras];
  }

  override clear(): void {
    this.localHandlers.clear();
    super.clear();
  }

  override async execute<TInput = unknown, TOutput = unknown>(
    id: string,
    input: TInput,
    options?:
      | { caller?: "ui" | "ui_agent"; traceId?: string | null; trace_id?: string | null }
      | "ui"
      | "ui_agent"
      | { context?: { caller?: string; traceId?: string | null } },
  ): Promise<TOutput> {
    const resolvedCaller: "ui" | "ui_agent" =
      typeof options === "string"
        ? options
        : options && "caller" in options && (options.caller === "ui" || options.caller === "ui_agent")
          ? options.caller
          : options && "context" in options && options.context?.caller === "ui_agent"
            ? "ui_agent"
            : "ui";

    const resolvedTraceId: string | undefined =
      typeof options === "object" && options !== null
        ? ("traceId" in options && typeof options.traceId === "string"
            ? options.traceId
            : "trace_id" in options && typeof options.trace_id === "string"
              ? options.trace_id
              : "context" in options && typeof options.context?.traceId === "string"
                ? options.context.traceId
                : undefined)
        : undefined;

    if (this.localHandlers.has(id)) {
      const localAction = this.localHandlers.get(id)!;
      const startTime = Date.now();
      const requestId = globalThis.crypto.randomUUID();
      try {
        const result = (await executeActionClient(localAction as any, input, {
          caller: resolvedCaller,
          traceId: resolvedTraceId,
        })) as TOutput;
        if (resolvedCaller === "ui_agent") {
          await this.recorder.record({
            action_id: id,
            request_id: requestId,
            trace_id: resolvedTraceId,
            outcome: "success",
            duration_ms: Math.max(0, Date.now() - startTime),
            input,
            caller: resolvedCaller,
          });
        }
        return result;
      } catch (err: any) {
        if (resolvedCaller === "ui_agent") {
          const outcome =
            err instanceof z.ZodError || err?.name === "ZodError"
              ? "validation_error"
              : "error";
          await this.recorder.record({
            action_id: id,
            request_id: requestId,
            trace_id: resolvedTraceId,
            outcome,
            duration_ms: Math.max(0, Date.now() - startTime),
            input,
            caller: resolvedCaller,
          });
        }
        throw err;
      }
    }

    const action = super.get(id);
    if (action) {
      return (await executeActionClient(action as any, input, { caller: resolvedCaller })) as TOutput;
    }

    const manifestEntry = manifestActions[id];
    if (isClientLocalManifestEntry(manifestEntry)) {
      throw new Error(`No local handler is bound for client_local action "${id}"`);
    }
    if (manifestEntry?.expose.ui_agent === true) {
      return await postActionToServer<TInput, TOutput>(
        id,
        manifestEntry.description,
        input,
        resolvedCaller,
      );
    }

    throw new Error(`Client action "${id}" is not registered in CAR`);
  }

  /**
   * Export registered actions and manifest `expose.ui_agent` actions as Gemini tool function declarations.
   */
  toGeminiTools(): GeminiTool[] {
    const manifestDeclarations = Object.entries(manifestActions)
      .filter(([, entry]) => entry.expose.ui_agent === true)
      .map(([id, entry]) =>
        jsonSchemaToGeminiDeclaration(id, entry.description, entry.input_schema),
      );
    const manifestIdSet = new Set(manifestDeclarations.map((d) => d.name));
    const localDeclarations = this.list()
      .filter((action) => !manifestIdSet.has(action.id))
      .map((action) =>
        zodToGeminiDeclaration(action.id, action.description, action.schema),
      );

    return [
      {
        functionDeclarations: [...manifestDeclarations, ...localDeclarations],
      },
    ];
  }
}

/**
 * Singleton client-side action registry populated with built-in domain actions.
 */
export const defaultClientActionRegistry = new ClientActionRegistry();

export function bindLocalHandler<TInput = any, TOutput = any>(
  id: string,
  handler: LocalActionHandler<TInput, TOutput>,
  registry: ClientActionRegistry = defaultClientActionRegistry,
): ClientActionDefinition<TInput, TOutput> {
  return registry.bindLocalHandler(id, handler);
}

export function getBoundLocalIds(
  registry: ClientActionRegistry = defaultClientActionRegistry,
): string[] {
  return registry.getBoundLocalIds();
}

defaultClientActionRegistry.register(entityCrudActionClient);
defaultClientActionRegistry.register(decisionReviewActionClient);
defaultClientActionRegistry.register(taskCrudActionClient);
defaultClientActionRegistry.register(graphNodeLevelActionClient);
defaultClientActionRegistry.register(relationshipCrudActionClient);
defaultClientActionRegistry.register(navigateActionClient);

bindLocalHandler("graph_filter", runGraphFilter);
bindLocalHandler("view_screen", runViewScreen);


