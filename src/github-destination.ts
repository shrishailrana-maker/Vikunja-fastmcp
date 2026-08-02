import { VikunjaError, redactSecrets } from './errors.js';
import { isIP } from 'node:net';

export interface GitHubDestinationConfig {
  owner: string;
  repo: string;
  apiUrl?: string;
}

export interface GitHubIssueReceipt {
  number: number;
  url: string;
  title: string;
  body: string;
  state: string;
}

export interface GitHubCommentInput {
  sourceId: number;
  body: string;
  marker: string;
}

function githubToken(): string {
  const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim();
  if (!token) {
    throw new VikunjaError({
      status: 401,
      code: 'GITHUB_TOKEN_REQUIRED',
      method: 'TOOLS_CALL',
      path: 'environment',
      message: 'Set GITHUB_TOKEN or GH_TOKEN in the MCP process environment.',
      fieldErrors: [],
    });
  }
  return token;
}

function normalizedApiUrl(value?: string): string {
  const url = (value?.trim() || 'https://api.github.com').replace(/\/+$/, '');
  const parsed = new URL(url);
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const configuredHosts = (process.env.VIKUNJA_GITHUB_API_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean);
  const allowedHosts = new Set(['api.github.com', ...configuredHosts]);
  const unsafeHostname =
    isIP(hostname) !== 0 ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    unsafeHostname ||
    !allowedHosts.has(hostname)
  ) {
    throw new VikunjaError({
      status: 400,
      code: 'UNSAFE_GITHUB_API_URL',
      method: 'TOOLS_CALL',
      path: 'destination.apiUrl',
      message:
        'GitHub apiUrl must use HTTPS and an approved host. Add a trusted GitHub Enterprise hostname to VIKUNJA_GITHUB_API_HOSTS.',
      fieldErrors: [],
    });
  }
  return url;
}

function githubRequestTimeoutMs(): number {
  const configured = Number(process.env.VIKUNJA_GITHUB_TIMEOUT_MS);
  return Number.isSafeInteger(configured) && configured >= 1_000 && configured <= 120_000
    ? configured
    : 30_000;
}

function normalizedIssue(value: any): GitHubIssueReceipt {
  return {
    number: Number(value.number),
    url: String(value.html_url ?? ''),
    title: String(value.title ?? ''),
    body: String(value.body ?? ''),
    state: String(value.state ?? 'open'),
  };
}

export class GitHubIssueDestination {
  private readonly token: string;
  private readonly apiUrl: string;
  private readonly repoPath: string;

  constructor(
    private readonly config: GitHubDestinationConfig,
    private readonly heartbeat?: () => void,
  ) {
    this.token = githubToken();
    this.apiUrl = normalizedApiUrl(config.apiUrl);
    this.repoPath = `/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`;
  }

  private async request<T>(method: string, requestPath: string, body?: unknown): Promise<T> {
    this.heartbeat?.();
    const response = await fetch(`${this.apiUrl}${requestPath}`, {
      method,
      signal: AbortSignal.timeout(githubRequestTimeoutMs()),
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'vikunja-fastmcp',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    this.heartbeat?.();
    const text = await response.text();
    let value: any = null;
    if (text) {
      try {
        value = JSON.parse(text);
      } catch {
        value = { message: text.slice(0, 500) };
      }
    }
    if (!response.ok) {
      const safeMessage = redactSecrets(
        String(value?.message ?? `GitHub returned HTTP ${response.status}`),
        this.token,
      );
      throw new VikunjaError({
        status: response.status,
        code: 'GITHUB_DESTINATION_ERROR',
        method,
        path: requestPath,
        message: safeMessage,
        fieldErrors: [],
      });
    }
    return value as T;
  }

  async findIssueByMarker(marker: string): Promise<GitHubIssueReceipt | null> {
    for (let page = 1; page <= 10; page += 1) {
      const issues = await this.request<any[]>(
        'GET',
        `${this.repoPath}/issues?state=all&sort=created&direction=desc&per_page=100&page=${page}`,
      );
      const match = issues.find(
        (issue) => !issue.pull_request && String(issue.body ?? '').includes(marker),
      );
      if (match) return normalizedIssue(match);
      if (issues.length < 100) return null;
    }
    throw new VikunjaError({
      status: 409,
      code: 'MIGRATION_LOOKUP_INCOMPLETE',
      method: 'GET',
      path: `${this.repoPath}/issues`,
      message:
        'Destination duplicate lookup reached its 1,000-issue safety cap. No issue was created.',
      fieldErrors: [],
    });
  }

  async createIssue(title: string, body: string): Promise<GitHubIssueReceipt> {
    const issue = await this.request<any>('POST', `${this.repoPath}/issues`, { title, body });
    return normalizedIssue(issue);
  }

  async readIssue(number: number): Promise<GitHubIssueReceipt> {
    return normalizedIssue(await this.request<any>('GET', `${this.repoPath}/issues/${number}`));
  }

  async migrateComments(number: number, comments: GitHubCommentInput[]): Promise<number> {
    if (comments.length === 0) return 0;
    const existingBodies: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const pageItems = await this.request<any[]>(
        'GET',
        `${this.repoPath}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      existingBodies.push(...pageItems.map((comment) => String(comment.body ?? '')));
      if (pageItems.length < 100) break;
      if (page === 10) {
        throw new VikunjaError({
          status: 409,
          code: 'MIGRATION_COMMENT_LOOKUP_INCOMPLETE',
          method: 'GET',
          path: `${this.repoPath}/issues/${number}/comments`,
          message: 'Comment deduplication reached its 1,000-comment safety cap.',
          fieldErrors: [],
        });
      }
    }
    let created = 0;
    for (const comment of comments) {
      if (existingBodies.some((body) => body.includes(comment.marker))) continue;
      await this.request('POST', `${this.repoPath}/issues/${number}/comments`, {
        body: `${comment.body}\n\n${comment.marker}`,
      });
      created += 1;
    }
    return created;
  }

  async verifyComments(number: number, comments: GitHubCommentInput[]): Promise<void> {
    if (comments.length === 0) return;
    const existingBodies: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const pageItems = await this.request<any[]>(
        'GET',
        `${this.repoPath}/issues/${number}/comments?per_page=100&page=${page}`,
      );
      existingBodies.push(...pageItems.map((comment) => String(comment.body ?? '')));
      if (pageItems.length < 100) break;
      if (page === 10) {
        throw new VikunjaError({
          status: 409,
          code: 'MIGRATION_COMMENT_LOOKUP_INCOMPLETE',
          method: 'GET',
          path: `${this.repoPath}/issues/${number}/comments`,
          message: 'Comment verification reached its 1,000-comment safety cap.',
          fieldErrors: [],
        });
      }
    }
    const missing = comments.find(
      (comment) => !existingBodies.includes(`${comment.body}\n\n${comment.marker}`),
    );
    if (missing) {
      throw new VikunjaError({
        status: 502,
        code: 'MIGRATION_COMMENT_READBACK_MISMATCH',
        method: 'GET',
        path: `${this.repoPath}/issues/${number}/comments`,
        message: `Destination comment for source comment ${missing.sourceId} did not verify.`,
        fieldErrors: [],
      });
    }
  }

  describe() {
    return { type: 'github' as const, owner: this.config.owner, repo: this.config.repo };
  }
}
