/**
 * Tests for envelopes, pagination, and Markdown conversion.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { jest } from '@jest/globals';
import {
  formatSuccessEnvelope,
  formatFailureEnvelope,
  normalizePagination,
  normalizeDatesAndNulls,
  htmlToMarkdown,
  markdownToHtml,
  toItemArray,
  fetchAllCollectionItems,
} from '../src/format.js';

describe('Format and Markdown tests', () => {
  describe('toItemArray (Vikunja 2.4 collection shape)', () => {
    it('unwraps the v2 paginated wrapper', () => {
      expect(toItemArray({ items: [{ id: 1 }, { id: 2 }], total: 2 })).toEqual([
        { id: 1 },
        { id: 2 },
      ]);
    });
    it.each([[{ id: 1 }], null, undefined, { message: 'no items' }])(
      'rejects non-wrapper collection response %#',
      (response) => {
        expect(() => toItemArray(response)).toThrow(
          expect.objectContaining({ code: 'INVALID_COLLECTION_RESPONSE' }),
        );
      },
    );

    it('rejects bare-array pagination metadata', () => {
      expect(() => normalizePagination([{ id: 1 }])).toThrow(
        expect.objectContaining({ code: 'INVALID_COLLECTION_RESPONSE' }),
      );
    });
  });

  describe('Pagination and Date normalization', () => {
    it('should normalize pagination properties', () => {
      const raw = {
        items: [],
        page: 1,
        per_page: 25,
        total: 50,
        total_pages: 2,
      };
      const normalized = normalizePagination(raw);
      expect(normalized).toEqual({
        page: 1,
        perPage: 25,
        total: 50,
        totalPages: 2,
        hasMore: true,
        nextPage: 2,
      });
    });

    it('should recursively normalize zero dates to null', () => {
      const input = {
        id: 1,
        created: '2026-07-11T12:00:00Z',
        dueDate: '0001-01-01T00:00:00Z',
        nested: {
          startDate: '0001-01-01T00:00:00.000Z',
          title: 'Hello',
        },
      };
      const normalized = normalizeDatesAndNulls(input);
      expect(normalized.dueDate).toBeNull();
      expect(normalized.nested.startDate).toBeNull();
      expect(normalized.nested.title).toBe('Hello');
    });

    it('fails closed when a paginated endpoint repeats the same page', async () => {
      const request = jest.fn(async () => ({
        items: [{ id: 1 }],
        page: 1,
        per_page: 1,
        total: 2,
        total_pages: 2,
      }));

      await expect(fetchAllCollectionItems(request, '/projects')).rejects.toMatchObject({
        code: 'COLLECTION_PAGE_REPEATED',
      });
    });
  });

  describe('Markdown / HTML conversions', () => {
    it('should convert safe headings, bold, links, code, lists and preserve them', () => {
      const md = `# Heading 1\n\nSome **bold text**, *italic text*, and \`inline_code\`.\n\nA link: [Google](https://google.com)\n\n* Item 1\n* Item 2\n\n\`\`\`javascript\nconst x = 1;\n\`\`\``;
      const html = markdownToHtml(md);
      expect(html).toContain('<h1>Heading 1</h1>');
      expect(html).toContain('<strong>bold text</strong>');
      expect(html).toContain('<em>italic text</em>');
      expect(html).toContain('<code>inline_code</code>');
      expect(html).not.toContain('INLINECODE');
      expect(html).toContain('<a href="https://google.com">Google</a>');
      expect(html).toContain('<li>Item 1</li>');
      expect(html).toContain('<pre><code>const x = 1;</code></pre>');

      // Round-trip check
      const backToMd = htmlToMarkdown(html);
      expect(backToMd).toContain('# Heading 1');
      expect(backToMd).toContain('**bold text**');
      expect(backToMd).toContain('*italic text*');
      expect(backToMd).toContain('`inline_code`');
      expect(backToMd).toContain('[Google](https://google.com)');
      expect(backToMd).toContain('* Item 1');
      expect(backToMd).toContain('const x = 1;');
    });

    it('should reject unsafe link schemes', () => {
      const md = 'Click here: [Malicious link](javascript:alert(1))';
      expect(() => markdownToHtml(md)).toThrow('Unsafe link scheme or malformed URL');
    });

    it('should escape raw HTML tags from input', () => {
      const md = 'Hello <script>alert("hack")</script>';
      const html = markdownToHtml(md);
      expect(html).not.toContain('<script>');
      expect(html).toContain('&lt;script&gt;alert("hack")&lt;/script&gt;');
    });

    it('should escape HTML breakout attempts inside fenced code blocks', () => {
      const md = '```\n</code></pre><script>alert(1)</script>\n```';
      const html = markdownToHtml(md);
      expect(html).toContain('&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;');
      expect(html).not.toMatch(/<script>/);
    });

    it('should not let a quote in a link URL break out of the href attribute', () => {
      const md = '[x](https://example.com/a"onmouseover=alert(1))';
      const html = markdownToHtml(md);
      // The stray quote must be encoded, leaving the href attribute intact.
      expect(html).toContain('&quot;onmouseover=alert(1');
      expect(html).not.toContain('a"onmouseover');
    });

    it('decodes numeric and common named entities from Vikunja HTML', () => {
      expect(htmlToMarkdown('<p>Home&#x2F;Scan &middot; done &#47; verified</p>')).toBe(
        'Home/Scan · done / verified',
      );
    });

    it('drops hostile script content and neutralizes unsafe stored links', () => {
      const markdown = htmlToMarkdown(
        '<p>Safe <a href="javascript:alert(1)">label</a></p><script>steal()</script>',
      );
      expect(markdown).toBe('Safe label');
      expect(markdown).not.toContain('javascript:');
      expect(markdown).not.toContain('steal');
    });
  });

  describe('Envelope formatting', () => {
    it('should format success response correctly', () => {
      const summary = 'Success summary';
      const data = { id: 101, title: 'Alpha Project' };
      const output = formatSuccessEnvelope(summary, data);
      expect(output).toContain('Success summary');
      expect(output).toContain('```json');
      expect(output).toContain('{"ok":true');
      expect(output).toContain('"title":"Alpha Project"');
      expect(output).not.toContain('\n  "ok"');
    });

    it('emits one machine envelope without duplicated prose in structured-only mode', () => {
      const output = formatSuccessEnvelope(
        'This summary must not be repeated',
        { task: 'ALPHA-5', action: 'created' },
        { structuredOnly: true },
      );

      expect(output).toMatch(/^```json\n\{"ok":true/);
      expect(output).not.toContain('This summary must not be repeated');
      expect(output.match(/```json/g)).toHaveLength(1);
    });

    it('should format failure response correctly', () => {
      const summary = 'Failure summary';
      const error = { status: 404, message: 'Not found' };
      const output = formatFailureEnvelope(summary, error);
      expect(output).toContain('Failure summary');
      expect(output).toContain('```json');
      expect(output).toContain('{"ok":false');
      expect(output).toContain('"status":404');
    });
  });
});
