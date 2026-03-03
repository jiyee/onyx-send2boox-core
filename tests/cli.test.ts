import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { main, type CliClientLike, type CliRuntime } from '../src/cli.js';
import { Send2BooxError } from '../src/exceptions.js';

interface DummyBook {
  unique_id: string;
  name: string;
  status: number | null;
  reading_status: number | null;
  title: string;
  authors: string;
}

interface DummyReadInfo {
  doc_id: string;
  name: string;
  total_time: number | null;
  avg_time: number | null;
  reading_progress: number | null;
  token_expired_at: number | null;
}

interface DummyAnnotation {
  unique_id: string;
  document_id: string;
  quote: string;
  note: string;
  chapter: string;
  page_number: number | null;
  position: string | null;
  start_position: string | null;
  end_position: string | null;
  color: number | null;
  shape: number | null;
  status: number | null;
  updated_at: number | null;
}

interface DummyBookmark {
  unique_id: string;
  document_id: string;
  quote: string;
  title: string;
  page_number: number | null;
  position: string | null;
  xpath: string | null;
  position_int: number | null;
  status: number | null;
  updated_at: number | null;
}

class DummyClient implements CliClientLike {
  config: AppConfig;

  constructor(config: AppConfig) {
    this.config = config;
  }

  async requestVerificationCode(account: string): Promise<void> {
    this.config.email = account;
  }

  async authenticateWithEmailCode(account: string, code: string): Promise<string> {
    this.config.email = account;
    this.config.token = `token-${code}`;
    return this.config.token;
  }

  async listFiles(_options?: { limit?: number; offset?: number }): Promise<any[]> {
    return [{ file_id: 'id-1', name: 'book.epub', size: 123 }];
  }

  async sendFile(_path: string): Promise<void> {}

  async deleteFiles(_ids: string[]): Promise<void> {}

  async listLibraryBooks(_options?: { includeInactive?: boolean }): Promise<DummyBook[]> {
    return [];
  }

  async getBookReadInfo(_bookId: string): Promise<DummyReadInfo> {
    return {
      doc_id: 'book-1',
      name: 'Alpha',
      total_time: 100,
      avg_time: 50,
      reading_progress: 12.34,
      token_expired_at: 999
    };
  }

  async listBookAnnotations(
    _bookId: string,
    _options?: { includeInactive?: boolean }
  ): Promise<DummyAnnotation[]> {
    return [];
  }

  async listBookBookmarks(
    _bookId: string,
    _options?: { includeInactive?: boolean }
  ): Promise<DummyBookmark[]> {
    return [];
  }
}

class DummyDebugReport {
  payload = '{"interfaces":[],"network_requests":0}';

  toJson(_options?: { indent?: number }): string {
    return this.payload;
  }
}

function appConfig(overrides?: Partial<AppConfig>): AppConfig {
  return {
    email: '',
    mobile: '',
    token: '',
    cloud: 'send2boox.com',
    ...overrides
  };
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'send2boox-cli-'));
}

function makeRuntime(overrides?: Partial<CliRuntime>): CliRuntime {
  return {
    loadConfig: () => appConfig(),
    saveConfig: () => {},
    createClient: (config) => new DummyClient(config),
    syncTokenCookies: async () => path.resolve('session-cookies.json'),
    launchDebugBrowserSession: async () => {},
    runPlaywrightDebug: async () => new DummyDebugReport() as any,
    sleepFn: async () => {},
    ...overrides
  };
}

async function runCli(argv: string[], runtime: Partial<CliRuntime> = {}) {
  let stdout = '';
  let stderr = '';
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: any) => {
      stdout += String(chunk);
      return true;
    }) as any);
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation(((chunk: any) => {
      stderr += String(chunk);
      return true;
    }) as any);
  try {
    const rc = await main(argv, makeRuntime(runtime));
    return { rc, stdout, stderr };
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cli', () => {
  it('request login code requires account', async () => {
    const { rc, stderr } = await runCli(['auth', 'login'], {
      loadConfig: () => appConfig({ email: '', token: '' })
    });
    expect(rc).toBe(1);
    expect(stderr).toContain('[ERROR]');
    expect(stderr).toContain('Login account is required');
  });

  it('request login code accepts mobile', async () => {
    const captured: Record<string, string> = {};
    class CapturingClient extends DummyClient {
      override async requestVerificationCode(account: string): Promise<void> {
        captured.account = account;
      }
    }
    const { rc, stderr } = await runCli(['auth', 'login', '--mobile', '13800138000'], {
      loadConfig: () => appConfig({ email: '', token: '', mobile: '' }),
      createClient: (config) => new CapturingClient(config)
    });
    expect(rc).toBe(0);
    expect(captured.account).toBe('13800138000');
    expect(stderr).toContain('[OK] Code requested.');
  });

  it('login with code uses config mobile when email empty', async () => {
    const saved: Record<string, unknown> = {};
    const { rc, stderr } = await runCli(['auth', 'code', '123456'], {
      loadConfig: () => appConfig({ email: '', mobile: '13800138000', cloud: 'eur.boox.com' }),
      saveConfig: (config, configPath) => {
        saved.config = config;
        saved.path = configPath;
      },
      syncTokenCookies: async () => path.resolve('session-cookies.json')
    });

    expect(rc).toBe(0);
    expect(stderr).toContain('[OK] Token obtained and saved.');
    expect(stderr).toContain('[OK] Token prefix:');
    const config = saved.config as AppConfig;
    expect(config.token).toBe('token-123456');
    expect(config.mobile).toBe('13800138000');
  });

  it('login with code updates config and calls save', async () => {
    const saved: Record<string, unknown> = {};
    const synced: Record<string, unknown> = {};
    const { rc, stderr } = await runCli(['auth', 'code', '123456'], {
      loadConfig: () => appConfig({ email: 'user@example.com', cloud: 'eur.boox.com' }),
      saveConfig: (config, configPath) => {
        saved.config = config;
        saved.path = configPath;
      },
      syncTokenCookies: async ({ cloud, token, outputPath, raiseOnEmpty }) => {
        synced.cloud = cloud;
        synced.token = token;
        synced.outputPath = outputPath;
        synced.raiseOnEmpty = raiseOnEmpty;
        return path.resolve(String(outputPath));
      }
    });

    expect(rc).toBe(0);
    expect(stderr).toContain('[OK] Token obtained and saved.');
    expect(stderr).toContain('[OK] Session cookies saved to session-cookies.json');
    const config = saved.config as AppConfig;
    expect(config.token).toBe('token-123456');
    expect(synced).toEqual({
      cloud: 'eur.boox.com',
      token: 'token-123456',
      outputPath: 'session-cookies.json',
      raiseOnEmpty: false
    });
  });

  it('list files command prints table', async () => {
    const { rc, stdout } = await runCli(['file', 'list', '--limit', '10', '--offset', '2'], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'eur.boox.com' })
    });
    expect(rc).toBe(0);
    expect(stdout).toContain('ID');
    expect(stdout).toContain('book.epub');
  });

  it('file delete rechecks list until deleted', async () => {
    const captured: Record<string, any> = { listCalls: 0 };
    class CapturingClient extends DummyClient {
      override async deleteFiles(ids: string[]): Promise<void> {
        captured.deletedIds = ids;
      }
      override async listFiles(): Promise<any[]> {
        captured.listCalls += 1;
        if (captured.listCalls === 1) {
          return [{ file_id: 'id-1', name: 'book.epub', size: 123 }];
        }
        return [{ file_id: 'id-2', name: 'other.epub', size: 456 }];
      }
    }

    const { rc, stdout } = await runCli(['file', 'delete', 'id-1'], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
      createClient: (config) => new CapturingClient(config)
    });

    expect(rc).toBe(0);
    expect(captured.deletedIds).toEqual(['id-1']);
    expect(captured.listCalls).toBeGreaterThanOrEqual(2);
    expect(stdout).toContain('id-2');
    expect(stdout).not.toContain('id-1');
  });

  it('file delete warns when target still present', async () => {
    class CapturingClient extends DummyClient {
      override async listFiles(): Promise<any[]> {
        return [
          { file_id: 'id-1', name: 'book.epub', size: 123 },
          { file_id: 'id-2', name: 'other.epub', size: 456 }
        ];
      }
    }

    const { rc, stderr } = await runCli(['file', 'delete', 'id-1'], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
      createClient: (config) => new CapturingClient(config)
    });

    expect(rc).toBe(0);
    expect(stderr).toContain('[WARN] delete request succeeded but file IDs still visible');
    expect(stderr).toContain('id-1');
  });

  it('list books outputs table and writes metadata', async () => {
    const dir = makeTempDir();
    const metadataPath = path.join(dir, 'library-books.json');
    const captured: Record<string, unknown> = {};
    class CapturingClient extends DummyClient {
      override async listLibraryBooks(options?: { includeInactive?: boolean }): Promise<DummyBook[]> {
        captured.includeInactive = options?.includeInactive ?? false;
        return [
          {
            unique_id: 'book-1',
            name: 'Alpha',
            status: 0,
            reading_status: 1,
            title: '',
            authors: ''
          },
          {
            unique_id: 'book-2',
            name: 'Beta',
            status: 1,
            reading_status: 2,
            title: '',
            authors: ''
          }
        ];
      }
    }

    const { rc, stdout } = await runCli(
      ['book', 'list', '--include-inactive', '--output', metadataPath],
      {
        loadConfig: () =>
          appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
        createClient: (config) => new CapturingClient(config)
      }
    );

    expect(rc).toBe(0);
    expect(captured.includeInactive).toBe(true);
    expect(stdout.split('\n')[0]).toContain('Book ID');
    expect(stdout.split('\n')[0]).toContain('Name');
    expect(stdout).toContain('book-1');
    expect(stdout).toContain('Alpha');
    expect(stdout).toContain('book-2');
    expect(stdout).toContain('Beta');
    expect(stdout).not.toContain('status');
    expect(stdout).not.toContain('reading_status');
    expect(JSON.parse(fs.readFileSync(metadataPath, 'utf-8'))).toEqual([
      { unique_id: 'book-1', name: 'Alpha', status: 0, reading_status: 1 },
      { unique_id: 'book-2', name: 'Beta', status: 1, reading_status: 2 }
    ]);
  });

  it('list books rejects removed full flag', async () => {
    const { rc, stderr } = await runCli(['book', 'list', '--full']);
    expect(rc).toBe(2);
    expect(stderr).toContain('unrecognized arguments: --full');
  });

  it('list books rejects removed table flag', async () => {
    const { rc, stderr } = await runCli(['book', 'list', '--table']);
    expect(rc).toBe(2);
    expect(stderr).toContain('unrecognized arguments: --table');
  });

  it('list books json outputs full metadata', async () => {
    class CapturingClient extends DummyClient {
      override async listLibraryBooks(): Promise<DummyBook[]> {
        return [
          {
            unique_id: 'book-1',
            name: 'Alpha',
            status: 0,
            reading_status: 1,
            title: '',
            authors: ''
          },
          {
            unique_id: 'book-2',
            name: 'Beta',
            status: 0,
            reading_status: 2,
            title: '',
            authors: ''
          }
        ];
      }
    }
    const { rc, stdout } = await runCli(['book', 'list', '--json'], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
      createClient: (config) => new CapturingClient(config)
    });
    expect(rc).toBe(0);
    expect(JSON.parse(stdout)).toEqual([
      { unique_id: 'book-1', name: 'Alpha', status: 0, reading_status: 1 },
      { unique_id: 'book-2', name: 'Beta', status: 0, reading_status: 2 }
    ]);
  });

  it('list books falls back to eur when primary unauthorized', async () => {
    const attemptedHosts: string[] = [];
    class FallbackClient extends DummyClient {
      override async listLibraryBooks(): Promise<DummyBook[]> {
        attemptedHosts.push(this.config.cloud);
        if (this.config.cloud === 'send2boox.com') {
          throw new Send2BooxError('API request failed with HTTP 401');
        }
        return [
          {
            unique_id: 'book-1',
            name: 'Alpha',
            status: 0,
            reading_status: 1,
            title: '',
            authors: ''
          }
        ];
      }
    }
    const { rc, stdout, stderr } = await runCli(['book', 'list'], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
      createClient: (config) => new FallbackClient(config)
    });
    expect(rc).toBe(0);
    expect(attemptedHosts.slice(0, 2)).toEqual(['send2boox.com', 'eur.boox.com']);
    expect(stdout.split('\n')[0]).toContain('Book ID');
    expect(stdout).toContain('book-1');
    expect(stdout).toContain('Alpha');
    expect(stderr).toContain('used eur.boox.com fallback');
  });

  it('read stats outputs json and writes file', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'read-stats.json');
    const captured: Record<string, string> = {};
    class CapturingClient extends DummyClient {
      override async getBookReadInfo(bookId: string): Promise<DummyReadInfo> {
        captured.bookId = bookId;
        return {
          doc_id: bookId,
          name: 'Alpha',
          total_time: 17880019,
          avg_time: 576775,
          reading_progress: 67.09,
          token_expired_at: 1788072864
        };
      }
    }
    const { rc, stdout } = await runCli(['book', 'stats', 'book-1', '--output', outputPath], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
      createClient: (config) => new CapturingClient(config)
    });
    expect(rc).toBe(0);
    expect(captured.bookId).toBe('book-1');
    const payload = JSON.parse(stdout);
    expect(payload).toEqual({
      doc_id: 'book-1',
      name: 'Alpha',
      total_time: 17880019,
      avg_time: 576775,
      reading_progress: 67.09,
      token_expired_at: 1788072864
    });
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf-8'))).toEqual(payload);
  });

  it('read stats falls back to eur when primary unauthorized', async () => {
    const attemptedHosts: string[] = [];
    class FallbackClient extends DummyClient {
      override async getBookReadInfo(bookId: string): Promise<DummyReadInfo> {
        attemptedHosts.push(this.config.cloud);
        if (this.config.cloud === 'send2boox.com') {
          throw new Send2BooxError('API request failed with HTTP 401');
        }
        return {
          doc_id: bookId,
          name: 'Alpha',
          total_time: 1,
          avg_time: 1,
          reading_progress: 1.0,
          token_expired_at: 1
        };
      }
    }
    const { rc, stdout, stderr } = await runCli(['book', 'stats', 'book-1'], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
      createClient: (config) => new FallbackClient(config)
    });
    expect(rc).toBe(0);
    expect(attemptedHosts.slice(0, 2)).toEqual(['send2boox.com', 'eur.boox.com']);
    expect(stdout).toContain('"doc_id": "book-1"');
    expect(stderr).toContain('used eur.boox.com fallback');
  });

  it('read annotations outputs json and writes file', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'annotations.json');
    const captured: Record<string, unknown> = {};
    class CapturingClient extends DummyClient {
      override async listBookAnnotations(
        bookId: string,
        options?: { includeInactive?: boolean }
      ): Promise<DummyAnnotation[]> {
        captured.bookId = bookId;
        captured.includeInactive = options?.includeInactive ?? false;
        return [
          {
            unique_id: 'ann-1',
            document_id: bookId,
            quote: '驴的潇洒与放荡',
            note: '',
            chapter: '第十二章',
            page_number: 199,
            position: '{"chapterIndex":24}',
            start_position: null,
            end_position: null,
            color: -983296,
            shape: 5,
            status: 0,
            updated_at: 1771337927265
          }
        ];
      }
    }

    const { rc, stdout } = await runCli(
      ['book', 'annotations', 'book-1', '--output', outputPath],
      {
        loadConfig: () =>
          appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
        createClient: (config) => new CapturingClient(config)
      }
    );
    expect(rc).toBe(0);
    expect(captured).toEqual({ bookId: 'book-1', includeInactive: false });
    const payload = JSON.parse(stdout);
    expect(payload).toEqual([
      {
        unique_id: 'ann-1',
        document_id: 'book-1',
        quote: '驴的潇洒与放荡',
        note: '',
        chapter: '第十二章',
        page_number: 199,
        position: '{"chapterIndex":24}',
        start_position: null,
        end_position: null,
        color: -983296,
        shape: 5,
        status: 0,
        updated_at: 1771337927265
      }
    ]);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf-8'))).toEqual(payload);
  });

  it('read bookmarks outputs json and writes file', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'bookmarks.json');
    const captured: Record<string, unknown> = {};
    class CapturingClient extends DummyClient {
      override async listBookBookmarks(
        bookId: string,
        options?: { includeInactive?: boolean }
      ): Promise<DummyBookmark[]> {
        captured.bookId = bookId;
        captured.includeInactive = options?.includeInactive ?? false;
        return [
          {
            unique_id: 'bm-1',
            document_id: bookId,
            quote: '推荐序能力与岗位的匹配',
            title: '推荐序',
            page_number: 1275,
            position: '1616778',
            xpath: '1/3/',
            position_int: 1616778,
            status: 0,
            updated_at: 1693543350299
          }
        ];
      }
    }

    const { rc, stdout } = await runCli(['book', 'bookmarks', 'book-1', '--output', outputPath], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
      createClient: (config) => new CapturingClient(config)
    });
    expect(rc).toBe(0);
    expect(captured).toEqual({ bookId: 'book-1', includeInactive: false });
    const payload = JSON.parse(stdout);
    expect(payload).toEqual([
      {
        unique_id: 'bm-1',
        document_id: 'book-1',
        quote: '推荐序能力与岗位的匹配',
        title: '推荐序',
        page_number: 1275,
        position: '1616778',
        xpath: '1/3/',
        position_int: 1616778,
        status: 0,
        updated_at: 1693543350299
      }
    ]);
    expect(JSON.parse(fs.readFileSync(outputPath, 'utf-8'))).toEqual(payload);
  });

  it('book dump outputs annotation txt template', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'book-annotations.txt');
    class CapturingClient extends DummyClient {
      override async listLibraryBooks(): Promise<DummyBook[]> {
        return [
          {
            unique_id: 'book-1',
            name: 'Alpha',
            status: 0,
            reading_status: 0,
            title: '',
            authors: ''
          }
        ];
      }
      override async listBookAnnotations(bookId: string): Promise<DummyAnnotation[]> {
        return [
          {
            unique_id: 'ann-1',
            document_id: bookId,
            chapter: '01 Chapter',
            quote: 'Quote 1',
            note: 'Note 1',
            page_number: 12,
            updated_at: null,
            position: null,
            start_position: null,
            end_position: null,
            color: null,
            shape: null,
            status: 0
          },
          {
            unique_id: 'ann-2',
            document_id: bookId,
            chapter: '',
            quote: 'Quote 2',
            note: '',
            page_number: 13,
            updated_at: null,
            position: null,
            start_position: null,
            end_position: null,
            color: null,
            shape: null,
            status: 0
          }
        ];
      }
    }
    const { rc, stdout, stderr } = await runCli(
      ['book', 'dump', 'book-1', '--author', 'Author A', '--output', outputPath],
      {
        loadConfig: () =>
          appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
        createClient: (config) => new CapturingClient(config)
      }
    );
    expect(rc).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toContain('[OK] Annotation dump written to');
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe(
      'Reading Notes | <<Alpha>>Author A\n' +
        '01 Chapter\n' +
        '1970-01-01 00:00  |  Page No.: 13\n' +
        'Quote 1\n' +
        '【Annotation】Note 1\n' +
        '-------------------\n' +
        '\n' +
        '1970-01-01 00:00  |  Page No.: 14\n' +
        'Quote 2\n' +
        '-------------------\n'
    );
  });

  it('book dump strips known extension from inferred title', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'book-annotations.txt');
    class CapturingClient extends DummyClient {
      override async listLibraryBooks(): Promise<DummyBook[]> {
        return [
          {
            unique_id: 'book-1',
            name: 'Alpha.epub',
            status: 0,
            reading_status: 0,
            title: '',
            authors: ''
          }
        ];
      }
      override async listBookAnnotations(bookId: string): Promise<DummyAnnotation[]> {
        return [
          {
            unique_id: 'ann-1',
            document_id: bookId,
            quote: 'Quote 1',
            note: '',
            chapter: '',
            page_number: 0,
            updated_at: null,
            position: null,
            start_position: null,
            end_position: null,
            color: null,
            shape: null,
            status: 0
          }
        ];
      }
    }
    const { rc } = await runCli(
      ['book', 'dump', 'book-1', '--author', 'Author A', '--output', outputPath],
      {
        loadConfig: () =>
          appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
        createClient: (config) => new CapturingClient(config)
      }
    );
    expect(rc).toBe(0);
    expect(fs.readFileSync(outputPath, 'utf-8').startsWith('Reading Notes | <<Alpha>>Author A\n')).toBe(
      true
    );
  });

  it('book dump uses book author when author arg missing', async () => {
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'book-annotations.txt');
    class CapturingClient extends DummyClient {
      override async listLibraryBooks(): Promise<DummyBook[]> {
        return [
          {
            unique_id: 'book-1',
            name: 'Alpha',
            authors: 'Author A',
            status: 0,
            reading_status: 0,
            title: ''
          }
        ];
      }
      override async listBookAnnotations(bookId: string): Promise<DummyAnnotation[]> {
        return [
          {
            unique_id: 'ann-1',
            document_id: bookId,
            quote: 'Quote 1',
            note: '',
            chapter: '',
            page_number: 0,
            updated_at: null,
            position: null,
            start_position: null,
            end_position: null,
            color: null,
            shape: null,
            status: 0
          }
        ];
      }
    }
    const { rc } = await runCli(['book', 'dump', 'book-1', '--output', outputPath], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
      createClient: (config) => new CapturingClient(config)
    });
    expect(rc).toBe(0);
    expect(fs.readFileSync(outputPath, 'utf-8').startsWith('Reading Notes | <<Alpha>>Author A\n')).toBe(
      true
    );
  });

  it('read bookmarks falls back to eur when primary unauthorized', async () => {
    const attemptedHosts: string[] = [];
    class FallbackClient extends DummyClient {
      override async listBookBookmarks(bookId: string): Promise<DummyBookmark[]> {
        attemptedHosts.push(this.config.cloud);
        if (this.config.cloud === 'send2boox.com') {
          throw new Send2BooxError('API request failed with HTTP 401');
        }
        return [
          {
            unique_id: 'bm-1',
            document_id: bookId,
            quote: '推荐序能力与岗位的匹配',
            title: '',
            page_number: null,
            position: null,
            xpath: null,
            position_int: null,
            status: 0,
            updated_at: null
          }
        ];
      }
    }
    const { rc, stdout, stderr } = await runCli(['book', 'bookmarks', 'book-1'], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'send2boox.com' }),
      createClient: (config) => new FallbackClient(config)
    });
    expect(rc).toBe(0);
    expect(attemptedHosts.slice(0, 2)).toEqual(['send2boox.com', 'eur.boox.com']);
    expect(stdout).toContain('"unique_id": "bm-1"');
    expect(stderr).toContain('used eur.boox.com fallback');
  });

  it('debug playwright command runs without config', async () => {
    const capturedArgs: Record<string, unknown> = {};
    const dir = makeTempDir();
    const outputPath = path.join(dir, 'playwright-report.json');

    const { rc, stderr } = await runCli(
      [
        'debug-playwright',
        'https://eur.boox.com',
        '--headful',
        '--timeout-ms',
        '11111',
        '--settle-ms',
        '2222',
        '--max-requests',
        '77',
        '--max-body-chars',
        '444',
        '--output',
        outputPath
      ],
      {
        loadConfig: () => {
          throw new Error('loadConfig must not be called');
        },
        runPlaywrightDebug: async (options) => {
          capturedArgs.url = options.url;
          capturedArgs.headless = options.headless;
          capturedArgs.timeoutMs = options.timeoutMs;
          capturedArgs.settleMs = options.settleMs;
          capturedArgs.maxRequests = options.maxRequests;
          capturedArgs.maxBodyChars = options.maxBodyChars;
          return new DummyDebugReport() as any;
        }
      }
    );

    expect(rc).toBe(0);
    expect(capturedArgs).toEqual({
      url: 'https://eur.boox.com',
      headless: false,
      timeoutMs: 11111,
      settleMs: 2222,
      maxRequests: 77,
      maxBodyChars: 444
    });
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('{"interfaces":[],"network_requests":0}');
    expect(stderr).toContain('[OK] Report written to');
  });

  it('server option overrides config cloud', async () => {
    const seen: Record<string, string> = {};
    class CapturingClient extends DummyClient {
      constructor(config: AppConfig) {
        super(config);
        seen.cloud = config.cloud;
      }
      override async listFiles(): Promise<any[]> {
        return [];
      }
    }
    const { rc } = await runCli(['--server', 'us.boox.com', 'file', 'list'], {
      loadConfig: () => appConfig({ email: 'user@example.com', token: 'tkn', cloud: 'eur.boox.com' }),
      createClient: (config) => new CapturingClient(config)
    });
    expect(rc).toBe(0);
    expect(seen.cloud).toBe('us.boox.com');
  });

  it('debug browser command runs without config', async () => {
    const captured: Record<string, unknown> = {};
    const { rc } = await runCli(
      [
        'debug-browser',
        'https://send2boox.com/#/login',
        '--token',
        'token-abc',
        '--token-key',
        'token',
        '--extra-token-key',
        'access_token',
        '--cookie-json',
        'cookies.json',
        '--timeout-ms',
        '22222',
        '--devtools',
        '--no-wait'
      ],
      {
        loadConfig: () => {
          throw new Error('loadConfig must not be called');
        },
        launchDebugBrowserSession: async (options) => {
          Object.assign(captured, options);
        }
      }
    );

    expect(rc).toBe(0);
    expect(captured).toEqual({
      url: 'https://send2boox.com/#/login',
      token: 'token-abc',
      tokenKey: 'token',
      extraTokenKeys: ['access_token'],
      cookieJsonPath: 'cookies.json',
      timeoutMs: 22222,
      devtools: true,
      waitForEnter: false
    });
  });

  it('debug browser uses config token and auto sync cookie', async () => {
    const dir = makeTempDir();
    const previousCwd = process.cwd();
    process.chdir(dir);
    const captured: Record<string, unknown> = {};
    const synced: Record<string, unknown> = {};

    try {
      const { rc, stderr } = await runCli(['debug-browser', 'https://send2boox.com/#/login'], {
        loadConfig: () =>
          appConfig({ email: 'user@example.com', token: 'cfg-token', cloud: 'send2boox.com' }),
        syncTokenCookies: async ({ cloud, token, outputPath, raiseOnEmpty }) => {
          synced.cloud = cloud;
          synced.token = token;
          synced.outputPath = outputPath;
          synced.raiseOnEmpty = raiseOnEmpty;
          return path.resolve(String(outputPath));
        },
        launchDebugBrowserSession: async (options) => {
          Object.assign(captured, options);
        }
      });

      expect(rc).toBe(0);
      expect(stderr).toContain('[OK] Session cookies synced to session-cookies.json');
      expect(synced).toEqual({
        cloud: 'send2boox.com',
        token: 'cfg-token',
        outputPath: 'session-cookies.json',
        raiseOnEmpty: false
      });
      expect(captured).toEqual({
        url: 'https://send2boox.com/#/login',
        token: 'cfg-token',
        tokenKey: 'token',
        extraTokenKeys: [],
        cookieJsonPath: path.resolve('session-cookies.json'),
        timeoutMs: 30000,
        devtools: false,
        waitForEnter: true
      });
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('obtain token warns when cookie sync empty', async () => {
    const { rc, stderr } = await runCli(['auth', 'code', '123456'], {
      loadConfig: () => appConfig({ email: 'user@example.com', cloud: 'eur.boox.com' }),
      saveConfig: () => {},
      syncTokenCookies: async () => null
    });
    expect(rc).toBe(0);
    expect(stderr).toContain('[WARN] session cookie sync returned no cookies.');
  });

  it('debug browser continues when cookie sync empty', async () => {
    const dir = makeTempDir();
    const previousCwd = process.cwd();
    process.chdir(dir);
    const captured: Record<string, unknown> = {};

    try {
      const { rc, stderr } = await runCli(['debug-browser', 'https://send2boox.com/#/login'], {
        loadConfig: () =>
          appConfig({ email: 'user@example.com', token: 'cfg-token', cloud: 'eur.boox.com' }),
        syncTokenCookies: async () => null,
        launchDebugBrowserSession: async (options) => {
          Object.assign(captured, options);
        }
      });
      expect(rc).toBe(0);
      expect(stderr).toContain('[WARN] session cookie sync returned no cookies.');
      expect(captured).toEqual({
        url: 'https://send2boox.com/#/login',
        token: 'cfg-token',
        tokenKey: 'token',
        extraTokenKeys: [],
        cookieJsonPath: null,
        timeoutMs: 30000,
        devtools: false,
        waitForEnter: true
      });
    } finally {
      process.chdir(previousCwd);
    }
  });
});
