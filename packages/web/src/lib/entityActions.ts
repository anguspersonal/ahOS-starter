import {
  entityFields,
  entitiesFilterInput,
  entityCrudSchema,
  type EntityCrudInput,
  type EntitiesFilterInput,
  ENTITY_SELECT_FIELDS,
  sanitizeEntityRow,
} from "@ahkms/core";
import { type ClientActionDefinition, useAction, executeActionClient } from "./actionClient.js";
import { supabase } from "./supabase.js";

export const clientEntityFields = entityFields;
export const clientEntityFilterInput = entitiesFilterInput;
export const clientEntityCrudSchema = entityCrudSchema;

export type ClientEntityFilterInput = EntitiesFilterInput;
export type ClientEntityCrudInput = EntityCrudInput;
export { ENTITY_SELECT_FIELDS, sanitizeEntityRow };

export interface ClientEntityResult {
  operation: "create" | "get" | "query" | "update" | "delete" | "bulk_delete" | "upsert";
  success?: boolean;
  count?: number;
  found?: boolean;
  entity?: Record<string, unknown> | null;
  rows?: Array<Record<string, unknown>>;
  updated?: Array<{ id: string; title: string | null }>;
  deleted?: Array<{ id: string; title: string | null }>;
  created?: string[];
  dryRun?: boolean;
  sample?: Array<{ id: string; title: string | null }>;
  wouldDeleteIds?: string[];
  [key: string]: unknown;
}

/**
 * Escapes characters with special meaning in SQL ILIKE patterns (% and _)
 * and in PostgREST double-quoted strings (\ and ").
 *
 * Inside a PostgREST double-quoted value, backslash is itself the quote-escape character.
 * So escaping happens in two distinct layers:
 * 1. Pattern layer: escape \, %, _ for Postgres ILIKE
 * 2. PostgREST quote layer: escape \ and " for PostgREST unquoting
 */
export function escapeIlike(text: string): string {
  const ilike = text.replace(/[\\%_]/g, (c) => "\\" + c);
  return ilike.replace(/[\\"]/g, (c) => "\\" + c);
}

/**
 * Direct read from Supabase under RLS for low-latency queries (#1317, #1325).
 */
export async function queryEntitiesDirect(
  input: ClientEntityFilterInput & { limit?: number },
): Promise<ClientEntityResult> {
  let q = supabase.from("entities").select(ENTITY_SELECT_FIELDS);
  if (input.domain) q = q.eq("domain_override", input.domain);
  if (input.entity_type) q = q.eq("entity_type", input.entity_type);
  if (!input.include_archived) q = q.eq("archived", false);
  if (input.tags && input.tags.length > 0) q = q.contains("tags", input.tags);
  if (input.ids && input.ids.length > 0) q = q.in("id", input.ids);
  if (input.local_name) q = q.eq("local_name", input.local_name);
  if (input.query) {
    const cleanQuery = input.query.trim();
    if (cleanQuery) {
      const escaped = escapeIlike(cleanQuery);
      q = q.or(`title.ilike."%${escaped}%",description.ilike."%${escaped}%"`);
    }
  }
  q = q.limit(input.limit || 20);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data || []).map(sanitizeEntityRow);
  return {
    operation: "query",
    count: rows.length,
    rows,
  };
}

/**
 * Direct get from Supabase under RLS (#1325).
 */
export async function getEntityDirect(id: string): Promise<ClientEntityResult> {
  const { data, error } = await supabase
    .from("entities")
    .select(ENTITY_SELECT_FIELDS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return {
    operation: "get",
    found: Boolean(data),
    entity: data ? sanitizeEntityRow(data) : null,
  };
}

/**
 * Client-side Action Definition for Entity CRUD (ADR-100).
 * All mutations route through CAR on the server (/api/actions/entity_crud).
 * Client action has no local run handler (ADR-101 #1325).
 */
export const entityCrudActionClient: ClientActionDefinition<
  ClientEntityCrudInput,
  ClientEntityResult
> = {
  id: "entity_crud",
  name: "entity_crud",
  description: "Centralized CRUD operations on knowledge graph entities",
  schema: clientEntityCrudSchema,
};

/**
 * Specialized options for bulk entity deletion.
 */
export interface BulkDeleteOptions {
  ids?: string[];
  filter?: ClientEntityFilterInput;
  dryRun?: boolean;
  archiveOnly?: boolean;
}

/**
 * React hook to interact with entities using the centralized action.
 * Provides specialized helpers for single delete, bulk delete, and preview.
 */
export function useEntityCrud() {
  const action = useAction(entityCrudActionClient);

  const deleteEntity = async (id: string, archiveOnly = true) => {
    return await action.execute({
      operation: "delete",
      id,
      archive_only: archiveOnly,
    });
  };

  const bulkDeleteEntities = async (options: BulkDeleteOptions) => {
    return await action.execute({
      operation: "bulk_delete",
      ids: options.ids,
      filter: options.filter,
      dry_run: options.dryRun,
      archive_only: options.archiveOnly,
    });
  };

  const previewBulkDelete = async (filter: ClientEntityFilterInput) => {
    return await action.execute({
      operation: "bulk_delete",
      filter,
      dry_run: true,
    });
  };

  return {
    ...action,
    deleteEntity,
    bulkDeleteEntities,
    previewBulkDelete,
  };
}

/**
 * Direct execution helper for Entity CRUD on the client.
 */
export async function executeEntityCrud(input: ClientEntityCrudInput) {
  return await executeActionClient(entityCrudActionClient, input);
}
