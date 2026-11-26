/**
 * Shared artifact title derivation.
 *
 * Every artifact-creation path (capture MCP tool, drive_ingest, web_upload via
 * the worker, etc.) needs a non-null `title` at insert time — a null title
 * renders as "(untitled)" in search (see issue #131). Rather than each writer
 * re-implementing "first line of text, truncated" with its own edge cases and
 * length limit, they should all call this helper.
 *
 * Precedence: explicit title > first non-blank line of text content
 * (truncated) > filename (extension stripped) > `null` (caller decides the
 * final fallback, e.g. 'Untitled', if even a filename isn't available).
 */

const DEFAULT_MAX_TITLE_LENGTH = 120;

/**
 * Derive a title from free-text content: the first non-blank line, trimmed
 * and truncated. Returns `null` if the text has no non-blank line (empty or
 * whitespace-only content) so callers can fall back to a filename or a
 * static default instead of persisting an empty string.
 */
export function deriveTitleFromText(
  text: string | null | undefined,
  maxLength: number = DEFAULT_MAX_TITLE_LENGTH,
): string | null {
  if (!text) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return trimmed.slice(0, maxLength);
    }
  }

  return null;
}

/**
 * Derive a human-friendly title from a filename by stripping its extension.
 * Returns `null` for an empty/missing filename, or for an extension-only
 * filename (e.g. `.txt`, `.gitignore`-style dotfiles with no basename) whose
 * stripped result would itself be empty, so callers never persist `''`.
 */
export function deriveTitleFromFilename(filename: string | null | undefined): string | null {
  if (!filename) {
    return null;
  }

  const trimmed = filename.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const stripped = trimmed.replace(/\.[^./\\]+$/, '');
  return stripped.length > 0 ? stripped : null;
}

/**
 * Options for {@link deriveArtifactTitle}.
 */
export interface DeriveArtifactTitleInput {
  /** Explicit title supplied by the caller/user, if any. */
  explicitTitle?: string | null;
  /** Free-text content of the artifact (note body, pasted text, extracted text), if any. */
  text?: string | null;
  /** Original/uploaded filename, used when there's no usable text content. */
  filename?: string | null;
  /** Max length for a text-derived title. Defaults to 120 (matches the `capture` MCP tool). */
  maxLength?: number;
}

/**
 * Single entry point every artifact writer should call to compute a title at
 * insert time: explicit title, else first line of text, else filename
 * (extension stripped), else `null`. Never returns an empty string — each
 * derivation step already normalizes `''` to `null`, and the `|| null` below
 * is a final guard so this guarantee holds even if a future step regresses.
 */
export function deriveArtifactTitle(input: DeriveArtifactTitleInput): string | null {
  const explicit = input.explicitTitle?.trim();
  if (explicit) {
    return explicit;
  }

  const fromText = deriveTitleFromText(input.text, input.maxLength);
  if (fromText) {
    return fromText;
  }

  const fromFilename = deriveTitleFromFilename(input.filename);
  return fromFilename || null;
}
