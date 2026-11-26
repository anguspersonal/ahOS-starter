/**
 * Mock Supabase client
 * Provides chainable query builder mocks for testing
 */

// Mock data storage
const mockData: Record<string, any[]> = {
  workflows: [],
  workflow_steps: [],
  artifacts: [],
  system_decisions: [],
  entities: [],
  artifact_entity_links: [],
  entity_relationships: [],
  notifications: [],
  user_tasks: [],
  system_learning: [],
  user_edits: [],
};

// Helper to reset mock data
export function resetMockData() {
  mockData.workflows = [];
  mockData.workflow_steps = [];
  mockData.artifacts = [];
  mockData.system_decisions = [];
  mockData.entities = [];
  mockData.artifact_entity_links = [];
  mockData.entity_relationships = [];
  mockData.notifications = [];
  mockData.user_tasks = [];
  mockData.system_learning = [];
  mockData.user_edits = [];
}

// Every `.select(columns)` this mock has seen, in call order. The mock does
// not project columns (results always come back whole), so a test that cares
// WHICH columns a query asked the server for — e.g. that entity reads name
// their columns instead of `*`, so migration 095's tsvector and 1536-float
// embedding stay server-side (#550) — has to assert on the request, not the
// response. Reset by resetMockSupabase() between tests.
const selectCalls: Array<{ table: string; columns: string }> = [];

/**
 * The column strings passed to `.select()`, optionally filtered to one table.
 * `{ count: 'exact', head: true }`-style option-object selects are recorded as
 * '*', matching what the real client sends.
 */
export function getSelectCalls(table?: string): string[] {
  return selectCalls
    .filter((call) => table === undefined || call.table === table)
    .map((call) => call.columns);
}

// Helper to reset mock supabase client
export function resetMockSupabase() {
  if (mockSupabase.from.mockClear) {
    mockSupabase.from.mockClear();
  }
  if (mockSupabase.storage?.from?.mockClear) {
    mockSupabase.storage.from.mockClear();
  }
  if (mockSupabase.rpc?.mockClear) {
    mockSupabase.rpc.mockClear();
  }
  mockServerRowCap = null;
  selectCalls.length = 0;
}

// Simulates PostgREST's `api.max_rows` config (`supabase/config.toml`, #401
// QA round 1 H1): the real server clamps the EFFECTIVE row count of any
// request — whether sized via `.limit()` or `.range()` — to this value
// regardless of what the caller asked for. Tests use this to prove a
// pagination loop's termination condition is "the page came back empty", not
// "the page came back shorter than requested" — the latter breaks the moment
// this cap drops below the caller's page size, which is exactly the bug this
// simulates. Reset to null (no clamp) by resetMockSupabase() between tests.
let mockServerRowCap: number | null = null;

export function setMockServerRowCap(cap: number | null) {
  mockServerRowCap = cap;
}

// Helper to set mock data
export function setMockData(table: string, data: any[]) {
  mockData[table] = data;
}

// Helper to get mock data
export function getMockData(table: string) {
  return mockData[table] || [];
}

// Chainable query builder
export function createQueryBuilder(table: string) {
  const builder: any = {
    _table: table,
    _filters: [] as Array<{ field: string; value: any; operator: string }>,
    _updates: {} as any,
    _inserts: [] as any[],
    _select: '*',
    _count: null as string | null,
    _limit: null as number | null,
    _orderBy: null as { field: string; ascending: boolean } | null,
    _range: null as { from: number; to: number } | null,
  };

  builder.select = function(fields: string | any = '*', options?: any) {
    if (typeof fields === 'string') {
      builder._select = fields;
    } else if (fields && typeof fields === 'object') {
      // Handle select with options like { count: 'exact', head: true }
      builder._count = fields.count || null;
      builder._select = '*';
    }
    if (options) {
      builder._count = options.count || null;
    }
    selectCalls.push({ table, columns: builder._select });
    return builder;
  };

  builder.insert = function(data: any) {
    builder._inserts = Array.isArray(data) ? data : [data];
    // Generate numeric IDs for workflow_steps table to match database schema
    let idCounter = mockData[table]?.length || 0;
    const insertResult: any = {
      select: function(fields: string = '*') {
        builder._select = fields;
        return {
          single: function() {
            const inserted = builder._inserts[0];
            // Use numeric ID for workflow_steps, string ID for others
            const id = inserted?.id || (table === 'workflow_steps' ? ++idCounter : `mock-id-${Date.now()}`);
            const record = { ...inserted, id };
            mockData[table].push(record);
            return Promise.resolve({ data: record, error: null });
          },
        };
      },
      single: function() {
        const inserted = builder._inserts[0];
        // Use numeric ID for workflow_steps, string ID for others
        const id = inserted?.id || (table === 'workflow_steps' ? ++idCounter : `mock-id-${Date.now()}`);
        const record = { ...inserted, id };
        mockData[table].push(record);
        return Promise.resolve({ data: record, error: null });
      },
      // Make insertResult thenable so it can be awaited directly
      then: function(resolve: any, reject: any) {
        // When insert is awaited directly, add all inserted records to mockData
        builder._inserts.forEach((inserted: any, index: number) => {
          // Use numeric ID for workflow_steps, string ID for others
          const id = inserted?.id || (table === 'workflow_steps' ? (idCounter + index + 1) : `mock-id-${Date.now()}-${Math.random()}`);
          const record = { ...inserted, id };
          mockData[table].push(record);
        });
        return Promise.resolve({ data: builder._inserts, error: null }).then(resolve, reject);
      },
      catch: function(reject: any) {
        return Promise.resolve({ data: builder._inserts, error: null }).catch(reject);
      },
    };
    return insertResult;
  };

  builder.update = function(updates: any) {
    builder._updates = updates;
    const updateBuilder: any = {
      _updateFilters: [] as Array<{ field: string; value: any; operator: string }>,
      eq: function(field: string, value: any) {
        // For update, we only use the filters added to updateBuilder, not the select filters
        const matching = mockData[table].filter((item: any) => {
          return item[field] === value && 
            updateBuilder._updateFilters.every((f: any) => {
              if (f.operator === 'eq') return item[f.field] === f.value;
              if (f.operator === 'gt') return item[f.field] > f.value;
              if (f.operator === 'ilike') {
                const fieldValue = String(item[f.field] || '').toLowerCase();
                const pattern = String(f.value || '').toLowerCase().replace(/%/g, '.*');
                return new RegExp(`^${pattern}$`).test(fieldValue);
              }
              if (f.operator === 'in') {
                const fieldValue = item[f.field];
                return Array.isArray(f.value) && f.value.includes(fieldValue);
              }
              return true;
            });
        });
        matching.forEach((item: any) => {
          Object.assign(item, builder._updates);
        });
        return Promise.resolve({ data: matching, error: null });
      },
      gt: function(field: string, value: any) {
        updateBuilder._updateFilters.push({ field, value, operator: 'gt' });
        return updateBuilder;
      },
    };
    return updateBuilder;
  };

  builder.delete = function() {
    const deleteBuilder: any = {
      _deleteFilters: [] as Array<{ field: string; value: any }>,
    };
    const apply = () => {
      const removed: any[] = [];
      mockData[table] = (mockData[table] || []).filter((item: any) => {
        const matches = deleteBuilder._deleteFilters.every((f: any) => item[f.field] === f.value);
        if (matches) removed.push(item);
        return !matches;
      });
      return { data: removed, error: null };
    };
    deleteBuilder.eq = function(field: string, value: any) {
      deleteBuilder._deleteFilters.push({ field, value });
      return deleteBuilder;
    };
    // Thenable: the delete runs when awaited, after all `.eq()` filters are set.
    deleteBuilder.then = function(resolve: any, reject: any) {
      return Promise.resolve(apply()).then(resolve, reject);
    };
    deleteBuilder.catch = function(reject: any) {
      return Promise.resolve(apply()).catch(reject);
    };
    return deleteBuilder;
  };

  builder.eq = function(field: string, value: any) {
    builder._filters.push({ field, value, operator: 'eq' });
    return builder;
  };

  builder.gt = function(field: string, value: any) {
    builder._filters.push({ field, value, operator: 'gt' });
    return builder;
  };

  builder.ilike = function(field: string, pattern: string) {
    builder._filters.push({ field, value: pattern, operator: 'ilike' });
    return builder;
  };

  builder.in = function(field: string, values: any[]) {
    builder._filters.push({ field, value: values, operator: 'in' });
    return builder;
  };

  // PostgREST .not(field, operator, value) negates a filter. Only the
  // `.not(field, 'is', null)` form (field IS NOT NULL) appears in this
  // codebase (learning/analyze.ts), so that's the only case implemented.
  //
  // Wrapped in jest.fn() (QA round 1 L1, #777) rather than a plain function:
  // callers were only ever able to assert on the OUTCOME of this filter
  // (a null-user_id row missing from the result), which a client-side guard
  // can produce just as well — that made a test claiming to cover the
  // server-side `.not()` call pass even with the call deleted. jest.fn()
  // lets a test assert the query itself asked the server to exclude nulls,
  // via `supabase.from('user_edits').mock.results[i].value.not`.
  builder.not = jest.fn(function(field: string, operator: string, value: any) {
    if (operator !== 'is' || value !== null) {
      throw new Error(
        `Mock Supabase client does not support .not('${field}', '${operator}', ${JSON.stringify(value)}) — only .not(field, 'is', null) is implemented`,
      );
    }
    builder._filters.push({ field, value: null, operator: 'not_null' });
    return builder;
  });

  builder.limit = function(count: number) {
    builder._limit = count;
    return builder;
  };

  builder.order = function(field: string, options?: { ascending?: boolean }) {
    builder._orderBy = { field, ascending: options?.ascending !== false };
    return builder;
  };

  // PostgREST .range(from, to) is an inclusive offset window, applied after
  // ordering — the pagination primitive dedupSweep's getActiveUserIds (#401)
  // and alertEvaluator's discovery scan (#573) both page through with.
  builder.range = function(from: number, to: number) {
    builder._range = { from, to };
    return builder;
  };

  // Execute query and return results
  const executeQuery = () => {
    let results = mockData[table] || [];
    
    // Apply filters
    results = results.filter((item: any) => {
      return builder._filters.every((filter: any) => {
        if (filter.operator === 'eq') {
          return item[filter.field] === filter.value;
        }
        if (filter.operator === 'gt') {
          return item[filter.field] > filter.value;
        }
        if (filter.operator === 'ilike') {
          const fieldValue = String(item[filter.field] || '').toLowerCase();
          const pattern = String(filter.value || '').toLowerCase().replace(/%/g, '.*');
          return new RegExp(`^${pattern}$`).test(fieldValue);
        }
        if (filter.operator === 'in') {
          const fieldValue = item[filter.field];
          return Array.isArray(filter.value) && filter.value.includes(fieldValue);
        }
        if (filter.operator === 'not_null') {
          return item[filter.field] !== null && item[filter.field] !== undefined;
        }
        return true;
      });
    });

    // Apply ordering
    if (builder._orderBy) {
      results.sort((a: any, b: any) => {
        const aVal = a[builder._orderBy.field];
        const bVal = b[builder._orderBy.field];
        if (aVal === bVal) return 0;
        const comparison = aVal > bVal ? 1 : -1;
        return builder._orderBy.ascending ? comparison : -comparison;
      });
    }

    // Resolve the requested window to an offset + row count, then clamp that
    // count to the simulated server cap — mirroring PostgREST, which clamps
    // the effective limit to `api.max_rows` regardless of whether the caller
    // sized the request via `.range()` or `.limit()`.
    let offset = 0;
    let requestedCount: number | null = null;
    if (builder._range !== null) {
      offset = builder._range.from;
      requestedCount = builder._range.to - builder._range.from + 1;
    } else if (builder._limit !== null) {
      requestedCount = builder._limit;
    }

    if (requestedCount !== null) {
      const effectiveCount =
        mockServerRowCap !== null ? Math.min(requestedCount, mockServerRowCap) : requestedCount;
      results = results.slice(offset, offset + effectiveCount);
    } else if (offset > 0) {
      results = results.slice(offset);
    }

    // Handle count queries
    if (builder._count) {
      return Promise.resolve({ count: results.length, data: null, error: null });
    }

    return Promise.resolve({ data: results, error: null });
  };

  builder.single = function() {
    return executeQuery().then((result: any) => {
      if (result.data && result.data.length > 0) {
        return { data: result.data[0], error: null };
      }
      return { data: null, error: { message: 'Not found' } };
    });
  };

  // Make the builder thenable so it can be awaited directly
  builder.then = function(resolve: any, reject: any) {
    return executeQuery().then(resolve, reject);
  };

  builder.catch = function(reject: any) {
    return executeQuery().catch(reject);
  };

  return builder;
}

// Mock storage
const mockStorage: Record<string, any> = {};

export function resetMockStorage() {
  Object.keys(mockStorage).forEach(key => delete mockStorage[key]);
}

export function setMockStorageFile(path: string, data: Buffer) {
  mockStorage[path] = data;
}

export function getMockStorageFile(path: string) {
  return mockStorage[path];
}

const mockSupabase: any = {
  from: jest.fn((table: string) => createQueryBuilder(table)),
  rpc: jest.fn(async (name: string, params: any) => {
    if (name === 'merge_entities') {
      const {
        p_winner_id,
        p_loser_id,
        p_user_id,
        p_winner_properties,
        p_winner_aliases,
        p_aliases_added,
        p_properties_carried,
        p_properties_skipped = {},
        p_decision_id,
        p_resolution_notes = 'Approved by user',
        p_survivor_overridden = false,
        p_decision_status = 'approved',
        p_resolved_by,
      } = params;

      const winner = mockData.entities.find((e: any) => e.id === p_winner_id);
      const loser = mockData.entities.find((e: any) => e.id === p_loser_id);

      if (!winner) {
        return { data: null, error: { message: `Merge winner entity not found: ${p_winner_id}` } };
      }
      if (!loser) {
        return { data: null, error: { message: `Merge loser entity not found: ${p_loser_id}` } };
      }

      if (loser.archived && loser.properties?.merged_into === p_winner_id) {
        if (p_decision_id) {
          const decision = mockData.system_decisions.find((d: any) => d.id === p_decision_id);
          if (decision) {
            decision.status = p_decision_status;
            decision.resolved_by = p_resolved_by ?? (p_user_id ? String(p_user_id) : undefined);
            decision.resolved_at = new Date().toISOString();
            decision.resolution_notes = p_resolution_notes;
            decision.decision_payload = {
              ...(decision.decision_payload || {}),
              winnerEntityId: p_winner_id,
              loserEntityId: p_loser_id,
              survivorOverridden: p_survivor_overridden,
            };
          }
        }
        return {
          data: {
            success: true,
            already_merged: true,
            idempotent: true,
            winner_id: p_winner_id,
            loser_id: p_loser_id,
          },
          error: null,
        };
      }

      const moved_edge_ids: string[] = [];
      const archived_edge_ids: string[] = [];
      const demoted_edge_types: Record<string, string> = {};

      for (const edge of mockData.entity_relationships) {
        if (edge.from_entity_id !== p_loser_id && edge.to_entity_id !== p_loser_id) continue;
        if (p_user_id && edge.user_id && edge.user_id !== p_user_id) continue;

        const newFrom = edge.from_entity_id === p_loser_id ? p_winner_id : edge.from_entity_id;
        const newTo = edge.to_entity_id === p_loser_id ? p_winner_id : edge.to_entity_id;

        if (newFrom === newTo) {
          edge.archived = true;
          archived_edge_ids.push(edge.id);
          continue;
        }

        let newType = edge.relationship_type;
        if (
          edge.relationship_type === 'belongs_to' &&
          edge.from_entity_id === p_loser_id &&
          !edge.archived &&
          (winner.entity_type === 'project' || winner.entity_type === 'resource')
        ) {
          const hasLivePrimary = mockData.entity_relationships.some(
            (other: any) =>
              other.from_entity_id === p_winner_id &&
              other.relationship_type === 'belongs_to' &&
              !other.archived &&
              other.to_entity_id !== newTo &&
              (!p_user_id || !other.user_id || other.user_id === p_user_id)
          );
          if (hasLivePrimary) {
            demoted_edge_types[edge.id] = edge.relationship_type;
            newType = 'associated_with';
          }
        }

        const collision = mockData.entity_relationships.some(
          (other: any) =>
            other.id !== edge.id &&
            other.from_entity_id === newFrom &&
            other.to_entity_id === newTo &&
            other.relationship_type === newType &&
            !other.archived &&
            (!p_user_id || !other.user_id || other.user_id === p_user_id)
        );

        if (collision) {
          delete demoted_edge_types[edge.id];
          edge.archived = true;
          archived_edge_ids.push(edge.id);
          continue;
        }

        edge.from_entity_id = newFrom;
        edge.to_entity_id = newTo;
        edge.relationship_type = newType;
        moved_edge_ids.push(edge.id);
      }

      const links_moved: string[] = [];
      const links_deleted: string[] = [];
      const remainingLinks: any[] = [];

      for (const link of mockData.artifact_entity_links) {
        if (link.entity_id === p_loser_id && (!p_user_id || !link.user_id || link.user_id === p_user_id)) {
          const collision = mockData.artifact_entity_links.some(
            (other: any) =>
              other.id !== link.id &&
              other.artifact_id === link.artifact_id &&
              other.entity_id === p_winner_id &&
              other.link_type === link.link_type &&
              (!p_user_id || !other.user_id || other.user_id === p_user_id)
          );
          if (collision) {
            links_deleted.push(link.id);
            continue;
          }
          link.entity_id = p_winner_id;
          links_moved.push(link.id);
        }
        remainingLinks.push(link);
      }
      mockData.artifact_entity_links = remainingLinks;

      winner.properties = p_winner_properties;
      winner.aliases = p_winner_aliases;

      const op_id = 'mock-op-id';
      const merged_at = new Date().toISOString();
      const merge_op = {
        op_id,
        merged_at,
        winner_id: p_winner_id,
        moved_edge_ids,
        archived_edge_ids,
        aliases_added: p_aliases_added,
        properties_carried: p_properties_carried,
        properties_skipped: Object.keys(p_properties_skipped).length > 0 ? p_properties_skipped : undefined,
        links_moved,
        links_deleted,
        demoted_edge_types: Object.keys(demoted_edge_types).length > 0 ? demoted_edge_types : undefined,
      };

      loser.archived = true;
      loser.archived_at = merged_at;
      loser.properties = {
        ...(loser.properties || {}),
        merged_into: p_winner_id,
        merged_at,
        archived_reason: 'merged_duplicate',
        _merge: merge_op,
      };

      if (p_decision_id) {
        const decision = mockData.system_decisions.find((d: any) => d.id === p_decision_id);
        if (decision) {
          decision.status = p_decision_status;
          decision.resolved_by = p_resolved_by ?? (p_user_id ? String(p_user_id) : undefined);
          decision.resolved_at = merged_at;
          decision.resolution_notes = p_resolution_notes;
          decision.decision_payload = {
            ...(decision.decision_payload || {}),
            winnerEntityId: p_winner_id,
            loserEntityId: p_loser_id,
            mergedAt: merged_at,
            survivorOverridden: p_survivor_overridden,
            mergeOpId: op_id,
          };
        }
      }

      return {
        data: {
          success: true,
          winner_id: p_winner_id,
          loser_id: p_loser_id,
          op_id,
          merged_at,
          merge_op,
          winner_title: winner.title,
          winner_description: winner.description,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  }),
  storage: {
    from: jest.fn((bucket: string) => ({
      upload: jest.fn((path: string, data: Buffer, options?: any) => {
        mockStorage[path] = data;
        return Promise.resolve({ data: { path }, error: null });
      }),
      download: jest.fn((path: string) => {
        const file = mockStorage[path];
        if (file) {
          const blob = new Blob([file]);
          return Promise.resolve({ data: blob, error: null });
        }
        return Promise.resolve({ data: null, error: { message: 'File not found' } });
      }),
      createSignedUrl: jest.fn((path: string, expiresIn: number = 3600) => {
        return Promise.resolve({
          data: { signedUrl: `https://mock-signed-url.com/${path}?expires=${expiresIn}` },
          error: null,
        });
      }),
    })),
  },
};

// Export both named and default to match the actual module
export const supabase = mockSupabase;
export default mockSupabase;

