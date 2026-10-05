/** Refresh generated, sanitized OpenAPI documents after a server upgrade. */
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const response = await fetch(`${config.vikunjaUrl}/openapi.json`, {
  headers: { Authorization: `Bearer ${config.vikunjaToken}` },
  signal: AbortSignal.timeout(config.requestTimeoutMs ?? 30_000),
  redirect: 'error',
});
if (!response.ok) throw new Error(`OpenAPI refresh failed with HTTP ${response.status}.`);
const spec = (await response.json()) as any;
if (!spec.paths || !spec.components?.schemas || typeof spec.info?.version !== 'string') {
  throw new Error('OpenAPI refresh returned an incomplete contract.');
}
spec.servers = [{ url: '/api/v2' }];
const sanitized = JSON.stringify(spec)
  .replaceAll(config.vikunjaUrl, 'https://vikunja.example.com/api/v2')
  .replaceAll(config.vikunjaWebUrl, 'https://vikunja.example.com/');
if (sanitized.includes(config.vikunjaToken)) throw new Error('OpenAPI contains credentials.');
fs.writeFileSync('docs/vikunja-v2-openapi.json', `${sanitized}\n`);
const version = spec.info.version;
const lines = [
  '# Vikunja V2 API Reference',
  '',
  'This file is generated from the sanitized local OpenAPI snapshot.',
  '',
  '- Raw specification: [`vikunja-v2-openapi.json`](vikunja-v2-openapi.json)',
  '- Upstream API documentation: https://vikunja.io/docs/api-documentation/',
  `- Minimum supported official release: https://github.com/go-vikunja/vikunja/releases/tag/${version}`,
  `- API version: ${version}`,
  `- OpenAPI version: ${spec.openapi}`,
  '- Instance URLs are sanitized; no credentials are stored.',
  '',
  '## Operations',
  '',
  '| Method | Path | Operation | Summary |',
  '| --- | --- | --- | --- |',
];
const operations: { method: string; path: string; operation: any }[] = [];
for (const [path, item] of Object.entries<any>(spec.paths)) {
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    if (item[method]) operations.push({ method, path, operation: item[method] });
  }
}
for (const { method, path, operation } of operations.sort(
  (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
)) {
  lines.push(
    `| ${method.toUpperCase()} | \`${path}\` | \`${operation.operationId}\` | ${String(operation.summary ?? '').replaceAll('|', '\\|')} |`,
  );
}
lines.push('', '## Schemas', '', '| Schema | Properties |', '| --- | --- |');
for (const [name, schema] of Object.entries<any>(spec.components.schemas).sort(([a], [b]) =>
  a.localeCompare(b),
)) {
  lines.push(`| \`${name}\` | ${Object.keys(schema.properties ?? {}).join(', ')} |`);
}
fs.writeFileSync('docs/VIKUNJA_V2_API_REFERENCE.md', `${lines.join('\n')}\n`);
process.stdout.write(`Refreshed ${version}: ${operations.length} operations.\n`);
