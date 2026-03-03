import { describe, expect, it, vi } from 'vitest';

import { BooxApi, CookieJar, type HttpResponseLike, type HttpSession } from '../src/api.js';
import { ApiError, ResponseFormatError } from '../src/exceptions.js';

class FakeSession implements HttpSession {
  cookies = new CookieJar();
  responses = new Map<string, HttpResponseLike>();
  calls: Array<{
    method: string;
    url: string;
    params?: Record<string, unknown>;
    json?: Record<string, unknown>;
    headers?: Record<string, string>;
    timeoutSeconds: number;
  }> = [];

  async request(options: {
    method: string;
    url: string;
    params?: Record<string, unknown>;
    json?: Record<string, unknown>;
    headers?: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<HttpResponseLike> {
    this.calls.push(options);
    const response = this.responses.get(options.url);
    if (!response) {
      return {
        status: 404,
        json: async () => ({ error: 'missing' })
      };
    }
    return response;
  }
}

describe('api', () => {
  it('api request success', async () => {
    const session = new FakeSession();
    session.responses.set('https://eur.boox.com/api/1/users/me', {
      status: 200,
      json: async () => ({ data: { uid: 'u1' } })
    });

    const api = new BooxApi({ cloud: 'eur.boox.com', token: 'token123', session });
    const payload = await api.request('users/me');

    expect(payload.data).toEqual({ uid: 'u1' });
    expect(session.calls[0]?.headers?.Authorization).toBe('Bearer token123');
  });

  it('api request http error raises api error', async () => {
    const session = new FakeSession();
    session.responses.set('https://eur.boox.com/api/1/users/me', {
      status: 500,
      json: async () => ({ error: 'server' })
    });

    const api = new BooxApi({ cloud: 'eur.boox.com', token: 'token123', session });
    await expect(api.request('users/me')).rejects.toMatchObject({
      statusCode: 500
    });
  });

  it('api request invalid json raises response format error', async () => {
    const session = new FakeSession();
    session.responses.set('https://eur.boox.com/api/1/users/me', {
      status: 200,
      json: async () => {
        throw new Error('not-json');
      }
    });

    const api = new BooxApi({ cloud: 'eur.boox.com', token: 'token123', session });
    await expect(api.request('users/me')).rejects.toBeInstanceOf(ResponseFormatError);
  });

  it('api request success false payload raises api error', async () => {
    const session = new FakeSession();
    session.responses.set('https://eur.boox.com/api/1/users/me', {
      status: 200,
      json: async () => ({ success: false, message: 'bad' })
    });

    const api = new BooxApi({ cloud: 'eur.boox.com', token: 'token123', session });
    await expect(api.request('users/me')).rejects.toBeInstanceOf(ApiError);
  });

  it('api sync token injects cookie from payload when set cookie missing', async () => {
    const session = new FakeSession();
    session.responses.set('https://send2boox.com/api/1/users/syncToken', {
      status: 200,
      json: async () => ({
        result_code: 0,
        data: {
          cookie_name: 'SyncGatewaySession',
          session_id: 'session-value-123'
        }
      })
    });

    const api = new BooxApi({ cloud: 'send2boox.com', token: 'token123', session });
    const payload = await api.request('users/syncToken');

    expect(payload.result_code).toBe(0);
    const cookies = new Set([...api.session.cookies].map((cookie) => `${cookie.name}:${cookie.value}`));
    expect(cookies.has('SyncGatewaySession:session-value-123')).toBe(true);
    expect(cookies.has('session_id:session-value-123')).toBe(true);
  });

  it('api uses syncToken payload cookies on subsequent _changes request', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const parsed = new URL(url);

      if (parsed.pathname.endsWith('/users/me')) {
        return {
          status: 200,
          json: async () => ({ data: { uid: 'u1' } })
        };
      }
      if (parsed.pathname.endsWith('/users/syncToken')) {
        return {
          status: 200,
          json: async () => ({
            result_code: 0,
            data: {
              cookie_name: 'SyncGatewaySession',
              session_id: 'session-value-123'
            }
          })
        };
      }
      if (parsed.pathname.endsWith('/neocloud/_changes')) {
        return {
          status: 200,
          json: async () => ({ results: [], last_seq: 0 })
        };
      }
      return {
        status: 404,
        json: async () => ({ error: 'missing' })
      };
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      const api = new BooxApi({ cloud: 'send2boox.com', token: 'token123' });
      await api.request('users/me');
      await api.request('users/syncToken');
      await api.requestPath('neocloud/_changes', {
        params: {
          style: 'all_docs',
          filter: 'sync_gateway/bychannel',
          channels: 'u1-READER_LIBRARY',
          since: '0',
          limit: 1000,
          include_docs: 'true'
        }
      });

      const calls = fetchMock.mock.calls as unknown as Array<unknown[]>;
      const changesInit = (calls[2]?.[1] ?? {}) as RequestInit;
      const changesHeaders = (changesInit.headers ?? {}) as Record<string, string>;
      expect(changesHeaders.Cookie ?? changesHeaders.cookie).toContain(
        'SyncGatewaySession=session-value-123'
      );
      expect(changesHeaders.Cookie ?? changesHeaders.cookie).toContain('session_id=session-value-123');
      expect(changesHeaders.Authorization ?? changesHeaders.authorization).toBe('Bearer token123');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('api forwards cookie jar entries as Cookie header on subsequent requests', async () => {
    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({ data: { ok: true } })
    }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    try {
      const api = new BooxApi({ cloud: 'send2boox.com', token: 'token123' });
      api.session.cookies.setCookie({
        name: 'SyncGatewaySession',
        value: 'session-value-123',
        domain: 'send2boox.com',
        path: '/',
        secure: true
      });

      await api.requestPath('neocloud/_changes', { params: { since: '0' } });

      const calls = fetchMock.mock.calls as unknown as Array<unknown[]>;
      const init = (calls[0]?.[1] ?? {}) as RequestInit;
      const headers = (init.headers ?? {}) as Record<string, string>;
      expect(headers.Cookie ?? headers.cookie).toContain('SyncGatewaySession=session-value-123');
      expect(headers.Authorization ?? headers.authorization).toBe('Bearer token123');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
