import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as dnsPromises } from 'node:dns';

vi.mock('node:dns', () => ({
  promises: { lookup: vi.fn() },
}));

import {
  decodeHtmlEntities,
  extractHtmlText,
  isDisallowedIp,
  isDisallowedIpv4,
  fetchUrlSafely,
  MAX_RESPONSE_BYTES,
  MAX_REDIRECTS,
} from './urlFetch';

describe('urlFetch utilities in @ahkms/shared', () => {
  describe('constants', () => {
    it('defines expected limits', () => {
      expect(MAX_RESPONSE_BYTES).toBe(20 * 1024 * 1024);
      expect(MAX_REDIRECTS).toBe(5);
    });
  });

  describe('decodeHtmlEntities', () => {
    it('decodes common named entities', () => {
      expect(decodeHtmlEntities('&amp; &lt; &gt; &quot; &#39; &apos; &nbsp;')).toBe('& < > " \' \'  ');
    });

    it('decodes decimal and hexadecimal numeric entities', () => {
      expect(decodeHtmlEntities('&#65; &#x42;')).toBe('A B');
    });

    it('leaves non-entity text intact', () => {
      expect(decodeHtmlEntities('Plain text without entities')).toBe('Plain text without entities');
    });
  });

  describe('extractHtmlText', () => {
    it('extracts title and strips script, style, nav, and footer tags', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Test Page Title &amp; Subtitle</title>
            <style>body { color: red; }</style>
            <script>console.log('secret');</script>
          </head>
          <body>
            <header>Header content</header>
            <nav><a href="/">Home</a></nav>
            <main>
              <h1>Main Heading</h1>
              <p>This is the first paragraph with &amp; entity.</p>
              <div>
                <p>Nested second paragraph.</p>
              </div>
            </main>
            <footer>Copyright 2026</footer>
          </body>
        </html>
      `;

      const result = extractHtmlText(html);
      expect(result.title).toBe('Test Page Title & Subtitle');
      expect(result.text).toContain('Main Heading');
      expect(result.text).toContain('This is the first paragraph with & entity.');
      expect(result.text).toContain('Nested second paragraph.');
      expect(result.text).not.toContain('body { color: red; }');
      expect(result.text).not.toContain('secret');
      expect(result.text).not.toContain('Header content');
      expect(result.text).not.toContain('Copyright 2026');
      expect(result.text).not.toContain('<p>');
    });

    it('handles empty or non-string input gracefully', () => {
      expect(extractHtmlText('')).toEqual({ title: null, text: '' });
      expect(extractHtmlText(null as any)).toEqual({ title: null, text: '' });
      expect(extractHtmlText(undefined as any)).toEqual({ title: null, text: '' });
    });
  });

  describe('isDisallowedIp & isDisallowedIpv4', () => {
    it('flags private, loopback, and link-local IPv4 ranges', () => {
      expect(isDisallowedIp('127.0.0.1')).toBe(true);
      expect(isDisallowedIp('10.1.2.3')).toBe(true);
      expect(isDisallowedIp('172.16.0.1')).toBe(true);
      expect(isDisallowedIp('172.31.255.255')).toBe(true);
      expect(isDisallowedIp('192.168.1.1')).toBe(true);
      expect(isDisallowedIp('169.254.1.1')).toBe(true);
      expect(isDisallowedIp('100.64.0.1')).toBe(true); // CGNAT
      expect(isDisallowedIp('0.0.0.0')).toBe(true);
      expect(isDisallowedIp('224.0.0.1')).toBe(true); // multicast
      expect(isDisallowedIp('255.255.255.255')).toBe(true); // broadcast
    });

    it('flags private, loopback, and link-local IPv6 ranges', () => {
      expect(isDisallowedIp('::1')).toBe(true);
      expect(isDisallowedIp('::')).toBe(true);
      expect(isDisallowedIp('fe80::1')).toBe(true);
      expect(isDisallowedIp('fc00::1')).toBe(true);
      expect(isDisallowedIp('fd00::1')).toBe(true);
      expect(isDisallowedIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('allows ordinary public IPv4 and IPv6 addresses', () => {
      expect(isDisallowedIp('93.184.216.34')).toBe(false);
      expect(isDisallowedIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    });

    it('blocks malformed or non-IP strings conservatively', () => {
      expect(isDisallowedIp('not-an-ip')).toBe(true);
      expect(isDisallowedIpv4('999.999.999.999.999')).toBe(true);
    });
  });

  describe('fetchUrlSafely network guards and extraction', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.mocked(dnsPromises.lookup).mockReset();
    });

    it('rejects a non-string or empty URL', async () => {
      await expect(fetchUrlSafely('')).rejects.toThrow(/non-empty string/);
      await expect(fetchUrlSafely(null as any)).rejects.toThrow(/non-empty string/);
    });

    it('rejects an invalid URL', async () => {
      await expect(fetchUrlSafely('not a url')).rejects.toThrow(/Invalid URL/);
    });

    it('rejects an unsupported protocol', async () => {
      await expect(fetchUrlSafely('ftp://example.com/file')).rejects.toThrow(/Unsupported protocol/);
    });

    it('rejects a literal loopback IP without making a network call', async () => {
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(fetchUrlSafely('http://127.0.0.1/admin')).rejects.toThrow(/private\/loopback/);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(dnsPromises.lookup).not.toHaveBeenCalled();
    });

    it('rejects a hostname that resolves to a private address', async () => {
      vi.mocked(dnsPromises.lookup).mockResolvedValue([{ address: '10.0.0.5', family: 4 }] as any);
      const fetchSpy = vi.fn();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(fetchUrlSafely('http://internal.example/secret')).rejects.toThrow(/private\/loopback/);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('re-validates a redirect target and rejects one that lands on a private address', async () => {
      vi.mocked(dnsPromises.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
      const fetchSpy = vi.fn().mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      await expect(fetchUrlSafely('http://public.example/redirector')).rejects.toThrow(/private\/loopback/);
      // Only the first (public) hop was actually requested.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects a response that declares a Content-Length over the size cap', async () => {
      vi.mocked(dnsPromises.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': String(30 * 1024 * 1024) },
        }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      await expect(fetchUrlSafely('http://public.example/huge.html')).rejects.toThrow(/too large/);
    });

    it('extracts readable text and metadata on a successful HTML fetch', async () => {
      vi.mocked(dnsPromises.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
      const html = '<html><head><title>Direct Article</title></head><body><script>evil()</script><p>Clean readable text</p></body></html>';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const result = await fetchUrlSafely('http://public.example/page', {
        userAgent: 'Custom-Agent/1.0',
      });

      expect(result.url).toBe('http://public.example/page');
      expect(result.title).toBe('Direct Article');
      expect(result.text).toContain('Clean readable text');
      expect(result.mimeType).toBe('text/html');
      expect(result.extension).toBe('html');
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.contentHash).toMatch(/^[0-9a-f]{64}$/);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://public.example/page',
        expect.objectContaining({
          headers: expect.objectContaining({ 'User-Agent': 'Custom-Agent/1.0' }),
        }),
      );
    });

    it('handles plain text and markdown formats correctly', async () => {
      vi.mocked(dnsPromises.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
      const mdContent = '# Markdown Title\n\nSome markdown body content.';
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(mdContent, { status: 200, headers: { 'content-type': 'text/markdown' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const result = await fetchUrlSafely('http://public.example/doc.md');

      expect(result.title).toBeNull();
      expect(result.text).toBe(mdContent);
      expect(result.mimeType).toBe('text/markdown');
      expect(result.extension).toBe('md');
    });

    it('handles PDF format without extracting raw text', async () => {
      vi.mocked(dnsPromises.lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }] as any);
      const pdfBytes = Buffer.from('%PDF-1.4 ...');
      const fetchSpy = vi.fn().mockResolvedValue(
        new Response(pdfBytes, { status: 200, headers: { 'content-type': 'application/pdf' } }),
      );
      vi.stubGlobal('fetch', fetchSpy);

      const result = await fetchUrlSafely('http://public.example/document.pdf');

      expect(result.title).toBeNull();
      expect(result.text).toBeNull();
      expect(result.mimeType).toBe('application/pdf');
      expect(result.extension).toBe('pdf');
      expect(result.buffer).toEqual(pdfBytes);
    });
  });
});
