/**
 * Unit tests for the worker's minimal embed-on-write client (#882, ADR-047
 * §2 follow-up to #551).
 */

const mockCreate = jest.fn();

jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    embeddings: { create: mockCreate },
  }));
});

// retryWithBackoff's own retry/backoff mechanics are this module's existing
// behavior, not something embeddings.ts needs to reprove; stub it to a single
// pass-through call so a provider-failure test below doesn't sit through real
// backoff delays (2s/4s/8s).
jest.mock('../../../src/utils/retry', () => ({
  retryWithBackoff: (fn: () => Promise<unknown>) => fn(),
}));

import { supabase } from '../../../src/utils/supabase';
import { embedEntityText, embedEntityAndStore } from '../../../src/utils/embeddings';

const mockSupabase = supabase as jest.Mocked<typeof supabase>;

describe('embedEntityText', () => {
  it('joins title, description, and role/organization/relationship properties', () => {
    const text = embedEntityText({
      title: 'David Lynch',
      description: 'Filmmaker',
      properties: { role: 'Director', organization: 'Lynch Films', relationship: 'colleague' },
    });
    expect(text).toBe('David Lynch\n\nFilmmaker\n\nDirector\n\nLynch Films\n\ncolleague');
  });

  it('drops missing fields rather than emitting empty segments', () => {
    const text = embedEntityText({ title: 'David Lynch', description: null, properties: {} });
    expect(text).toBe('David Lynch');
  });

  it('returns empty string when there is nothing to embed', () => {
    expect(embedEntityText({})).toBe('');
  });
});

describe('embedEntityAndStore', () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...OLD_ENV };
    delete process.env.GEMINI_API_KEY;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('skips without calling the provider or the DB when OPENAI_API_KEY is unset', async () => {
    delete process.env.OPENAI_API_KEY;

    const outcome = await embedEntityAndStore('entity-1', { title: 'David Lynch' });

    expect(outcome).toBe('skipped');
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('skips when there is no embeddable text, even with a key configured', async () => {
    process.env.OPENAI_API_KEY = 'test-key';

    const outcome = await embedEntityAndStore('entity-1', { title: null, description: null, properties: {} });

    expect(outcome).toBe('skipped');
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('embeds and writes the vector to entities.embedding on success', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({ data: [{ embedding: [0.1, 0.2, 0.3] }] });

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn().mockReturnValue({ eq: updateEq });
    (mockSupabase.from as jest.Mock).mockReturnValue({ update });

    const outcome = await embedEntityAndStore('entity-1', { title: 'David Lynch' });

    expect(outcome).toBe('embedded');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'David Lynch' }),
    );
    expect(mockSupabase.from).toHaveBeenCalledWith('entities');
    expect(update).toHaveBeenCalledWith({ embedding: JSON.stringify([0.1, 0.2, 0.3]) });
    expect(updateEq).toHaveBeenCalledWith('id', 'entity-1');
  });

  it('never throws and leaves the row untouched when the provider call fails', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockCreate.mockRejectedValue(new Error('provider down'));

    const outcome = await embedEntityAndStore('entity-1', { title: 'David Lynch' });

    expect(outcome).toBe('failed');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('never throws and reports failed when the DB write errors', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({ data: [{ embedding: [0.1] }] });

    const updateEq = jest.fn().mockResolvedValue({ error: { message: 'db down' } });
    const update = jest.fn().mockReturnValue({ eq: updateEq });
    (mockSupabase.from as jest.Mock).mockReturnValue({ update });

    const outcome = await embedEntityAndStore('entity-1', { title: 'David Lynch' });

    expect(outcome).toBe('failed');
  });

  it('never throws and reports failed when the OpenAI response has no embedding data', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({ data: [] });

    const outcome = await embedEntityAndStore('entity-1', { title: 'David Lynch' });

    expect(outcome).toBe('failed');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('never throws and reports failed when the OpenAI response embedding is not an array', async () => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockCreate.mockResolvedValue({ data: [{ embedding: 'not-an-array' }] });

    const outcome = await embedEntityAndStore('entity-1', { title: 'David Lynch' });

    expect(outcome).toBe('failed');
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('prefers Gemini 1536d embeddings over OpenAI when GEMINI_API_KEY is set (#1974)', async () => {
    process.env.GEMINI_API_KEY = 'gemini-secret-key';
    process.env.OPENAI_API_KEY = 'openai-fallback-key';
    const origFetch = global.fetch;
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ embedding: { values: [0.4, 0.5, 0.6] } }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const updateEq = jest.fn().mockResolvedValue({ error: null });
    const update = jest.fn().mockReturnValue({ eq: updateEq });
    (mockSupabase.from as jest.Mock).mockReturnValue({ update });

    try {
      const outcome = await embedEntityAndStore('entity-1', { title: 'David Lynch' });

      expect(outcome).toBe('embedded');
      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringMatching(/\/v1beta\/models\/gemini-embedding-001:embedContent$/),
        expect.objectContaining({
          method: 'POST',
          headers: {
            'x-goog-api-key': 'gemini-secret-key',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'models/gemini-embedding-001',
            content: { parts: [{ text: 'David Lynch' }] },
            outputDimensionality: 1536,
          }),
        }),
      );
      expect(update).toHaveBeenCalledWith({ embedding: JSON.stringify([0.4, 0.5, 0.6]) });
    } finally {
      global.fetch = origFetch;
    }
  });
});
