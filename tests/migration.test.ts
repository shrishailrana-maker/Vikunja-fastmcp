import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  getProjectMigrationStatus,
  previewProjectMigration,
  runProjectMigration,
  sanitizePublicString,
} from '../src/migration.js';
import { GitHubIssueDestination } from '../src/github-destination.js';
import { idempotency } from '../src/idempotency.js';
import { cache } from '../src/identity.js';

describe('portable project migration', () => {
  let root: string;
  let originalGitHubToken: string | undefined;
  let originalGitHubHosts: string | undefined;

  beforeEach(async () => {
    idempotency.clear();
    cache.clearProjects();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-migration-'));
    originalGitHubToken = process.env.GITHUB_TOKEN;
    originalGitHubHosts = process.env.VIKUNJA_GITHUB_API_HOSTS;
    process.env.GITHUB_TOKEN = 'ghp_neutral_test_token';
    delete process.env.VIKUNJA_GITHUB_API_HOSTS;
  });

  afterEach(async () => {
    if (originalGitHubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalGitHubToken;
    if (originalGitHubHosts === undefined) delete process.env.VIKUNJA_GITHUB_API_HOSTS;
    else process.env.VIKUNJA_GITHUB_API_HOSTS = originalGitHubHosts;
    await fs.rm(root, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  function sourceClient() {
    const request = jest.fn(async (method: string, requestPath: string) => {
      if (method === 'GET' && requestPath === '/projects/31') {
        return { id: 31, title: 'Example Project', identifier: 'EX' };
      }
      if (method === 'GET' && requestPath.startsWith('/projects/31/tasks')) {
        return {
          items: [
            {
              id: 7001,
              index: 5,
              identifier: 'EX-5',
              title: 'Example migration task',
              description:
                '<p>Run <code>tool --check</code> at http://10.1.2.3:3456 and use tk_private_value</p>',
              done: false,
              priority: 3,
              labels: [{ title: 'bug' }],
              assignees: [{ username: 'developer' }],
            },
          ],
          page: 1,
          per_page: 1000,
          total: 1,
          total_pages: 1,
        };
      }
      if (method === 'GET' && requestPath.startsWith('/tasks/7001/comments')) {
        return {
          items: [
            {
              id: 8101,
              comment: '<p>PASS from C:\\Users\\Example\\private.log</p>',
              author: { id: 1, username: 'tester' },
              created: '2026-08-01T10:00:00Z',
            },
          ],
          page: 1,
          per_page: 1000,
          total: 1,
          total_pages: 1,
        };
      }
      if (method === 'GET' && requestPath.startsWith('/tasks/7001/attachments')) {
        return {
          items: [{ id: 8201, file: { name: 'evidence.log', mime: 'text/plain', size: 42 } }],
          page: 1,
          per_page: 1000,
          total: 1,
          total_pages: 1,
        };
      }
      if (method === 'GET' && requestPath === '/tasks/7001') {
        return {
          related_tasks: {
            related: [{ id: 7002, index: 6, identifier: 'EX-6', title: 'Related source task' }],
          },
        };
      }
      throw new Error(`Unexpected source request ${method} ${requestPath}`);
    });
    return {
      request,
      getConfig: () => ({
        attachmentDownloadRoot: root,
        vikunjaToken: 'tk_source_token',
        vikunjaWebUrl: 'https://vikunja.example.com/',
      }),
    } as any;
  }

  const options = (key: string) => ({
    projectSelector: { id: 31 },
    destination: { owner: 'example-org', repo: 'example-repo' },
    actor: 'Codex',
    idempotencyKey: key,
    publicSanitize: true,
  });

  it('sanitizes credentials, private URLs, and private paths', () => {
    const safe = sanitizePublicString(
      'Bearer secret http://192.168.1.2/path http://intranet.local/log ' +
        'http://[::1]/debug http://[::ffff:127.0.0.1]/secret ' +
        'file:///D:/Private%20Logs/secret.txt C:\\Users\\Example\\secret.log ' +
        'D:\\Private Logs\\secret.txt, tk_abc123',
      'secret',
    );
    expect(safe).not.toContain('secret');
    expect(safe).not.toContain('192.168.1.2');
    expect(safe).not.toContain('C:\\Users');
    expect(safe).not.toContain('intranet.local');
    expect(safe).not.toContain('[::1]');
    expect(safe).not.toContain('::ffff');
    expect(safe).not.toContain('file:///');
    expect(safe).not.toContain('D:\\Private Logs');
    expect(safe).not.toContain('tk_abc123');
  });

  it('sends credentials only to GitHub or an explicit trusted enterprise host', () => {
    expect(
      () =>
        new GitHubIssueDestination({
          owner: 'example-org',
          repo: 'example-repo',
          apiUrl: 'https://127.0.0.1',
        }),
    ).toThrow(expect.objectContaining({ code: 'UNSAFE_GITHUB_API_URL' }));
    expect(
      () =>
        new GitHubIssueDestination({
          owner: 'example-org',
          repo: 'example-repo',
          apiUrl: 'https://untrusted.example.net',
        }),
    ).toThrow(expect.objectContaining({ code: 'UNSAFE_GITHUB_API_URL' }));

    process.env.VIKUNJA_GITHUB_API_HOSTS = 'github.example.net';
    expect(
      () =>
        new GitHubIssueDestination({
          owner: 'example-org',
          repo: 'example-repo',
          apiUrl: 'https://github.example.net/api/v3',
        }),
    ).not.toThrow();
  });

  it('writes a versioned sanitized manifest and preserves inline code', async () => {
    const result = await previewProjectMigration(sourceClient(), options('preview-manifest'));
    const manifest = JSON.parse(await fs.readFile(path.join(root, result.manifestFile), 'utf8'));

    expect(result).toMatchObject({
      status: 'preview',
      taskCount: 1,
      commentCount: 1,
      attachmentCount: 1,
      relationCount: 1,
      binaryAttachmentTransferSupported: false,
    });
    expect(manifest).toMatchObject({
      schemaVersion: 1,
      capabilities: { binaryAttachments: false, attachmentMetadata: true },
    });
    expect(manifest.tasks[0].description).toContain('`tool --check`');
    expect(JSON.stringify(manifest)).not.toContain('@@INLINECODE');
    expect(JSON.stringify(manifest)).not.toContain('10.1.2.3');
    expect(JSON.stringify(manifest)).not.toContain('tk_private_value');
    expect(JSON.stringify(manifest)).not.toContain('C:\\\\Users');
    expect(manifest.tasks[0].relations[0]).toMatchObject({ identifier: 'EX-6' });
  });

  it('refuses to disable public sanitization for a GitHub migration', async () => {
    await expect(
      previewProjectMigration(sourceClient(), {
        ...options('unsafe-preview'),
        publicSanitize: false,
      }),
    ).rejects.toMatchObject({ status: 400, code: 'PUBLIC_SANITIZATION_REQUIRED' });
  });

  it('creates, reads back, comments, and resumes one GitHub issue without duplication', async () => {
    let createdBody = '';
    const createdComments: string[] = [];
    const githubFetch = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && /\/issues\?/.test(url)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === 'POST' && /\/issues$/.test(url)) {
        const body = JSON.parse(String(init?.body));
        createdBody = body.body;
        return new Response(
          JSON.stringify({
            number: 17,
            html_url: 'https://github.com/example-org/example-repo/issues/17',
            title: body.title,
            body: body.body,
            state: 'open',
          }),
          { status: 201 },
        );
      }
      if (method === 'GET' && /\/issues\/17$/.test(url)) {
        return new Response(
          JSON.stringify({
            number: 17,
            html_url: 'https://github.com/example-org/example-repo/issues/17',
            title: 'Example migration task',
            body: createdBody,
            state: 'open',
          }),
          { status: 200 },
        );
      }
      if (method === 'GET' && /\/issues\/17\/comments/.test(url)) {
        return new Response(
          JSON.stringify(createdComments.map((body, id) => ({ id: id + 1, body }))),
          { status: 200 },
        );
      }
      if (method === 'POST' && /\/issues\/17\/comments$/.test(url)) {
        createdComments.push(JSON.parse(String(init?.body)).body);
        return new Response(JSON.stringify({ id: 99 }), { status: 201 });
      }
      throw new Error(`Unexpected GitHub request ${method} ${url}`);
    });
    const client = sourceClient();

    const first = await runProjectMigration(client, options('run-once'));
    const writes = githubFetch.mock.calls.filter(([, init]) => init?.method === 'POST').length;
    const second = await runProjectMigration(client, options('run-once'));
    const status = getProjectMigrationStatus(first.operationId);

    expect(first).toMatchObject({ status: 'completed', requested: 1, migrated: 1, failed: 0 });
    expect(createdBody).toContain('vfm-migration:31:EX-5');
    expect(createdBody).toContain('sha256:');
    expect(createdBody).toContain('related: EX-6');
    expect(createdBody).not.toContain('source task 7002');
    expect(createdComments[0]).toContain('_Source created: 2026-08-01T10:00:00Z_');
    expect(createdComments[0]).toContain('sha256:');
    expect(second).toMatchObject({ status: 'completed', migrated: 1 });
    expect(githubFetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
      writes,
    );
    expect(status).toMatchObject({
      returnedCount: 1,
      totalCount: 1,
      incomplete: false,
      receipts: [
        expect.objectContaining({
          sourceIdentifier: 'EX-5',
          status: 'verified',
          destination: { number: 17, url: expect.stringContaining('/issues/17') },
          commentsCreated: 1,
          commentsVerified: 1,
          resultHash: expect.any(String),
        }),
      ],
    });
  });

  it('reports truthful cursor paging and count-only migration status', () => {
    idempotency.set('project-migration-state:paged', {
      operationId: 'paged',
      status: 'completed',
      requested: 3,
      receipts: [
        { sourceTaskId: 3, status: 'verified' },
        { sourceTaskId: 1, status: 'verified' },
        { sourceTaskId: 2, status: 'verified' },
      ],
    });

    expect(getProjectMigrationStatus('paged', 0, 2)).toMatchObject({
      returnedCount: 2,
      totalCount: 3,
      nextCursor: '2',
      incomplete: true,
    });
    expect(getProjectMigrationStatus('paged', 2, 2)).toMatchObject({
      returnedCount: 1,
      nextCursor: null,
      incomplete: false,
    });
    expect(getProjectMigrationStatus('paged', 0, 2, true)).toMatchObject({
      receipts: [],
      returnedCount: 0,
      totalCount: 3,
      nextCursor: null,
      incomplete: false,
    });
  });

  it('stops before destination writes when migration lease ownership is lost', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch');
    jest.spyOn(idempotency, 'renewLease').mockReturnValue(false);

    await expect(runProjectMigration(sourceClient(), options('lost-lease'))).rejects.toMatchObject({
      status: 409,
      code: 'MIGRATION_LEASE_LOST',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a tampered saved manifest before retrying destination writes', async () => {
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'temporary failure' }), { status: 503 }),
      );
    const client = sourceClient();
    const first = await runProjectMigration(client, options('tampered-manifest'));
    expect(first).toMatchObject({ status: 'partial', failed: 1 });
    expect(idempotency.get(`project-migration-state:${first.operationId}`).manifestHash).toEqual(
      expect.any(String),
    );
    const manifestPath = path.join(root, first.manifestFile);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    manifest.tasks[0].title = 'Tampered title';
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    const callsBeforeRetry = fetchSpy.mock.calls.length;

    await expect(runProjectMigration(client, options('tampered-manifest'))).rejects.toMatchObject({
      status: 409,
      code: 'MIGRATION_MANIFEST_INTEGRITY_ERROR',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(callsBeforeRetry);
  });

  it('never closes a source task when destination read-back does not verify', async () => {
    const githubFetch = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && /\/issues\?/.test(url)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === 'POST' && /\/issues$/.test(url)) {
        const body = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            number: 18,
            html_url: 'https://github.com/example-org/example-repo/issues/18',
            title: body.title,
            body: body.body,
            state: 'open',
          }),
          { status: 201 },
        );
      }
      if (method === 'GET' && /\/issues\/18$/.test(url)) {
        return new Response(
          JSON.stringify({
            number: 18,
            html_url: 'https://github.com/example-org/example-repo/issues/18',
            title: 'Wrong title',
            body: 'Wrong body',
            state: 'open',
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected GitHub request ${method} ${url}`);
    });
    const client = sourceClient();

    const result = await runProjectMigration(client, {
      ...options('readback-failure'),
      archiveSource: true,
    });

    expect(result).toMatchObject({ status: 'partial', migrated: 0, failed: 1, archived: 0 });
    expect(
      githubFetch.mock.calls.some(
        ([input, init]) => init?.method === 'POST' && /\/comments$/.test(String(input)),
      ),
    ).toBe(false);
    expect(
      client.request.mock.calls.some(([method]: [string]) =>
        ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method),
      ),
    ).toBe(false);
  });

  it('never closes a source task until migrated comments read back exactly', async () => {
    let createdBody = '';
    jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      if (method === 'GET' && /\/issues\?/.test(url)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (method === 'POST' && /\/issues$/.test(url)) {
        const body = JSON.parse(String(init?.body));
        createdBody = body.body;
        return new Response(
          JSON.stringify({
            number: 19,
            html_url: 'https://github.com/example-org/example-repo/issues/19',
            title: body.title,
            body: body.body,
            state: 'open',
          }),
          { status: 201 },
        );
      }
      if (method === 'POST' && /\/issues\/19\/comments$/.test(url)) {
        return new Response(JSON.stringify({ id: 100 }), { status: 201 });
      }
      if (method === 'GET' && /\/issues\/19$/.test(url)) {
        return new Response(
          JSON.stringify({
            number: 19,
            html_url: 'https://github.com/example-org/example-repo/issues/19',
            title: 'Example migration task',
            body: createdBody,
            state: 'open',
          }),
          { status: 200 },
        );
      }
      if (method === 'GET' && /\/issues\/19\/comments/.test(url)) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      throw new Error(`Unexpected GitHub request ${method} ${url}`);
    });
    const client = sourceClient();

    const result = await runProjectMigration(client, {
      ...options('comment-readback-failure'),
      archiveSource: true,
    });

    expect(result).toMatchObject({ status: 'partial', migrated: 0, failed: 1, archived: 0 });
    expect(
      client.request.mock.calls.some(([method]: [string]) =>
        ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method),
      ),
    ).toBe(false);
  });
});
