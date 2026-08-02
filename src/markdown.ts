/**
 * Bounded, fail-closed Markdown↔HTML conversion for descriptions and comments.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

export function decodeEntities(text: string): string {
  if (!text) return '';
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    hellip: '…',
    lt: '<',
    mdash: '—',
    middot: '·',
    ndash: '–',
    nbsp: ' ',
    quot: '"',
    sol: '/',
  };
  return text.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (entity, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1]?.toLowerCase() === 'x';
      const codePoint = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (
        Number.isInteger(codePoint) &&
        codePoint >= 0 &&
        codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return String.fromCodePoint(codePoint);
      }
      return entity;
    }
    return named[body.toLowerCase()] ?? entity;
  });
}

export function validateUrlScheme(urlStr: string): string {
  try {
    if (urlStr.toLowerCase().startsWith('mailto:')) {
      return urlStr;
    }
    // Relative paths
    if (urlStr.startsWith('/') || urlStr.startsWith('./') || urlStr.startsWith('../')) {
      return urlStr;
    }
    const parsed = new URL(urlStr);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return urlStr;
    }
  } catch (err: any) {
    // Malformed absolute URL — surface as validation, not a 500.
    if (err && err.name === 'VikunjaError') throw err;
  }
  // Imported lazily-shaped error to avoid circular deps: use a plain Error with
  // a stable marker that CallTool maps to VALIDATION_ERROR when needed.
  const err = new Error(`Unsafe link scheme or malformed URL: ${urlStr}`);
  (err as any).status = 400;
  (err as any).code = 'UNSAFE_MARKDOWN';
  (err as any).method = 'MARKDOWN';
  (err as any).path = 'description';
  throw err;
}

export function markdownToHtml(md: string): string {
  if (!md) return '';

  const rawLines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];

  let currentBlockType: 'p' | 'ul' | 'ol' | 'code' | null = null;
  let currentBlockLines: string[] = [];

  function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function placeholderPrefix(text: string, kind: string): string {
    let attempt = 0;
    let prefix = `VFM${kind}${attempt}X`;
    while (text.includes(prefix)) {
      attempt += 1;
      prefix = `VFM${kind}${attempt}X`;
    }
    return prefix;
  }

  function emphasis(text: string): string {
    return text
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/__([^_]+)__/g, '<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g, '<em>$1</em>')
      .replace(/_([^_]+)_/g, '<em>$1</em>');
  }

  function extractLinks(text: string, prefix: string): { text: string; links: string[] } {
    const links: string[] = [];
    let output = '';
    for (let index = 0; index < text.length;) {
      const labelStart = text.indexOf('[', index);
      if (labelStart < 0) {
        output += text.slice(index);
        break;
      }
      const labelEnd = text.indexOf('](', labelStart + 1);
      if (labelEnd < 0) {
        output += text.slice(index);
        break;
      }
      let depth = 1;
      let cursor = labelEnd + 2;
      for (; cursor < text.length && depth > 0; cursor += 1) {
        if (text[cursor] === '(') depth += 1;
        else if (text[cursor] === ')') depth -= 1;
      }
      if (depth !== 0) {
        output += text.slice(index);
        break;
      }
      const label = text.slice(labelStart + 1, labelEnd);
      const encodedUrl = text.slice(labelEnd + 2, cursor - 1);
      const safeUrl = validateUrlScheme(decodeEntities(encodedUrl));
      const attrSafeUrl = safeUrl
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      output += text.slice(index, labelStart);
      const linkIndex = links.length;
      links.push(`<a href="${attrSafeUrl}">${emphasis(label)}</a>`);
      output += `${prefix}${linkIndex}Z`;
      index = cursor;
    }
    return { text: output, links };
  }

  const flushBlock = () => {
    if (currentBlockLines.length === 0) return;

    if (currentBlockType === 'code') {
      // Must escape so ``` payloads cannot break out of <pre><code> into stored HTML.
      const codeContent = escapeHtml(currentBlockLines.join('\n'));
      blocks.push(`<pre><code>${codeContent}</code></pre>`);
    } else if (currentBlockType === 'ul') {
      const listItems = currentBlockLines.map((line) => `<li>${parseInline(line)}</li>`).join('\n');
      blocks.push(`<ul>\n${listItems}\n</ul>`);
    } else if (currentBlockType === 'ol') {
      const listItems = currentBlockLines.map((line) => `<li>${parseInline(line)}</li>`).join('\n');
      blocks.push(`<ol>\n${listItems}\n</ol>`);
    } else if (currentBlockType === 'p') {
      const pContent = currentBlockLines.map((line) => parseInline(line)).join('\n');
      blocks.push(`<p>${pContent}</p>`);
    }

    currentBlockLines = [];
    currentBlockType = null;
  };

  function parseInline(text: string): string {
    let escaped = escapeHtml(text);

    // Protect code and links before applying emphasis so URL punctuation and
    // literal placeholder-like text cannot be rewritten.
    const inlineCodes: string[] = [];
    const codePrefix = placeholderPrefix(escaped, 'CODE');
    escaped = escaped.replace(/`([^`]+)`/g, (_, code) => {
      const idx = inlineCodes.length;
      inlineCodes.push(`<code>${code}</code>`);
      return `${codePrefix}${idx}Z`;
    });
    const linkPrefix = placeholderPrefix(escaped, 'LINK');
    const extracted = extractLinks(escaped, linkPrefix);
    escaped = emphasis(extracted.text);
    escaped = escaped.replace(
      new RegExp(`${linkPrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)Z`, 'g'),
      (_, idx) => extracted.links[Number(idx)],
    );
    escaped = escaped.replace(
      new RegExp(`${codePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)Z`, 'g'),
      (_, idx) => inlineCodes[Number(idx)],
    );

    return escaped;
  }

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (currentBlockType === 'code') {
        flushBlock();
      } else {
        flushBlock();
        currentBlockType = 'code';
      }
      continue;
    }

    if (currentBlockType === 'code') {
      currentBlockLines.push(line);
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      flushBlock();
      const level = headingMatch[1].length;
      const content = parseInline(headingMatch[2]);
      blocks.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    // Lists
    const ulMatch = line.match(/^[\*\-]\s+(.*)$/);
    const olMatch = line.match(/^\d+\.\s+(.*)$/);

    if (ulMatch) {
      if (currentBlockType !== 'ul') {
        flushBlock();
        currentBlockType = 'ul';
      }
      currentBlockLines.push(ulMatch[1]);
    } else if (olMatch) {
      if (currentBlockType !== 'ol') {
        flushBlock();
        currentBlockType = 'ol';
      }
      currentBlockLines.push(olMatch[1]);
    } else if (trimmed === '') {
      flushBlock();
    } else {
      if (currentBlockType !== 'p' && currentBlockType !== null) {
        flushBlock();
      }
      if (currentBlockType === null) {
        currentBlockType = 'p';
      }
      currentBlockLines.push(line);
    }
  }

  flushBlock();
  return blocks.join('\n');
}

export function htmlToMarkdown(html: string): string {
  if (!html) return '';

  let md = html;
  md = md.replace(/\r\n/g, '\n');
  md = md.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');

  const placeholderPrefix = (kind: string) => {
    let attempt = 0;
    let prefix = `VFM${kind}${attempt}X`;
    while (md.includes(prefix)) {
      attempt += 1;
      prefix = `VFM${kind}${attempt}X`;
    }
    return prefix;
  };

  // Extract pre blocks
  const preBlocks: string[] = [];
  const prePrefix = placeholderPrefix('PRE');
  md = md.replace(/<pre><code>([\s\S]*?)<\/code><\/pre>/g, (_, code) => {
    const index = preBlocks.length;
    preBlocks.push(`\n\`\`\`\n${decodeEntities(code.trim())}\n\`\`\`\n`);
    return `${prePrefix}${index}Z`;
  });
  md = md.replace(/<pre>([\s\S]*?)<\/pre>/g, (_, code) => {
    const index = preBlocks.length;
    preBlocks.push(`\n\`\`\`\n${decodeEntities(code.trim())}\n\`\`\`\n`);
    return `${prePrefix}${index}Z`;
  });

  // Extract inline code
  const inlineCodes: string[] = [];
  const codePrefix = placeholderPrefix('CODE');
  md = md.replace(/<code>(.*?)<\/code>/g, (_, code) => {
    const index = inlineCodes.length;
    inlineCodes.push(`\`${decodeEntities(code)}\``);
    return `${codePrefix}${index}Z`;
  });

  // Headings
  md = md.replace(/<h1>(.*?)<\/h1>/gi, '\n# $1\n');
  md = md.replace(/<h2>(.*?)<\/h2>/gi, '\n## $1\n');
  md = md.replace(/<h3>(.*?)<\/h3>/gi, '\n### $1\n');

  // Lists
  md = md.replace(/<ul>([\s\S]*?)<\/ul>/gi, (_, inner) => {
    const items = inner.match(/<li>([\s\S]*?)<\/li>/gi) || [];
    return (
      '\n' +
      items
        .map((item: string) => {
          const content = item.replace(/<\/?li>/gi, '').trim();
          return `* ${content}`;
        })
        .join('\n') +
      '\n'
    );
  });

  md = md.replace(/<ol>([\s\S]*?)<\/ol>/gi, (_, inner) => {
    const items = inner.match(/<li>([\s\S]*?)<\/li>/gi) || [];
    return (
      '\n' +
      items
        .map((item: string, idx: number) => {
          const content = item.replace(/<\/?li>/gi, '').trim();
          return `${idx + 1}. ${content}`;
        })
        .join('\n') +
      '\n'
    );
  });

  // Bold
  md = md.replace(/<strong>(.*?)<\/strong>/gi, '**$1**');
  md = md.replace(/<b>(.*?)<\/b>/gi, '**$1**');

  // Italics
  md = md.replace(/<em>(.*?)<\/em>/gi, '*$1*');
  md = md.replace(/<i>(.*?)<\/i>/gi, '*$1*');

  // Links
  md = md.replace(
    /<a\s+[^>]*href=(?:"([^"]*)"|'([^']*)')[^>]*>([\s\S]*?)<\/a>/gi,
    (_match, doubleQuoted, singleQuoted, label) => {
      const href = decodeEntities(doubleQuoted ?? singleQuoted ?? '');
      try {
        return `[${label}](${validateUrlScheme(href)})`;
      } catch {
        return label;
      }
    },
  );

  // Paragraphs & Breaks
  md = md.replace(/<p>(.*?)<\/p>/gi, '\n$1\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');

  // Strip remaining HTML tags
  md = md.replace(/<[^>]+>/g, '');

  // Decode ordinary prose once, then restore already-decoded code payloads so
  // entities inside code are never decoded a second time.
  md = decodeEntities(md.trim()).replace(/\n{3,}/g, '\n\n');
  md = md.replace(
    new RegExp(`${prePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)Z`, 'g'),
    (_, idx) => preBlocks[Number(idx)],
  );
  md = md.replace(
    new RegExp(`${codePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)Z`, 'g'),
    (_, idx) => inlineCodes[Number(idx)],
  );
  return md.replace(/\n{3,}/g, '\n\n');
}
