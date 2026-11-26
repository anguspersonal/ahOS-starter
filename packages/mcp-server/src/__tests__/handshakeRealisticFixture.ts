/**
 * A handshake fixture at real sizes (#2346). Every name, rule and gloss is made up;
 * only the lengths are modelled on the live config. server.test.ts asserts the size
 * floors, which must not be shrunk to make an order test pass.
 */
import { dosConfigSchema } from "../dosConfig.js";
import type { HotTierRow } from "../hotTier.js";

const SUBJECTS = [
	"status updates", "meeting notes", "investor emails", "pull request bodies", "issue comments",
	"release notes", "handover notes", "weekly summaries", "design proposals", "review findings",
	"error reports", "chat replies", "calendar invites", "task titles", "commit messages",
	"decision records", "research briefs", "onboarding guides", "customer replies", "board papers",
	"runbooks", "retrospectives", "hiring notes", "roadmap entries", "incident timelines",
];

const tone = SUBJECTS.map((subject, i) =>
	`Sample rule ${i + 1}: in ${subject}, lead with the outcome, use plain words and cut what the reader would skip.`);

const operating_principles = [
	"evidence first", "smallest change", "one home per fact", "say what was not checked",
	"stop at a fork", "tests before code", "name the owner", "leave the tree clean",
].map((name, i) =>
	`Sample principle ${i + 1} (${name}): apply it before any write, and state in the reply where it changed what was done.`);

const types = ["note", "decision", "lesson", "question", "reference", "meeting", "task", "idea"].map((key) => ({
	key,
	description: `A made-up ${key} atom: one self-contained ${key} with its source, its date and the people it concerns.`,
}));

const audiences = ["board", "investors", "team", "partners", "advisers", "family"].map((key, i) => ({
	key,
	role: `sample ${key} readers`,
	domain: i < 4 ? "workplace" : "home",
	cadence: i % 2 === 0 ? "weekly" : "monthly",
	register: `Short and concrete for the ${key}: numbers before narrative, no internal shorthand, one ask at the end.`,
	standing_exclusions: [`unconfirmed figures about the ${key}`, "anything marked private"],
}));

const domain = (name: string) => ({
	topics: ["Planning", "Finance", "Hiring", "Product", "Research", "Operations", "Legal", "Outreach"].map((t) => `${name} ${t}`),
	pillars: [1, 2, 3, 4].map((n) => ({
		key: `Pillar ${n}`,
		label: `${name} objective ${n}`,
		description: `Made-up objective ${n} for ${name}.`,
		notion_option: `${name} option ${n}`,
	})),
	domain_signals: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((s) => `${name}-${s}`),
	artefact_registers: ["update", "memo", "brief"].map((key) => ({ key, tone: `plain ${name} ${key} voice` })),
	waiting_on_status: `Waiting on ${name}`,
});

export const realisticDosConfig = dosConfigSchema.parse({
	tone,
	operating_principles,
	types,
	audiences,
	by_domain: { workplace: domain("workplace"), home: domain("home") },
});

const FIRST = ["Avery", "Blake", "Carmen", "Dmitri", "Elena", "Farid", "Greta", "Hugo", "Ines", "Jonas", "Keiko", "Lars", "Mirela", "Nuno", "Odile"];
const LAST = ["Quillfeather", "Marrowind", "Thistledown", "Ashcombe", "Varnholt", "Pennywhistle", "Okonjara", "Stellmach", "Brightwater", "Dunmarrow", "Halvorsen", "Castellane", "Rookwood", "Fenwright", "Lindqvist"];
const ROLES = ["Head of Partnerships", "Finance Lead", "Design Director", "Staff Engineer", "General Counsel"];

const people: HotTierRow[] = FIRST.map((first, i) => ({
	id: `person-${i + 1}`,
	entity_type: "people",
	title: `${first} ${LAST[i]}`,
	description: null,
	properties: { role: ROLES[i % ROLES.length], organization: `Example Org ${i + 1} Ltd` },
	aliases: [first.toLowerCase(), `${first[0]}${LAST[i][0]}`],
}));

const TERMS = ["QBR", "NDA", "ARR", "OKR", "RFP", "SLA", "MOU", "KPI"];
const terms: HotTierRow[] = TERMS.map((title, i) => ({
	id: `term-${i + 1}`,
	entity_type: "term",
	title,
	description: null,
	properties: { expansion: `Made-up expansion number ${i + 1} of ${title}`, context: "sample planning shorthand" },
	aliases: [title.toLowerCase()],
}));

const PROJECTS = ["Lantern", "Harbour", "Juniper", "Meridian", "Saffron", "Tundra", "Willow"];
const others: HotTierRow[] = PROJECTS.map((name, i) => ({
	id: `other-${i + 1}`,
	entity_type: i % 2 === 0 ? "project" : "organization",
	title: `${name} Example`,
	description: `Made-up codename ${i + 1}, a sample workstream`,
	properties: {},
	aliases: [name.toLowerCase()],
}));

/** 30 hot rows: 15 people, then 8 terms and 7 other entities. */
export const realisticHotRows: HotTierRow[] = [...people, ...terms, ...others];
