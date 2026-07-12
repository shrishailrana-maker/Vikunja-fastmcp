import { VikunjaApiClient } from './api.js';
import { fetchAllCollectionItems } from './format.js';
import { resolveProject } from './identity.js';
import { VikunjaError } from './errors.js';

export interface WebhookSecrets {
  secret?: string;
  basicAuthUser?: string;
  basicAuthPassword?: string;
}

function normalizeWebhook(webhook: any) {
  return {
    id: webhook.id,
    targetUrl: webhook.target_url,
    events: Array.isArray(webhook.events) ? webhook.events : [],
    projectId: webhook.project_id || null,
    userId: webhook.user_id || null,
  };
}

function webhookBody(targetUrl: string, events: string[], secrets: WebhookSecrets = {}) {
  const url = new URL(targetUrl);
  if (!['http:', 'https:'].includes(url.protocol))
    throw new VikunjaError({
      status: 400,
      code: 'VALIDATION_ERROR',
      method: 'TOOLS_CALL',
      path: 'targetUrl',
      message: 'Webhook target must use http or https.',
      fieldErrors: [],
    });
  return {
    target_url: targetUrl,
    events,
    ...(secrets.secret ? { secret: secrets.secret } : {}),
    ...(secrets.basicAuthUser ? { basic_auth_user: secrets.basicAuthUser } : {}),
    ...(secrets.basicAuthPassword ? { basic_auth_password: secrets.basicAuthPassword } : {}),
  };
}

async function collectionPath(client: VikunjaApiClient, project?: { id?: number; title?: string }) {
  if (!project) return '/user/settings/webhooks';
  const resolved = await resolveProject(client, project);
  return `/projects/${resolved.id}/webhooks`;
}

export async function listWebhooks(
  client: VikunjaApiClient,
  project?: { id?: number; title?: string },
) {
  const base = await collectionPath(client, project);
  const items = await fetchAllCollectionItems<any>((path) => client.request('GET', path), base);
  return items.map(normalizeWebhook);
}

export async function createWebhook(
  client: VikunjaApiClient,
  project: { id?: number; title?: string } | undefined,
  targetUrl: string,
  events: string[],
  secrets: WebhookSecrets = {},
) {
  const base = await collectionPath(client, project);
  return normalizeWebhook(
    await client.request('POST', base, { body: webhookBody(targetUrl, events, secrets) }),
  );
}

export async function updateWebhook(
  client: VikunjaApiClient,
  webhookId: number,
  project: { id?: number; title?: string } | undefined,
  events: string[],
) {
  const base = await collectionPath(client, project);
  return normalizeWebhook(
    await client.request('PUT', `${base}/${webhookId}`, {
      body: { events },
    }),
  );
}

export async function deleteWebhook(
  client: VikunjaApiClient,
  webhookId: number,
  project?: { id?: number; title?: string },
) {
  const base = await collectionPath(client, project);
  await client.request('DELETE', `${base}/${webhookId}`);
  return { deleted: true, webhookId };
}

export async function listWebhookEvents(
  client: VikunjaApiClient,
  scope: 'project' | 'user' = 'project',
) {
  const path = scope === 'user' ? '/user/settings/webhooks/events' : '/webhooks/events';
  const events = await client.request<any>('GET', path);
  return Array.isArray(events) ? events : [];
}
