/** Selects the bounded MCP tool surface exposed to a client process. */

export const TOOL_PROFILES = ['core', 'qa', 'developer', 'full', 'compatibility'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

const CORE_TOOLS = new Set([
  'self_check',
  'vikunja_auth',
  'vikunja_projects',
  'vikunja_task_read',
  'vikunja_task_write',
  'vikunja_task_workflow',
  'vikunja_task_comments',
  'vikunja_task_attachments',
]);

const QA_TOOLS = new Set([
  ...CORE_TOOLS,
  'vikunja_task_organize',
  'vikunja_labels',
  'vikunja_users',
  'vikunja_task_bulk',
  'vikunja_task_reminders',
  'vikunja_batch_import',
  'vikunja_export_project',
]);

const DEVELOPER_TOOLS = new Set([
  ...QA_TOOLS,
  'vikunja_request_user_export',
  'vikunja_download_user_export',
  'vikunja_templates',
  'vikunja_webhooks',
]);

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
  if (profile === 'full') return tools.filter((tool) => tool.name !== 'vikunja_tasks');
  const allowed = profile === 'core' ? CORE_TOOLS : profile === 'qa' ? QA_TOOLS : DEVELOPER_TOOLS;
  return tools.filter((tool) => allowed.has(tool.name));
}
