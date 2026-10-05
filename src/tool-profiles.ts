/** Selects the bounded MCP tool surface exposed to a client process. */

export const TOOL_PROFILES = [
  'native',
  'core',
  'qa',
  'developer',
  'full',
  'compatibility',
] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

export function loadToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const raw = env.VIKUNJA_MCP_TOOL_PROFILE?.trim().toLowerCase() || 'native';
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
  if (profile === 'native') {
    return tools.filter((tool) =>
      [
        'self_check',
        'vikunja_task_read',
        'vikunja_task_write',
        'vikunja_task_workflow',
        'vikunja_task_comments',
        'vikunja_task_organize',
        'vikunja_task_attachments',
        'vikunja_task_bulk',
        'vikunja_export_project',
        'vikunja_project_migration',
        'vikunja_batch_import',
        'vikunja_download_user_export',
        'vikunja_request_user_export',
        'vikunja_templates',
        'vikunja_webhooks',
      ].includes(tool.name),
    );
  }
  return tools.filter((tool) => tool.name !== 'vikunja_tasks');
}
