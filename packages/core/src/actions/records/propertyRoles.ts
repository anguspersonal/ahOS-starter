import { describeProperties, type NotionDatabaseSchema } from "../notion/schemaGuard.js";

// Finding the property that plays a given ROLE in a database (#1059, #1576).
//
// meeting_create takes `start`, `type`, `attendees`. None of those is a Notion property
// name: the Work Meetings database calls its datetime "Event time", the personal
// Meeting Notes database does not, and either could be renamed tomorrow by someone
// dragging a column header. #1059's decision is that structural conventions are
// discovered from the live schema rather than encoded here, so this is the discovery.
//
// The rule that matters is at the bottom of `resolveRole`: **a value the caller supplied
// with nowhere to put it is an error, never a silent drop.** Notion accepts a create
// whose `properties` omit anything it does not recognise, so dropping `attendees`
// because the database has no people property would return a cheerful id for a meeting
// with no attendees. That is ADR-054 §6's defect — a feature that reads as working and
// writes nothing — and it is the whole reason this file is not three lines of
// `schema.properties.find(p => p.name === "Type")`.

export type Role = {
	/** What the caller's argument is called, for error messages. */
	argument: string;
	/** Property names to prefer, in order, matched case-insensitively. */
	preferred: string[];
	/** Notion property types that can carry this role. */
	types: string[];
};

export const PILLARS_ROLE = "pillars";

export const ROLES = {
	meetingDate: { argument: "start", preferred: ["Event time", "Date", "When"], types: ["date"] },
	meetingType: { argument: "type", preferred: ["Type", "Meeting type"], types: ["select"] },
	attendees: { argument: "attendees", preferred: ["Attendees", "Participants"], types: ["people"] },
	external: {
		argument: "external",
		preferred: ["External", "External attendees", "Contacts"],
		types: ["relation"],
	},
	sourceUrl: { argument: "source_url", preferred: ["Source", "Source URL", "URL", "Link"], types: ["url"] },
	contactType: { argument: "contact_type", preferred: ["Contact Type", "Type"], types: ["select"] },
	email: { argument: "email", preferred: ["Email", "Email address"], types: ["email"] },
	company: { argument: "company", preferred: ["Company", "Organisation", "Organization"], types: ["rich_text", "select", "relation"] },
	contactRole: { argument: "role", preferred: ["Role", "Job title", "Title"], types: ["rich_text", "select"] },
	pillars: { argument: "pillars", preferred: ["Pillars"], types: ["multi_select"] },
} as const satisfies Record<string, Role>;

/**
 * The property playing `role`, or null when the database has none.
 *
 * Preference order is: an exact (case-insensitive) name match of the right type, then
 * the database's only property of one of those types. The second clause is what lets
 * the personal Meeting Notes database work without being told its column names, and
 * the first is what stops "Type" on a database with two selects being a coin toss.
 */
export function findRole(schema: NotionDatabaseSchema, role: Role): string | null {
	const candidates = schema.properties.filter((p) => role.types.includes(p.type));
	if (candidates.length === 0) return null;

	for (const wanted of role.preferred) {
		const hit = candidates.find((p) => p.name.toLowerCase() === wanted.toLowerCase());
		if (hit) return hit.name;
	}

	return candidates.length === 1 ? candidates[0].name : null;
}

/**
 * The property playing `role`, insisting that one exists because the caller supplied a
 * value for it. `explicit` lets a caller name the property outright when the database is
 * ambiguous — two date properties, say — rather than being stuck.
 */
export function resolveRole(
	schema: NotionDatabaseSchema,
	role: Role,
	databaseId: string,
	explicit?: string,
): string {
	if (explicit) {
		const hit = schema.properties.find((p) => p.name === explicit);
		if (!hit) {
			throw new Error(
				`'${explicit}' is not a property of Notion database ${databaseId}. Its properties are: ${describeProperties(schema)}`,
			);
		}
		if (!role.types.includes(hit.type)) {
			throw new Error(
				`'${explicit}' is of type '${hit.type}', which cannot carry \`${role.argument}\` (needs ${role.types.join(" or ")}).`,
			);
		}
		return explicit;
	}

	const found = findRole(schema, role);
	if (found) return found;

	const candidates = schema.properties.filter((p) => role.types.includes(p.type));
	if (candidates.length === 0) {
		throw new Error(
			[
				`You passed \`${role.argument}\`, but Notion database ${databaseId} has no ${role.types.join(" or ")} property to put it in. Nothing was written.`,
				`Notion would have accepted the create and silently ignored it, so this is refused instead.`,
				`Its properties are: ${describeProperties(schema)}`,
			].join("\n"),
		);
	}
	throw new Error(
		[
			`\`${role.argument}\` is ambiguous on Notion database ${databaseId}: ${candidates.length} properties could carry it (${candidates.map((p) => p.name).join(", ")}), and none is named ${role.preferred.map((n) => `'${n}'`).join(" or ")}.`,
			`Pass \`${role.argument}_property\` to name the one you mean. Nothing was written.`,
		].join("\n"),
	);
}

/** Assert a select-like value is one the database already declares. */
export function assertOption(
	schema: NotionDatabaseSchema,
	propertyName: string,
	value: string,
	argument: string,
): void {
	const declared = schema.properties.find((p) => p.name === propertyName);
	const options = declared?.options ?? [];
	if (options.includes(value)) return;
	throw new Error(
		[
			`\`${argument}: '${value}'\` is not an option of '${propertyName}'. Nothing was written, and nothing was created: Notion would have ADDED the option rather than rejecting it.`,
			`Its options are: ${options.length > 0 ? options.join(" | ") : "(none declared)"}`,
		].join("\n"),
	);
}
