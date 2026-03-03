import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import { BooxApi, type CookieJar, applySyncTokenPayloadToCookies } from './api.js';
import { Send2BooxError } from './exceptions.js';

export const DEFAULT_SESSION_COOKIE_JSON = 'session-cookies.json';

const SAME_SITE_MAP: Record<string, 'Lax' | 'Strict' | 'None'> = {
  lax: 'Lax',
  strict: 'Strict',
  none: 'None',
  no_restriction: 'None'
};

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Lax' | 'Strict' | 'None';
  expires?: number;
}

export function loadExportedCookies(cookiePath: string): PlaywrightCookie[] {
  const normalizedPath = path.resolve(cookiePath);
  if (!fs.existsSync(normalizedPath)) {
    throw new Send2BooxError(`Cookie JSON file not found: ${cookiePath}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8'));
  } catch {
    throw new Send2BooxError(`Cookie JSON is invalid: ${cookiePath}`);
  }

  if (!Array.isArray(data)) {
    throw new Send2BooxError('Cookie JSON must be an array.');
  }

  return convertExportedCookies(data as Record<string, unknown>[]);
}

export function convertExportedCookies(
  cookieRecords: Record<string, unknown>[]
): PlaywrightCookie[] {
  const converted: PlaywrightCookie[] = [];
  for (const [index, record] of cookieRecords.entries()) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Send2BooxError(`Cookie entry #${index} must be an object.`);
    }

    const name = requiredStr(record, 'name', index);
    const value = requiredStr(record, 'value', index);
    const domain = requiredStr(record, 'domain', index);
    const cookiePath = String(record.path ?? '/') || '/';
    const cookie: PlaywrightCookie = {
      name,
      value,
      domain,
      path: cookiePath,
      secure: Boolean(record.secure ?? false),
      httpOnly: Boolean(record.httpOnly ?? false)
    };

    const sameSite = normalizeSameSite(record.sameSite);
    if (sameSite !== null) {
      cookie.sameSite = sameSite;
    }

    const expires = normalizeExpires(record);
    if (expires !== null) {
      cookie.expires = expires;
    }

    converted.push(cookie);
  }
  return converted;
}

export function exportCookieJarForBrowser(cookieJar: CookieJar): Record<string, unknown>[] {
  const exported: Record<string, unknown>[] = [];
  for (const cookie of cookieJar) {
    const record: Record<string, unknown> = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      secure: Boolean(cookie.secure),
      httpOnly: cookieRestFlag(cookie, 'httponly'),
      session: cookie.expires === undefined,
      hostOnly: !String(cookie.domain).startsWith('.')
    };
    if (cookie.expires !== undefined) {
      record.expirationDate = Math.trunc(cookie.expires);
    }
    const sameSite = cookieRestValue(cookie, 'samesite');
    if (sameSite) {
      const normalizedSameSite = sameSite.trim().toLowerCase();
      if (['none', 'lax', 'strict', 'no_restriction'].includes(normalizedSameSite)) {
        record.sameSite = normalizedSameSite;
      }
    }
    exported.push(record);
  }
  return exported;
}

export async function syncTokenCookies(options: {
  cloud: string;
  token: string;
  outputPath?: string;
  raiseOnEmpty?: boolean;
  apiFactory?: (args: { cloud: string; token: string }) => {
    session: { cookies: CookieJar };
    request(endpoint: string): Promise<Record<string, unknown>>;
  };
}): Promise<string | null> {
  const outputPath = options.outputPath ?? DEFAULT_SESSION_COOKIE_JSON;
  const raiseOnEmpty = options.raiseOnEmpty ?? true;

  const api =
    options.apiFactory?.({ cloud: options.cloud, token: options.token }) ??
    new BooxApi({ cloud: options.cloud, token: options.token });
  const payload = await api.request('users/syncToken');
  applySyncTokenPayloadToCookies({
    payload,
    cookieJar: api.session.cookies,
    cloud: options.cloud
  });

  const records = exportCookieJarForBrowser(api.session.cookies);
  if (records.length === 0) {
    if (raiseOnEmpty) {
      throw new Send2BooxError(
        'Cookie sync succeeded but no cookies were returned. Please verify server domain and account state.'
      );
    }
    return null;
  }

  const targetPath = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(records, null, 2), 'utf-8');
  return targetPath;
}

export async function launchDebugBrowserSession(options: {
  url: string;
  token: string;
  tokenKey?: string;
  extraTokenKeys?: string[];
  cookieJsonPath?: string | null;
  timeoutMs?: number;
  devtools?: boolean;
  waitForEnter?: boolean;
}): Promise<void> {
  let playwrightModule: any;
  try {
    playwrightModule = await import('playwright');
  } catch {
    throw new Send2BooxError(
      "Playwright is not installed. Install with `npm install playwright` and run `npx playwright install chromium`."
    );
  }

  const tokenKey = options.tokenKey ?? 'token';
  const extraTokenKeys = options.extraTokenKeys ?? [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  const devtools = options.devtools ?? false;
  const waitForEnter = options.waitForEnter ?? true;

  const tokenKeys = buildTokenKeys({ primary: tokenKey, extra: extraTokenKeys });
  const cookies = options.cookieJsonPath ? loadExportedCookies(options.cookieJsonPath) : [];

  try {
    const launchOptions: Record<string, unknown> = { headless: false };
    if (devtools) {
      if (supportsKeywordArgument(playwrightModule.chromium.launch, 'devtools')) {
        launchOptions.devtools = true;
      } else {
        console.warn(
          'Warning: this Playwright build does not support devtools launch flag. Continuing without --devtools.'
        );
      }
    }

    const browser = await playwrightModule.chromium.launch(launchOptions);
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    if (cookies.length > 0) {
      await context.addCookies(cookies as any);
    }
    const page = await context.newPage();
    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.evaluate(
      ({ token, tokenKeys: keys }: { token: string; tokenKeys: string[] }) => {
        keys.forEach((key) => window.localStorage.setItem(key, token));
      },
      { token: options.token, tokenKeys }
    );
    await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });

    if (waitForEnter) {
      console.log(
        'Browser launched and auth state injected. Press Enter in this terminal to close.'
      );
      const rl = readline.createInterface({ input, output });
      try {
        await rl.question('');
      } catch {
        // Ignore EOF.
      } finally {
        rl.close();
      }
    }

    await context.close();
    await browser.close();
  } catch (error) {
    throw new Send2BooxError(`Debug browser launch failed: ${String(error)}`);
  }
}

export function requiredStr(
  record: Record<string, unknown>,
  key: string,
  index: number
): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) {
    throw new Send2BooxError(`Cookie entry #${index} is missing required string key: ${key}`);
  }
  return value;
}

export function normalizeSameSite(value: unknown): 'Lax' | 'Strict' | 'None' | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Send2BooxError('Cookie sameSite must be a string when provided.');
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'unspecified') {
    return null;
  }
  const mapped = SAME_SITE_MAP[normalized];
  if (!mapped) {
    throw new Send2BooxError(`Unsupported sameSite value: ${value}`);
  }
  return mapped;
}

export function normalizeExpires(record: Record<string, unknown>): number | null {
  if (record.session === true) {
    return null;
  }
  const raw = record.expirationDate;
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'number') {
    return Math.trunc(raw);
  }
  throw new Send2BooxError('Cookie expirationDate must be numeric when provided.');
}

export function buildTokenKeys(options: {
  primary: string;
  extra: string[];
}): string[] {
  const keys = [options.primary, ...options.extra];
  const normalized: string[] = [];
  for (const key of keys) {
    const clean = key.trim();
    if (clean && !normalized.includes(clean)) {
      normalized.push(clean);
    }
  }
  if (normalized.length === 0) {
    throw new Send2BooxError('At least one token key must be provided.');
  }
  return normalized;
}

export function cookieRestValue(
  cookie: { rest?: Record<string, unknown> },
  key: string
): string | null {
  const rest = cookie.rest;
  if (!rest || typeof rest !== 'object') {
    return null;
  }
  const loweredKey = key.toLowerCase();
  for (const [rawKey, value] of Object.entries(rest)) {
    if (String(rawKey).trim().toLowerCase() !== loweredKey) {
      continue;
    }
    if (value === null || value === undefined) {
      return 'true';
    }
    return String(value);
  }
  return null;
}

export function cookieRestFlag(
  cookie: { rest?: Record<string, unknown> },
  key: string
): boolean {
  const value = cookieRestValue(cookie, key);
  if (value === null) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

export function supportsKeywordArgument(callableObj: unknown, key: string): boolean {
  if (typeof callableObj !== 'function') {
    return false;
  }
  const source = Function.prototype.toString.call(callableObj);
  return source.includes(key);
}
