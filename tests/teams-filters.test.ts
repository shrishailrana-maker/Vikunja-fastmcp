/**
 * Tests for teams and saved filters.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { jest } from '@jest/globals';
import { VikunjaApiClient } from '../src/api.js';
import {
  createTeam,
  getTeam,
  listTeams,
  updateTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  setTeamMemberAdmin,
} from '../src/teams.js';
import {
  createSavedFilter,
  getSavedFilter,
  updateSavedFilter,
  deleteSavedFilter,
} from '../src/filters.js';

describe('Teams and Saved Filters tests', () => {
  const config = {
    vikunjaUrl: 'https://vikunja.example.com/api/v2',
    vikunjaToken: 'tk_token',
    vikunjaWebUrl: 'https://vikunja.example.com/',
    attachmentDownloadRoot: '/tmp',
  };

  let client: VikunjaApiClient;
  let mockFetch: any;

  beforeEach(() => {
    client = new VikunjaApiClient(config);
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  describe('Teams CRUD', () => {
    it('should create team, get, list, update and delete', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 1, name: 'Admins' }),
      } as Response);

      const team = await createTeam(client, 'Admins');
      expect(team.id).toBe(1);
      expect(team.name).toBe('Admins');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 1, name: 'Admins' }),
      } as Response);

      const fetched = await getTeam(client, 1);
      expect(fetched.name).toBe('Admins');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ id: 1, name: 'Admins' }]),
      } as Response);

      const list = await listTeams(client);
      expect(list.length).toBe(1);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 1, name: 'Super Admins' }),
      } as Response);

      const updated = await updateTeam(client, 1, 'Super Admins');
      expect(updated.name).toBe('Super Admins');
      expect(mockFetch.mock.calls.at(-1)?.[1]?.method).toBe('PATCH');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const delRes = await deleteTeam(client, 1);
      expect(delRes.ok).toBe(true);
      expect(delRes.teamId).toBe(1);
    });
  });

  describe('Team Members Management', () => {
    it('should add team member by username and return userId not membership id', async () => {
      // POST may return membership row id; we re-GET the team for the user id.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 999, username: 'bob', admin: false }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 1,
            name: 'Admins',
            members: [{ id: 5, username: 'bob', admin: false }],
          }),
      } as Response);

      const member = await addTeamMember(client, 1, 'bob');
      expect(member.username).toBe('bob');
      expect(member.userId).toBe(5);

      const postCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      expect(JSON.parse(postCall[1].body)).toEqual({ username: 'bob' });
    });

    it('rejects adding a member by numeric id (v2 has no user-by-id lookup)', async () => {
      await expect(addTeamMember(client, 1, '42')).rejects.toThrow(
        expect.objectContaining({ status: 400, code: 'USERNAME_REQUIRED' }),
      );
      // Fails fast, before any HTTP call.
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    it('should remove a team member by username', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const res = await removeTeamMember(client, 1, 'charlie');
      expect(res.ok).toBe(true);
      expect(res.username).toBe('charlie');
    });

    it('resolves a numeric member id via the team members list (remove)', async () => {
      // GET /teams/1 returns the team with embedded members (v2 shape).
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 1,
            name: 'Admins',
            members: [{ id: 5, username: 'bob', admin: false }],
          }),
      } as Response);
      mockFetch.mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' } as Response);

      const res = await removeTeamMember(client, 1, 5);
      expect(res.username).toBe('bob');
      const del = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'DELETE');
      expect(del[0]).toContain('/teams/1/members/bob');
    });

    it('toggles admin status only when it differs from the requested state', async () => {
      // GET team — bob is not an admin yet.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 1,
            name: 'Admins',
            members: [{ id: 5, username: 'bob', admin: false }],
          }),
      } as Response);
      // toggle POST
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ message: 'ok' }),
      } as Response);
      // re-GET after toggle
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 1,
            name: 'Admins',
            members: [{ id: 5, username: 'bob', admin: true }],
          }),
      } as Response);

      const res1 = await setTeamMemberAdmin(client, 1, 'bob', true);
      expect(res1.admin).toBe(true);
      expect(res1.userId).toBe(5);
      expect(mockFetch.mock.calls.filter((c: any) => c[1]?.method === 'POST').length).toBe(1);

      mockFetch.mockClear();

      // Already admin -> no toggle POST.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 1,
            name: 'Admins',
            members: [{ id: 5, username: 'bob', admin: true }],
          }),
      } as Response);

      const res2 = await setTeamMemberAdmin(client, 1, 'bob', true);
      expect(res2.admin).toBe(true);
      expect(mockFetch.mock.calls.filter((c: any) => c[1]?.method === 'POST').length).toBe(0);
    });
  });

  describe('Saved Filters CRUD', () => {
    it('should create, get, update, and delete saved filter', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 10, title: 'F1', filters: 'done = false' }),
      } as Response);

      const filter = await createSavedFilter(client, 'F1', 'done = false');
      expect(filter.id).toBe(10);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 10, title: 'F1', filters: 'done = false' }),
      } as Response);

      const fetched = await getSavedFilter(client, 10);
      expect(fetched.title).toBe('F1');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 10, title: 'F2', filters: 'done = false' }),
      } as Response);

      const updated = await updateSavedFilter(client, 10, { title: 'F2' });
      expect(updated.title).toBe('F2');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const delRes = await deleteSavedFilter(client, 10);
      expect(delRes.ok).toBe(true);
    });

    it('should declare filters listing as an unsupported operation', async () => {
      // Listing is unregistered from the tool; self-check documents why.
      const { UNSUPPORTED_OPERATIONS } = await import('../src/diagnostics.js');
      expect(UNSUPPORTED_OPERATIONS.map((o) => o.operation)).toContain('vikunja_filters:list');
    });
  });
});
