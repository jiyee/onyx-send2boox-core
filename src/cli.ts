import { ArgumentParser } from 'argparse';
import fs from 'node:fs';
import path from 'node:path';

import {
  Send2BooxClient,
  formatBookAnnotationsDump,
  formatFilesTable,
  formatLibraryBooksTable
} from './client.js';
import type { AppConfig } from './config.js';
import { loadConfig, saveConfig } from './config.js';
import { ConfigError, Send2BooxError } from './exceptions.js';
import { runPlaywrightDebug } from './playwrightDebug.js';
import {
  DEFAULT_SESSION_COOKIE_JSON,
  launchDebugBrowserSession,
  syncTokenCookies
} from './playwrightSession.js';

const DELETE_VISIBILITY_RECHECK_ATTEMPTS = 5;
const DELETE_VISIBILITY_RECHECK_INTERVAL_SECONDS = 0.4;

export interface CliClientLike {
  config: AppConfig;
  requestVerificationCode(account: string): Promise<void>;
  authenticateWithEmailCode(account: string, code: string): Promise<string>;
  listFiles(options?: { limit?: number; offset?: number }): Promise<{ file_id: string; name: string; size: number }[]>;
  sendFile(filePath: string): Promise<void>;
  deleteFiles(ids: string[]): Promise<void>;
  listLibraryBooks(options?: { includeInactive?: boolean }): Promise<any[]>;
  getBookReadInfo(bookId: string): Promise<any>;
  listBookAnnotations(bookId: string, options?: { includeInactive?: boolean }): Promise<any[]>;
  listBookBookmarks(bookId: string, options?: { includeInactive?: boolean }): Promise<any[]>;
}

export interface CliRuntime {
  loadConfig: (configPath: string) => AppConfig;
  saveConfig: (config: AppConfig, configPath: string) => void;
  createClient: (config: AppConfig) => CliClientLike;
  syncTokenCookies: typeof syncTokenCookies;
  launchDebugBrowserSession: typeof launchDebugBrowserSession;
  runPlaywrightDebug: typeof runPlaywrightDebug;
  sleepFn: (seconds: number) => Promise<void>;
}

class ParserExitError extends Error {
  status: number;
  output: string;

  constructor(status: number, output: string) {
    super(output);
    this.status = status;
    this.output = output;
  }
}

class SafeArgumentParser extends ArgumentParser {
  override exit(status = 0, message = ''): never {
    throw new ParserExitError(status, message ?? '');
  }
}

function printOk(message: string): void {
  process.stderr.write(`[OK] ${message}\n`);
}

function printWarn(message: string): void {
  process.stderr.write(`[WARN] ${message}\n`);
}

function printError(message: string): void {
  process.stderr.write(`[ERROR] ${message}\n`);
}

export function buildParser(): ArgumentParser {
  const parser = new SafeArgumentParser({ prog: 'send2boox' });
  parser.add_argument('--config', {
    default: 'config.toml',
    help: 'Path to TOML config file (default: config.toml)'
  });
  parser.add_argument('--server', {
    help: 'send2boox server host; overrides config server'
  });
  parser.add_argument('--log-level', {
    default: 'WARNING',
    choices: ['DEBUG', 'INFO', 'WARNING', 'ERROR', 'CRITICAL'],
    help: 'Python logging level'
  });

  const subparsers = parser.add_subparsers({ dest: 'command_group', required: true } as any);

  const authParser = subparsers.add_parser('auth', { help: 'Authentication commands' });
  const authSubparsers = authParser.add_subparsers({ dest: 'auth_command', required: true } as any);

  const requestParser = authSubparsers.add_parser('login', {
    help: 'Request login code by email or mobile'
  });
  requestParser.set_defaults({ command: 'auth_login' });
  const requestIdentityGroup = requestParser.add_mutually_exclusive_group();
  requestIdentityGroup.add_argument('--account', {
    help: 'Login account (email or mobile); falls back to config value'
  });
  requestIdentityGroup.add_argument('--email', {
    help: 'Email address; falls back to config email/mobile'
  });
  requestIdentityGroup.add_argument('--mobile', {
    help: 'Mobile number; falls back to config mobile/email'
  });

  const tokenParser = authSubparsers.add_parser('code', { help: 'Exchange code for token' });
  tokenParser.set_defaults({ command: 'auth_code' });
  tokenParser.add_argument('code', { help: '6 digit verification code' });
  const tokenIdentityGroup = tokenParser.add_mutually_exclusive_group();
  tokenIdentityGroup.add_argument('--account', {
    help: 'Login account (email or mobile); falls back to config value'
  });
  tokenIdentityGroup.add_argument('--email', {
    help: 'Email address; falls back to config email/mobile'
  });
  tokenIdentityGroup.add_argument('--mobile', {
    help: 'Mobile number; falls back to config mobile/email'
  });
  tokenParser.add_argument('--cookie-output', {
    default: DEFAULT_SESSION_COOKIE_JSON,
    help: `Path to write auto-synced session cookies (default: ${DEFAULT_SESSION_COOKIE_JSON})`
  });
  tokenParser.add_argument('--no-cookie-sync', {
    action: 'store_true',
    help: 'Skip automatic users/syncToken cookie synchronization'
  });

  const fileParser = subparsers.add_parser('file', { help: 'Remote file commands' });
  const fileSubparsers = fileParser.add_subparsers({ dest: 'file_command', required: true } as any);

  const sendParser = fileSubparsers.add_parser('send', { help: 'Send one or more files' });
  sendParser.set_defaults({ command: 'file_send' });
  sendParser.add_argument('files', { nargs: '*', help: 'Local files to upload' });

  const listParser = fileSubparsers.add_parser('list', { help: 'List remote files' });
  listParser.set_defaults({ command: 'file_list' });
  listParser.add_argument('--limit', { type: 'int', default: 24 });
  listParser.add_argument('--offset', { type: 'int', default: 0 });

  const deleteParser = fileSubparsers.add_parser('delete', {
    help: 'Delete remote files by id'
  });
  deleteParser.set_defaults({ command: 'file_delete' });
  deleteParser.add_argument('ids', { nargs: '+', help: 'Remote file IDs' });

  const bookParser = subparsers.add_parser('book', { help: 'Book and reading data commands' });
  const bookSubparsers = bookParser.add_subparsers({ dest: 'book_command', required: true } as any);

  const dumpBookIdsParser = bookSubparsers.add_parser('list', {
    help: 'Fetch library book metadata without browser DevTools'
  });
  dumpBookIdsParser.set_defaults({ command: 'book_list' });
  dumpBookIdsParser.add_argument('--include-inactive', {
    action: 'store_true',
    help: 'Include books whose status is not 0'
  });
  dumpBookIdsParser.add_argument('--json', {
    action: 'store_true',
    help: 'Print full JSON metadata instead of ID/name table'
  });
  dumpBookIdsParser.add_argument('--output', {
    help: 'Optional path to write JSON metadata'
  });

  const readInfoParser = bookSubparsers.add_parser('stats', {
    help: 'Fetch single-book reading stats via statistics/readInfoList'
  });
  readInfoParser.set_defaults({ command: 'book_stats' });
  readInfoParser.add_argument('book_id', { help: 'Book unique id (docId)' });
  readInfoParser.add_argument('--output', {
    help: 'Optional path to write JSON reading record'
  });

  const annotationsParser = bookSubparsers.add_parser('annotations', {
    help: 'Fetch single-book annotations (modeType=1) from READER_LIBRARY'
  });
  annotationsParser.set_defaults({ command: 'book_annotations' });
  annotationsParser.add_argument('book_id', { help: 'Book unique id (documentId)' });
  annotationsParser.add_argument('--include-inactive', {
    action: 'store_true',
    help: 'Include annotation records whose status is not 0'
  });
  annotationsParser.add_argument('--output', {
    help: 'Optional path to write JSON annotations'
  });

  const bookmarksParser = bookSubparsers.add_parser('bookmarks', {
    help: 'Fetch single-book bookmarks (modeType=2) from READER_LIBRARY'
  });
  bookmarksParser.set_defaults({ command: 'book_bookmarks' });
  bookmarksParser.add_argument('book_id', { help: 'Book unique id (documentId)' });
  bookmarksParser.add_argument('--include-inactive', {
    action: 'store_true',
    help: 'Include bookmark records whose status is not 0'
  });
  bookmarksParser.add_argument('--output', {
    help: 'Optional path to write JSON bookmarks'
  });

  const dumpParser = bookSubparsers.add_parser('dump', {
    help: 'Export single-book annotations as Boox Reading Notes TXT'
  });
  dumpParser.set_defaults({ command: 'book_dump' });
  dumpParser.add_argument('book_id', { help: 'Book unique id (documentId)' });
  dumpParser.add_argument('--author', {
    default: '',
    help:
      'Optional author suffix for header: Reading Notes | <<title>>author. If omitted, use library metadata authors when available.'
  });
  dumpParser.add_argument('--title', {
    default: '',
    help: 'Optional title override for header and auto output filename'
  });
  dumpParser.add_argument('--include-inactive', {
    action: 'store_true',
    help: 'Include annotation records whose status is not 0'
  });
  dumpParser.add_argument('--output', {
    help: 'Optional output TXT path; default is <title>-annotation-YYYY-MM-DD_HH_MM_SS.txt'
  });

  const debugParser = subparsers.add_parser('debug-playwright', {
    help: 'Open a page with Playwright and infer API interfaces'
  });
  debugParser.set_defaults({ command: 'debug_playwright' });
  debugParser.add_argument('url', { help: 'Target URL to inspect' });
  debugParser.add_argument('--headful', {
    action: 'store_true',
    help: 'Show browser window (default is headless)'
  });
  debugParser.add_argument('--timeout-ms', {
    type: 'int',
    default: 30_000,
    help: 'Navigation timeout in milliseconds'
  });
  debugParser.add_argument('--settle-ms', {
    type: 'int',
    default: 2_000,
    help: 'Extra wait time after navigation in milliseconds'
  });
  debugParser.add_argument('--max-requests', {
    type: 'int',
    default: 250,
    help: 'Maximum number of network responses to capture'
  });
  debugParser.add_argument('--max-body-chars', {
    type: 'int',
    default: 1_200,
    help: 'Maximum request/response body chars to keep per capture'
  });
  debugParser.add_argument('--output', {
    help: 'Optional path to write JSON report'
  });

  const browserParser = subparsers.add_parser('debug-browser', {
    help: 'Launch headful Chromium and inject cookies/localStorage token'
  });
  browserParser.set_defaults({ command: 'debug_browser' });
  browserParser.add_argument('url', { help: 'Target URL to open' });
  browserParser.add_argument('--token', {
    help: 'Token value to inject; defaults to token from config.toml'
  });
  browserParser.add_argument('--token-key', {
    default: 'token',
    help: 'Primary localStorage key for token (default: token)'
  });
  browserParser.add_argument('--extra-token-key', {
    action: 'append',
    default: [],
    help: 'Additional localStorage keys for token; repeatable'
  });
  browserParser.add_argument('--cookie-json', {
    help: 'Path to exported browser cookie JSON'
  });
  browserParser.add_argument('--timeout-ms', {
    type: 'int',
    default: 30_000,
    help: 'Navigation timeout in milliseconds'
  });
  browserParser.add_argument('--devtools', {
    action: 'store_true',
    help: 'Open Chromium with DevTools'
  });
  browserParser.add_argument('--no-wait', {
    action: 'store_true',
    help: 'Exit immediately after injection instead of waiting for Enter'
  });

  return parser;
}

function resolveLoginAccount(args: Record<string, unknown>, config: AppConfig): string {
  const values = [
    args.account,
    args.mobile,
    args.email,
    config.mobile,
    config.email
  ] as unknown[];
  for (const value of values) {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized) {
        return normalized;
      }
    }
  }
  return '';
}

function persistLoginAccount(config: AppConfig, account: string): void {
  const normalized = account.trim();
  if (!normalized) {
    return;
  }
  if (normalized.includes('@')) {
    config.email = normalized;
  } else {
    config.mobile = normalized;
  }
}

async function syncCookiesWithFallback(options: {
  cloud: string;
  token: string;
  outputPath: string;
  syncTokenCookiesFn: typeof syncTokenCookies;
}): Promise<string | null> {
  const hosts = [options.cloud.trim()];
  if (options.cloud.trim().toLowerCase() !== 'send2boox.com') {
    hosts.push('send2boox.com');
  }
  for (const host of hosts) {
    const cookiePath = await options.syncTokenCookiesFn({
      cloud: host,
      token: options.token,
      outputPath: options.outputPath,
      raiseOnEmpty: false
    });
    if (cookiePath !== null) {
      return cookiePath;
    }
  }
  return null;
}

function ensureParentDir(filePath: string): void {
  fs.mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

function uniqueHosts(preferredCloud: string): string[] {
  const hosts: string[] = [];
  for (const host of [preferredCloud, 'send2boox.com', 'eur.boox.com']) {
    const normalized = host.trim();
    if (normalized && !hosts.includes(normalized)) {
      hosts.push(normalized);
    }
  }
  return hosts;
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

export async function main(
  argv?: string[],
  runtimeOverrides?: Partial<CliRuntime>
): Promise<number> {
  const runtime: CliRuntime = {
    loadConfig,
    saveConfig,
    createClient: (config) => new Send2BooxClient(config),
    syncTokenCookies,
    launchDebugBrowserSession,
    runPlaywrightDebug,
    sleepFn: sleep,
    ...runtimeOverrides
  };

  const parser = buildParser();
  let args: Record<string, unknown>;
  try {
    args = parser.parse_args(argv) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ParserExitError) {
      if (error.output) {
        process.stderr.write(error.output);
      }
      return error.status;
    }
    throw error;
  }

  const command = String(args.command ?? '');

  try {
    if (command === 'debug_browser') {
      let token = typeof args.token === 'string' ? args.token.trim() : '';
      let cookieJsonPath = typeof args.cookie_json === 'string' ? args.cookie_json : undefined;
      let syncCloud = typeof args.server === 'string' ? args.server.trim() : '';
      let runtimeConfig: AppConfig | null = null;

      const ensureRuntimeConfig = (): AppConfig => {
        if (!runtimeConfig) {
          runtimeConfig = runtime.loadConfig(String(args.config ?? 'config.toml'));
          if (typeof args.server === 'string' && args.server.trim()) {
            runtimeConfig.cloud = args.server.trim();
          }
          syncCloud = runtimeConfig.cloud;
        }
        return runtimeConfig;
      };

      if (!token) {
        token = ensureRuntimeConfig().token.trim();
      }

      if (!token) {
        throw new ConfigError('Token is required. Pass --token or set token in config.toml.');
      }

      if (!cookieJsonPath) {
        const defaultCookiePath = path.resolve(DEFAULT_SESSION_COOKIE_JSON);
        if (fs.existsSync(defaultCookiePath)) {
          cookieJsonPath = defaultCookiePath;
        } else {
          if (!syncCloud) {
            syncCloud = ensureRuntimeConfig().cloud;
          }
          const syncedPath = await syncCookiesWithFallback({
            cloud: syncCloud,
            token,
            outputPath: DEFAULT_SESSION_COOKIE_JSON,
            syncTokenCookiesFn: runtime.syncTokenCookies
          });
          if (syncedPath !== null) {
            cookieJsonPath = syncedPath;
            printOk(`Session cookies synced to ${path.relative(process.cwd(), syncedPath) || syncedPath}`);
          } else {
            printWarn(
              'session cookie sync returned no cookies. Continuing with token-only injection.'
            );
          }
        }
      }

      await runtime.launchDebugBrowserSession({
        url: String(args.url),
        token,
        tokenKey: String(args.token_key ?? 'token'),
        extraTokenKeys: Array.isArray(args.extra_token_key)
          ? (args.extra_token_key as string[])
          : [],
        cookieJsonPath: cookieJsonPath ?? null,
        timeoutMs: Number(args.timeout_ms ?? 30_000),
        devtools: Boolean(args.devtools),
        waitForEnter: !Boolean(args.no_wait)
      });
      return 0;
    }

    if (command === 'debug_playwright') {
      const report = await runtime.runPlaywrightDebug({
        url: String(args.url),
        headless: !Boolean(args.headful),
        timeoutMs: Number(args.timeout_ms ?? 30_000),
        settleMs: Number(args.settle_ms ?? 2_000),
        maxRequests: Number(args.max_requests ?? 250),
        maxBodyChars: Number(args.max_body_chars ?? 1_200)
      });
      const reportJson = report.toJson({ indent: 2 });
      if (typeof args.output === 'string' && args.output) {
        ensureParentDir(args.output);
        fs.writeFileSync(path.resolve(args.output), reportJson, 'utf-8');
        printOk(`Report written to ${args.output}`);
      }
      process.stdout.write(`${reportJson}\n`);
      return 0;
    }

    const configPath = String(args.config ?? 'config.toml');
    const config = runtime.loadConfig(configPath);
    if (typeof args.server === 'string' && args.server.trim()) {
      config.cloud = args.server.trim();
    }
    let client = runtime.createClient(config);

    if (command === 'auth_login') {
      const account = resolveLoginAccount(args, config);
      if (!account) {
        throw new ConfigError(
          'Login account is required. Set email/mobile in config.toml or pass --account/--email/--mobile.'
        );
      }
      await client.requestVerificationCode(account);
      printOk('Code requested. Check your mailbox/SMS.');
      return 0;
    }

    if (command === 'auth_code') {
      const account = resolveLoginAccount(args, config);
      if (!account) {
        throw new ConfigError(
          'Login account is required. Set email/mobile in config.toml or pass --account/--email/--mobile.'
        );
      }
      const token = await client.authenticateWithEmailCode(account, String(args.code));
      persistLoginAccount(config, account);
      runtime.saveConfig(config, configPath);
      printOk('Token obtained and saved.');
      printOk(`Token prefix: ${token.slice(0, 8)}...`);
      if (!Boolean(args.no_cookie_sync)) {
        const cookiePath = await syncCookiesWithFallback({
          cloud: config.cloud,
          token,
          outputPath: String(args.cookie_output),
          syncTokenCookiesFn: runtime.syncTokenCookies
        });
        if (cookiePath !== null) {
          printOk(`Session cookies saved to ${path.relative(process.cwd(), cookiePath) || cookiePath}`);
        } else {
          printWarn(
            'session cookie sync returned no cookies. Token is saved; browser debugging can continue with token injection.'
          );
        }
      }
      return 0;
    }

    if (command === 'file_send') {
      const files = Array.isArray(args.files) ? (args.files as string[]) : [];
      for (const filePath of files) {
        await client.sendFile(filePath);
      }
      const remoteFiles = await client.listFiles();
      process.stdout.write(`${formatFilesTable(remoteFiles)}\n`);
      return 0;
    }

    if (command === 'file_list') {
      const files = await client.listFiles({
        limit: Number(args.limit ?? 24),
        offset: Number(args.offset ?? 0)
      });
      process.stdout.write(`${formatFilesTable(files)}\n`);
      return 0;
    }

    if (command === 'book_stats') {
      const normalizedBookId = String(args.book_id ?? '').trim();
      if (!normalizedBookId) {
        throw new ConfigError('book_id is required.');
      }

      const preferredCloud = config.cloud.trim();
      let readInfo: Awaited<ReturnType<Send2BooxClient['getBookReadInfo']>> | null = null;
      let activeCloud = preferredCloud;
      let statsLastError: Send2BooxError | null = null;

      for (const host of uniqueHosts(preferredCloud)) {
        let activeClient = client;
        if (host !== preferredCloud) {
          activeClient = runtime.createClient({
            email: config.email,
            mobile: config.mobile,
            token: config.token,
            cloud: host
          });
        }
        try {
          readInfo = await activeClient.getBookReadInfo(normalizedBookId);
          activeCloud = host;
          break;
        } catch (error) {
          if (error instanceof Send2BooxError) {
            statsLastError = error;
          } else {
            throw error;
          }
        }
      }

      if (readInfo === null) {
        if (statsLastError) {
          throw statsLastError;
        }
        throw new Send2BooxError('Failed to fetch reading info.');
      }

      const readInfoPayload = {
        doc_id: readInfo.doc_id,
        name: readInfo.name,
        total_time: readInfo.total_time,
        avg_time: readInfo.avg_time,
        reading_progress: readInfo.reading_progress,
        token_expired_at: readInfo.token_expired_at
      };
      const outputJson = JSON.stringify(readInfoPayload, null, 2);

      if (typeof args.output === 'string' && args.output) {
        ensureParentDir(args.output);
        fs.writeFileSync(path.resolve(args.output), outputJson, 'utf-8');
        printOk(`Reading record written to ${args.output}`);
      }

      process.stdout.write(`${outputJson}\n`);
      if (activeCloud !== preferredCloud) {
        printWarn(`failed on ${preferredCloud}; used ${activeCloud} fallback.`);
      }
      return 0;
    }

    if (command === 'book_list') {
      const preferredCloud = config.cloud.trim();
      let books: Awaited<ReturnType<Send2BooxClient['listLibraryBooks']>> | null = null;
      let activeCloud = preferredCloud;
      let bookLastError: Send2BooxError | null = null;

      for (const host of uniqueHosts(preferredCloud)) {
        let activeClient = client;
        if (host !== preferredCloud) {
          activeClient = runtime.createClient({
            email: config.email,
            mobile: config.mobile,
            token: config.token,
            cloud: host
          });
        }
        try {
          books = await activeClient.listLibraryBooks({
            includeInactive: Boolean(args.include_inactive)
          });
          activeCloud = host;
          break;
        } catch (error) {
          if (error instanceof Send2BooxError) {
            bookLastError = error;
          } else {
            throw error;
          }
        }
      }

      if (books === null) {
        if (bookLastError) {
          throw bookLastError;
        }
        throw new Send2BooxError('Failed to fetch library books.');
      }

      const bookListPayload = books.map((item) => ({
        unique_id: item.unique_id,
        name: item.name,
        status: item.status,
        reading_status: item.reading_status
      }));

      if (typeof args.output === 'string' && args.output) {
        ensureParentDir(args.output);
        fs.writeFileSync(path.resolve(args.output), JSON.stringify(bookListPayload, null, 2), 'utf-8');
        printOk(`Metadata written to ${args.output}`);
      }

      if (Boolean(args.json)) {
        process.stdout.write(`${JSON.stringify(bookListPayload, null, 2)}\n`);
      } else {
        process.stdout.write(`${formatLibraryBooksTable(books)}\n`);
      }

      if (activeCloud !== preferredCloud) {
        printWarn(`failed on ${preferredCloud}; used ${activeCloud} fallback.`);
      }
      return 0;
    }

    if (command === 'book_annotations') {
      const normalizedBookId = String(args.book_id ?? '').trim();
      if (!normalizedBookId) {
        throw new ConfigError('book_id is required.');
      }
      const preferredCloud = config.cloud.trim();
      let annotations: Awaited<ReturnType<Send2BooxClient['listBookAnnotations']>> | null = null;
      let activeCloud = preferredCloud;
      let annotationLastError: Send2BooxError | null = null;

      for (const host of uniqueHosts(preferredCloud)) {
        let activeClient = client;
        if (host !== preferredCloud) {
          activeClient = runtime.createClient({
            email: config.email,
            mobile: config.mobile,
            token: config.token,
            cloud: host
          });
        }
        try {
          annotations = await activeClient.listBookAnnotations(normalizedBookId, {
            includeInactive: Boolean(args.include_inactive)
          });
          activeCloud = host;
          break;
        } catch (error) {
          if (error instanceof Send2BooxError) {
            annotationLastError = error;
          } else {
            throw error;
          }
        }
      }

      if (annotations === null) {
        if (annotationLastError) {
          throw annotationLastError;
        }
        throw new Send2BooxError('Failed to fetch annotations.');
      }

      const annotationsPayload = annotations.map((item) => ({
        unique_id: item.unique_id,
        document_id: item.document_id,
        quote: item.quote,
        note: item.note,
        chapter: item.chapter,
        page_number: item.page_number,
        position: item.position,
        start_position: item.start_position,
        end_position: item.end_position,
        color: item.color,
        shape: item.shape,
        status: item.status,
        updated_at: item.updated_at
      }));
      const outputJson = JSON.stringify(annotationsPayload, null, 2);

      if (typeof args.output === 'string' && args.output) {
        ensureParentDir(args.output);
        fs.writeFileSync(path.resolve(args.output), outputJson, 'utf-8');
        printOk(`Annotations written to ${args.output}`);
      }

      process.stdout.write(`${outputJson}\n`);
      if (activeCloud !== preferredCloud) {
        printWarn(`failed on ${preferredCloud}; used ${activeCloud} fallback.`);
      }
      return 0;
    }

    if (command === 'book_bookmarks') {
      const normalizedBookId = String(args.book_id ?? '').trim();
      if (!normalizedBookId) {
        throw new ConfigError('book_id is required.');
      }
      const preferredCloud = config.cloud.trim();
      let bookmarks: Awaited<ReturnType<Send2BooxClient['listBookBookmarks']>> | null = null;
      let activeCloud = preferredCloud;
      let bookmarkLastError: Send2BooxError | null = null;

      for (const host of uniqueHosts(preferredCloud)) {
        let activeClient = client;
        if (host !== preferredCloud) {
          activeClient = runtime.createClient({
            email: config.email,
            mobile: config.mobile,
            token: config.token,
            cloud: host
          });
        }
        try {
          bookmarks = await activeClient.listBookBookmarks(normalizedBookId, {
            includeInactive: Boolean(args.include_inactive)
          });
          activeCloud = host;
          break;
        } catch (error) {
          if (error instanceof Send2BooxError) {
            bookmarkLastError = error;
          } else {
            throw error;
          }
        }
      }

      if (bookmarks === null) {
        if (bookmarkLastError) {
          throw bookmarkLastError;
        }
        throw new Send2BooxError('Failed to fetch bookmarks.');
      }

      const bookmarksPayload = bookmarks.map((item) => ({
        unique_id: item.unique_id,
        document_id: item.document_id,
        quote: item.quote,
        title: item.title,
        page_number: item.page_number,
        position: item.position,
        xpath: item.xpath,
        position_int: item.position_int,
        status: item.status,
        updated_at: item.updated_at
      }));
      const outputJson = JSON.stringify(bookmarksPayload, null, 2);

      if (typeof args.output === 'string' && args.output) {
        ensureParentDir(args.output);
        fs.writeFileSync(path.resolve(args.output), outputJson, 'utf-8');
        printOk(`Bookmarks written to ${args.output}`);
      }

      process.stdout.write(`${outputJson}\n`);
      if (activeCloud !== preferredCloud) {
        printWarn(`failed on ${preferredCloud}; used ${activeCloud} fallback.`);
      }
      return 0;
    }

    if (command === 'book_dump') {
      const normalizedBookId = String(args.book_id ?? '').trim();
      if (!normalizedBookId) {
        throw new ConfigError('book_id is required.');
      }
      const preferredCloud = config.cloud.trim();
      let annotations: Awaited<ReturnType<Send2BooxClient['listBookAnnotations']>> | null = null;
      let activeCloud = preferredCloud;
      let dumpLastError: Send2BooxError | null = null;
      let matchedBookName = '';
      let matchedBookAuthor = '';

      for (const host of uniqueHosts(preferredCloud)) {
        let activeClient = client;
        if (host !== preferredCloud) {
          activeClient = runtime.createClient({
            email: config.email,
            mobile: config.mobile,
            token: config.token,
            cloud: host
          });
        }
        try {
          annotations = await activeClient.listBookAnnotations(normalizedBookId, {
            includeInactive: Boolean(args.include_inactive)
          });
          activeCloud = host;
          let books: Awaited<ReturnType<Send2BooxClient['listLibraryBooks']>> = [];
          try {
            books = await activeClient.listLibraryBooks({ includeInactive: true });
          } catch {
            books = [];
          }
          for (const item of books) {
            if (item.unique_id === normalizedBookId && item.name.trim()) {
              matchedBookName = item.name.trim();
              matchedBookAuthor = item.authors.trim();
              break;
            }
          }
          break;
        } catch (error) {
          if (error instanceof Send2BooxError) {
            dumpLastError = error;
          } else {
            throw error;
          }
        }
      }

      if (annotations === null) {
        if (dumpLastError) {
          throw dumpLastError;
        }
        throw new Send2BooxError('Failed to fetch annotations for dump.');
      }

      const explicitTitle = String(args.title ?? '').trim();
      const inferredTitle = stripKnownBookExtension(matchedBookName);
      const dumpTitle = explicitTitle || inferredTitle || normalizedBookId;
      const dumpAuthor = String(args.author ?? '').trim() || matchedBookAuthor;
      const dumpText = formatBookAnnotationsDump({
        annotations,
        bookTitle: dumpTitle,
        bookAuthor: dumpAuthor
      });

      const outputPath =
        typeof args.output === 'string' && args.output
          ? path.resolve(args.output)
          : buildDefaultAnnotationDumpPath(dumpTitle);
      ensureParentDir(outputPath);
      fs.writeFileSync(outputPath, dumpText, 'utf-8');
      printOk(`Annotation dump written to ${path.relative(process.cwd(), outputPath) || outputPath}`);
      if (activeCloud !== preferredCloud) {
        printWarn(`failed on ${preferredCloud}; used ${activeCloud} fallback.`);
      }
      return 0;
    }

    if (command === 'file_delete') {
      const targetIds = (Array.isArray(args.ids) ? (args.ids as string[]) : [])
        .map((item) => item.trim())
        .filter((item) => item);
      await client.deleteFiles(targetIds);

      let files = await client.listFiles();
      let remaining = findRemainingTargetIds({ files, targetIds });
      if (remaining.length > 0) {
        for (let index = 0; index < DELETE_VISIBILITY_RECHECK_ATTEMPTS; index += 1) {
          await runtime.sleepFn(DELETE_VISIBILITY_RECHECK_INTERVAL_SECONDS);
          files = await client.listFiles();
          remaining = findRemainingTargetIds({ files, targetIds });
          if (remaining.length === 0) {
            break;
          }
        }
      }

      if (remaining.length > 0) {
        printWarn(
          `delete request succeeded but file IDs still visible after refresh window: ${remaining.join(', ')}`
        );
      }

      process.stdout.write(`${formatFilesTable(files)}\n`);
      return 0;
    }

    return 2;
  } catch (error) {
    if (error instanceof Send2BooxError) {
      printError(String(error.message));
      return 1;
    }
    throw error;
  }
}

export function findRemainingTargetIds(options: {
  files: { file_id: string }[];
  targetIds: string[];
}): string[] {
  const targetSet = new Set(options.targetIds.filter((item) => item));
  if (targetSet.size === 0) {
    return [];
  }
  const remaining = options.files
    .map((item) => item.file_id)
    .filter((fileId) => targetSet.has(fileId));
  remaining.sort();
  return remaining;
}

export function buildDefaultAnnotationDumpPath(bookTitle: string): string {
  const date = new Date();
  const timestamp = `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}_${`${date.getHours()}`.padStart(2, '0')}_${`${date.getMinutes()}`.padStart(2, '0')}_${`${date.getSeconds()}`.padStart(2, '0')}`;
  const normalizedTitle = sanitizeFilenameComponent(bookTitle);
  return path.resolve(`${normalizedTitle}-annotation-${timestamp}.txt`);
}

export function sanitizeFilenameComponent(value: string): string {
  const normalized = value.trim() || 'book';
  const sanitized = normalized.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  return sanitized || 'book';
}

export function stripKnownBookExtension(value: string): string {
  const normalized = value.trim();
  if (!normalized) {
    return '';
  }
  const match = normalized.match(/^(?<base>.+?)(?<ext>\.[A-Za-z0-9]{2,8})$/);
  if (!match?.groups) {
    return normalized;
  }
  const ext = match.groups.ext.toLowerCase();
  if (
    [
      '.epub',
      '.pdf',
      '.mobi',
      '.azw',
      '.azw3',
      '.txt',
      '.doc',
      '.docx',
      '.fb2',
      '.rtf',
      '.djvu',
      '.djv',
      '.cbz',
      '.cbr'
    ].includes(ext)
  ) {
    return match.groups.base;
  }
  return normalized;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((error) => {
      process.stderr.write(String(error) + '\n');
      process.exit(1);
    });
}
