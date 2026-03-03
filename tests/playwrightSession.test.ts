import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CookieJar } from '../src/api.js';
import { Send2BooxError } from '../src/exceptions.js';
import {
  convertExportedCookies,
  exportCookieJarForBrowser,
  loadExportedCookies,
  supportsKeywordArgument,
  syncTokenCookies
} from '../src/playwrightSession.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'send2boox-playwright-session-'));
}

describe('playwrightSession', () => {
  it('convertExportedCookies maps browser fields', () => {
    const cookies = convertExportedCookies([
      {
        domain: '.send2boox.com',
        expirationDate: 1799726273.91,
        httpOnly: false,
        name: '_c_WBKFRo',
        path: '/',
        sameSite: 'unspecified',
        secure: false,
        value: 'value-a'
      },
      {
        domain: '.send2boox.com',
        httpOnly: false,
        name: 'session_id',
        path: '/',
        sameSite: 'no_restriction',
        secure: true,
        session: true,
        value: 'value-b'
      }
    ]);

    expect(cookies[0]).toEqual({
      name: '_c_WBKFRo',
      value: 'value-a',
      domain: '.send2boox.com',
      path: '/',
      secure: false,
      httpOnly: false,
      expires: 1799726273
    });
    expect(cookies[1]).toEqual({
      name: 'session_id',
      value: 'value-b',
      domain: '.send2boox.com',
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'None'
    });
  });

  it('loadExportedCookies from json file', () => {
    const dir = makeTempDir();
    const cookieFile = path.join(dir, 'cookies.json');
    fs.writeFileSync(
      cookieFile,
      JSON.stringify([{ domain: '.send2boox.com', name: 'uid', value: 'token-value', path: '/' }])
    );

    const cookies = loadExportedCookies(cookieFile);
    expect(cookies).toEqual([
      {
        name: 'uid',
        value: 'token-value',
        domain: '.send2boox.com',
        path: '/',
        secure: false,
        httpOnly: false
      }
    ]);
  });

  it('convertExportedCookies rejects missing fields', () => {
    expect(() =>
      convertExportedCookies([
        {
          domain: '.send2boox.com',
          path: '/'
        } as Record<string, unknown>
      ])
    ).toThrow(Send2BooxError);
  });

  it('exportCookieJarForBrowser maps cookie attributes', () => {
    const cookieJar = new CookieJar();
    cookieJar.setCookie({
      name: 'session_id',
      value: 'abc',
      domain: '.send2boox.com',
      path: '/',
      secure: true,
      expires: 1799726273,
      rest: { HttpOnly: true, SameSite: 'None' }
    });

    const records = exportCookieJarForBrowser(cookieJar);
    expect(records).toEqual([
      {
        name: 'session_id',
        value: 'abc',
        domain: '.send2boox.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'none',
        session: false,
        expirationDate: 1799726273,
        hostOnly: false
      }
    ]);
  });

  it('syncTokenCookies writes cookie file', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'cookies.json');
    const captured: Record<string, string> = {};

    const writtenPath = await syncTokenCookies({
      cloud: 'send2boox.com',
      token: 'token-abc',
      outputPath,
      apiFactory: ({ cloud, token }) => {
        captured.cloud = cloud;
        captured.token = token;
        const jar = new CookieJar();
        jar.setCookie({
          name: 'uid',
          value: 'u-token',
          domain: '.send2boox.com',
          path: '/',
          secure: true,
          rest: { SameSite: 'Lax' }
        });
        return {
          session: { cookies: jar },
          request: async (endpoint: string) => {
            captured.endpoint = endpoint;
            return { success: true };
          }
        };
      }
    });

    const raw = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as Array<Record<string, unknown>>;
    expect(writtenPath).toBe(path.resolve(outputPath));
    expect(captured).toEqual({
      cloud: 'send2boox.com',
      token: 'token-abc',
      endpoint: 'users/syncToken'
    });
    expect(raw[0]?.name).toBe('uid');
    expect(raw[0]?.domain).toBe('.send2boox.com');
  });

  it('syncTokenCookies allows empty when disabled', async () => {
    const dir = makeTempDir();
    const result = await syncTokenCookies({
      cloud: 'send2boox.com',
      token: 'token-abc',
      outputPath: path.join(dir, 'unused.json'),
      raiseOnEmpty: false,
      apiFactory: () => ({
        session: { cookies: new CookieJar() },
        request: async () => ({ success: true })
      })
    });
    expect(result).toBeNull();
  });

  it('syncTokenCookies reads session_id from payload', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'cookies.json');
    const writtenPath = await syncTokenCookies({
      cloud: 'send2boox.com',
      token: 'token-abc',
      outputPath,
      apiFactory: () => ({
        session: { cookies: new CookieJar() },
        request: async () => ({
          result_code: 0,
          data: { cookie_name: 'SyncGatewaySession', session_id: 'payload-session-value' }
        })
      })
    });

    expect(writtenPath).toBe(path.resolve(outputPath));
    const raw = JSON.parse(fs.readFileSync(outputPath, 'utf-8')) as Array<Record<string, unknown>>;
    expect(raw.some((item) => item.name === 'SyncGatewaySession')).toBe(true);
  });

  it('supportsKeywordArgument detects kwarg presence', () => {
    const fnWithDevtools = ({ devtools = false }: { devtools?: boolean }) => devtools;
    const fnWithoutDevtools = ({ headless = false }: { headless?: boolean }) => headless;
    expect(supportsKeywordArgument(fnWithDevtools, 'devtools')).toBe(true);
    expect(supportsKeywordArgument(fnWithoutDevtools, 'devtools')).toBe(false);
  });
});
