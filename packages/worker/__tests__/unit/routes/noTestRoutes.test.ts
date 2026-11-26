import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

// Prevent accidental network calls in route modules that build a Supabase client.
jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    auth: {
      getUser: jest.fn(async () => ({ data: { user: null }, error: { message: 'Invalid token' } })),
    },
    storage: {
      from: jest.fn(() => ({
        upload: jest.fn(async () => ({ data: { path: 'mock/path' }, error: null })),
        createSignedUrl: jest.fn(async () => ({ data: { signedUrl: 'https://mock/signed' }, error: null })),
      })),
    },
    from: jest.fn(() => ({})),
  })),
}));

describe('No test upload routes in worker (ADR-100 / ADR-102 / #1460)', () => {
  it('app.js read as text contains no upload-test', () => {
    const appJsPath = path.resolve(__dirname, '../../../app.js');
    const appJsContent = fs.readFileSync(appJsPath, 'utf-8');
    expect(appJsContent).not.toContain('upload-test');
  });

  it('routes/api/upload-test.js and public/test-upload.html do not exist', () => {
    const uploadTestRoutePath = path.resolve(__dirname, '../../../routes/api/upload-test.js');
    const testUploadHtmlPath = path.resolve(__dirname, '../../../public/test-upload.html');

    expect(fs.existsSync(uploadTestRoutePath)).toBe(false);
    expect(fs.existsSync(testUploadHtmlPath)).toBe(false);
  });

  it('mounting routes/api/upload.js and posting a file with no Authorization header answers 401', async () => {
    const uploadRouter = require('../../../routes/api/upload');

    const app = express();
    app.use('/api/upload', uploadRouter);

    const res = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('test file payload'), 'sample.txt');

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Missing or invalid Authorization header');
  });
});
