-- Migration 138: Create public.review_lessons table
-- Records lessons with a cooling-off window when the owner rejects a suggestion. Cites ADR-100 §1 and issue #1649.

SET statement_timeout = '15s';

CREATE TABLE IF NOT EXISTS public.review_lessons (
  id                 uuid        NOT NULL DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decision_id        uuid        NOT NULL REFERENCES public.system_decisions(id) ON DELETE CASCADE,
  decision_type      text        NOT NULL,
  subject_key        text        NOT NULL,
  category           text        NOT NULL CHECK (category IN ('not_wanted', 'wrong', 'not_now', 'duplicate')),
  summary            text        NOT NULL CHECK (char_length(summary) <= 500),
  cooling_off_until  timestamptz,
  created_at         timestamptz NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT review_lessons_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_review_lessons_user_type_subject
  ON public.review_lessons (user_id, decision_type, subject_key);

ALTER TABLE public.review_lessons ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own review_lessons" ON public.review_lessons;
CREATE POLICY "Users can view own review_lessons"
ON public.review_lessons AS PERMISSIVE FOR SELECT TO public
USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own review_lessons" ON public.review_lessons;
CREATE POLICY "Users can insert own review_lessons"
ON public.review_lessons AS PERMISSIVE FOR INSERT TO public
WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own review_lessons" ON public.review_lessons;
CREATE POLICY "Users can update own review_lessons"
ON public.review_lessons AS PERMISSIVE FOR UPDATE TO public
USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own review_lessons" ON public.review_lessons;
CREATE POLICY "Users can delete own review_lessons"
ON public.review_lessons AS PERMISSIVE FOR DELETE TO public
USING (auth.uid() = user_id);
