'use strict';

const mockPoolInstance = { query: jest.fn() };
const MockPool = jest.fn(() => mockPoolInstance);

jest.mock('pg', () => ({ Pool: MockPool }));

// Re-require db module after mock is in place
const { createPool, getDatabaseUrl } = require('../../lib/db');

describe('getDatabaseUrl', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('returns SUPABASE_DB_URL when set', () => {
    process.env.SUPABASE_DB_URL = 'postgres://supabase-url';
    process.env.DATABASE_URL = 'postgres://other-url';
    expect(getDatabaseUrl()).toBe('postgres://supabase-url');
  });

  it('falls back to DATABASE_URL when SUPABASE_DB_URL is absent', () => {
    process.env.DATABASE_URL = 'postgres://other-url';
    expect(getDatabaseUrl()).toBe('postgres://other-url');
  });

  it('returns undefined when neither env var is set', () => {
    expect(getDatabaseUrl()).toBeUndefined();
  });
});

describe('createPool', () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.SUPABASE_DB_URL;
    delete process.env.DATABASE_URL;
    MockPool.mockClear();
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('throws when no connection string is configured', () => {
    expect(() => createPool()).toThrow('Missing SUPABASE_DB_URL or DATABASE_URL');
  });

  it('creates a Pool instance for localhost without SSL', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
    createPool();
    expect(MockPool).toHaveBeenCalledWith({
      connectionString: 'postgres://user:pass@localhost:5432/testdb',
    });
  });

  it('creates a Pool with SSL for supabase.co hostnames', () => {
    process.env.SUPABASE_DB_URL = 'postgres://user:pass@db.abc.supabase.co:5432/postgres';
    createPool();
    expect(MockPool).toHaveBeenCalledWith({
      connectionString: 'postgres://user:pass@db.abc.supabase.co:5432/postgres',
      ssl: { rejectUnauthorized: false },
    });
  });

  it('creates a Pool with SSL for supabase.com hostnames', () => {
    process.env.SUPABASE_DB_URL = 'postgres://user:pass@db.supabase.com:5432/postgres';
    createPool();
    expect(MockPool).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: { rejectUnauthorized: false } })
    );
  });

  it('creates a Pool with SSL for pooler hostnames', () => {
    process.env.SUPABASE_DB_URL =
      'postgres://user:pass@aws-0-us-east-1.pooler.supabase.com:5432/postgres';
    createPool();
    expect(MockPool).toHaveBeenCalledWith(
      expect.objectContaining({ ssl: { rejectUnauthorized: false } })
    );
  });

  it('skips SSL even for supabase.co when sslmode=disable is in the URL', () => {
    process.env.SUPABASE_DB_URL =
      'postgres://user:pass@db.supabase.co:5432/postgres?sslmode=disable';
    createPool();
    expect(MockPool).toHaveBeenCalledWith({
      connectionString: 'postgres://user:pass@db.supabase.co:5432/postgres?sslmode=disable',
    });
  });

  it('returns the Pool instance created by pg', () => {
    process.env.DATABASE_URL = 'postgres://user:pass@localhost:5432/testdb';
    const pool = createPool();
    expect(pool).toBe(mockPoolInstance);
  });
});
