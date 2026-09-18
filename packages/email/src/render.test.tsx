import { light } from '@skating/design';
import { describe, expect, it } from 'vitest';
import { Layout } from './Layout';
import { renderEmail } from './render';
import { DataExportReady } from './templates/DataExportReady';

describe('renderEmail', () => {
  it('renders HTML and a plain-text alternative from one tree', async () => {
    const { html, text } = await renderEmail(
      <DataExportReady downloadUrl="https://example.convex.site/export/abc" ttlDays={7} />,
    );
    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('Your data export is ready');
    expect(html).toContain('https://example.convex.site/export/abc');
    expect(html).toContain('7 days');
    // The text half carries the same facts and the raw URL, with no markup. Headings come out
    // upper-cased by the plain-text renderer, so match case-insensitively.
    expect(text.toLowerCase()).toContain('your data export is ready');
    expect(text).toContain('https://example.convex.site/export/abc');
    expect(text).not.toContain('<');
  });

  it('never carries a verdict about ice (D3) — the layout is shared by every mail', async () => {
    const { text } = await renderEmail(
      <DataExportReady downloadUrl="https://x.test/e" ttlDays={7} />,
    );
    expect(text).not.toMatch(/\b(safe|unsafe|skateable|danger)\b|good to go/i);
  });

  it('escapes what it is given — a URL cannot break out of its attribute', async () => {
    const { html } = await renderEmail(
      <DataExportReady downloadUrl={'https://x.test/?a=1&b="<script>'} ttlDays={1} />,
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('1 day');
    expect(html).not.toContain('1 days');
  });

  it('pulls its colors from the design tokens, not from literals', async () => {
    const { html } = await renderEmail(
      <DataExportReady downloadUrl="https://x.test/e" ttlDays={7} />,
    );
    expect(html).toContain(light.primary.toLowerCase());
    expect(html).toContain(light.background.toLowerCase());
  });

  it('renders the footer slot after the standing line', async () => {
    const { html, text } = await renderEmail(
      <Layout preview="p" footer={<a href="https://x.test/unsub">Unsubscribe</a>}>
        <p>body</p>
      </Layout>,
    );
    expect(html).toContain('Gli');
    expect(html).toContain('Unsubscribe');
    expect(text).toContain('https://x.test/unsub');
  });
});
