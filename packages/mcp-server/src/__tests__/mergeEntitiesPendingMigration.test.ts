import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../supabase/migrations"
);

function getMigrations(): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function extractFunction(sql: string): string {
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.merge_entities(");
  if (start === -1) return "";
  const endMarker = "\n$$;";
  const end = sql.indexOf(endMarker, start);
  if (end === -1) return "";
  return sql.slice(start, end + endMarker.length);
}

function normalizeFunction(fn: string): string {
  const notFoundRegex =
    /\n\s*IF NOT FOUND THEN\s*\n\s*RAISE EXCEPTION 'Decision % was resolved concurrently; nothing changed\.', p_decision_id;\s*\n\s*END IF;/g;
  let normalized = fn.replace(notFoundRegex, "");
  normalized = normalized.replaceAll(" AND status = 'pending';", ";");
  normalized = normalized.replaceAll(
    "COALESCE(p_resolved_by::uuid, p_user_id)",
    "COALESCE(p_resolved_by, p_user_id::text)"
  );
  return normalized;
}

describe("merge_entities pending decision migration", () => {
  const migrations = getMigrations();
  const mergeMigrations = migrations.filter((f) => {
    const content = readFileSync(join(migrationsDir, f), "utf8");
    return content.includes("CREATE OR REPLACE FUNCTION public.merge_entities(");
  });
  const newestFile = mergeMigrations[mergeMigrations.length - 1];
  const newestSql = readFileSync(join(migrationsDir, newestFile), "utf8");
  const newestFunction = extractFunction(newestSql);

  const m126File = migrations.find((f) => /_126_/.test(f));
  if (!m126File) throw new Error("Migration 126 not found");
  const m126Sql = readFileSync(join(migrationsDir, m126File), "utf8");
  const m126Function = extractFunction(m126Sql);

  it("1. exactly one file ends _merge_entities_pending_decision.sql, and it is that newest migration", () => {
    const matching = migrations.filter((f) =>
      f.endsWith("_merge_entities_pending_decision.sql")
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]).toBe(newestFile);
  });

  it("2. has DROP FUNCTION IF EXISTS for 13-argument signature, REVOKE, GRANT to service_role, and SECURITY INVOKER", () => {
    expect(newestSql).toMatch(
      /DROP FUNCTION IF EXISTS public\.merge_entities\(uuid, uuid, uuid, jsonb, text\[\], text\[\], text\[\], jsonb, uuid, text, boolean, text, text\);/
    );
    expect(newestSql).toMatch(
      /REVOKE ALL ON FUNCTION public\.merge_entities\(uuid, uuid, uuid, jsonb, text\[\], text\[\], text\[\], jsonb, uuid, text, boolean, text, text\) FROM PUBLIC, anon, authenticated;/
    );
    expect(newestSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.merge_entities\(uuid, uuid, uuid, jsonb, text\[\], text\[\], text\[\], jsonb, uuid, text, boolean, text, text\) TO service_role;/
    );
    expect(newestFunction).toMatch(/\bSECURITY INVOKER\b/);
  });

  it("3. has exactly three UPDATE system_decisions with status = 'pending' and concurrency exception", () => {
    const updateCount = (newestFunction.match(/UPDATE system_decisions/g) || []).length;
    expect(updateCount).toBe(3);

    const pattern =
      /UPDATE system_decisions[\s\S]*?WHERE id = p_decision_id AND user_id = p_user_id AND status = 'pending';\s*IF NOT FOUND THEN\s*RAISE EXCEPTION 'Decision % was resolved concurrently; nothing changed\.', p_decision_id;\s*END IF;/g;
    const matches = [...newestFunction.matchAll(pattern)];
    expect(matches).toHaveLength(3);
  });

  it("4. has resolved_by = COALESCE(p_resolved_by::uuid, p_user_id) three times and no p_user_id::text", () => {
    const matches = [
      ...newestFunction.matchAll(
        /resolved_by = COALESCE\(p_resolved_by::uuid, p_user_id\)/g
      ),
    ];
    expect(matches).toHaveLength(3);
    expect(newestFunction).not.toContain("p_user_id::text");
  });

  it("5. function equals migration 126's once both are normalised", () => {
    expect(normalizeFunction(newestFunction)).toBe(normalizeFunction(m126Function));
  });
});
