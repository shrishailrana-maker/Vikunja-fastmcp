/** Idempotent row-by-row CSV import tests. */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import { VikunjaApiClient } from '../src/api.js';
import {
  clearIdempotentImportLedger,
  getIdempotentImportStatus,
  importCsvIdempotently,
  previewIdempotentCsvImport,
} from '../src/csv-import.js';

const TEST_TOKEN = `tk_${'a'.repeat(40)}`;

describe('idempotent CSV import', () => {
  const config = {
    vikunjaUrl: 'https://vikunja.example.com/api/v2',
    vikunjaToken: TEST_TOKEN,
    vikunjaWebUrl: 'https://vikunja.example.com/',
    attachmentDownloadRoot: '/tmp/vikunja-tests',
  };
  const importConfig = {
    delimiter: ',',
    quote_char: '"',
    date_format: '2006-01-02',
    skip_rows: 0,
    mapping: [
      { column_index: 0, column_name: 'title', attribute: 'title' },
      { column_index: 1, column_name: 'description', attribute: 'description' },
      { column_index: 2, column_name: 'priority', attribute: 'priority' },
    ],
  };

  let client: VikunjaApiClient;
  let mockFetch: jest.SpiedFunction<typeof fetch>;
  let root: string;
  let csvPath: string;

  beforeEach(async () => {
    clearIdempotentImportLedger();
    client = new VikunjaApiClient(config);
    mockFetch = jest.spyOn(global, 'fetch');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-idempotent-csv-'));
    csvPath = path.join(root, 'tasks.csv');
    await fs.writeFile(
      csvPath,
      'title,description,priority\n"First task","Evidence, with comma",5\nSecond task,More evidence,2\n',
    );
  });

  afterEach(async () => {
    mockFetch.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('previews all locally parsed rows without writing', async () => {
    const preview = await previewIdempotentCsvImport(csvPath, importConfig, { id: 7 });
    expect(preview).toMatchObject({ mode: 'idempotent', totalRows: 2 });
    expect(preview.tasks[0]).toMatchObject({
      title: 'First task',
      description: 'Evidence, with comma',
      priority: 5,
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('creates each row once and skips it on a same-key rerun', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 7, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 101, index: 1, title: 'First task', project_id: 7 }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 7, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({ id: 102, index: 2, title: 'Second task', project_id: 7 }),
      } as Response);

    const first = await importCsvIdempotently(client, csvPath, importConfig, 'import-run-1', {
      id: 7,
    });
    expect(first).toMatchObject({ total: 2, created: 2, skipped: 0, failed: 0 });
    expect(
      mockFetch.mock.calls.filter((call) => (call[1] as RequestInit)?.method === 'POST'),
    ).toHaveLength(2);

    mockFetch.mockClear();
    const second = await importCsvIdempotently(client, csvPath, importConfig, 'import-run-1', {
      id: 7,
    });
    expect(second).toMatchObject({ total: 2, created: 0, skipped: 2, failed: 0 });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(getIdempotentImportStatus('import-run-1')).toEqual({
      mode: 'idempotent',
      idempotent: true,
      ledgerPresent: true,
      trackedRows: 2,
    });
  });

  it('rejects impossible dates instead of silently rolling them forward', async () => {
    await fs.writeFile(csvPath, 'title,due\nInvalid date,2026-02-30\n');
    const dateConfig = {
      ...importConfig,
      mapping: [
        { column_index: 0, column_name: 'title', attribute: 'title' },
        { column_index: 1, column_name: 'due', attribute: 'due_date' },
      ],
    };

    await expect(previewIdempotentCsvImport(csvPath, dateConfig, { id: 7 })).rejects.toMatchObject({
      code: 'INVALID_CSV_DATE',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a short year when the configured layout requires four digits', async () => {
    await fs.writeFile(csvPath, 'title,due\nShort year,01/02/26\n');
    const dateConfig = {
      ...importConfig,
      mapping: [
        { column_index: 0, column_name: 'title', attribute: 'title' },
        { column_index: 1, column_name: 'due', attribute: 'due_date' },
      ],
    };

    await expect(previewIdempotentCsvImport(csvPath, dateConfig, { id: 7 })).rejects.toMatchObject({
      code: 'INVALID_CSV_DATE',
    });
  });

  it('supports headerless CSV and preserves physical row numbers around blank lines', async () => {
    await fs.writeFile(csvPath, 'First task,5\n\nSecond task,2\n');
    const headerless = {
      ...importConfig,
      has_header: false,
      mapping: [
        { column_index: 0, attribute: 'title' },
        { column_index: 1, attribute: 'priority' },
      ],
    };

    const preview = await previewIdempotentCsvImport(csvPath, headerless, { id: 7 });
    expect(preview.tasks).toEqual([
      expect.objectContaining({ title: 'First task', rowNumber: 1 }),
      expect.objectContaining({ title: 'Second task', rowNumber: 3 }),
    ]);
  });

  it('does not reuse a row receipt when mutable imported fields change', async () => {
    const fullConfig = {
      ...importConfig,
      mapping: [
        { column_index: 0, attribute: 'title' },
        { column_index: 1, attribute: 'description' },
        { column_index: 2, attribute: 'priority' },
      ],
    };
    await fs.writeFile(csvPath, 'title,description,priority\nExample,Body,2\n');
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 7, title: 'Alpha' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 101, index: 1, title: 'Example', project_id: 7 }), {
          status: 201,
        }),
      );
    await importCsvIdempotently(client, csvPath, fullConfig, 'changed-row', { id: 7 });

    await fs.writeFile(csvPath, 'title,description,priority\nExample,Body,5\n');
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 7, title: 'Alpha' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 102, index: 2, title: 'Example', project_id: 7 }), {
          status: 201,
        }),
      );
    const rerun = await importCsvIdempotently(client, csvPath, fullConfig, 'changed-row', {
      id: 7,
    });

    expect(rerun).toMatchObject({ created: 1, skipped: 0 });
  });

  it.each([
    ['blank titles', 'title,done\n,yes\n', 'INVALID_CSV_TITLE'],
    ['unknown booleans', 'title,done\nExample,perhaps\n', 'INVALID_CSV_BOOLEAN'],
    ['out-of-range priorities', 'title,priority\nExample,9\n', 'INVALID_CSV_PRIORITY'],
  ])('rejects %s during preview', async (_case, contents, code) => {
    await fs.writeFile(csvPath, contents);
    const attribute = contents.includes('priority') ? 'priority' : 'done';
    const validationConfig = {
      ...importConfig,
      mapping: [
        { column_index: 0, column_name: 'title', attribute: 'title' },
        { column_index: 1, column_name: attribute, attribute },
      ],
    };

    await expect(
      previewIdempotentCsvImport(csvPath, validationConfig, { id: 7 }),
    ).rejects.toMatchObject({ code });
  });
});
