'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { checkCodeSource, checkMigrationsDir, runCheck, main } = require('./check-client-writes.js');

test('1. flags Supabase client write patterns with file and line', () => {
  const multiline = 'const res = await supabase\n  .from("entities")\n  .update({ title: "x" });\n';
  const vMulti = checkCodeSource('packages/web/src/a.ts', multiline);
  assert.equal(vMulti.length, 1);
  assert.match(vMulti[0], /^packages\/web\/src\/a\.ts:2:/);

  const cases = [
    ['packages/web/src/del.ts', 'await supabase.from("x").delete();', /:1:.*\.delete\(\)/],
    ['packages/web/src/ins.ts', 'await supabase.from("x").insert({ a: 1 });', /:1:.*\.insert\(\)/],
    ['packages/web/src/ups.ts', 'await supabase.from("x").upsert({ a: 1 });', /:1:.*\.upsert\(\)/],
    ['packages/web/src/tbl.ts', 'await supabase.from(TABLE).update({ a: 1 });', /:1:.*\.update\(\)/],
    ['packages/web/src/rpc.ts', 'await supabase.rpc("f");', /:1:.*\.rpc\(\)/],
    ['packages/web/src/sto.ts', 'supabase.storage.from("b");', /:1:.*\.storage\.from\(\)/],
    ['packages/web/src/fn.ts', 'supabase.functions.invoke("fn");', /:1:.*\.functions\.invoke\(\)/],
    ['packages/web/src/rest.ts', 'fetch("https://example.supabase.co/rest/v1/entities");', /:1:.*\/rest\/v1\//],
  ];

  for (const [file, src, pattern] of cases) {
    const res = checkCodeSource(file, src);
    assert.equal(res.length, 1, `expected 1 violation for ${file}`);
    assert.match(res[0], pattern);
  }
});

test('2. does not flag Set/Map delete, Array.from, or Supabase select', () => {
  const src = [
    'next.delete(id);',
    'listeners.delete(fn);',
    'const keys = Array.from(map.keys());',
    'const { data } = await supabase.from("entities").select("*").eq("id", x);',
  ].join('\n');
  assert.deepEqual(checkCodeSource('packages/web/src/clean.ts', src), []);
});

test('3. ignores __tests__/ and *.test.ts(x)', () => {
  const bad = 'await supabase.from("entities").delete();';
  assert.deepEqual(checkCodeSource('packages/web/src/__tests__/foo.ts', bad), []);
  assert.deepEqual(checkCodeSource('packages/web/src/foo.test.ts', bad), []);
  assert.deepEqual(checkCodeSource('packages/web/src/foo.test.tsx', bad), []);
});

test('4. migration rule enforces cut-over and rejects later write grants to anon/authenticated', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-writes-mig-'));
  try {
    // No cut-over file -> violation
    fs.writeFileSync(path.join(tmp, '20260101000000_001_init.sql'), 'SELECT 1;\n');
    const noCut = checkMigrationsDir(tmp);
    assert.equal(noCut.violations.length, 1);
    assert.match(noCut.violations[0], /missing \*_client_roles_read_only\.sql/);

    // Cut-over file alone -> passes
    const cutover = path.join(tmp, '20261019090200_141_client_roles_read_only.sql');
    fs.writeFileSync(
      cutover,
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;\n',
    );
    assert.deepEqual(checkMigrationsDir(tmp).violations, []);

    const later = path.join(tmp, '20261020000000_142_later.sql');
    for (const badSql of [
      'grant all on table public.x to authenticated;',
      'GRANT INSERT ON TABLE "public"."x" TO "anon";',
      'alter default privileges in schema public grant insert on tables to authenticated;',
    ]) {
      fs.writeFileSync(later, `${badSql}\n`);
      const res = checkMigrationsDir(tmp);
      assert.equal(res.violations.length, 1, `should flag: ${badSql}`);
    }

    // Allowed later statements: select, execute on function(s), non-table default privileges, comment line
    fs.writeFileSync(
      later,
      [
        'grant select on table public.x to authenticated;',
        'grant execute on function public.my_fn() to authenticated;',
        'grant all on all functions in schema public to authenticated;',
        'alter default privileges in schema public grant all on sequences to authenticated;',
        '-- grant insert on table public.x to authenticated;',
      ].join('\n'),
    );
    assert.deepEqual(checkMigrationsDir(tmp).violations, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('5. exits 2 when a client root has no code files or migrations dir is missing', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'client-writes-empty-'));
  try {
    const resEmpty = runCheck({ clientRoots: [emptyDir], repoRoot: emptyDir });
    assert.equal(resEmpty.code, 2);

    const codeFile = path.join(emptyDir, 'index.ts');
    fs.writeFileSync(codeFile, 'export const x = 1;\n');
    const resMissingMig = runCheck({
      clientRoots: [emptyDir],
      migrationsDir: path.join(emptyDir, 'no-such-migrations'),
      repoRoot: emptyDir,
    });
    assert.equal(resMissingMig.code, 2);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('6. main([]) on the real tree returns 0', () => {
  assert.equal(main([]), 0);
});
