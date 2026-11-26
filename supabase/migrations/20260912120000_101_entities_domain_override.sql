-- Migration: entities.domain_override — the residue/correction memo for ADR-084
-- ADR: ADR-084 (An entity's domain is derived by rule; the residue is a stored override)
-- Issue: #935
-- Date: 2026-09-12
--
-- ADR-057 §7 settled that an entity has exactly one `domain` (the dos routing
-- home, `work` | `angus` — ADR-051 §1) and left open how it is ASSIGNED and
-- WHERE it is stored. ADR-084 answers both: domain is derived at read time, in
-- order —
--   1. `domain_override` (this column), if set;
--   2. PARA containment (the primary `belongs_to` edge, ADR-049) — a thing
--      inherits its container's domain;
--   3. the `domain_signals` classifier already shipped for the `dos` ritual's
--      atom-level routing (ADR-054 §5, `user_preferences.dos_config`).
-- Only the residue neither reaches — or a human correcting a wrong rule
-- answer — is EVER written here. This is deliberately NOT a domain column
-- asserted on every row: that shape was the one `docs/vision.md` argued
-- against (multi-membership forcing duplication), and ADR-057 §7 shows that
-- argument lapsed with multi-membership, not that every row now needs a
-- stamped value. Mirrors `artifacts.trust_override` exactly (migration 055 /
-- ADR-026): the derived concept is never itself a column; only the exception
-- hook is.
--
-- NOT the same "domain" as `entities.entity_type = 'domain'` (migration 075 /
-- ADR-019 §4) — those rows are binding-layer SCOPE NODES for `create_binding`
-- resolution (seeded `work`/`personal`, a naming drift ADR-057 §7 already
-- flagged), unrelated to the dos routing axis this column answers. This
-- column is an ordinary property on an ordinary entity row, never a pointer
-- to one of those nodes — conflating the two would resurrect the exact
-- "domain collides across axes" failure #701/ADR-054 §2 already fixed once.
--
-- Deliberately unwired here: no resolver, no MCP tool surface change, no
-- skill update. This migration lands the storage half of the decision only;
-- the read-side resolver (containment walk + domain_signals + this override,
-- wired into entities/people reads and the `process_artifact`/`dos` skills)
-- is follow-up execution, named in ADR-084's Consequences.

ALTER TABLE public.entities
  ADD COLUMN IF NOT EXISTS domain_override text
  CHECK (domain_override IS NULL OR domain_override = ANY (ARRAY[
    'work'::text, 'angus'::text
  ]));

COMMENT ON COLUMN public.entities.domain_override IS
  'Optional, narrow exception hook (ADR-084): NULL for the ordinary case, where domain is derived at read via PARA containment then the domain_signals classifier. Set only for the residue neither rule reaches, or to correct a wrong derivation — once set, this value is read verbatim and is never re-derived. Values match packages/mcp-server/src/domains.ts DOMAINS (work, angus); keep the CHECK in sync by hand if that set changes. Not the entity_type=''domain'' binding-scope node (migration 075) — an unrelated axis.';
