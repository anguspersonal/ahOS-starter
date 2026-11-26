import { describe, expect, it, vi, beforeEach } from "vitest";
import { queryEntitiesDirect, escapeIlike } from "../lib/entityActions.js";
import { supabase } from "../lib/supabase.js";

/**
 * Splits a PostgREST filter string into top-level conditions,
 * respecting double-quoted values where commas and parens are literal.
 */
export function splitPostgrestConditions(filter: string): string[] {
  const conditions: string[] = [];
  let current = "";
  let inQuotes = false;
  let escaped = false;

  for (let i = 0; i < filter.length; i++) {
    const char = filter[i];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === "," && !inQuotes) {
      conditions.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current) {
    conditions.push(current.trim());
  }
  return conditions;
}

describe("escapeIlike helper", () => {
  it("leaves plain words unchanged", () => {
    expect(escapeIlike("plain")).toBe("plain");
    expect(escapeIlike("hello world")).toBe("hello world");
  });

  it("escapes % and _ for SQL ILIKE", () => {
    expect(escapeIlike("50%")).toBe("50\\\\%");
    expect(escapeIlike("user_name")).toBe("user\\\\_name");
  });

  it("escapes backslashes", () => {
    expect(escapeIlike("a\\b")).toBe("a\\\\\\\\b");
  });

  it("escapes double quotes for PostgREST quoting", () => {
    expect(escapeIlike('quoted "value"')).toBe('quoted \\"value\\"');
    expect(escapeIlike('say "hi"')).toBe('say \\"hi\\"');
  });

  it("handles complex strings with multiple special characters", () => {
    expect(escapeIlike('50%_discount \\ "fall"')).toBe('50\\\\%\\\\_discount \\\\\\\\ \\"fall\\"');
  });
});

describe("queryEntitiesDirect search escaping", () => {
  let capturedOr: string | undefined;

  beforeEach(() => {
    capturedOr = undefined;
    vi.restoreAllMocks();

    const mockQueryBuilder: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      contains: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      or: vi.fn((filter: string) => {
        capturedOr = filter;
        return mockQueryBuilder;
      }),
      limit: vi.fn().mockReturnThis(),
      then: vi.fn((resolve) => resolve({ data: [], error: null })),
    };

    vi.spyOn(supabase, "from").mockReturnValue(mockQueryBuilder as any);
  });

  it("searching 'a,b)' quotes the value and produces exactly two conditions", async () => {
    await queryEntitiesDirect({ query: "a,b)" });

    expect(capturedOr).toBeDefined();
    // PostgREST double-quote quoting preserves commas and parens inside a single value
    expect(capturedOr).toBe('title.ilike."%a,b)%",description.ilike."%a,b)%"');

    const conditions = splitPostgrestConditions(capturedOr!);
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toBe('title.ilike."%a,b)%"');
    expect(conditions[1]).toBe('description.ilike."%a,b)%"');
  });

  it("searching '50%' escapes % for ilike and produces exactly two conditions", async () => {
    await queryEntitiesDirect({ query: "50%" });

    expect(capturedOr).toBeDefined();
    expect(capturedOr).toBe('title.ilike."%50\\\\%%",description.ilike."%50\\\\%%"');

    const conditions = splitPostgrestConditions(capturedOr!);
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toBe('title.ilike."%50\\\\%%"');
    expect(conditions[1]).toBe('description.ilike."%50\\\\%%"');
  });

  it("searching 'a_b' escapes _ for ilike and produces exactly two conditions", async () => {
    await queryEntitiesDirect({ query: "a_b" });

    expect(capturedOr).toBeDefined();
    expect(capturedOr).toBe('title.ilike."%a\\\\_b%",description.ilike."%a\\\\_b%"');

    const conditions = splitPostgrestConditions(capturedOr!);
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toBe('title.ilike."%a\\\\_b%"');
    expect(conditions[1]).toBe('description.ilike."%a\\\\_b%"');
  });

  it("searching 'a\\b' escapes backslashes for both ilike and PostgREST quoting", async () => {
    await queryEntitiesDirect({ query: "a\\b" });

    expect(capturedOr).toBeDefined();
    expect(capturedOr).toBe('title.ilike."%a\\\\\\\\b%",description.ilike."%a\\\\\\\\b%"');

    const conditions = splitPostgrestConditions(capturedOr!);
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toBe('title.ilike."%a\\\\\\\\b%"');
    expect(conditions[1]).toBe('description.ilike."%a\\\\\\\\b%"');
  });

  it("searching 'say \"hi\"' escapes quotes for PostgREST quoting", async () => {
    await queryEntitiesDirect({ query: 'say "hi"' });

    expect(capturedOr).toBeDefined();
    expect(capturedOr).toBe('title.ilike."%say \\"hi\\"%",description.ilike."%say \\"hi\\"%"');

    const conditions = splitPostgrestConditions(capturedOr!);
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toBe('title.ilike."%say \\"hi\\"%"');
    expect(conditions[1]).toBe('description.ilike."%say \\"hi\\"%"');
  });

  it("searching plain words keeps search behaviour unchanged and quoted as a single value", async () => {
    await queryEntitiesDirect({ query: "knowledge" });

    expect(capturedOr).toBeDefined();
    expect(capturedOr).toBe('title.ilike."%knowledge%",description.ilike."%knowledge%"');

    const conditions = splitPostgrestConditions(capturedOr!);
    expect(conditions).toHaveLength(2);
    expect(conditions[0]).toBe('title.ilike."%knowledge%"');
    expect(conditions[1]).toBe('description.ilike."%knowledge%"');
  });

  it("does not add .or() filter when query is empty or only whitespace", async () => {
    await queryEntitiesDirect({ query: "   " });
    expect(capturedOr).toBeUndefined();
  });
});
