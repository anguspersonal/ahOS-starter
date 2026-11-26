/**
 * The version-family key for a document title (#1217): the TypeScript mirror of
 * `public.document_title_key`, which migration 119 defines and
 * `document_duplicate_clusters` groups by.
 *
 * The SQL function is the one that runs; nothing at runtime imports this copy. It
 * exists so the normaliser's behaviour is unit-testable without a database, and so
 * a reader can see in one place what "same document, different copy" means.
 *
 * What is pinned, and what is not. The regex patterns below are the strings the
 * migration uses, and a test asserts each appears in it verbatim, so none of them
 * can change on one side only. Step 5 is NOT pinned: SQL's `[^[:alnum:]]+` has no
 * JavaScript spelling, and it follows the database's character classification,
 * while this file uses the Unicode classes (`\p{L}\p{N}`). The two agree on
 * non-ASCII letters ("résumé") under a UTF-8 locale; migration 119's PR carries
 * the one-line check of production's behaviour. Mirrored by intent, not by text.
 *
 * Steps, in order (mirroring the SQL):
 *   1. lower-case, trim spaces;
 *   1b. reject macOS AppleDouble resource forks (`^\._`, e.g. "._Angus Hally CV.pdf");
 *   2. strip a leading "copy of " (repeated);
 *   3. strip the tail in one anchored pass: a trailing " n" copy counter, any
 *      " (n)" counters, a MultCloud-style "-vYYYYMMDDHHMMSS" backup suffix, then a
 *      file extension;
 *   4. split letter/digit runs ("oct2022" -> "oct 2022");
 *   5. collapse every run of non-alphanumerics to one space;
 *   6. drop month names (short and full) and 2- and 4-digit year tokens;
 *   7. trim; an empty result or OS/placeholder junk (`ds store`, `untitled`) is null.
 *
 * The key only ever removes text from a title (and adds spaces), so every token of
 * a key is a substring of the lower-cased title.
 */
export const TITLE_KEY_SQL_PATTERNS = {
	appleDouble: String.raw`^\._`,
	copyOf: String.raw`^(copy of\s+)+`,
	tail: String.raw`(\s+[0-9]+)?(\s*\([0-9]+\))*(-v[0-9]{14})?(\.[a-z0-9]{1,5})?$`,
	letterDigit: String.raw`([a-z])(?=[0-9])|([0-9])(?=[a-z])`,
	dateTokens: String.raw` (?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec|(?:19|20)[0-9]{2}|[0-9]{2})(?= )`,
	junkKey: String.raw`^(?:ds store|untitled)$`,
} as const;

const APPLE_DOUBLE = new RegExp(TITLE_KEY_SQL_PATTERNS.appleDouble);
const COPY_OF = new RegExp(TITLE_KEY_SQL_PATTERNS.copyOf);
const TAIL = new RegExp(TITLE_KEY_SQL_PATTERNS.tail);
const LETTER_DIGIT = new RegExp(TITLE_KEY_SQL_PATTERNS.letterDigit, "g");
// Step 5, mirrored by intent (see the header): SQL's `[^[:alnum:]]+` under a UTF-8
// locale, spelled with the Unicode letter and number classes.
const NON_ALNUM = /[^\p{L}\p{N}]+/gu;
const DATE_TOKENS = new RegExp(TITLE_KEY_SQL_PATTERNS.dateTokens, "g");
const JUNK_KEY = new RegExp(TITLE_KEY_SQL_PATTERNS.junkKey);

/** Postgres `btrim(s)`: trims spaces only, unlike String.prototype.trim. */
function btrim(s: string): string {
	return s.replace(/^ +| +$/g, "");
}

/** The family key for `title`, or null when the title normalises to nothing. */
export function documentTitleKey(title: string | null | undefined): string | null {
	if (title == null) return null;
	let s = btrim(title.toLowerCase());
	if (APPLE_DOUBLE.test(s)) return null;
	s = s.replace(COPY_OF, "");
	s = s.replace(TAIL, "");
	s = s.replace(LETTER_DIGIT, "$1$2 ");
	s = ` ${s.replace(NON_ALNUM, " ")} `;
	s = btrim(s.replace(DATE_TOKENS, ""));
	return s === "" || JUNK_KEY.test(s) ? null : s;
}
