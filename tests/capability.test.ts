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
    // Prefer live openapi if it exists, fallback to saved snapshot
    const livePath = path.join(process.cwd(), 'docs/vikunja-v2-openapi-live.json');
    const savedPath = path.join(process.cwd(), 'docs/vikunja-v2-openapi.json');
    const targetPath = fs.existsSync(livePath) ? livePath : savedPath;

    expect(fs.existsSync(targetPath)).toBe(true);
    const content = fs.readFileSync(targetPath, 'utf8');
    openapi = JSON.parse(content);
  });

  const expectedRoutes = [
    { method: 'get', path: '/info' },
    { method: 'get', path: '/user' },
    { method: 'get', path: '/users' },
    { method: 'get', path: '/projects' },
    { method: 'get', path: '/projects/{id}' },
    { method: 'get', path: '/projects/{project}/tasks' },
    { method: 'get', path: '/tasks' },
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
    { method: 'put', path: '/teams/{id}' },
    { method: 'delete', path: '/teams/{id}' },
    { method: 'post', path: '/teams/{team}/members' },
    { method: 'delete', path: '/teams/{team}/members/{user}' },
    { method: 'post', path: '/teams/{team}/members/{user}/admin' },
    { method: 'post', path: '/filters' },
    { method: 'get', path: '/filters/{filter}' },
    { method: 'put', path: '/filters/{filter}' },
    { method: 'delete', path: '/filters/{filter}' },
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
