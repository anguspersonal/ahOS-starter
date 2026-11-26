// Minimal SKILL.md frontmatter reader — pulls the scalar `name` / `description`
// out of the leading `--- ... ---` block so a push can carry a description
// without a full YAML dependency.
//
// Block scalars (`description: >` / `|`, with the text on following indented
// lines) are handled because real skills use them: `.claude/skills/dogfood`
// does, and the naive version of this reader registered its description as the
// literal string ">". A description is metadata, not load-bearing for hashing —
// the BODY is always the file verbatim — but a capability whose description is
// a punctuation mark is exactly the "looks registered, says nothing" state #689
// is about, so it is worth reading properly.

export interface Frontmatter {
	name?: string;
	description?: string;
}

const KEY = /^(name|description):\s*(.*)$/;
/** A YAML block-scalar header: `>`, `|`, plus optional chomp/indent indicators. */
const BLOCK_SCALAR = /^[|>][+-]?\d*$/;

function unquote(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

/** Consume the indented lines belonging to a block scalar opened at `start`. */
function readBlock(lines: string[], start: number, folded: boolean): { value: string; next: number } {
	const collected: string[] = [];
	let index = start;
	for (; index < lines.length; index++) {
		const line = lines[index];
		if (line.trim() === "") {
			collected.push("");
			continue;
		}
		if (!/^\s/.test(line)) break; // dedented — the block ended
		collected.push(line.trim());
	}
	while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
	// Folded (`>`) joins lines into one paragraph; literal (`|`) keeps the breaks.
	return { value: collected.join(folded ? " " : "\n").trim(), next: index };
}

export function parseFrontmatter(text: string): Frontmatter {
	const norm = text.replace(/\r\n?/g, "\n");
	if (!norm.startsWith("---\n")) return {};
	const end = norm.indexOf("\n---", 3);
	if (end === -1) return {};

	const lines = norm.slice(4, end).split("\n");
	const out: Frontmatter = {};

	for (let index = 0; index < lines.length; index++) {
		const match = KEY.exec(lines[index]);
		if (!match) continue;
		const key = match[1] as "name" | "description";
		const inline = match[2].trim();

		if (BLOCK_SCALAR.test(inline)) {
			const block = readBlock(lines, index + 1, inline.startsWith(">"));
			out[key] = block.value;
			index = block.next - 1;
			continue;
		}

		out[key] = unquote(inline);
	}

	return out;
}
