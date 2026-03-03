import { ApiError, ResponseFormatError } from './exceptions.js';

export const DEFAULT_API_PREFIX = 'api/1';
export const DEFAULT_TIMEOUT_SECONDS = 15.0;

export interface CookieRecord {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  expires?: number;
  rest?: Record<string, unknown>;
}

export class CookieJar implements Iterable<CookieRecord> {
  private readonly cookies: CookieRecord[] = [];

  setCookie(cookie: CookieRecord): void {
    const index = this.cookies.findIndex(
      (item) =>
        item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path
    );
    if (index >= 0) {
      this.cookies[index] = cookie;
      return;
    }
    this.cookies.push(cookie);
  }

  [Symbol.iterator](): Iterator<CookieRecord> {
    return this.cookies[Symbol.iterator]();
  }

  toArray(): CookieRecord[] {
    return [...this.cookies];
  }
}

export interface HttpResponseLike {
  status: number;
  json(): Promise<unknown>;
}

export interface HttpSession {
  cookies: CookieJar;
  request(options: {
    method: string;
    url: string;
    params?: Record<string, unknown>;
    json?: Record<string, unknown>;
    headers?: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<HttpResponseLike>;
}

class FetchHttpSession implements HttpSession {
  cookies = new CookieJar();

  async request(options: {
    method: string;
    url: string;
    params?: Record<string, unknown>;
    json?: Record<string, unknown>;
    headers?: Record<string, string>;
    timeoutSeconds: number;
  }): Promise<HttpResponseLike> {
    const requestUrl = new URL(options.url);
    for (const [key, value] of Object.entries(options.params ?? {})) {
      requestUrl.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, Math.max(options.timeoutSeconds, 0) * 1000);

    try {
      const response = await fetch(requestUrl, {
        method: options.method,
        headers: options.headers,
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
        signal: controller.signal
      });
      return {
        status: response.status,
        json: async (): Promise<unknown> => response.json()
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class BooxApi {
  cloud: string;
  token: string;
  apiPrefix: string;
  timeoutSeconds: number;
  session: HttpSession;

  constructor(options: {
    cloud: string;
    token?: string | null;
    apiPrefix?: string;
    timeoutSeconds?: number;
    session?: HttpSession;
  }) {
    this.cloud = options.cloud;
    this.token = options.token ?? '';
    this.apiPrefix = (options.apiPrefix ?? DEFAULT_API_PREFIX).replace(/^\/+|\/+$/g, '');
    this.timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    this.session = options.session ?? new FetchHttpSession();
  }

  setToken(token: string): void {
    this.token = token;
  }

  async request(
    endpoint: string,
    options?: {
      method?: string;
      params?: Record<string, unknown>;
      jsonData?: Record<string, unknown>;
      headers?: Record<string, string>;
      requireAuth?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    const url = `https://${this.cloud}/${this.apiPrefix}/${endpoint.replace(/^\/+/, '')}`;
    return this.requestUrl(url, options);
  }

  async requestPath(
    path: string,
    options?: {
      method?: string;
      params?: Record<string, unknown>;
      jsonData?: Record<string, unknown>;
      headers?: Record<string, string>;
      requireAuth?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    const url = `https://${this.cloud}/${path.replace(/^\/+/, '')}`;
    return this.requestUrl(url, options);
  }

  private async requestUrl(
    url: string,
    options?: {
      method?: string;
      params?: Record<string, unknown>;
      jsonData?: Record<string, unknown>;
      headers?: Record<string, string>;
      requireAuth?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    const requestHeaders: Record<string, string> = { ...(options?.headers ?? {}) };
    const requireAuth = options?.requireAuth ?? true;
    let method = options?.method ?? 'GET';

    if (requireAuth && this.token) {
      requestHeaders.Authorization = `Bearer ${this.token}`;
    }

    if (options?.jsonData !== undefined) {
      if (!requestHeaders['Content-Type']) {
        requestHeaders['Content-Type'] = 'application/json;charset=utf-8';
      }
      method = 'POST';
    }

    let response: HttpResponseLike;
    try {
      response = await this.session.request({
        method,
        url,
        params: options?.params,
        json: options?.jsonData,
        headers: requestHeaders,
        timeoutSeconds: this.timeoutSeconds
      });
    } catch (error) {
      throw new ApiError(`API request failed: ${String(error)}`, { url });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      if (response.status < 200 || response.status >= 300) {
        throw new ApiError(`API request failed with HTTP ${response.status}`, {
          statusCode: response.status,
          payload: null,
          url
        });
      }
      throw new ResponseFormatError('API response is not valid JSON.', {
        statusCode: response.status,
        url
      });
    }

    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(`API request failed with HTTP ${response.status}`, {
        statusCode: response.status,
        payload,
        url
      });
    }

    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new ResponseFormatError('API response JSON must be an object.', {
        statusCode: response.status,
        payload,
        url
      });
    }

    const payloadObject = payload as Record<string, unknown>;
    if (payloadObject.success === false) {
      throw new ApiError('API response reported failure.', {
        statusCode: response.status,
        payload: payloadObject,
        url
      });
    }

    if (url.replace(/\/+$/, '').endsWith('/users/syncToken')) {
      applySyncTokenPayloadToCookies({
        payload: payloadObject,
        cookieJar: this.session.cookies,
        cloud: this.cloud
      });
    }

    return payloadObject;
  }
}

export function applySyncTokenPayloadToCookies(options: {
  payload: Record<string, unknown>;
  cookieJar: CookieJar;
  cloud: string;
}): boolean {
  const sessionIdRaw = findNestedKey(options.payload, ['session_id', 'sessionId', 'session']);
  if (typeof sessionIdRaw !== 'string') {
    return false;
  }
  const sessionId = sessionIdRaw.trim();
  if (!sessionId) {
    return false;
  }

  const cookieNameRaw = findNestedKey(options.payload, ['cookie_name', 'cookieName']);
  let cookieName = 'session_id';
  if (typeof cookieNameRaw === 'string' && cookieNameRaw.trim()) {
    cookieName = cookieNameRaw.trim();
  }

  const domainRaw = findNestedKey(options.payload, ['cookie_domain', 'cookieDomain', 'domain']);
  const domain =
    typeof domainRaw === 'string' && domainRaw.trim() ? domainRaw.trim() : options.cloud.trim();

  const pathRaw = findNestedKey(options.payload, ['cookie_path', 'cookiePath', 'path']);
  const cookiePath = typeof pathRaw === 'string' && pathRaw.trim() ? pathRaw.trim() : '/';

  let secure = true;
  const secureRaw = findNestedKey(options.payload, ['secure', 'isSecure']);
  if (typeof secureRaw === 'boolean') {
    secure = secureRaw;
  } else if (typeof secureRaw === 'string') {
    const normalized = secureRaw.trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      secure = false;
    } else if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      secure = true;
    }
  } else if (typeof secureRaw === 'number') {
    secure = Boolean(secureRaw);
  }

  for (const name of new Set([cookieName, 'session_id', 'SyncGatewaySession'])) {
    options.cookieJar.setCookie({
      name,
      value: sessionId,
      domain,
      path: cookiePath,
      secure
    });
  }
  return true;
}

export function findNestedKey(payload: Record<string, unknown>, keys: string[]): unknown {
  const queue: Record<string, unknown>[] = [payload];
  const visited = new Set<Record<string, unknown>>();

  while (queue.length > 0) {
    const current = queue.shift() as Record<string, unknown>;
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(current, key)) {
        return current[key];
      }
    }

    for (const value of Object.values(current)) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        queue.push(value as Record<string, unknown>);
      }
    }
  }

  return null;
}

