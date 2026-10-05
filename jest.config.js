// Legacy REST fixture tests are isolated from the operator's real MCP token.
// Native adapter tests explicitly select their local HTTP test server.
process.env.VIKUNJA_MCP_BACKEND = 'rest';
process.env.VIKUNJA_API_TOKEN_FILE = '';

export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: 'tsconfig.test.json',
      },
    ],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['**/tests/**/*.test.ts'],
};
