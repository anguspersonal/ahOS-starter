import { promises as dnsPromisesImport } from 'node:dns';

jest.mock('node:dns', () => ({
  promises: { lookup: jest.fn() },
}));
const dnsPromises = dnsPromisesImport as unknown as { lookup: jest.Mock };

import { extractHtmlText, decodeHtmlEntities, fetchUrlContent, isDisallowedIp } from '../../../src/utils/fetchUrl';

describe('fetchUrl utils', () => {
  describe('decodeHtmlEntities', () => {
    it('decodes common named entities', () => {
      expect(decodeHtmlEntities('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'  ');
    });

    it('decodes decimal and hexadecimal numeric entities', () => {
      expect(decodeHtmlEntities('&#65; &#x42;')).toBe('A B');
    });
  });

  describe('extractHtmlText', () => {
    it('extracts title and strips script, style, nav, and footer tags', () => {
      const html = `
        <!DOCTYPE html>
        <html>
          <head>
            <title>Test Page Title</title>
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
      expect(result.title).toBe('Test Page Title');
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
    });
  });

  describe('isDisallowedIp', () => {
    it('flags private, loopback, and link-local ranges', () => {
      expect(isDisallowedIp('127.0.0.1')).toBe(true);
      expect(isDisallowedIp('10.1.2.3')).toBe(true);
      expect(isDisallowedIp('172.16.0.1')).toBe(true);
      expect(isDisallowedIp('192.168.1.1')).toBe(true);
      expect(isDisallowedIp('169.254.1.1')).toBe(true);
      expect(isDisallowedIp('::1')).toBe(true);
      expect(isDisallowedIp('fe80::1')).toBe(true);
      expect(isDisallowedIp('fc00::1')).toBe(true);
      expect(isDisallowedIp('::ffff:127.0.0.1')).toBe(true);
    });

    it('allows ordinary public addresses', () => {
      expect(isDisallowedIp('93.184.216.34')).toBe(false);
      expect(isDisallowedIp('2606:2800:220:1:248:1893:25c8:1946')).toBe(false);
    });
  });

  // Round-1 QA High finding: no SSRF guard / size cap on this network-egress
  // sink. These exercise fetchUrlContent's guard directly, with global fetch
  // and dns.lookup both mocked so no real network call is ever made.
  describe('fetchUrlContent network-fetch guards', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
      dnsPromises.lookup.mockReset();
    });

    it('rejects a non-string/empty URL', async () => {
      await expect(fetchUrlContent('')).rejects.toThrow(/non-empty string/);
    });

    it('rejects an invalid URL', async () => {
      await expect(fetchUrlContent('not a url')).rejects.toThrow(/Invalid URL/);
    });

    it('rejects an unsupported protocol', async () => {
      await expect(fetchUrlContent('ftp://example.com/file')).rejects.toThrow(/Unsupported protocol/);
    });

    it('rejects a literal loopback IP without making a network call', async () => {
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      await expect(fetchUrlContent('http://127.0.0.1/admin')).rejects.toThrow(/private\/loopback/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(dnsPromises.lookup).not.toHaveBeenCalled();
    });

    it('rejects a hostname that resolves to a private address', async () => {
      dnsPromises.lookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      await expect(fetchUrlContent('http://internal.example/secret')).rejects.toThrow(/private\/loopback/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('re-validates a redirect target and rejects one that lands on a private address', async () => {
      dnsPromises.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const fetchMock = jest
        .fn()
        .mockResolvedValueOnce(
          new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }),
        );
      global.fetch = fetchMock as any;

      await expect(fetchUrlContent('http://public.example/redirector')).rejects.toThrow(/private\/loopback/);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects a response that declares a Content-Length over the size cap', async () => {
      dnsPromises.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const fetchMock = jest.fn().mockResolvedValue(
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'text/html', 'content-length': String(30 * 1024 * 1024) },
        }),
      );
      global.fetch = fetchMock as any;

      await expect(fetchUrlContent('http://public.example/huge.html')).rejects.toThrow(/too large/);
    });

    it('extracts readable text on a successful fetch', async () => {
      dnsPromises.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
      const html = '<html><head><title>Direct</title></head><body><script>evil()</script><p>Clean text</p></body></html>';
      const fetchMock = jest
        .fn()
        .mockResolvedValue(new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }));
      global.fetch = fetchMock as any;

      const result = await fetchUrlContent('http://public.example/page');
      expect(result.text).toContain('Clean text');
      expect(result.text).not.toContain('evil()');
      expect(result.title).toBe('Direct');
      expect(fetchMock).toHaveBeenCalledWith(
        'http://public.example/page',
        expect.objectContaining({
          headers: expect.objectContaining({
            'User-Agent': 'Mozilla/5.0 (compatible; ahOS-Worker/1.0; +https://github.com/anguspersonal/ahOS)',
          }),
        }),
      );
    });
  });
});
