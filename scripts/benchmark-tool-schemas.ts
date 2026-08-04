import { server } from '../src/index.js';

const profiles = ['core', 'qa', 'developer', 'full', 'compatibility'] as const;
const budgets: Record<(typeof profiles)[number], number> = {
  core: 60_000,
  qa: 60_000,
  developer: 60_000,
  full: 60_000,
  compatibility: 90_000,
};
const handler = (server as any)._requestHandlers.get('tools/list');
const results: Record<string, { tools: number; chars: number }> = {};
const toolNames: Record<string, string[]> = {};

for (const profile of profiles) {
  process.env.VIKUNJA_MCP_TOOL_PROFILE = profile;
  const response = await handler({ method: 'tools/list' });
  const chars = JSON.stringify(response.tools).length;
  results[profile] = { tools: response.tools.length, chars };
  toolNames[profile] = response.tools.map((tool: { name: string }) => tool.name);
  if (chars > budgets[profile]) {
    throw new Error(`${profile} tool schema is ${chars} chars; budget is ${budgets[profile]}.`);
  }
}

for (const profile of ['qa', 'developer', 'full']) {
  if (
    results[profile].tools !== results.core.tools ||
    results[profile].chars !== results.core.chars
  ) {
    throw new Error(`${profile} profile does not match the core typed tool surface.`);
  }
}

const compatibilityOnlyNames = toolNames.compatibility.filter(
  (name) => !toolNames.core.includes(name),
);
if (
  results.compatibility.tools !== results.core.tools + 1 ||
  compatibilityOnlyNames.length !== 1 ||
  compatibilityOnlyNames[0] !== 'vikunja_tasks'
) {
  throw new Error('Compatibility must add exactly the legacy vikunja_tasks tool.');
}
if (results.compatibility.chars <= results.core.chars) {
  throw new Error('Compatibility must have a larger schema than the typed profiles.');
}

console.log(JSON.stringify(results, null, 2));
