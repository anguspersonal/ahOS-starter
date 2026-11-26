-- Migration: rationalise artifact provenance — add surface + trust_override
-- ADR: ADR-026 (Rationalised Provenance & Derived Trust)
-- Date: 2026-06-27
--
-- Artifacts already carry source (locus/url) and source_channel (broad class).
-- ADR-026 adds:
--   * surface       — the specific app/agent/ingest path a capture came through
--                     (finer than source_channel; OPEN vocab, so a free text col).
--   * trust_override — an optional per-artifact trust tier that overrides the
--                     value normally DERIVED at read time from the user's
--                     surface→trust map. Trust itself is NOT stored (capture is
--                     dumb; the tier is computed on read), so there is no `trust`
--                     column — only this exception hook.
-- captured_by already exists; it stays the actor, not the surface.

ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS surface text;

ALTER TABLE public.artifacts
  ADD COLUMN IF NOT EXISTS trust_override text
  CHECK (trust_override IS NULL OR trust_override = ANY (ARRAY[
    'perfect'::text, 'high'::text, 'medium'::text, 'low'::text, 'unverified'::text
  ]));

COMMENT ON COLUMN public.artifacts.surface IS
  'Specific app/agent/ingest path the capture came through (e.g. claude_code, gmail_ingest). Finer than source_channel; open vocab. See ADR-026.';
COMMENT ON COLUMN public.artifacts.trust_override IS
  'Optional per-artifact trust tier overriding the value derived at read from the surface→trust map. NULL = derive normally. See ADR-026.';
