/**
 * Generates/validates MCP_API.md from the runtime tool schemas.
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
import { TOOLS } from '../src/index.js';
import { TOOL_OPERATION_DOCS } from '../src/tool-contract.js';
import { z } from 'zod';

const rootDir = process.cwd();
const targetPath = path.join(rootDir, 'MCP_API.md');

function getPropertyTypeDescription(prop: any): string {
  let inner = prop;
  let isOptional = false;

  if (inner instanceof z.ZodOptional) {
    isOptional = true;
    inner = inner._def.innerType;
  }
  if (inner instanceof z.ZodNullable) {
    inner = inner._def.innerType;
  }

  let typeStr = 'string';
  if (inner instanceof z.ZodNumber) typeStr = 'number';
  else if (inner instanceof z.ZodBoolean) typeStr = 'boolean';
  else if (inner instanceof z.ZodEnum)
    typeStr = `enum [${inner._def.values.map((v: any) => `"${v}"`).join(', ')}]`;
  else if (inner instanceof z.ZodArray) typeStr = 'array';
  else if (inner instanceof z.ZodObject) typeStr = 'object';
  else if (inner instanceof z.ZodRecord) typeStr = 'object';
  else if (inner instanceof z.ZodUnion) typeStr = 'string | number';

  const constraints: string[] = [];
  for (const check of inner?._def?.checks ?? []) {
    if (check.kind === 'int') constraints.push('integer');
    if (check.kind === 'min') constraints.push(`min ${check.value}`);
    if (check.kind === 'max') constraints.push(`max ${check.value}`);
  }

  const suffix = constraints.length > 0 ? `; ${constraints.join(', ')}` : '';
  return `${typeStr}${isOptional ? ' (optional)' : ' (required)'}${suffix}`;
}

function generateMarkdown(): string {
  let md = `# Vikunja FastMCP V2 Tool Reference\n\n`;
  md += `This reference is generated automatically from runtime schemas.\n\n`;
  md += `Tools with multiple actions publish action-specific JSON Schema branches, so clients can present only the fields valid for the selected action.\n\n`;
  md += `All responses contain a short Markdown summary followed by exactly one fenced JSON envelope: \`{ "ok": true, "data": ... }\` or \`{ "ok": false, "error": ... }\`. HTTP error status, method, and path are preserved and secrets are redacted.\n\n`;
  md += `## Identity And Scope\n\n`;
  md += `Numeric task selectors are global database IDs. A portal reference such as \`#305\` or \`PRJ-305\` requires an explicit \`projectSelector\`. Task lists require exactly one explicit scope: \`projectSelector\`, \`projects\`, or \`allProjects: true\`. Writes echo task title, project title/id, portal index, identifier, and global ID.\n\n`;
  md += `Normalized task records include \`creator: { id, username }\` when Vikunja supplies \`created_by\`. Project exports always include creator identity; comments are included only when \`includeComments: true\` is requested.\n\n`;
  md += `## Tools\n\n`;

  for (const tool of TOOLS) {
    md += `### \`${tool.name}\`\n`;
    md += `* **Description**: ${tool.description}\n`;
    md += `* **Parameters**:\n`;

    const shape = tool.inputSchema.shape;
    const entries = Object.entries(shape);

    if (entries.length === 0) {
      md += `  * None\n`;
    } else {
      for (const [key, value] of entries) {
        md += `  * \`${key}\`: ${getPropertyTypeDescription(value)}\n`;
      }
    }
    md += `\n`;

    const operations = TOOL_OPERATION_DOCS[tool.name];
    if (operations) {
      md += `#### Operations\n\n`;
      md += `| Action | Required | Optional | Execution |\n`;
      md += `| --- | --- | --- | --- |\n`;
      for (const operation of operations) {
        const required = operation.required?.join(', ') || 'none';
        const optional = operation.optional?.join(', ') || 'none';
        const execution = operation.note
          ? `${operation.execution}. ${operation.note}`
          : operation.execution;
        md += `| \`${operation.action}\` | ${required} | ${optional} | ${execution} |\n`;
      }
      md += `\n`;
    }
  }

  md += `## Attachment Examples\n\n`;
  md += `Upload local logs with \`vikunja_tasks\` action \`attach\`, a global or project-scoped \`taskSelector\`, and \`filePaths\`. Inline content uses \`base64Content\` plus \`filename\`. Download with action \`download-attachment\` and \`attachmentId\`; bytes stream to the configured temporary sandbox and the response contains only local path and metadata.\n\n`;
  md += `## Limits And Defaults\n\n`;
  md += `Task lists default to open tasks, compact response mode, page 1, and 20 items. Requests above 100 items per project page are safely capped to 100 with truthful pagination metadata. The 100-item ceiling keeps typical compact responses below 100 KB while avoiding the megabyte-scale responses produced by unbounded pages. Use \`countOnly\` for totals and request later pages for more items. Task get is compact by default; explicit \`full\` mode includes the latest 5 comments unless \`commentLimit\` changes that bounded value. Bulk update, create, and delete accept at most 100 tasks per call; composed create/delete are non-atomic, and delete requires \`confirm: true\`. CSV imports and file downloads use \`VIKUNJA_MAX_ATTACHMENT_BYTES\` (default 100 MiB); Vikunja controls CSV row limits. Idempotency keys are process-local, expire after five minutes, and do not provide distributed locking.\n`;

  return md;
}

const isCheck = process.argv.includes('--check');
const content = generateMarkdown();

if (isCheck) {
  if (!fs.existsSync(targetPath)) {
    console.error('MCP_API.md does not exist.');
    process.exit(1);
  }
  const existing = fs.readFileSync(targetPath, 'utf8');
  if (existing.replace(/\r\n/g, '\n') !== content.replace(/\r\n/g, '\n')) {
    console.error('MCP_API.md is out of sync. Run npm run docs:api to regenerate.');
    process.exit(1);
  }
  console.log('MCP_API.md check passed.');
  process.exit(0);
} else {
  fs.writeFileSync(targetPath, content, 'utf8');
  console.log('MCP_API.md generated successfully.');
  process.exit(0);
}
