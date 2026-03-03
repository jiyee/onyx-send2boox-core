import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { type AppConfig } from '../src/config.js';
import {
  type BookAnnotation,
  Send2BooxClient,
  formatBookAnnotationsDump
} from '../src/client.js';
import { ApiError, ResponseFormatError } from '../src/exceptions.js';

type FakeResponseMap = Record<string, unknown | unknown[] | (() => unknown)>;

class FakeApi {
  responses: FakeResponseMap;
  token: string;
  pathResponses: FakeResponseMap;
  calls: Array<Record<string, unknown>>;

  constructor(
    responses: FakeResponseMap,
    token = 'token',
    options?: { pathResponses?: FakeResponseMap }
  ) {
    this.responses = responses;
    this.token = token;
    this.pathResponses = options?.pathResponses ?? {};
    this.calls = [];
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
    this.calls.push({
      endpoint,
      method: options?.method ?? 'GET',
      params: options?.params,
      json_data: options?.jsonData,
      headers: options?.headers,
      require_auth: options?.requireAuth ?? true
    });
    const response = this.responses[endpoint];
    if (typeof response === 'function') {
      return response() as Record<string, unknown>;
    }
    if (Array.isArray(response)) {
      return (response.shift() ?? {}) as Record<string, unknown>;
    }
    if (!response) {
      return {};
    }
    return response as Record<string, unknown>;
  }

  async requestPath(
    endpoint: string,
    options?: {
      method?: string;
      params?: Record<string, unknown>;
      jsonData?: Record<string, unknown>;
      headers?: Record<string, string>;
      requireAuth?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    this.calls.push({
      endpoint,
      method: options?.method ?? 'GET',
      params: options?.params,
      json_data: options?.jsonData,
      headers: options?.headers,
      require_auth: options?.requireAuth ?? true,
      path_request: true
    });
    const response = this.pathResponses[endpoint];
    if (typeof response === 'function') {
      return response() as Record<string, unknown>;
    }
    if (Array.isArray(response)) {
      return (response.shift() ?? {}) as Record<string, unknown>;
    }
    if (!response) {
      return {};
    }
    return response as Record<string, unknown>;
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'send2boox-client-'));
}

describe('client', () => {
  it('authenticateWithEmailCode sets token', async () => {
    const api = new FakeApi({ 'users/signupByPhoneOrEmail': { data: { token: 'abc123' } } }, '');
    const client = new Send2BooxClient(appConfig({ email: 'foo@example.com' }), api as any);

    const token = await client.authenticateWithEmailCode('foo@example.com', '654321');
    expect(token).toBe('abc123');
    expect((client.api as any).token).toBe('abc123');
  });

  it('authenticateWithEmailCode accepts mobile account', async () => {
    const api = new FakeApi({ 'users/signupByPhoneOrEmail': { data: { token: 'abc123' } } }, '');
    const client = new Send2BooxClient(appConfig({ mobile: '13800138000' }), api as any);

    const token = await client.authenticateWithEmailCode('13800138000', '654321');
    expect(token).toBe('abc123');
    expect(api.calls[0]?.json_data).toEqual({ mobi: '13800138000', code: '654321' });
  });

  it('requestVerificationCode accepts mobile account', async () => {
    const api = new FakeApi({}, '');
    const client = new Send2BooxClient(appConfig({ mobile: '13800138000' }), api as any);

    await client.requestVerificationCode('13800138000');
    expect(api.calls[0]?.endpoint).toBe('users/sendMobileCode');
    expect(api.calls[0]?.json_data).toEqual({ mobi: '13800138000' });
    expect(api.calls[0]?.require_auth).toBe(false);
  });

  it('listFiles parses response', async () => {
    const api = new FakeApi({
      'push/message': {
        list: [
          {
            data: {
              args: {
                _id: 'id1',
                name: 'book.epub',
                formats: ['epub'],
                storage: { epub: { oss: { size: '42' } } }
              }
            }
          }
        ]
      }
    });
    const client = new Send2BooxClient(appConfig({ token: 't' }), api as any);

    const files = await client.listFiles({ limit: 12, offset: 3 });
    expect(files).toEqual([{ file_id: 'id1', name: 'book.epub', size: 42 }]);
    expect((api.calls[0]?.params as any).where).toBe('{"limit": 12, "offset": 3, "parent": 0}');
  });

  it('deleteFiles requires non-empty ids', async () => {
    const api = new FakeApi({});
    const client = new Send2BooxClient(appConfig({ token: 't' }), api as any);
    await expect(client.deleteFiles([])).rejects.toThrow('file_ids must not be empty');
  });

  it('deleteFiles raises when result_code is non-zero', async () => {
    const api = new FakeApi(
      {
        'push/message/batchDelete': {
          result_code: 40101,
          message: 'DELETE_FAILED'
        }
      },
      't'
    );
    const client = new Send2BooxClient(appConfig({ token: 't' }), api as any);

    await expect(client.deleteFiles(['id-1'])).rejects.toBeInstanceOf(ApiError);
  });

  it('sendFile uploads and pushes', async () => {
    const uploaded: Record<string, unknown> = {};
    const api = new FakeApi(
      {
        'users/me': { data: { uid: 'u-1' } },
        'users/getDevice': {},
        'im/getSig': {},
        'config/buckets': {
          data: { 'onyx-cloud': { bucket: 'bucket-a', aliEndpoint: 'oss-cn.example.com' } }
        },
        'config/stss': {
          data: {
            AccessKeyId: 'ak',
            AccessKeySecret: 'sk',
            SecurityToken: 'st'
          }
        },
        'push/saveAndPush': {}
      },
      'token'
    );

    const dir = makeTempDir();
    const localFile = path.join(dir, 'demo.pdf');
    fs.writeFileSync(localFile, 'hello');

    const client = new Send2BooxClient(appConfig({ token: 'token' }), api as any, {
      uploadImpl: async (options) => {
        uploaded.file_path = options.filePath;
        uploaded.headers = { 'x-oss-security-token': options.securityToken };
        uploaded.remote_name = options.remoteName;
      }
    });
    await client.sendFile(localFile);

    expect(String(uploaded.file_path)).toContain('demo.pdf');
    expect((uploaded.headers as any)['x-oss-security-token']).toBe('st');
    expect(String(uploaded.remote_name)).toContain('u-1/push/');
    expect(String(uploaded.remote_name)).toMatch(/\.pdf$/);

    const saveCall = api.calls.find((call) => call.endpoint === 'push/saveAndPush');
    const data = (saveCall?.json_data as any).data;
    expect(data.name).toBe('demo.pdf');
    expect(data.resourceType).toBe('pdf');
  });

  it('sendFile raises for missing file', async () => {
    const api = new FakeApi({}, 'token');
    const client = new Send2BooxClient(appConfig({ token: 'token' }), api as any);
    await expect(client.sendFile('/non/existing/file.txt')).rejects.toThrow('File not found');
  });

  it('listLibraryBooks filters modeType and deduplicates', async () => {
    const api = new FakeApi(
      {
        'users/me': { data: { uid: 'u-1' } },
        'users/syncToken': {}
      },
      'token',
      {
        pathResponses: {
          'neocloud/_changes': [
            {
              results: [
                {
                  doc: {
                    modeType: 4,
                    uniqueId: 'book-1',
                    name: 'Alpha',
                    title: 'Alpha T',
                    authors: 'Author A',
                    status: 0
                  }
                },
                { doc: { modeType: 1, uniqueId: 'note-1', status: 0 } }
              ],
              last_seq: '10'
            },
            {
              results: [
                {
                  doc: {
                    modeType: 4,
                    uniqueId: 'book-1',
                    name: 'Alpha v2',
                    title: 'Alpha T2',
                    authors: 'Author A2',
                    status: 0
                  }
                },
                { doc: { modeType: 4, uniqueId: 'book-2', name: 'Beta', status: 0 } },
                { doc: { modeType: 4, uniqueId: 'book-3', name: 'Archived', status: 1 } }
              ],
              last_seq: '11'
            },
            { results: [], last_seq: '11' }
          ]
        }
      }
    );
    const client = new Send2BooxClient(appConfig({ token: 't', cloud: 'send2boox.com' }), api as any);

    const books = await client.listLibraryBooks();
    expect(books.map((item) => item.unique_id)).toEqual(['book-1', 'book-2']);
    expect(books[0]?.name).toBe('Alpha v2');
    expect(books[0]?.title).toBe('Alpha T2');
    expect(books[0]?.authors).toBe('Author A2');

    const pathCalls = api.calls.filter((call) => call.path_request);
    expect(pathCalls).toHaveLength(3);
    expect(pathCalls[0]?.params).toEqual({
      style: 'all_docs',
      filter: 'sync_gateway/bychannel',
      channels: 'u-1-READER_LIBRARY',
      since: '0',
      limit: 1000,
      include_docs: 'true'
    });
    expect(pathCalls[0]?.require_auth).toBe(true);
    expect((pathCalls[1]?.params as any).since).toBe('10');
    expect((pathCalls[2]?.params as any).since).toBe('11');
  });

  it('listLibraryBooks includeInactive keeps non-zero status', async () => {
    const api = new FakeApi(
      {
        'users/me': { data: { uid: 'u-1' } },
        'users/syncToken': {}
      },
      'token',
      {
        pathResponses: {
          'neocloud/_changes': [
            {
              results: [
                { doc: { modeType: 4, uniqueId: 'book-1', name: 'Alpha', status: 0 } },
                { doc: { modeType: 4, uniqueId: 'book-2', name: 'Archived', status: 1 } }
              ],
              last_seq: '1'
            },
            { results: [], last_seq: '1' }
          ]
        }
      }
    );
    const client = new Send2BooxClient(appConfig({ token: 't', cloud: 'send2boox.com' }), api as any);
    const books = await client.listLibraryBooks({ includeInactive: true });
    expect(books.map((item) => item.unique_id)).toEqual(['book-1', 'book-2']);
  });

  it('getBookReadInfo parses statistics payload', async () => {
    const api = new FakeApi(
      {
        'statistics/readInfoList': {
          result_code: 0,
          data: [
            {
              docId: 'book-1',
              totalTime: 17880019,
              avgTime: 576775,
              readingProgress: 67.09,
              name: 'demo.epub'
            }
          ],
          tokenExpiredAt: 1788072864
        }
      },
      'token'
    );
    const client = new Send2BooxClient(appConfig({ token: 'token' }), api as any);
    const info = await client.getBookReadInfo('book-1');
    expect(info).toEqual({
      doc_id: 'book-1',
      name: 'demo.epub',
      total_time: 17880019,
      avg_time: 576775,
      reading_progress: 67.09,
      token_expired_at: 1788072864
    });
    expect(api.calls[0]?.endpoint).toBe('statistics/readInfoList');
    expect(api.calls[0]?.json_data).toEqual({ docIds: ['book-1'] });
  });

  it('getBookReadInfo raises when data is empty', async () => {
    const api = new FakeApi(
      {
        'statistics/readInfoList': {
          result_code: 0,
          data: []
        }
      },
      'token'
    );
    const client = new Send2BooxClient(appConfig({ token: 'token' }), api as any);
    await expect(client.getBookReadInfo('book-1')).rejects.toBeInstanceOf(ResponseFormatError);
  });

  it('listBookAnnotations filters modeType document and status', async () => {
    const api = new FakeApi(
      {
        'users/me': { data: { uid: 'u-1' } },
        'users/syncToken': {}
      },
      'token',
      {
        pathResponses: {
          'neocloud/_changes': [
            {
              results: [
                {
                  doc: {
                    modeType: 1,
                    uniqueId: 'ann-1',
                    documentId: 'book-1',
                    quote: '批注 A',
                    pageNumber: 12,
                    status: 0
                  }
                },
                {
                  doc: {
                    modeType: 1,
                    uniqueId: 'ann-2',
                    documentId: 'book-1',
                    quote: '批注 B',
                    pageNumber: 13,
                    status: 1
                  }
                },
                {
                  doc: {
                    modeType: 1,
                    uniqueId: 'ann-3',
                    documentId: 'book-2',
                    quote: '其他书',
                    status: 0
                  }
                },
                { doc: { modeType: 2, uniqueId: 'bm-1', documentId: 'book-1', status: 0 } }
              ],
              last_seq: '1'
            },
            { results: [], last_seq: '1' }
          ]
        }
      }
    );
    const client = new Send2BooxClient(appConfig({ token: 't', cloud: 'send2boox.com' }), api as any);
    const annotations = await client.listBookAnnotations('book-1');
    expect(annotations.map((item) => item.unique_id)).toEqual(['ann-1']);
    expect(annotations[0]?.document_id).toBe('book-1');
    expect(annotations[0]?.quote).toBe('批注 A');
    expect(annotations[0]?.page_number).toBe(12);
    expect(annotations[0]?.status).toBe(0);
  });

  it('listBookBookmarks filters modeType document and status', async () => {
    const api = new FakeApi(
      {
        'users/me': { data: { uid: 'u-1' } },
        'users/syncToken': {}
      },
      'token',
      {
        pathResponses: {
          'neocloud/_changes': [
            {
              results: [
                {
                  doc: {
                    modeType: 2,
                    uniqueId: 'bm-1',
                    documentId: 'book-1',
                    quote: '书签 A',
                    pageNumber: 31,
                    position: '8888',
                    status: 0
                  }
                },
                {
                  doc: {
                    modeType: 2,
                    uniqueId: 'bm-2',
                    documentId: 'book-1',
                    quote: '书签 B',
                    pageNumber: 32,
                    status: 1
                  }
                },
                {
                  doc: {
                    modeType: 2,
                    uniqueId: 'bm-3',
                    documentId: 'book-2',
                    quote: '其他书签',
                    status: 0
                  }
                },
                { doc: { modeType: 1, uniqueId: 'ann-1', documentId: 'book-1', status: 0 } }
              ],
              last_seq: '1'
            },
            { results: [], last_seq: '1' }
          ]
        }
      }
    );
    const client = new Send2BooxClient(appConfig({ token: 't', cloud: 'send2boox.com' }), api as any);
    const bookmarks = await client.listBookBookmarks('book-1');
    expect(bookmarks.map((item) => item.unique_id)).toEqual(['bm-1']);
    expect(bookmarks[0]?.document_id).toBe('book-1');
    expect(bookmarks[0]?.quote).toBe('书签 A');
    expect(bookmarks[0]?.page_number).toBe(31);
    expect(bookmarks[0]?.position).toBe('8888');
    expect(bookmarks[0]?.status).toBe(0);
  });

  it('formatBookAnnotationsDump matches template', () => {
    const annotations: BookAnnotation[] = [
      {
        unique_id: 'ann-1',
        document_id: 'book-1',
        chapter: '01 Chapter',
        quote: 'Quote 1',
        note: 'Note 1\n\nSSH',
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
        document_id: 'book-1',
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

    const dump = formatBookAnnotationsDump({
      annotations,
      bookTitle: 'Alpha',
      bookAuthor: 'Author A'
    });

    expect(dump).toBe(
      'Reading Notes | <<Alpha>>Author A\n' +
        '01 Chapter\n' +
        '1970-01-01 00:00  |  Page No.: 13\n' +
        'Quote 1\n' +
        '【Annotation】Note 1\n' +
        '\n' +
        'SSH\n' +
        '-------------------\n' +
        '\n' +
        '1970-01-01 00:00  |  Page No.: 14\n' +
        'Quote 2\n' +
        '-------------------\n'
    );
  });
});
