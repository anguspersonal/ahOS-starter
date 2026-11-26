/**
 * Unit tests for the golden-extraction exporter's pure shaping logic.
 *
 * The script itself is plain CommonJS (matches sibling worker scripts, e.g.
 * seed-foaf-relationships.js), so it's required directly rather than imported.
 * Only the pure functions (no Supabase I/O) are exercised here.
 */

// Makes this a module rather than a global script, so its top-level `const`s
// cannot collide with a sibling script test destructuring the same names — see
// the note in check-migration-versions.test.ts.
export {};

const {
	shapeGoldenRecord,
	propertiesSubset,
} = require('../../../scripts/export-golden-extractions');

describe('propertiesSubset', () => {
	it('picks known keys and drops the rest', () => {
		const result = propertiesSubset({
			role: 'sister',
			organization: 'Acme',
			favorite_color: 'blue', // not in the allowlist
			relation: 'sibling',
		});
		expect(result).toEqual({
			role: 'sister',
			organization: 'Acme',
			relation: 'sibling',
		});
	});

	it('omits null/undefined values', () => {
		const result = propertiesSubset({ role: null, organization: undefined, email: 'a@example.com' });
		expect(result).toEqual({ email: 'a@example.com' });
	});

	it('returns an empty object for null/non-object input', () => {
		expect(propertiesSubset(null)).toEqual({});
		expect(propertiesSubset(undefined)).toEqual({});
		expect(propertiesSubset('not an object')).toEqual({});
	});
});

describe('shapeGoldenRecord', () => {
	const artifact = {
		id: 'artifact-1',
		captured_at: '2026-01-01T00:00:00.000Z',
		created_at: '2026-01-02T00:00:00.000Z',
		plain_text: 'Anne Hally is my sister. She works at Acme.',
		processing_metadata: {
			golden_extraction: {
				marked_at: '2026-07-05T00:00:00.000Z',
				status: 'approved',
				notes: 'corrected sibling edge',
			},
		},
	};

	const entities = [
		{ id: 'e-anne', entity_type: 'people', title: 'Anne Hally', properties: { role: 'sister', organization: 'Acme' } },
		{ id: 'e-self', entity_type: 'people', title: 'Me', properties: { is_self: true } },
	];

	const edges = [
		{ from_entity_id: 'e-anne', to_entity_id: 'e-self', relationship_type: 'siblingOf', notes: null },
	];

	it('maps artifact + entities + edges into the export shape', () => {
		const record = shapeGoldenRecord(artifact, entities, edges);

		expect(record.artifact_id).toBe('artifact-1');
		expect(record.captured_at).toBe('2026-01-01T00:00:00.000Z');
		expect(record.input).toBe('Anne Hally is my sister. She works at Acme.');

		expect(record.labels.entities).toEqual([
			{ title: 'Anne Hally', entity_type: 'people', properties_subset: { role: 'sister', organization: 'Acme' } },
			{ title: 'Me', entity_type: 'people', properties_subset: { is_self: true } },
		]);

		expect(record.labels.edges).toEqual([
			{ from_title: 'Anne Hally', relationship_type: 'siblingOf', to_title: 'Me', notes: null },
		]);

		expect(record.refs.entities).toEqual([
			{ id: 'e-anne', title: 'Anne Hally' },
			{ id: 'e-self', title: 'Me' },
		]);
		expect(record.refs.edges).toEqual([
			{ from_id: 'e-anne', relationship_type: 'siblingOf', to_id: 'e-self' },
		]);

		expect(record.meta).toEqual({
			marked_at: '2026-07-05T00:00:00.000Z',
			status: 'approved',
			notes: 'corrected sibling edge',
		});
	});

	it('falls back to created_at when captured_at is missing', () => {
		const record = shapeGoldenRecord({ ...artifact, captured_at: null }, entities, edges);
		expect(record.captured_at).toBe('2026-01-02T00:00:00.000Z');
	});

	it('defaults input to an empty string when plain_text is missing', () => {
		const record = shapeGoldenRecord({ ...artifact, plain_text: null }, [], []);
		expect(record.input).toBe('');
	});

	it('returns null meta when processing_metadata.golden_extraction is absent', () => {
		const record = shapeGoldenRecord({ ...artifact, processing_metadata: {} }, [], []);
		expect(record.meta).toBeNull();
	});

	it('handles artifacts with no linked entities or edges', () => {
		const record = shapeGoldenRecord(artifact, [], []);
		expect(record.labels.entities).toEqual([]);
		expect(record.labels.edges).toEqual([]);
		expect(record.refs.entities).toEqual([]);
		expect(record.refs.edges).toEqual([]);
	});

	it('resolves edge endpoint titles even when entities is a partial set', () => {
		// An edge referencing an entity id not present in `entities` should
		// degrade to null titles rather than throwing.
		const partialEdges = [
			{ from_entity_id: 'e-anne', to_entity_id: 'unknown-id', relationship_type: 'knows', notes: 'test' },
		];
		const record = shapeGoldenRecord(artifact, [entities[0]], partialEdges);
		expect(record.labels.edges).toEqual([
			{ from_title: 'Anne Hally', relationship_type: 'knows', to_title: null, notes: 'test' },
		]);
	});
});
