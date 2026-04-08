'use strict';

const request = require('supertest');

// ─── Module mocks (hoisted before any require) ────────────
jest.mock('pgvector', () => ({ toSql: jest.fn((v) => v) }));

// Shared mock pool — mutated per-test to simulate DB responses.
const mockPool = { query: jest.fn() };
jest.mock('../../lib/db', () => ({
  createPool: jest.fn(() => mockPool),
  getDatabaseUrl: jest.fn(),
}));

// ─── Environment setup ────────────────────────────────────
const VALID_KEY = 'test-access-key';

beforeAll(() => {
  process.env.MCP_ACCESS_KEY = VALID_KEY;
});

afterAll(() => {
  delete process.env.MCP_ACCESS_KEY;
});

// Require app after env vars are configured
let app;
beforeAll(() => {
  app = require('../../server').app;
});

beforeEach(() => {
  mockPool.query.mockReset();
  global.fetch = jest.fn();
});

// ─── GET /health ──────────────────────────────────────────
describe('GET /health', () => {
  it('returns 200 with ok status when DB is reachable', async () => {
    mockPool.query
      .mockResolvedValueOnce({})                         // SELECT 1
      .mockResolvedValueOnce({ rows: [{ count: '42' }] }); // COUNT

    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.thoughts).toBe('42');
  });

  it('returns 500 when the DB query fails', async () => {
    mockPool.query.mockRejectedValue(new Error('connection refused'));

    const res = await request(app).get('/health');
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toContain('connection refused');
  });
});

// ─── POST /capture ────────────────────────────────────────
describe('POST /capture', () => {
  it('returns 401 when the access key is missing', async () => {
    const res = await request(app).post('/capture').send({ content: 'hello' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid or missing access key/i);
  });

  it('returns 401 when the access key is wrong', async () => {
    const res = await request(app)
      .post('/capture')
      .set('x-brain-key', 'wrong-key')
      .send({ content: 'hello' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when content is empty', async () => {
    const res = await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({ content: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/i);
  });

  it('returns 400 when content is missing from body', async () => {
    const res = await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/content is required/i);
  });

  it('returns 400 when content exceeds 12000 characters', async () => {
    const longContent = 'a'.repeat(12001);
    const res = await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({ content: longContent });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too long/i);
    expect(res.body.error).toContain('12000');
  });

  it('accepts content up to 12000 characters', async () => {
    const exactMaxContent = 'a'.repeat(12000);
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    });
    // Second fetch call for metadata extraction
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2] }] }),
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ topics: ['test'], type: 'observation' }) } }],
      }),
    });
    mockPool.query.mockResolvedValue({ rows: [{ id: 'new-id', created_at: new Date().toISOString() }] });

    const res = await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({ content: exactMaxContent });
    expect(res.status).toBe(200);
  });

  it('returns 200 with id and metadata on success', async () => {
    const embedding = Array.from({ length: 5 }, (_, i) => i / 10);
    const metadata = { topics: ['work', 'meeting'], type: 'observation', people: [], action_items: [] };

    global.fetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ embedding }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(metadata) } }],
        }),
      });

    mockPool.query.mockResolvedValue({
      rows: [{ id: 'abc-123', created_at: '2025-01-01T00:00:00Z' }],
    });

    const res = await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({ content: 'Had a meeting about project status', source: 'test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.id).toBe('abc-123');
    expect(res.body.metadata).toEqual(metadata);
    expect(typeof res.body.confirmation).toBe('string');
  });

  it('includes source in stored metadata', async () => {
    const embedding = [0.1];
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ topics: ['t'], type: 'idea' }) } }] }),
      });
    mockPool.query.mockResolvedValue({ rows: [{ id: 'id1', created_at: new Date() }] });

    await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({ content: 'Some content', source: 'mobile' });

    const insertCall = mockPool.query.mock.calls[0];
    const storedMeta = insertCall[1][2];
    expect(storedMeta.source).toBe('mobile');
  });

  it('defaults source to "api" when not provided', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ topics: ['t'], type: 'idea' }) } }] }),
      });
    mockPool.query.mockResolvedValue({ rows: [{ id: 'id2', created_at: new Date() }] });

    await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({ content: 'Some content' });

    const insertCall = mockPool.query.mock.calls[0];
    const storedMeta = insertCall[1][2];
    expect(storedMeta.source).toBe('api');
  });

  it('normalizes whitespace in content', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ topics: ['t'], type: 'idea' }) } }] }),
      });
    mockPool.query.mockResolvedValue({ rows: [{ id: 'id3', created_at: new Date() }] });

    await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({ content: '  Hello   world  ' });

    // The stored content should be normalized
    const insertCall = mockPool.query.mock.calls[0];
    const storedContent = insertCall[1][0];
    expect(storedContent).toBe('Hello world');
  });

  it('returns 500 when embedding API fails', async () => {
    // getEmbedding and extractMetadata both call fetch concurrently via Promise.all.
    // First Once → getEmbedding (fails); second Once → extractMetadata (succeeds but
    // is irrelevant because Promise.all rejects on the first failure).
    global.fetch
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () => 'service unavailable',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({ topics: ['t'], type: 'observation' }) } }],
        }),
      });

    const res = await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({ content: 'Some thought' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/embedding failed/i);
  });

  it('returns 500 when DB insert fails', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ topics: ['t'], type: 'idea' }) } }] }),
      });
    mockPool.query.mockRejectedValue(new Error('DB insert failed'));

    const res = await request(app)
      .post('/capture')
      .set('x-brain-key', VALID_KEY)
      .send({ content: 'Some thought' });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('DB insert failed');
  });

  it('accepts key via query parameter', async () => {
    global.fetch
      .mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ embedding: [0.1] }] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ topics: ['t'], type: 'idea' }) } }] }),
      });
    mockPool.query.mockResolvedValue({ rows: [{ id: 'id4', created_at: new Date() }] });

    const res = await request(app)
      .post(`/capture?key=${VALID_KEY}`)
      .send({ content: 'Some thought' });

    expect(res.status).toBe(200);
  });
});

// ─── POST /search ─────────────────────────────────────────
describe('POST /search', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).post('/search').send({ query: 'hello' });
    expect(res.status).toBe(401);
  });

  it('returns 400 when query is missing', async () => {
    const res = await request(app)
      .post('/search')
      .set('x-brain-key', VALID_KEY)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query is required/i);
  });

  it('returns 200 with results on success', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.5, 0.5] }] }),
    });

    const fakeRows = [
      { id: '1', content: 'First result', metadata: {}, created_at: '2025-01-01' },
      { id: '2', content: 'Second result', metadata: {}, created_at: '2025-01-02' },
    ];
    mockPool.query.mockResolvedValue({ rows: fakeRows });

    const res = await request(app)
      .post('/search')
      .set('x-brain-key', VALID_KEY)
      .send({ query: 'test query', limit: 5, threshold: 0.7 });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.results).toHaveLength(2);
  });

  it('passes filter to DB query', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    });
    mockPool.query.mockResolvedValue({ rows: [] });

    await request(app)
      .post('/search')
      .set('x-brain-key', VALID_KEY)
      .send({ query: 'test', filter: { type: 'idea' } });

    const queryArgs = mockPool.query.mock.calls[0];
    expect(queryArgs[1][3]).toBe(JSON.stringify({ type: 'idea' }));
  });

  it('returns 500 when embedding API fails', async () => {
    global.fetch.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'internal error',
    });

    const res = await request(app)
      .post('/search')
      .set('x-brain-key', VALID_KEY)
      .send({ query: 'test' });

    expect(res.status).toBe(500);
  });

  it('returns empty results when no matches found', async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1] }] }),
    });
    mockPool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post('/search')
      .set('x-brain-key', VALID_KEY)
      .send({ query: 'obscure thing nobody said' });

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.results).toEqual([]);
  });
});

// ─── GET /thoughts ────────────────────────────────────────
describe('GET /thoughts', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/thoughts');
    expect(res.status).toBe(401);
  });

  it('returns 200 with list of thoughts', async () => {
    const fakeThoughts = [
      { id: '1', content: 'Thought 1', metadata: { type: 'idea' }, created_at: '2025-01-01' },
    ];
    mockPool.query.mockResolvedValue({ rows: fakeThoughts });

    const res = await request(app)
      .get('/thoughts')
      .set('x-brain-key', VALID_KEY);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.thoughts).toHaveLength(1);
  });

  it('returns empty list when no thoughts exist', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .get('/thoughts')
      .set('x-brain-key', VALID_KEY);

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(0);
    expect(res.body.thoughts).toEqual([]);
  });

  it('passes type filter to query', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await request(app)
      .get('/thoughts?type=idea')
      .set('x-brain-key', VALID_KEY);

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain("metadata->>'type'");
    const params = mockPool.query.mock.calls[0][1];
    expect(params).toContain('idea');
  });

  it('passes topic filter to query', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await request(app)
      .get('/thoughts?topic=ai')
      .set('x-brain-key', VALID_KEY);

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain("metadata->'topics'");
    const params = mockPool.query.mock.calls[0][1];
    expect(params).toContain('ai');
  });

  it('passes person filter to query', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await request(app)
      .get('/thoughts?person=Alice')
      .set('x-brain-key', VALID_KEY);

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toContain("metadata->'people'");
  });

  it('passes days filter to query', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await request(app)
      .get('/thoughts?days=7')
      .set('x-brain-key', VALID_KEY);

    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/interval.*7.*days/i);
  });

  it('applies default limit of 10 when not specified', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await request(app)
      .get('/thoughts')
      .set('x-brain-key', VALID_KEY);

    const params = mockPool.query.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(10);
  });

  it('respects custom limit', async () => {
    mockPool.query.mockResolvedValue({ rows: [] });

    await request(app)
      .get('/thoughts?limit=25')
      .set('x-brain-key', VALID_KEY);

    const params = mockPool.query.mock.calls[0][1];
    expect(params[params.length - 1]).toBe(25);
  });

  it('returns 500 when DB fails', async () => {
    mockPool.query.mockRejectedValue(new Error('DB down'));

    const res = await request(app)
      .get('/thoughts')
      .set('x-brain-key', VALID_KEY);

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('DB down');
  });
});

// ─── GET /stats ───────────────────────────────────────────
describe('GET /stats', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app).get('/stats');
    expect(res.status).toBe(401);
  });

  it('returns 200 with aggregated stats', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: '5' }] }) // total count
      .mockResolvedValueOnce({
        rows: [
          { metadata: { type: 'idea', topics: ['tech', 'ai'], people: ['Alice'] }, created_at: '2025-01-02' },
          { metadata: { type: 'observation', topics: ['tech'], people: [] }, created_at: '2025-01-01' },
          { metadata: { type: 'idea', topics: ['ai'], people: ['Alice', 'Bob'] }, created_at: '2024-12-31' },
        ],
      });

    const res = await request(app)
      .get('/stats')
      .set('x-brain-key', VALID_KEY);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.types).toEqual(expect.arrayContaining([
      { name: 'idea', count: 2 },
      { name: 'observation', count: 1 },
    ]));
    expect(res.body.top_topics).toEqual(expect.arrayContaining([
      { name: 'tech', count: 2 },
      { name: 'ai', count: 2 },
    ]));
    expect(res.body.people_mentioned).toEqual(expect.arrayContaining([
      { name: 'Alice', count: 2 },
    ]));
  });

  it('returns null date_range when there are no thoughts', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: '0' }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/stats')
      .set('x-brain-key', VALID_KEY);

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.date_range).toBeNull();
  });

  it('includes earliest and latest dates in date_range', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: '2' }] })
      .mockResolvedValueOnce({
        rows: [
          { metadata: {}, created_at: '2025-01-10' },
          { metadata: {}, created_at: '2025-01-01' },
        ],
      });

    const res = await request(app)
      .get('/stats')
      .set('x-brain-key', VALID_KEY);

    expect(res.body.date_range.latest).toBe('2025-01-10');
    expect(res.body.date_range.earliest).toBe('2025-01-01');
  });

  it('limits types and topics to top 10', async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      metadata: { type: `type_${i}`, topics: [`topic_${i}`], people: [] },
      created_at: new Date().toISOString(),
    }));

    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: '15' }] })
      .mockResolvedValueOnce({ rows });

    const res = await request(app)
      .get('/stats')
      .set('x-brain-key', VALID_KEY);

    expect(res.body.types.length).toBeLessThanOrEqual(10);
    expect(res.body.top_topics.length).toBeLessThanOrEqual(10);
  });

  it('handles thoughts with missing metadata gracefully', async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [{ count: '1' }] })
      .mockResolvedValueOnce({
        rows: [{ metadata: null, created_at: '2025-01-01' }],
      });

    const res = await request(app)
      .get('/stats')
      .set('x-brain-key', VALID_KEY);

    expect(res.status).toBe(200);
    expect(res.body.types).toEqual([]);
  });

  it('returns 500 when DB fails', async () => {
    mockPool.query.mockRejectedValue(new Error('stats query failed'));

    const res = await request(app)
      .get('/stats')
      .set('x-brain-key', VALID_KEY);

    expect(res.status).toBe(500);
  });
});
