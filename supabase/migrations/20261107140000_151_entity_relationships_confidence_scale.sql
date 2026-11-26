-- Migration 151: Unify entity_relationships.confidence_score to the 0.0-1.0 scale (#1979)
-- Normalizes legacy 1 < confidence_score <= 100 rows to 0.0-1.0, tightens the CHECK
-- constraint to [0, 1], and documents the canonical scale and artifact file columns.

SET statement_timeout = '5min';

UPDATE public.entity_relationships
   SET confidence_score = round(confidence_score / 100.0, 4)
 WHERE confidence_score > 1;

ALTER TABLE public.entity_relationships
  DROP CONSTRAINT IF EXISTS entity_relationships_confidence_score_check;

ALTER TABLE public.entity_relationships
  ADD CONSTRAINT entity_relationships_confidence_score_check
  CHECK (confidence_score >= 0 AND confidence_score <= 1);

COMMENT ON COLUMN public.entity_relationships.confidence_score IS 'Edge confidence on the canonical 0.0-1.0 scale (unified with artifact_entity_links.confidence_score and system_decisions.confidence_score in migration 151, #1979). Legacy 1 < x <= 100 values are normalized to 0.0-1.0 at the entity_relate boundary and backfilled in migration 151.';

COMMENT ON COLUMN public.artifacts.original_file_name IS 'Exact filename at upload; never overwritten. Used for extension and display when semantic filename is set (filename is updated post-analysis in analyze.ts; #1979).';

COMMENT ON COLUMN public.artifacts.file_type IS 'MIME type of the artifact (distinct from content_type, which is ''text'' | ''binary'' in the worker pipeline; #1979).';

COMMENT ON COLUMN public.artifacts.content_type IS 'Worker pipeline content classification (''text'' | ''binary''), distinct from file_type MIME type (#1979).';
