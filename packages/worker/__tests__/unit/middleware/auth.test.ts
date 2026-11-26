import type { Request, Response, NextFunction } from 'express';

jest.mock('../../../src/db/client', () => {
  return {
    supabase: {
      auth: {
        getUser: jest.fn(),
      },
    },
  };
});

const { supabase } = require('../../../src/db/client');
const { authenticate } = require('../../../src/middleware/auth');

function createRes() {
  const res: Partial<Response> & {
    _status?: number;
    _json?: unknown;
  } = {};

  res.status = ((code: number) => {
    res._status = code;
    return res as Response;
  }) as Response['status'];

  res.json = ((payload: unknown) => {
    res._json = payload;
    return res as Response;
  }) as Response['json'];

  return res as Response & { _status?: number; _json?: unknown };
}

describe('authenticate middleware', () => {
  beforeEach(() => {
    supabase.auth.getUser.mockReset();
  });

  it('returns 401 when Authorization header missing', async () => {
    const req = { headers: {} } as unknown as Request;
    const res = createRes();
    const next = jest.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Missing or invalid Authorization header' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when token invalid', async () => {
    supabase.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: { message: 'Invalid JWT' } });

    const req = { headers: { authorization: 'Bearer bad' } } as unknown as Request;
    const res = createRes();
    const next = jest.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(res._status).toBe(401);
    expect(res._json).toEqual({ error: 'Invalid JWT' });
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches req.user and calls next when token valid', async () => {
    supabase.auth.getUser.mockResolvedValueOnce({
      data: { user: { id: 'user-1', email: 'test@example.com' } },
      error: null,
    });

    const req = { headers: { authorization: 'Bearer good' } } as unknown as Request & { user?: any };
    const res = createRes();
    const next = jest.fn() as NextFunction;

    await authenticate(req, res, next);

    expect(req.user?.id).toBe('user-1');
    expect(next).toHaveBeenCalledTimes(1);
  });
});

