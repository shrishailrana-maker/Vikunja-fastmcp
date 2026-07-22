/** Idempotent, row-by-row CSV import using the normal task API. */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { VikunjaApiClient } from './api.js';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from './config.js';
import { VikunjaError } from './errors.js';
import { applyLabel, createTask } from './tasks.js';

const MAX_IDEMPOTENT_ROWS = 1000;
const MAX_IMPORT_LEDGER_KEYS = 100;
const SUPPORTED_ATTRIBUTES = new Set([
  'title',
  'description',
  'due_date',
  'done',
  'priority',
  'labels',
  'project',
  'ignore',
]);

interface ColumnMapping {
  column_index: number;
  column_name?: string;
  attribute: string;
}

export interface CsvImportConfig {
  delimiter?: string;
  quote_char?: string;
  date_format?: string;
  skip_rows?: number;
  mapping: ColumnMapping[];
}

interface ParsedImportTask {
  title: string;
  description?: string;
  done?: boolean;
  priority?: number;
  dueDate?: string;
  labels: string[];
  project?: string;
  rowNumber: number;
}

const importLedger = new Map<string, Map<string, number>>();

function importError(code: string, message: string, path = 'config'): VikunjaError {
  return new VikunjaError({
    status: 400,
    code,
    method: 'TOOLS_CALL',
    path,
    message,
    fieldErrors: [],
  });
}

function validateConfig(config: unknown): CsvImportConfig {
  if (!config || typeof config !== 'object') {
    throw importError('INVALID_IMPORT_CONFIG', 'CSV import config must be an object.');
  }
  const candidate = config as Partial<CsvImportConfig>;
  const delimiter = candidate.delimiter || ',';
  const quoteChar = candidate.quote_char || '"';
  if (![',', ';', '\t', '|'].includes(delimiter) || delimiter.length !== 1) {
    throw importError('INVALID_IMPORT_CONFIG', 'delimiter must be comma, semicolon, tab, or pipe.');
  }
  if (!['"', "'"].includes(quoteChar)) {
    throw importError('INVALID_IMPORT_CONFIG', 'quote_char must be a single or double quote.');
  }
  if (!Array.isArray(candidate.mapping) || candidate.mapping.length === 0) {
    throw importError('INVALID_IMPORT_CONFIG', 'mapping must contain at least one column mapping.');
  }
  const mapping = candidate.mapping.map((item) => {
    if (
      !item ||
      !Number.isInteger(item.column_index) ||
      item.column_index < 0 ||
      typeof item.attribute !== 'string'
    ) {
      throw importError('INVALID_IMPORT_CONFIG', 'Each mapping needs column_index and attribute.');
    }
    if (!SUPPORTED_ATTRIBUTES.has(item.attribute)) {
      throw importError(
        'IDEMPOTENT_IMPORT_FIELD_UNSUPPORTED',
        `Idempotent mode does not support mapped attribute "${item.attribute}". Use native mode for start_date, end_date, or reminder.`,
      );
    }
    return {
      column_index: item.column_index,
      column_name: item.column_name,
      attribute: item.attribute,
    };
  });
  if (!mapping.some((item) => item.attribute === 'title')) {
    throw importError('INVALID_IMPORT_CONFIG', 'At least one CSV column must map to title.');
  }
  const skipRows = candidate.skip_rows ?? 0;
  if (!Number.isInteger(skipRows) || skipRows < 0) {
    throw importError('INVALID_IMPORT_CONFIG', 'skip_rows must be a non-negative integer.');
  }
  return {
    delimiter,
    quote_char: quoteChar,
    date_format: candidate.date_format || '2006-01-02',
    skip_rows: skipRows,
    mapping,
  };
}

function parseCsv(text: string, delimiter: string, quoteChar: string, maxRows: number): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    if (row.some((cell) => cell.length > 0)) rows.push(row);
    row = [];
    if (rows.length > maxRows) {
      throw importError(
        'IDEMPOTENT_IMPORT_TOO_LARGE',
        `Idempotent mode accepts at most ${MAX_IDEMPOTENT_ROWS} task rows; use native mode for larger files.`,
        'filePath',
      );
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === quoteChar) {
      if (quoted && text[index + 1] === quoteChar) {
        field += quoteChar;
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === delimiter) {
      pushField();
    } else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      field += character;
    }
  }
  if (quoted) throw importError('INVALID_CSV', 'CSV contains an unterminated quoted field.');
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

function parseDone(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['true', 'yes', '1', 'done', 'completed'].includes(normalized)) return true;
  if (['false', 'no', '0', 'open', 'incomplete'].includes(normalized)) return false;
  throw importError('INVALID_CSV_BOOLEAN', `Could not parse done value "${value}".`);
}

function parsePriority(value: string): number {
  const numeric = Number(value.trim());
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 5) return numeric;
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('urgent') || normalized.includes('highest')) return 5;
  if (normalized.includes('high')) return 4;
  if (normalized.includes('medium') || normalized.includes('normal')) return 3;
  if (normalized.includes('lowest')) return 1;
  if (normalized.includes('low')) return 2;
  throw importError('INVALID_CSV_PRIORITY', `Could not parse priority value "${value}".`);
}

function utcDate(year: string, month: string, day: string, time = '00:00:00'): string {
  const value = new Date(`${year}-${month}-${day}T${time}Z`);
  const expectedDate = `${year}-${month}-${day}`;
  if (Number.isNaN(value.getTime()) || value.toISOString().slice(0, 10) !== expectedDate) {
    throw importError('INVALID_CSV_DATE', 'CSV date is invalid.');
  }
  return value.toISOString();
}

function parseDate(value: string, layout: string): string {
  const input = value.trim();
  const direct = Date.parse(input);

  const timeMatch = input.match(/(?:[ T])(\d{2}:\d{2}(?::\d{2})?)$/);
  const time = timeMatch
    ? timeMatch[1].length === 5
      ? `${timeMatch[1]}:00`
      : timeMatch[1]
    : undefined;
  const datePart = timeMatch ? input.slice(0, timeMatch.index).trim() : input;
  const numbers = datePart.match(/^(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})$/);
  if (!numbers) {
    if (!Number.isNaN(direct)) return new Date(direct).toISOString();
    throw importError('INVALID_CSV_DATE', `Could not parse CSV date "${input}".`);
  }

  let year: string;
  let month: string;
  let day: string;
  if (layout.startsWith('2006')) {
    [, year, month, day] = numbers;
  } else if (layout.startsWith('02')) {
    [, day, month, year] = numbers;
  } else {
    [, month, day, year] = numbers;
  }
  return utcDate(year.padStart(4, '0'), month.padStart(2, '0'), day.padStart(2, '0'), time);
}

function mappedValue(
  row: string[],
  mapping: ColumnMapping[],
  attribute: string,
): string | undefined {
  let result: string | undefined;
  for (const item of mapping) {
    if (item.attribute === attribute && item.column_index < row.length) {
      const value = row[item.column_index]?.trim();
      if (value) result = value;
    }
  }
  return result;
}

async function readRows(
  filePath: string,
  config: unknown,
  maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
): Promise<ParsedImportTask[]> {
  const parsedConfig = validateConfig(config);
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw importError(
      'INVALID_CSV',
      'CSV import file does not exist or cannot be read.',
      'filePath',
    );
  }
  if (!stat.isFile() || stat.size > maxBytes) {
    throw importError(
      'INVALID_CSV',
      `CSV import file is invalid or exceeds the configured ${maxBytes}-byte limit.`,
      'filePath',
    );
  }
  const text = (await fs.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
  const records = parseCsv(
    text,
    parsedConfig.delimiter!,
    parsedConfig.quote_char!,
    1 + parsedConfig.skip_rows! + MAX_IDEMPOTENT_ROWS,
  );
  if (records.length === 0) throw importError('INVALID_CSV', 'CSV file is empty.', 'filePath');
  const rows = records.slice(1 + parsedConfig.skip_rows!);

  return rows.map((row, index) => {
    const rowNumber = index + 2 + parsedConfig.skip_rows!;
    const title = mappedValue(row, parsedConfig.mapping, 'title');
    if (!title) {
      throw importError('INVALID_CSV_TITLE', `CSV row ${rowNumber} has no task title.`);
    }
    const description = mappedValue(row, parsedConfig.mapping, 'description');
    const dueDate = mappedValue(row, parsedConfig.mapping, 'due_date');
    const done = mappedValue(row, parsedConfig.mapping, 'done');
    const priority = mappedValue(row, parsedConfig.mapping, 'priority');
    const labels = parsedConfig.mapping
      .filter((item) => item.attribute === 'labels' && item.column_index < row.length)
      .flatMap((item) => row[item.column_index].split(',').map((label) => label.trim()))
      .filter(Boolean);
    return {
      title,
      description,
      dueDate: dueDate ? parseDate(dueDate, parsedConfig.date_format!) : undefined,
      done: done === undefined ? undefined : parseDone(done),
      priority: priority === undefined ? undefined : parsePriority(priority),
      labels: [...new Set(labels)],
      project: mappedValue(row, parsedConfig.mapping, 'project'),
      rowNumber,
    };
  });
}

function normalizedHashText(value: string | undefined): string {
  return (value ?? '').replace(/\r\n/g, '\n').trim();
}

function rowHash(project: { id?: number; title?: string }, row: ParsedImportTask): string {
  const projectKey = project.id ?? project.title?.trim().toLowerCase() ?? '';
  return crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        projectKey,
        normalizedHashText(row.title).toLowerCase(),
        normalizedHashText(row.description),
      ]),
    )
    .digest('hex');
}

function rowProject(
  row: ParsedImportTask,
  fallback?: { id?: number; title?: string },
): { id?: number; title?: string } {
  if (row.project) return { title: row.project };
  if (fallback?.id !== undefined || fallback?.title) return fallback;
  throw importError(
    'PROJECT_SCOPE_REQUIRED',
    `CSV row ${row.rowNumber} has no project mapping; supply projectSelector.`,
    'projectSelector',
  );
}

function ledgerFor(idempotencyKey: string): Map<string, number> {
  const existing = importLedger.get(idempotencyKey);
  if (existing) return existing;

  if (importLedger.size >= MAX_IMPORT_LEDGER_KEYS) {
    const oldestKey = importLedger.keys().next().value;
    if (oldestKey !== undefined) importLedger.delete(oldestKey);
  }
  const ledger = new Map<string, number>();
  importLedger.set(idempotencyKey, ledger);
  return ledger;
}

export async function previewIdempotentCsvImport(
  filePath: string,
  config: unknown,
  projectSelector?: { id?: number; title?: string },
  maxBytes = DEFAULT_MAX_ATTACHMENT_BYTES,
) {
  const rows = await readRows(filePath, config, maxBytes);
  for (const row of rows) rowProject(row, projectSelector);
  return {
    mode: 'idempotent' as const,
    totalRows: rows.length,
    tasks: rows.slice(0, 5).map(({ rowNumber, labels, project, ...task }) => ({
      ...task,
      labels,
      project: project ?? projectSelector ?? null,
      rowNumber,
    })),
  };
}

export async function importCsvIdempotently(
  client: VikunjaApiClient,
  filePath: string,
  config: unknown,
  idempotencyKey: string,
  projectSelector?: { id?: number; title?: string },
  actor?: string,
) {
  const rows = await readRows(
    filePath,
    config,
    client.getConfig().maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES,
  );
  if (rows.length > MAX_IDEMPOTENT_ROWS) {
    throw importError(
      'IDEMPOTENT_IMPORT_TOO_LARGE',
      `Idempotent mode accepts at most ${MAX_IDEMPOTENT_ROWS} rows; use native mode for larger files.`,
      'filePath',
    );
  }
  const ledger = ledgerFor(idempotencyKey);
  let created = 0;
  let skipped = 0;
  const failures: { row: number; message: string }[] = [];
  const warnings: { row: number; taskId: number; message: string }[] = [];

  for (const row of rows) {
    try {
      const project = rowProject(row, projectSelector);
      const hash = rowHash(project, row);
      if (ledger.has(hash)) {
        skipped += 1;
        continue;
      }
      const result = await createTask(
        client,
        project,
        {
          title: row.title,
          description: row.description,
          done: row.done,
          priority: row.priority,
          dueDate: row.dueDate,
        },
        `csv:${idempotencyKey}:${hash}`,
        undefined,
        actor,
      );
      ledger.set(hash, result.target.id);
      created += 1;
      for (const label of row.labels) {
        try {
          await applyLabel(client, result.target.id, label, project);
        } catch (error) {
          warnings.push({
            row: row.rowNumber,
            taskId: result.target.id,
            message:
              error instanceof Error ? error.message.slice(0, 300) : 'Label application failed.',
          });
        }
      }
    } catch (error) {
      failures.push({
        row: row.rowNumber,
        message: error instanceof Error ? error.message.slice(0, 300) : 'Task creation failed.',
      });
    }
  }

  return {
    mode: 'idempotent' as const,
    idempotent: true,
    total: rows.length,
    created,
    skipped,
    failed: failures.length,
    failures,
    warnings,
  };
}

export function clearIdempotentImportLedger(): void {
  importLedger.clear();
}

export function getIdempotentImportStatus(idempotencyKey: string) {
  const ledger = importLedger.get(idempotencyKey);
  return {
    mode: 'idempotent' as const,
    idempotent: true,
    ledgerPresent: Boolean(ledger),
    trackedRows: ledger?.size ?? 0,
  };
}
