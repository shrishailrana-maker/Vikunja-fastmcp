import { VikunjaApiClient } from './api.js';
import { fetchAllCollectionItems } from './format.js';
import { resolveProject } from './identity.js';
import { VikunjaError } from './errors.js';
import { isIP } from 'node:net';

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

function unsafeWebhookHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (isIP(host) === 4) {
    const [a, b] = host.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (isIP(host) === 6) {
    return (
      host === '::' ||
      host === '::1' ||
      host.startsWith('fc') ||
      host.startsWith('fd') ||
      /^fe[89ab]/.test(host) ||
      /^fe[c-f]/.test(host) ||
      host.startsWith('::ffff:127.') ||
      host.startsWith('::ffff:10.') ||
      host.startsWith('::ffff:192.168.')
    );
  }
  return false;
}

function webhookBody(targetUrl: string, events: string[], secrets: WebhookSecrets = {}) {
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new VikunjaError({
      status: 400,
      code: 'UNSAFE_WEBHOOK_URL',
      method: 'TOOLS_CALL',
      path: 'targetUrl',
      message: 'Webhook target must be a valid credential-free HTTPS URL.',
      fieldErrors: [],
    });
  }
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    unsafeWebhookHost(url.hostname)
  ) {
    throw new VikunjaError({
      status: 400,
      code: 'UNSAFE_WEBHOOK_URL',
      method: 'TOOLS_CALL',
      path: 'targetUrl',
      message:
        'Webhook target must use HTTPS, contain no URL credentials, and address a public host.',
      fieldErrors: [],
    });
  }
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
  const body = webhookBody(targetUrl, events, secrets);
  const base = await collectionPath(client, project);
  return normalizeWebhook(await client.request('POST', base, { body }));
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
