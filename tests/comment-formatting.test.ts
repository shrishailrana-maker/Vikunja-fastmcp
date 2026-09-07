import { jest } from '@jest/globals';
import { formatComment } from '../src/comments.js';
import { htmlToMarkdown, markdownToHtml } from '../src/markdown.js';
import { createTypedTaskTools } from '../src/task-tools.js';
import { TOOLS } from '../src/index.js';

describe('comment fidelity and explicit read actions', () => {
  it('preserves identifier underscores while retaining standalone emphasis', () => {
    const html = markdownToHtml('sample_import_batches and _emphasis_');
    expect(html).toContain('sample_import_batches');
    expect(html).toContain('<em>emphasis</em>');
    expect(htmlToMarkdown(html)).toContain('sample_import_batches');
  });

  it('preserves comment line breaks and escapes literal HTML in plain mode', () => {
    expect(formatComment('first\nsecond')).toBe('<p>first<br>second</p>');
    const plain = formatComment('sample_import_batches\n*literal* <script>&', 'plain');
    expect(plain).toBe('<p>sample_import_batches<br>*literal* &lt;script&gt;&amp;</p>');
    expect(htmlToMarkdown(plain)).toContain('sample_import_batches\n*literal*');
  });

  it('selects fixed read shapes with named actions', async () => {
    const dispatch = jest.fn(async () => ({}));
    const read = createTypedTaskTools(dispatch).find((tool) => tool.name === 'vikunja_task_read')!;
    await read.handler({ action: 'get_basic', taskSelector: { globalId: 12 } }, {} as any);
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        action: 'get',
        responseMode: 'minimal',
        fields: expect.arrayContaining(['updatedAt', 'taskUrl']),
      }),
      expect.anything(),
    );
    await read.handler(
      { action: 'get_full', taskSelector: { globalId: 12 }, commentLimit: 3 },
      {} as any,
    );
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 'get', responseMode: 'full', commentLimit: 3 }),
      expect.anything(),
    );
    expect(
      read.inputSchema.safeParse({
        action: 'receipt_lookup',
        operation: 'close_with_evidence',
        idempotencyKey: 'example',
      }).success,
    ).toBe(true);
    expect(
      TOOLS.find((tool) => tool.name === 'vikunja_tasks')!.inputSchema.safeParse({
        action: 'receipt_lookup',
        operation: 'close_with_evidence',
        idempotencyKey: 'example',
      }).success,
    ).toBe(true);
  });
});
