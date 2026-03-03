import type { BooxApi } from './api.js';

export interface ReaderLibraryBook {
  uniqueId: string;
  title: string;
  authors: string;
  status: number | null;
  readingStatus: number | null;
}

export interface ReaderLibraryAnnotation {
  uniqueId: string;
  documentId: string;
  quote: string;
  note: string;
  chapter: string;
  pageNumber: number | null;
  position: string | null;
  startPosition: string | null;
  endPosition: string | null;
  color: number | null;
  shape: number | null;
  status: number | null;
  updatedAt: number | null;
}

export interface ReaderLibrarySnapshot {
  books: ReaderLibraryBook[];
  annotationsByBookId: Map<string, ReaderLibraryAnnotation[]>;
}

type JsonObject = Record<string, unknown>;

export async function fetchReaderLibrarySnapshot(options: {
  api: BooxApi;
  includeInactive?: boolean;
}): Promise<ReaderLibrarySnapshot> {
  const userPayload = await options.api.request('users/me');
  const userId = readNestedString(userPayload, ['data', 'uid']);
  if (!userId) {
    throw new Error('Unable to resolve Boox user id from users/me response.');
  }

  await options.api.request('users/syncToken');

  const docs = await fetchReaderLibraryDocs({
    api: options.api,
    userId
  });

  return parseReaderLibrarySnapshot(docs, {
    includeInactive: options.includeInactive ?? false
  });
}

export async function fetchReaderLibraryDocs(options: {
  api: BooxApi;
  userId: string;
  limit?: number;
}): Promise<JsonObject[]> {
  const limit = options.limit ?? 1000;
  const channel = `${options.userId}-READER_LIBRARY`;
  const docs: JsonObject[] = [];
  const seenSince = new Set<string>();
  let since = '0';

  while (true) {
    const payload = await options.api.requestPath('neocloud/_changes', {
      params: {
        style: 'all_docs',
        filter: 'sync_gateway/bychannel',
        channels: channel,
        since,
        limit,
        include_docs: 'true'
      }
    });

    const results = payload.results;
    if (!Array.isArray(results)) {
      throw new Error('Expected results array in neocloud/_changes response.');
    }

    for (const entry of results) {
      if (!isObject(entry)) {
        continue;
      }
      const doc = entry.doc;
      if (isObject(doc)) {
        docs.push(doc);
      }
    }

    if (results.length === 0) {
      break;
    }

    const lastSeq = payload.last_seq;
    if (lastSeq === null || lastSeq === undefined) {
      break;
    }

    if (typeof lastSeq !== 'string' && typeof lastSeq !== 'number') {
      break;
    }

    const nextSince = String(lastSeq);
    if (nextSince === since || seenSince.has(nextSince)) {
      break;
    }

    seenSince.add(since);
    since = nextSince;
  }

  return docs;
}

export function parseReaderLibrarySnapshot(
  docs: JsonObject[],
  options?: { includeInactive?: boolean }
): ReaderLibrarySnapshot {
  const includeInactive = options?.includeInactive ?? false;

  const booksById = new Map<string, ReaderLibraryBook>();
  const annotationsById = new Map<string, ReaderLibraryAnnotation>();

  for (const doc of docs) {
    const modeType = asInt(doc.modeType);

    if (modeType === 4) {
      const uniqueId = resolveUniqueId(doc);
      if (!uniqueId) {
        continue;
      }

      const status = asInt(doc.status);
      if (!includeInactive && status !== null && status !== 0) {
        continue;
      }

      booksById.set(uniqueId, {
        uniqueId,
        title: asString(doc.title) ?? asString(doc.name) ?? '',
        authors: asString(doc.authors) ?? '',
        status,
        readingStatus: asInt(doc.readingStatus)
      });
      continue;
    }

    if (modeType === 1) {
      const documentId = asString(doc.documentId)?.trim();
      if (!documentId) {
        continue;
      }

      const status = asInt(doc.status);
      if (!includeInactive && status !== null && status !== 0) {
        continue;
      }

      const uniqueId = resolveUniqueId(doc);
      if (!uniqueId) {
        continue;
      }

      const annotation: ReaderLibraryAnnotation = {
        uniqueId,
        documentId,
        quote: asString(doc.quote) ?? '',
        note: asString(doc.note) ?? '',
        chapter: asString(doc.chapter) ?? '',
        pageNumber: asInt(doc.pageNumber),
        position: asString(doc.position),
        startPosition: asString(doc.startPosition),
        endPosition: asString(doc.endPosition),
        color: asInt(doc.color),
        shape: asInt(doc.shape),
        status,
        updatedAt: asInt(doc.updatedAt)
      };

      const existing = annotationsById.get(uniqueId);
      if (!existing) {
        annotationsById.set(uniqueId, annotation);
      } else {
        const existingTs = normalizeTimestamp(existing.updatedAt);
        const nextTs = normalizeTimestamp(annotation.updatedAt);
        if (nextTs >= existingTs) {
          annotationsById.set(uniqueId, annotation);
        }
      }
    }
  }

  const annotationsByBookId = new Map<string, ReaderLibraryAnnotation[]>();
  for (const annotation of annotationsById.values()) {
    const annotations = annotationsByBookId.get(annotation.documentId) ?? [];
    annotations.push(annotation);
    annotationsByBookId.set(annotation.documentId, annotations);
  }

  for (const annotations of annotationsByBookId.values()) {
    annotations.sort((left, right) => {
      const leftTs = normalizeTimestamp(left.updatedAt);
      const rightTs = normalizeTimestamp(right.updatedAt);
      if (leftTs !== rightTs) {
        return leftTs - rightTs;
      }
      return left.uniqueId.localeCompare(right.uniqueId);
    });
  }

  const books = Array.from(booksById.values()).sort((left, right) => {
    const leftTitle = left.title || left.uniqueId;
    const rightTitle = right.title || right.uniqueId;
    return leftTitle.localeCompare(rightTitle);
  });

  return {
    books,
    annotationsByBookId
  };
}

function readNestedString(payload: JsonObject, path: string[]): string {
  let current: unknown = payload;

  for (const key of path) {
    if (!isObject(current)) {
      return '';
    }
    current = current[key];
  }

  if (typeof current !== 'string') {
    return '';
  }

  return current.trim();
}

function resolveUniqueId(doc: JsonObject): string {
  const uniqueId = asString(doc.uniqueId);
  if (uniqueId && uniqueId.trim()) {
    return uniqueId.trim();
  }

  const fallback = asString(doc._id);
  if (fallback && fallback.trim()) {
    return fallback.trim();
  }

  return '';
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number') {
    return String(value);
  }

  return null;
}

function asInt(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }

  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    const parsed = Number.parseInt(normalized, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function normalizeTimestamp(value: number | null): number {
  if (typeof value !== 'number') {
    return -1;
  }

  if (value > 10_000_000_000) {
    return Math.trunc(value / 1000);
  }

  return Math.trunc(value);
}
