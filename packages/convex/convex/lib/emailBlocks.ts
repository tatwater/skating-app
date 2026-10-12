/**
 * A staff email as typed blocks, rendered twice — HTML and plain text — from one source (A06i §4).
 *
 * The season emails grew a table (the sentinels that fired, with their lows) and lists, which a
 * `lines: string[]` could only fake. A block knows what it is, so the HTML gets a real `<table>` and
 * the text part gets columns padded to line up, and neither can say something the other doesn't.
 *
 * Inline markup is deliberately tiny: `` `code` `` and `**bold**`. Everything else is escaped.
 */

import { v } from 'convex/values';

import { escapeHtml } from './resend';

export type EmailBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'table'; columns: string[]; rows: string[][] };

export const emailBlock = v.union(
  v.object({ kind: v.literal('heading'), text: v.string() }),
  v.object({ kind: v.literal('paragraph'), text: v.string() }),
  v.object({ kind: v.literal('list'), items: v.array(v.string()) }),
  v.object({
    kind: v.literal('table'),
    columns: v.array(v.string()),
    rows: v.array(v.array(v.string())),
  }),
);

/** Escape, then turn the two inline marks into tags. Escaping first means a mark cannot inject. */
export function inlineHtml(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code style="font-family:ui-monospace,monospace">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/** The text part keeps backticks (they read as code in a terminal mail client) and drops `**`. */
export function inlineText(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, '$1');
}

const CELL = 'padding:2px 16px 2px 0;text-align:left;vertical-align:top';

function blockHtml(block: EmailBlock): string {
  switch (block.kind) {
    case 'heading':
      return `<h3 style="margin:16px 0 6px;font-size:15px">${inlineHtml(block.text)}</h3>`;
    case 'paragraph':
      return `<p style="margin:0 0 8px">${inlineHtml(block.text)}</p>`;
    case 'list':
      return `<ul style="margin:0 0 8px;padding-left:20px">${block.items
        .map((item) => `<li style="margin:0 0 4px">${inlineHtml(item)}</li>`)
        .join('')}</ul>`;
    case 'table': {
      const head = block.columns
        .map((c) => `<th style="${CELL};font-weight:600">${inlineHtml(c)}</th>`)
        .join('');
      const body = block.rows
        .map(
          (row) =>
            `<tr>${row.map((c) => `<td style="${CELL}">${inlineHtml(c)}</td>`).join('')}</tr>`,
        )
        .join('');
      return `<table style="border-collapse:collapse;margin:0 0 8px;font-variant-numeric:tabular-nums"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
    }
  }
}

export function renderBlocksHtml(blocks: readonly EmailBlock[]): string {
  return blocks.map(blockHtml).join('');
}

/** Columns padded to the widest cell, two spaces apart — the founder's "aligned names and temps". */
export function renderTableText(columns: readonly string[], rows: readonly string[][]): string {
  const all = [columns, ...rows].map((row) => row.map(inlineText));
  const widths = columns.map((_, i) => Math.max(...all.map((row) => (row[i] ?? '').length)));
  return all
    .map((row) =>
      row
        .map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] as number)))
        .join('  '),
    )
    .join('\n');
}

function blockText(block: EmailBlock): string {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
      return inlineText(block.text);
    case 'list':
      return block.items.map((item) => `- ${inlineText(item)}`).join('\n');
    case 'table':
      return renderTableText(block.columns, block.rows);
  }
}

export function renderBlocksText(blocks: readonly EmailBlock[]): string {
  return blocks.map(blockText).join('\n\n');
}
