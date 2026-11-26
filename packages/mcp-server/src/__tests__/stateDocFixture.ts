import type { NotionBlock, NotionRichTextRun } from "../notion.js";

// A fixture of the real State Doc's SHAPE (not its content): a header callout whose
// governance lines sit in one block's rich text, then a run of `##` sections with a
// single stray `#` among them. That stray `#` is the whole reason ADR-053 chose the
// flat-span rule — under the conventional "next heading of the same or higher level"
// rule, replacing `This week focus` would swallow every section after it.

let counter = 0;
function id(prefix: string): string {
	counter += 1;
	return `${prefix}-${counter}`;
}

function runs(...parts: [string, Record<string, unknown>?][]): NotionRichTextRun[] {
	return parts.map(([content, annotations]) => ({
		type: "text",
		text: { content },
		plain_text: content,
		...(annotations ? { annotations } : {}),
	}));
}

function block(type: string, richText: NotionRichTextRun[], extra: Record<string, unknown> = {}): NotionBlock {
	return { id: id(type), type, [type]: { rich_text: richText, ...extra } };
}

function heading(level: 1 | 2 | 3, text: string): NotionBlock {
	return block(`heading_${level}`, runs([text]));
}

function para(text: string): NotionBlock {
	return block("paragraph", runs([text]));
}

function bullet(text: string): NotionBlock {
	return block("bulleted_list_item", runs([text]));
}

/**
 * The header callout, with `Last updated`, `Sole writer` and `Read by` as three lines
 * of ONE block's rich text, and bold labels split across runs — the arrangement that
 * makes "rewrite only the Last updated line" a real constraint rather than a trivial one.
 */
export const CALLOUT_RUNS: NotionRichTextRun[] = runs(
	["📌 ", { bold: false }],
	["Last updated:", { bold: true }],
	[" 2026-07-27 (dos-hl)\n"],
	["Sole writer:", { bold: true }],
	[" dos-hl ritual\n"],
	["Read by:", { bold: true }],
	[" every operating-partner session"],
);

/** A fresh copy of the fixture page. Mutating tests must not share block objects. */
export function stateDocFixture(): NotionBlock[] {
	counter = 0;
	return [
		{ id: id("callout"), type: "callout", callout: { rich_text: CALLOUT_RUNS, icon: { emoji: "📌" } } },
		para("If something here conflicts with the most recent Daily Log entry, this State Doc wins."),

		heading(2, "🏢 Company snapshot"),
		para("Seed-stage, 4 people, London."),
		bullet("Runway: 14 months"),

		// The stray `#`, second among the headings, with every heading after it at `##`.
		heading(1, "🎯 This week focus — Week 27 Jul – 2 Aug 2026"),
		bullet("Ship the 4.8 resubmission"),
		bullet("Close the Bri intro loop"),

		heading(2, "📌 Open Actions"),
		bullet("Chase Mitesh for PR fix ETA"),
		bullet("Test SIWA on device"),

		heading(2, "📣 Recent communications log"),
		bullet("27 Jul: chased Mitesh on PR ETA"),

		heading(2, "🚧 Known blockers"),
		bullet("Apple review 4.8 gate"),

		heading(2, "🧱 Tech stack"),
		para("Next.js, Supabase, Railway."),

		heading(2, "⚖️ Legal / Compliance"),
		para("DPA with the pilot customer signed 12 Jun."),
	];
}

/**
 * Render the page to `heading → section text`, one line per block. Used to assert that
 * a section write left every OTHER section byte-identical.
 */
export function renderSections(blocks: NotionBlock[]): Record<string, string> {
	const out: Record<string, string> = {};
	let current = "(page header)";
	let lines: string[] = [];

	const flush = () => {
		out[current] = lines.join("\n");
	};

	for (const b of blocks) {
		const richText = (b[b.type] as { rich_text?: NotionRichTextRun[] } | undefined)?.rich_text ?? [];
		const text = richText.map((r) => r.plain_text ?? r.text?.content ?? "").join("");
		if (b.type.startsWith("heading_")) {
			flush();
			current = text.trim();
			lines = [];
			continue;
		}
		lines.push(`${b.type}\t${text}`);
	}
	flush();

	return out;
}
