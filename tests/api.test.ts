import { describe, expect, it } from 'vitest';

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
});
