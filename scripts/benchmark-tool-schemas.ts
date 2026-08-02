import { server } from '../src/index.js';

const profiles = ['core', 'qa', 'developer', 'full', 'compatibility'] as const;
const budgets: Record<(typeof profiles)[number], number> = {
  core: 35_000,
  qa: 50_000,
  developer: 55_000,
  full: 60_000,
  compatibility: 90_000,
};
const handler = (server as any)._requestHandlers.get('tools/list');
const results: Record<string, { tools: number; chars: number }> = {};

for (const profile of profiles) {
  process.env.VIKUNJA_MCP_TOOL_PROFILE = profile;
  const response = await handler({ method: 'tools/list' });
  const chars = JSON.stringify(response.tools).length;
  results[profile] = { tools: response.tools.length, chars };
  if (chars > budgets[profile]) {
    throw new Error(`${profile} tool schema is ${chars} chars; budget is ${budgets[profile]}.`);
  }
}

if (results.core.chars >= results.compatibility.chars * 0.65) {
  throw new Error('The core profile no longer saves at least 35% versus compatibility.');
}

console.log(JSON.stringify(results, null, 2));
