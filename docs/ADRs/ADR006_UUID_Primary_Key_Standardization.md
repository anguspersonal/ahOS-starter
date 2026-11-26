# ADR006: UUID Primary Key Standardization

## Status
**Accepted** - December 2024

## Context

During implementation of the workflow orchestrator, artifact creation was failing with:
```
null value in column "id" of relation "artifacts" violates not-null constraint
```

Investigation revealed that several tables had been migrated from TEXT to UUID primary keys (migrations 010, 011, 012) but the `DEFAULT gen_random_uuid()` clause was never added to the actual columns—it was only set on temporary mapping tables used during migration.

Additionally, two tables (`discovered_patterns`, `training_examples`) still used TEXT primary keys and had never been converted.

### Tables Affected

| Table | Original State | Issue |
|-------|---------------|-------|
| `artifacts` | TEXT → UUID (migration 010) | Missing default |
| `entities` | TEXT → UUID (migration 011) | Missing default |
| `workflows` | TEXT → UUID (migration 012) | Missing default |
| `discovered_patterns` | TEXT | Never converted |
| `training_examples` | TEXT | Never converted |

### Root Cause

The TEXT→UUID migration pattern used temporary mapping tables:
```sql
CREATE TEMP TABLE artifact_id_mapping (
  old_id TEXT PRIMARY KEY,
  new_id UUID NOT NULL DEFAULT gen_random_uuid()  -- Default only on temp table!
);
```

The default was set on the temp table for populating existing rows, but never transferred to the actual table column after the swap.

## Decision

**All tables should use UUID primary keys with database-generated defaults.**

### Implementation

Created migration `025_standardize_uuid_primary_keys.sql` which:

1. **Adds defaults to already-converted tables:**
   ```sql
   ALTER TABLE artifacts ALTER COLUMN id SET DEFAULT gen_random_uuid();
   ALTER TABLE entities ALTER COLUMN id SET DEFAULT gen_random_uuid();
   ALTER TABLE workflows ALTER COLUMN id SET DEFAULT gen_random_uuid();
   ```

2. **Converts remaining TEXT tables to UUID:**
   - `discovered_patterns`: Full TEXT→UUID conversion with default
   - `training_examples`: Full TEXT→UUID conversion with default (including self-reference `superseded_by`)

3. **Adds documentation comments** to all affected columns

### Exceptions (Not Converted)

Some tables intentionally keep non-UUID primary keys:

| Table | ID Type | Reason |
|-------|---------|--------|
| `activity_logs` | INTEGER (sequence) | Append-only log, sequential IDs appropriate |
| `invitations` | INTEGER (sequence) | Low volume, sequential sufficient |
| `team_members` | INTEGER (sequence) | Junction table, sequential sufficient |
| `teams` | INTEGER (sequence) | Low volume, sequential sufficient |
| `workflow_steps` | BIGINT (identity) | Ordered execution, sequential IDs meaningful |
| `user_profiles` | UUID (no default) | Linked to `auth.users.id`, managed by Supabase Auth |
| `users` | UUID (no default) | Linked to `auth.users.id`, managed by Supabase Auth |

## Rationale

### Why Database-Generated UUIDs?

1. **Consistency** - All UUIDs generated the same way using PostgreSQL's `gen_random_uuid()`
2. **Atomicity** - ID created within the same transaction as the insert
3. **Source Independence** - Works regardless of insert source (application code, SQL scripts, migrations, manual inserts)
4. **Simpler Application Code** - No need to import UUID libraries or handle generation
5. **No Collision Risk** - Database guarantees uniqueness at the constraint level
6. **Debugging** - UUIDs are globally unique, making cross-system tracing easier

### Why UUID Over Sequential Integers?

1. **Distributed Systems** - UUIDs work across multiple database instances without coordination
2. **Security** - IDs are not guessable (no enumeration attacks)
3. **Merge Safety** - Data can be merged from different sources without ID conflicts
4. **API Design** - UUIDs are standard for REST APIs and don't leak information about record counts

### Why `gen_random_uuid()` Over `uuid_generate_v4()`?

- `gen_random_uuid()` is built into PostgreSQL 13+ (no extension required)
- `uuid_generate_v4()` requires the `uuid-ossp` extension
- Both produce equivalent UUIDv4 random UUIDs
- Standardizing on `gen_random_uuid()` reduces dependencies

## Consequences

### Positive
- Application code no longer needs to generate UUIDs
- Consistent ID generation across all tables
- Reduced risk of ID-related bugs
- Clearer database schema with documented conventions

### Negative
- Migration may take time on large tables (discovered_patterns, training_examples)
- Any code manually setting IDs will need review (should be rare)

### Migration Required
```bash
cd supabase
npx supabase db push
```

## Related
- Migration: `supabase/migrations/20251227160000_025_standardize_uuid_primary_keys.sql`
- ADR005: Edge Function Migration (related workflow changes)

