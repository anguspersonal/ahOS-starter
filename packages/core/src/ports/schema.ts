/**
 * One column, as PostgREST describes it.
 *
 * `type` is the Postgres type (PostgREST puts it in OpenAPI's `format`); `jsonType` is
 * the JSON shape it serialises to. Both are reported because they disagree in the cases
 * that matter most: a `numeric` column is `type: number` in JSON but arrives as a string
 * over the wire, and a `timestamptz` is `type: string`.
 */
export type SchemaColumn = {
	name: string;
	/** Postgres type, e.g. 'uuid', 'text', 'timestamp with time zone', 'jsonb'. */
	type: string;
	/** JSON type the column serialises to, e.g. 'string', 'integer', 'array'. */
	jsonType: string;
	/**
	 * True when PostgREST lists the column in the definition's `required` array. That
	 * means "must be supplied on INSERT" — NOT NULL *and* no default. It is NOT the same
	 * as NOT NULL: a NOT NULL column with a default (`id uuid default gen_random_uuid()`,
	 * `created_at timestamptz default now()`) is not required here. The distinction is
	 * named in the rendering rather than papered over as "nullable", because reading it
	 * as nullability is wrong in exactly the columns a caller is most likely to check.
	 */
	requiredOnInsert: boolean;
	/** Allowed values, when the column is a Postgres enum. */
	enumValues?: string[];
	/** PostgREST's note field: column comment, plus its `<pk/>` / `<fk .../>` markers. */
	description?: string;
};

export type SchemaTable = {
	name: string;
	columns: SchemaColumn[];
};

/** PostgREST's OpenAPI 2.0 document, narrowed to the parts `store_schema` reads. */
export type OpenApiDoc = {
	definitions?: Record<
		string,
		{
			required?: string[];
			properties?: Record<
				string,
				{ format?: string; type?: string; enum?: string[]; description?: string }
			>;
		}
	>;
};

export interface SchemaIntrospectionPort {
	fetchOpenApi(): Promise<OpenApiDoc>;
}
