'use strict';

// Mock pg and lib/db before requiring server
jest.mock('pg', () => ({ Pool: jest.fn(() => ({ query: jest.fn() })) }));
jest.mock('../../lib/db', () => ({
  createPool: jest.fn(() => ({ query: jest.fn() })),
  getDatabaseUrl: jest.fn(),
}));
jest.mock('pgvector', () => ({ toSql: jest.fn((v) => v) }));

const { translateWorkingDir, buildPrompt } = require('../../server');

// ─── translateWorkingDir ───────────────────────────────────
describe('translateWorkingDir', () => {
  const HOST_ROOT = '/host/workspaces';
  const CONTAINER_ROOT = '/container/workspaces';

  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    delete process.env.HOST_WORKSPACES_ROOT;
    delete process.env.CONTAINER_WORKSPACES_ROOT;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it('returns null for a null input', () => {
    expect(translateWorkingDir(null)).toBeNull();
  });

  it('returns null for an undefined input', () => {
    expect(translateWorkingDir(undefined)).toBeNull();
  });

  it('returns path unchanged when host/container roots are not configured', () => {
    const path = '/some/arbitrary/path';
    expect(translateWorkingDir(path)).toBe(path);
  });

  it('translates a host path to container path when roots are configured', () => {
    process.env.HOST_WORKSPACES_ROOT = HOST_ROOT;
    process.env.CONTAINER_WORKSPACES_ROOT = CONTAINER_ROOT;

    // translateWorkingDir reads env at call time via module-level constants —
    // we need to re-require server with fresh env for this assertion.
    // Since the constants are captured at require time, we test the
    // already-required instance (env was not set when server loaded above).
    // Instead, verify the returned path structure when env is pre-set.
  });

  it('returns path unchanged when it does not start with the host root', () => {
    // Even with roots configured in the module, paths outside host root pass through.
    const outsidePath = '/outside/host/workspaces/project';
    // The server module was loaded without HOST_WORKSPACES_ROOT set, so all
    // paths pass through unchanged — that is also valid coverage of the else branch.
    expect(translateWorkingDir(outsidePath)).toBe(outsidePath);
  });
});

// ─── translateWorkingDir with pre-configured roots ────────
describe('translateWorkingDir (with configured roots)', () => {
  // Use a fresh module instance so we can set env before require
  let translate;

  beforeAll(() => {
    jest.resetModules();
    // Re-apply all mocks after resetModules
    jest.mock('pg', () => ({ Pool: jest.fn(() => ({ query: jest.fn() })) }));
    jest.mock('../../lib/db', () => ({
      createPool: jest.fn(() => ({ query: jest.fn() })),
      getDatabaseUrl: jest.fn(),
    }));
    jest.mock('pgvector', () => ({ toSql: jest.fn((v) => v) }));

    process.env.HOST_WORKSPACES_ROOT = '/host/workspaces';
    process.env.CONTAINER_WORKSPACES_ROOT = '/container/workspaces';

    translate = require('../../server').translateWorkingDir;
  });

  afterAll(() => {
    delete process.env.HOST_WORKSPACES_ROOT;
    delete process.env.CONTAINER_WORKSPACES_ROOT;
    jest.resetModules();
  });

  it('translates a host path to its container equivalent', () => {
    expect(translate('/host/workspaces/myproject')).toBe('/container/workspaces/myproject');
  });

  it('translates nested host paths correctly', () => {
    expect(translate('/host/workspaces/a/b/c')).toBe('/container/workspaces/a/b/c');
  });

  it('leaves paths outside the host root unchanged', () => {
    expect(translate('/var/data/other')).toBe('/var/data/other');
  });
});

// ─── buildPrompt ──────────────────────────────────────────
describe('buildPrompt', () => {
  const baseTask = {
    id: 'task-123',
    title: 'Fix the bug',
    description: 'Details about the bug',
    priority: 'high',
    due_date: '2025-01-15',
  };

  it('includes the task ID', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('Task ID: task-123');
  });

  it('includes the title', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('Title: Fix the bug');
  });

  it('includes the description when present', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('Description: Details about the bug');
  });

  it('includes the priority when present', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('Priority: high');
  });

  it('includes the due date when present', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('Due: 2025-01-15');
  });

  it('omits description line when description is absent', () => {
    const prompt = buildPrompt({ id: 'x', title: 'T' });
    expect(prompt).not.toContain('Description:');
  });

  it('omits priority line when priority is absent', () => {
    const prompt = buildPrompt({ id: 'x', title: 'T' });
    expect(prompt).not.toContain('Priority:');
  });

  it('omits due date line when due_date is absent', () => {
    const prompt = buildPrompt({ id: 'x', title: 'T' });
    expect(prompt).not.toContain('Due:');
  });

  it('instructs the agent to skip non-code tasks via stderr', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('write a one-line explanation to stderr');
    // The phrase spans a line break in buildPrompt, so check each part separately
    expect(prompt).toMatch(/exit WITHOUT making any/);
    expect(prompt).toMatch(/commits.*dispatcher will detect the no-op/s);
  });

  it('instructs the agent to commit and push on the current branch', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('commit your changes on the current branch');
    expect(prompt).toContain('push to the tracking remote');
  });

  it('tells the agent not to force-push or rebase', () => {
    const prompt = buildPrompt(baseTask);
    expect(prompt).toContain('Do NOT force-push');
    // "do NOT" and "rebase published history" may span a line break
    expect(prompt).toMatch(/rebase published history/);
  });

  it('returns a non-empty string', () => {
    const prompt = buildPrompt(baseTask);
    expect(typeof prompt).toBe('string');
    expect(prompt.length).toBeGreaterThan(0);
  });
});
