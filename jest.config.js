'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  clearMocks: true,
  testTimeout: 10000,
  // Exclude git worktrees created by Claude Code from the module map
  watchPathIgnorePatterns: ['/\\.claude/'],
  modulePathIgnorePatterns: ['<rootDir>/\\.claude/'],
};
