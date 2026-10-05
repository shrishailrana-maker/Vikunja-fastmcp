/** Translate our campaign operations into the server's OpenAPI-derived MCP actions. */

import { VikunjaError } from './errors.js';

// Operation names are API facts from Vikunja v2.7.0's MCP exposure catalog.
// Permission-filtered discovery must not cause a denied operation to fall back to REST.
export const NATIVE_ACTIONS = new Set(
  `
buckets_create buckets_delete buckets_list buckets_update
filters_create filters_delete filters_read filters_update
labels_create labels_delete labels_list labels_read labels_update
notifications_delete_all notifications_list notifications_mark_all_read notifications_mark_read
project_tasks_list project_teams_create project_teams_delete project_teams_list project_teams_update
project_time_entries_list project_users_create project_users_delete project_users_list project_users_update
project_view_buckets_tasks_list project_view_tasks_list
project_views_create project_views_delete project_views_list project_views_read project_views_update
projects_create projects_delete projects_duplicate projects_list projects_read projects_update projects_users_search
reactions_create reactions_delete reactions_list
task_assignees_bulk task_assignees_create task_assignees_delete task_assignees_list
task_attachments_delete task_attachments_list task_bucket_update
task_comments_create task_comments_delete task_comments_list task_comments_read task_comments_update
task_labels_bulk_replace task_labels_create task_labels_delete task_labels_list task_time_entries_list
tasks_bulk_create tasks_bulk_update tasks_create tasks_delete tasks_duplicate tasks_list tasks_mark_read
tasks_position_update tasks_read tasks_read_by_index tasks_relations_create tasks_relations_delete tasks_update
teams_create teams_delete teams_list teams_members_add teams_members_remove teams_members_toggle_admin
teams_read teams_update time_entries_create time_entries_delete time_entries_list time_entries_read
time_entries_timer_stop time_entries_update users_search
`
    .trim()
    .split(/\s+/),
);

export interface NativeRoute {
  action: string;
  parameters: any[];
  method: string;
  path: string;
  pattern: RegExp;
  pathNames: string[];
}

export function nativeRoutes(openapi: any, exposedActions: Set<string>): NativeRoute[] {
  const routes: NativeRoute[] = [];
  for (const [path, item] of Object.entries<any>(openapi.paths ?? {})) {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const operation = item[method.toLowerCase()];
      if (!operation) continue;
      // Native Vikunja prefers PATCH under the PUT operation name.
      const name = method === 'PATCH' && item.put ? item.put.operationId : operation.operationId;
      const action = String(name ?? '').replaceAll('-', '_');
      if (!exposedActions.has(action)) continue;
      const pathNames: string[] = [];
      const pattern = path
        .split('/')
        .map((part: string) => {
          const match = /^\{([^}]+)\}$/.exec(part);
          if (!match) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          pathNames.push(match[1]);
          return '([^/]+)';
        })
        .join('/');
      routes.push({
        action,
        parameters: operation.parameters ?? [],
        method,
        path,
        pattern: new RegExp(`^${pattern}$`),
        pathNames,
      });
    }
  }
  return routes.sort(
    (a, b) => a.pathNames.length - b.pathNames.length || b.path.length - a.path.length,
  );
}

function argumentError(message: string): VikunjaError {
  return new VikunjaError({
    status: 400,
    code: 'NATIVE_ARGUMENT_UNSUPPORTED',
    method: 'TOOLS_CALL',
    path: '/mcp',
    message,
    fieldErrors: [],
  });
}

function scalar(value: string, schema: any): unknown {
  const types = [schema?.type].flat();
  if (types.includes('integer') || types.includes('number')) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) throw argumentError('Invalid numeric native argument.');
    return numeric;
  }
  if (types.includes('boolean')) {
    if (value !== 'true' && value !== 'false')
      throw argumentError('Invalid boolean native argument.');
    return value === 'true';
  }
  return value;
}

export function nativeArguments(
  route: NativeRoute,
  requestPath: string,
  body?: unknown,
): Record<string, unknown> {
  const url = new URL(requestPath, 'https://vikunja.example');
  const match = route.pattern.exec(url.pathname);
  if (!match) throw argumentError('Native route does not match the requested path.');
  const args: Record<string, unknown> = {};
  route.pathNames.forEach((name, index) => {
    const parameter = route.parameters.find((p) => p.in === 'path' && p.name === name);
    args[name] = scalar(decodeURIComponent(match[index + 1]), parameter?.schema);
  });
  for (const name of new Set(url.searchParams.keys())) {
    const parameter = route.parameters.find((p) => p.in === 'query' && p.name === name);
    if (!parameter) throw argumentError(`The native API does not support query argument ${name}.`);
    const values = url.searchParams.getAll(name);
    const types = [parameter.schema?.type].flat();
    args[name] = types.includes('array')
      ? values
          .flatMap((value) => (parameter.explode ? [value] : value.split(',')))
          .map((value) => scalar(value, parameter.schema.items))
      : scalar(values[0], parameter.schema);
  }
  if (Array.isArray(body)) {
    if (route.method !== 'PATCH') throw argumentError('Native request bodies must be objects.');
    const operations: Record<string, unknown> = {};
    for (const entry of body) {
      if (
        !entry ||
        !['replace', 'add', 'remove'].includes(entry.op) ||
        !/^\/[^/]+$/.test(entry.path)
      ) {
        throw argumentError(
          'Only top-level JSON Patch add/replace/remove is supported by the native adapter.',
        );
      }
      const name = entry.path.slice(1).replaceAll('~1', '/').replaceAll('~0', '~');
      if (Object.hasOwn(operations, name))
        throw argumentError('Repeated JSON Patch fields are not supported by the native adapter.');
      operations[name] = entry.op === 'remove' ? null : entry.value;
    }
    body = operations;
  }
  if (body !== undefined) {
    if (!body || typeof body !== 'object')
      throw argumentError('Native request bodies must be objects.');
    for (const [name, value] of Object.entries(body)) {
      if (value === undefined) continue;
      if (Object.hasOwn(args, name))
        throw argumentError(`Native body conflicts with route argument ${name}.`);
      args[name] = value;
    }
  }
  return args;
}
