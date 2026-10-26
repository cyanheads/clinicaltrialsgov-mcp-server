/**
 * @fileoverview CommonMark reading of `content[]` text. The framework encodes
 * error messages, recovery hints, and trailer values for Markdown, so a test
 * asserting what a reader sees parses the text rather than matching its escapes.
 * @module tests/helpers/commonmark
 */

import MarkdownIt from 'markdown-it';

const commonmark = new MarkdownIt('commonmark');

type InlineToken = { type: string; content: string; children: InlineToken[] | null };

const seen = (children: InlineToken[]): string =>
  children
    .map((c) =>
      c.type === 'softbreak' || c.type === 'hardbreak'
        ? '\n'
        : c.children?.length
          ? seen(c.children)
          : c.type === 'text' || c.type === 'code_inline'
            ? c.content
            : '',
    )
    .join('');

/** The text a CommonMark reader sees in `markdown`: each block on its own line, markup removed. */
export function readMarkdown(markdown: string): string {
  return commonmark
    .parse(markdown, {})
    .map((t) =>
      t.type === 'inline'
        ? seen((t.children ?? []) as InlineToken[])
        : t.type === 'fence' || t.type === 'code_block'
          ? t.content
          : null,
    )
    .filter((line): line is string => line !== null)
    .join('\n');
}
