import { describe, expect, it } from 'vitest';

import type { BooxApi } from '../src/api.js';
import { fetchReaderLibrarySnapshot, parseReaderLibrarySnapshot } from '../src/snapshot.js';

type JsonObject = Record<string, unknown>;

describe('snapshot parser', () => {
  it('parses books and deduplicated annotations', () => {
    const snapshot = parseReaderLibrarySnapshot([
      {
        modeType: 4,
        uniqueId: 'book-1',
        title: 'Book 1',
        authors: 'Author 1',
        status: 0
      },
      {
        modeType: 1,
        uniqueId: 'ann-1',
        documentId: 'book-1',
        quote: 'old',
        updatedAt: 100,
        status: 0
      },
      {
        modeType: 1,
        uniqueId: 'ann-1',
        documentId: 'book-1',
        quote: 'new',
        updatedAt: 200,
        status: 0
      },
      {
        modeType: 1,
        uniqueId: 'ann-2',
        documentId: 'book-1',
        quote: 'inactive',
        status: 2
      }
    ] as JsonObject[]);

    expect(snapshot.books).toHaveLength(1);
    const annotations = snapshot.annotationsByBookId.get('book-1') ?? [];
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.quote).toBe('new');
  });
});

describe('fetchReaderLibrarySnapshot', () => {
  it('loads user and paged _changes docs via api', async () => {
    const requestCalls: string[] = [];
    const requestPathCalls: string[] = [];

    const api = {
      request: async (endpoint: string) => {
        requestCalls.push(endpoint);
        if (endpoint === 'users/me') {
          return { data: { uid: 'u-1' } };
        }
        if (endpoint === 'users/syncToken') {
          return { success: true };
        }
        throw new Error(`Unexpected endpoint: ${endpoint}`);
      },
      requestPath: async (_path: string, options?: { params?: Record<string, unknown> }) => {
        const since = String(options?.params?.since ?? '0');
        requestPathCalls.push(since);
        if (since === '0') {
          return {
            results: [
              {
                doc: {
                  modeType: 4,
                  uniqueId: 'book-1',
                  title: 'Book 1',
                  status: 0
                }
              }
            ],
            last_seq: '1'
          };
        }
        return {
          results: [],
          last_seq: '1'
        };
      }
    } as unknown as BooxApi;

    const snapshot = await fetchReaderLibrarySnapshot({ api });

    expect(snapshot.books.map((item) => item.uniqueId)).toEqual(['book-1']);
    expect(requestCalls).toEqual(['users/me', 'users/syncToken']);
    expect(requestPathCalls).toEqual(['0', '1']);
  });
});
