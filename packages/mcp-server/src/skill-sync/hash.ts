import { createHash } from "node:crypto";

// Canonical hashing for skill bodies (ADR: ahkms as source of truth for
// single-file skills). Local files and the ahkms body must hash equal when they
// carry the same content, so we normalise incidental whitespace before hashing:
//   - CRLF / lone CR -> LF
//   - strip trailing spaces/tabs per line
//   - drop trailing blank lines, then re-add exactly one trailing newline
// The `x-upstream` frontmatter block is intentional body content and is hashed
// like everything else — it is NOT stripped here.

export function canonicalize(text: string): string {
	const lines = text
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => line.replace(/[ \t]+$/g, ""));
	while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length === 0 ? "" : lines.join("\n") + "\n";
}

export function hashBody(text: string): string {
	return createHash("sha256").update(canonicalize(text), "utf8").digest("hex");
}
