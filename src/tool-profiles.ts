/** Selects the bounded MCP tool surface exposed to a client process. */

export const TOOL_PROFILES = ['core', 'qa', 'developer', 'full', 'compatibility'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

export function loadToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const raw = env.VIKUNJA_MCP_TOOL_PROFILE?.trim().toLowerCase() || 'core';
  if (!(TOOL_PROFILES as readonly string[]).includes(raw)) {
    throw new Error(`VIKUNJA_MCP_TOOL_PROFILE must be one of: ${TOOL_PROFILES.join(', ')}.`);
  }
  return raw as ToolProfile;
}

export function selectToolsForProfile<T extends { name: string }>(
  tools: T[],
  profile: ToolProfile,
): T[] {
  if (profile === 'compatibility') return tools;
  return tools.filter((tool) => tool.name !== 'vikunja_tasks');
}
