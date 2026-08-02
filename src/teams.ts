/**
 * Team and team-member management.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { VikunjaApiClient } from './api.js';
import { VikunjaError } from './errors.js';
import { fetchAllCollectionItems } from './format.js';

export interface Team {
  id: number;
  name: string;
  created: string;
  updated: string;
  members?: TeamMember[];
}

/** Normalized member: userId is always the Vikunja user id (not membership row id). */
export interface TeamMember {
  userId: number;
  username: string;
  admin: boolean;
  created?: string;
  /** Present when the API returned a separate membership row id. */
  membershipId?: number;
}

const adminMutationQueues = new Map<string, Promise<void>>();

async function serializeAdminMutation<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = adminMutationQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  adminMutationQueues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (adminMutationQueues.get(key) === queued) adminMutationQueues.delete(key);
  }
}

export async function createTeam(client: VikunjaApiClient, name: string): Promise<Team> {
  return client.request<Team>('POST', '/teams', {
    body: { name },
  });
}

export async function getTeam(client: VikunjaApiClient, id: number): Promise<Team> {
  const raw = await client.request<any>('GET', `/teams/${id}`);
  return {
    id: raw.id,
    name: raw.name,
    created: raw.created,
    updated: raw.updated,
    members: Array.isArray(raw.members) ? raw.members.map(normalizeMemberFromEmbed) : [],
  };
}

/** Embedded members use user id as `id`. */
function normalizeMemberFromEmbed(raw: any): TeamMember {
  return {
    userId: Number(raw.id),
    username: raw.username,
    admin: !!raw.admin,
    created: raw.created,
  };
}

export async function listTeams(client: VikunjaApiClient): Promise<Team[]> {
  const items = await fetchAllCollectionItems(
    async (path) => client.request<any>('GET', path),
    '/teams',
  );
  // List endpoints typically omit members — document via empty/undefined members.
  return items.map((t: any) => ({
    id: t.id,
    name: t.name,
    created: t.created,
    updated: t.updated,
  }));
}

export async function updateTeam(
  client: VikunjaApiClient,
  id: number,
  name: string,
): Promise<Team> {
  return client.request<Team>('PATCH', `/teams/${id}`, {
    body: { name },
    headers: { 'Content-Type': 'application/merge-patch+json' },
  });
}

export async function deleteTeam(
  client: VikunjaApiClient,
  id: number,
): Promise<{ ok: boolean; teamId: number }> {
  await client.request<any>('DELETE', `/teams/${id}`);
  return { ok: true, teamId: id };
}

async function fetchTeamMembers(client: VikunjaApiClient, teamId: number): Promise<TeamMember[]> {
  const team = await getTeam(client, teamId);
  return team.members || [];
}

function findTeamMember(
  members: TeamMember[],
  usernameOrId: string | number,
): TeamMember | undefined {
  const sel = String(usernameOrId).trim();
  if (/^\d+$/.test(sel)) {
    const id = Number(sel);
    return members.find((m) => m.userId === id);
  }
  return members.find((m) => m.username.toLowerCase() === sel.toLowerCase());
}

export async function addTeamMember(
  client: VikunjaApiClient,
  teamId: number,
  usernameOrId: string | number,
): Promise<TeamMember> {
  const sel = String(usernameOrId).trim();

  if (/^\d+$/.test(sel)) {
    throw new VikunjaError({
      status: 400,
      code: 'USERNAME_REQUIRED',
      method: 'POST',
      path: `/teams/${teamId}/members`,
      message: `Adding a team member requires a username; the Vikunja v2 API has no lookup of a user by numeric id (received "${sel}").`,
      fieldErrors: [],
    });
  }

  const raw = await client.request<any>('POST', `/teams/${teamId}/members`, {
    body: { username: sel },
  });

  // Re-read team so userId is the embedded user id, not the membership row id
  // that POST sometimes returns as `id`.
  const members = await fetchTeamMembers(client, teamId);
  const found = findTeamMember(members, sel);
  if (found) {
    return found;
  }

  // Read-back did not show the member. Only trust an explicit user id from the
  // add response; never return userId:0, which callers could store as a real id.
  const rawUserId = Number(raw.user_id ?? raw.userId);
  if (Number.isInteger(rawUserId) && rawUserId > 0) {
    return {
      userId: rawUserId,
      username: raw.username || sel,
      admin: !!raw.admin,
      created: raw.created,
      membershipId: raw.id !== undefined ? Number(raw.id) : undefined,
    };
  }
  throw new VikunjaError({
    status: 502,
    code: 'MEMBER_ADD_UNVERIFIED',
    method: 'POST',
    path: `/teams/${teamId}/members`,
    message: `Added "${sel}" but could not read the member back to resolve its user id. Re-fetch the team to confirm.`,
    fieldErrors: [],
  });
}

export async function removeTeamMember(
  client: VikunjaApiClient,
  teamId: number,
  usernameOrId: string | number,
): Promise<{ ok: boolean; username: string; userId?: number }> {
  const sel = String(usernameOrId).trim();
  let username = sel;
  let userId: number | undefined;

  if (/^\d+$/.test(sel)) {
    const member = findTeamMember(await fetchTeamMembers(client, teamId), sel);
    if (!member) {
      throw new VikunjaError({
        status: 404,
        code: 'MEMBER_NOT_FOUND',
        method: 'DELETE',
        path: `/teams/${teamId}/members/${sel}`,
        message: `No member with user id ${sel} in team ${teamId}. (Use the user id from getTeam members, not a membership row id from add.)`,
        fieldErrors: [],
      });
    }
    username = member.username;
    userId = member.userId;
  }

  await client.request<any>('DELETE', `/teams/${teamId}/members/${encodeURIComponent(username)}`);
  return { ok: true, username, userId };
}

export async function setTeamMemberAdmin(
  client: VikunjaApiClient,
  teamId: number,
  usernameOrId: string | number,
  admin: boolean,
): Promise<TeamMember> {
  return serializeAdminMutation(
    `${teamId}:${String(usernameOrId).trim().toLowerCase()}`,
    async () => {
      const members = await fetchTeamMembers(client, teamId);
      const member = findTeamMember(members, usernameOrId);
      if (!member) {
        throw new VikunjaError({
          status: 404,
          code: 'MEMBER_NOT_FOUND',
          method: 'POST',
          path: `/teams/${teamId}/members/${String(usernameOrId).trim()}/admin`,
          message: `Member "${usernameOrId}" is not in team ${teamId}.`,
          fieldErrors: [],
        });
      }

      if (member.admin === admin) {
        return member;
      }

      // POST admin is a toggle on this API — only call when state must change.
      await client.request<any>(
        'POST',
        `/teams/${teamId}/members/${encodeURIComponent(member.username)}/admin`,
      );

      // Re-fetch to return authoritative state after the toggle.
      const refreshed = findTeamMember(await fetchTeamMembers(client, teamId), member.username);
      if (refreshed && refreshed.admin === admin) {
        return refreshed;
      }
      throw new VikunjaError({
        status: 502,
        code: 'MEMBER_ADMIN_UPDATE_UNVERIFIED',
        method: 'POST',
        path: `/teams/${teamId}/members/${encodeURIComponent(member.username)}/admin`,
        message: `Vikunja accepted the admin toggle for "${member.username}" but the requested state could not be verified. Re-read the team before retrying.`,
        fieldErrors: [],
      });
    },
  );
}
