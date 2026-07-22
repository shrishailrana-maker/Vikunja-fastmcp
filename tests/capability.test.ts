/**
 * Capability gate tests.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import fs from 'fs';
import path from 'path';

describe('V2 OpenAPI Capability Gate', () => {
  let openapi: any;

  beforeAll(() => {
    const targetPath = path.join(process.cwd(), 'docs/vikunja-v2-openapi.json');

    expect(fs.existsSync(targetPath)).toBe(true);
    const content = fs.readFileSync(targetPath, 'utf8');
    openapi = JSON.parse(content);
  });

  it('pins the sanitized contract to Vikunja 2.4.0', () => {
    expect(openapi.info?.version).toBe('v2.4.0');
    expect(openapi.openapi).toBe('3.1.0');
    expect(openapi.servers).toEqual([
      { url: '/api/v2' },
      { url: 'https://vikunja.example.com/api/v2' },
    ]);
    expect(openapi.components?.schemas?.FormFile).toBeUndefined();
    expect(openapi.components?.schemas?.VikunjaErrorModel?.properties?.i18n_params).toBeDefined();
    expect(
      openapi.paths?.['/tasks/{projecttask}']?.patch?.requestBody?.content?.[
        'application/json-patch+json'
      ],
    ).toBeDefined();
  });

  const expectedRoutes = [
    { method: 'get', path: '/info' },
    { method: 'get', path: '/user' },
    { method: 'get', path: '/users' },
    { method: 'get', path: '/projects' },
    { method: 'get', path: '/projects/{id}' },
    { method: 'get', path: '/projects/{project}/tasks' },
    { method: 'get', path: '/projects/{project}/tasks/by-index/{index}' },
    { method: 'get', path: '/tasks' },
    { method: 'put', path: '/tasks/bulk' },
    { method: 'get', path: '/tasks/{projecttask}' },
    { method: 'post', path: '/projects/{project}/tasks' },
    { method: 'patch', path: '/tasks/{projecttask}' },
    { method: 'delete', path: '/tasks/{projecttask}' },
    { method: 'get', path: '/tasks/{projecttask}/assignees' },
    { method: 'post', path: '/tasks/{projecttask}/assignees' },
    { method: 'delete', path: '/tasks/{projecttask}/assignees/{user}' },
    { method: 'put', path: '/tasks/{projecttask}/assignees/bulk' },
    { method: 'get', path: '/tasks/{projecttask}/labels' },
    { method: 'post', path: '/tasks/{projecttask}/labels' },
    { method: 'delete', path: '/tasks/{projecttask}/labels/{label}' },
    { method: 'put', path: '/tasks/{projecttask}/labels/bulk' },
    { method: 'get', path: '/tasks/{task}/comments' },
    { method: 'post', path: '/tasks/{task}/comments' },
    { method: 'get', path: '/tasks/{task}/comments/{commentid}' },
    { method: 'patch', path: '/tasks/{task}/comments/{commentid}' },
    { method: 'put', path: '/tasks/{task}/comments/{commentid}' },
    { method: 'delete', path: '/tasks/{task}/comments/{commentid}' },
    { method: 'get', path: '/tasks/{task}/attachments' },
    { method: 'post', path: '/tasks/{task}/attachments' },
    { method: 'get', path: '/tasks/{task}/attachments/{attachment}' },
    { method: 'delete', path: '/tasks/{task}/attachments/{attachment}' },
    { method: 'post', path: '/tasks/{task}/relations' },
    { method: 'delete', path: '/tasks/{task}/relations/{relationKind}/{otherTask}' },
    { method: 'get', path: '/teams' },
    { method: 'post', path: '/teams' },
    { method: 'get', path: '/teams/{id}' },
    { method: 'patch', path: '/teams/{id}' },
    { method: 'put', path: '/teams/{id}' },
    { method: 'delete', path: '/teams/{id}' },
    { method: 'post', path: '/teams/{team}/members' },
    { method: 'delete', path: '/teams/{team}/members/{user}' },
    { method: 'post', path: '/teams/{team}/members/{user}/admin' },
    { method: 'post', path: '/filters' },
    { method: 'get', path: '/filters/{filter}' },
    { method: 'patch', path: '/filters/{filter}' },
    { method: 'put', path: '/filters/{filter}' },
    { method: 'delete', path: '/filters/{filter}' },
    { method: 'get', path: '/labels' },
    { method: 'post', path: '/labels' },
    { method: 'get', path: '/labels/{id}' },
    { method: 'patch', path: '/labels/{id}' },
    { method: 'delete', path: '/labels/{id}' },
    { method: 'post', path: '/migration/csv/detect' },
    { method: 'post', path: '/migration/csv/preview' },
    { method: 'post', path: '/migration/csv/migrate' },
    { method: 'get', path: '/migration/csv/status' },
    { method: 'get', path: '/user/export' },
    { method: 'post', path: '/user/export/request' },
    { method: 'post', path: '/user/export/download' },
    { method: 'get', path: '/webhooks/events' },
    { method: 'get', path: '/projects/{project}/webhooks' },
    { method: 'post', path: '/projects/{project}/webhooks' },
    { method: 'put', path: '/projects/{project}/webhooks/{webhook}' },
    { method: 'delete', path: '/projects/{project}/webhooks/{webhook}' },
    { method: 'get', path: '/user/settings/webhooks' },
    { method: 'post', path: '/user/settings/webhooks' },
    { method: 'get', path: '/user/settings/webhooks/events' },
    { method: 'put', path: '/user/settings/webhooks/{webhook}' },
    { method: 'delete', path: '/user/settings/webhooks/{webhook}' },
  ];

  for (const route of expectedRoutes) {
    it(`should support ${route.method.toUpperCase()} ${route.path}`, () => {
      const pathObj = openapi.paths[route.path];
      expect(pathObj).toBeDefined();
      const methodObj = pathObj[route.method];
      expect(methodObj).toBeDefined();
    });
  }

  it('should confirm relation_kind values in tasks-relations-create schema', () => {
    // Post path: /tasks/{task}/relations
    const relationCreate = openapi.paths['/tasks/{task}/relations']?.post;
    expect(relationCreate).toBeDefined();

    // Find relation_kind property in the requestBody schema
    const requestBody = relationCreate.requestBody;
    expect(requestBody).toBeDefined();

    // The reference can be direct or nested, let's resolve components/schemas/TaskRelation if needed
    // Usually body is dynamic or schema is directly mapped.
    // Let's print or verify the relation kind enum.
    let schema = requestBody.content?.['application/json']?.schema;
    if (schema && schema.$ref) {
      const refName = schema.$ref.split('/').pop();
      schema = openapi.components.schemas[refName];
    }
    expect(schema).toBeDefined();

    const relationKindProp = schema.properties?.relation_kind;
    expect(relationKindProp).toBeDefined();
    const kinds = relationKindProp.enum;
    expect(kinds).toBeDefined();

    const expectedKinds = [
      'subtask',
      'parenttask',
      'related',
      'duplicateof',
      'duplicates',
      'blocking',
      'blocked',
      'precedes',
      'follows',
      'copiedfrom',
      'copiedto',
    ];

    for (const kind of expectedKinds) {
      expect(kinds).toContain(kind);
    }
  });

  it('should confirm task-create request body fields', () => {
    const taskCreate = openapi.paths['/projects/{project}/tasks']?.post;
    expect(taskCreate).toBeDefined();

    let schema = taskCreate.requestBody?.content?.['application/json']?.schema;
    if (schema && schema.$ref) {
      const refName = schema.$ref.split('/').pop();
      schema = openapi.components.schemas[refName];
    }
    expect(schema).toBeDefined();
    expect(schema.properties?.title).toBeDefined();
    // We expect done, priority, description, etc.
  });
});

describe('README agent update prompt', () => {
  it('uses the npm installation, global command, and current package version in five lines', () => {
    const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');
    const prompt = readme.match(
      /### Copy-Paste Agent Update Prompt\s+```text\r?\n([\s\S]*?)\r?\n```/,
    )?.[1];

    expect(prompt).toBeDefined();
    expect(prompt?.split(/\r?\n/)).toHaveLength(5);
    expect(prompt).toContain('npm install -g vikunja-fastmcp@latest');
    expect(prompt).toContain('Get-Command vikunja-mcp');
    expect(prompt).toContain('command -v vikunja-mcp');
    expect(prompt).not.toContain('where.exe');
    expect(prompt).toContain('command "vikunja-mcp"');
    expect(prompt).toContain('npm root -g');
    expect(prompt).toContain("agent's user-wide skill directory");
    expect(prompt).toContain('~/.codex/skills/vikunja-fastmcp');
    expect(prompt).toContain('~/.claude/skills/vikunja-fastmcp');
    expect(prompt).toContain('npm view vikunja-fastmcp version');
    expect(prompt).not.toMatch(/expected latest is \d/);
  });
});

describe('packaged Vikunja skill', () => {
  it('documents safe task identity, search, formatting, and pagination', () => {
    const skill = fs.readFileSync(
      path.join(process.cwd(), 'skills', 'vikunja-fastmcp', 'SKILL.md'),
      'utf8',
    );
    const normalizedSkill = skill.replace(/\s+/g, ' ');

    expect(normalizedSkill).toContain('Use `q` for ordinary free-text task search');
    expect(normalizedSkill).toContain('`search` is an equivalent alias');
    expect(normalizedSkill).toContain('Do not run `self_check` or probe filter syntax');
    expect(normalizedSkill).toContain(
      'A bare numeric selector always means the global database ID',
    );
    expect(normalizedSkill).toContain('`taskSelector: 360` targets global task 360');
    expect(normalizedSkill).toContain('`taskSelector: "#360"` plus an explicit `projectSelector`');
    expect(normalizedSkill).toContain('Task-list `perPage` must not exceed 100');
    expect(normalizedSkill).toContain(
      'Wrap file paths, commands, and code identifiers in inline backticks',
    );
  });
});
