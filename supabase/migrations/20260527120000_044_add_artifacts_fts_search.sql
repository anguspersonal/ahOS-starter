-- ADR-012 / Phase 0 MCP tool layer: real retrieval for "ask".
-- Adds a generated full-text search vector over artifact text and a GIN index.
-- The MCP search_knowledge tool prefers this column and falls back to ILIKE
-- if it is not present, so applying this is non-breaking.

alter table public.artifacts
	add column if not exists search_vector tsvector
	generated always as (
		to_tsvector(
			'english',
			coalesce(title, '') || ' ' ||
			coalesce(plain_text, '') || ' ' ||
			coalesce(extracted_content, '') || ' ' ||
			coalesce(description, '')
		)
	) stored;

create index if not exists artifacts_search_vector_idx
	on public.artifacts
	using gin (search_vector);
