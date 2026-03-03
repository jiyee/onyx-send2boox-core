import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { BooxApi } from './api.js';
import type { AppConfig } from './config.js';
import {
  ApiError,
  AuthenticationError,
  ResponseFormatError,
  UploadError
} from './exceptions.js';

type JsonObject = Record<string, unknown>;

export interface RemoteFile {
  file_id: string;
  name: string;
  size: number;
}

export interface LibraryBook {
  unique_id: string;
  name: string;
  title: string;
  authors: string;
  status: number | null;
  reading_status: number | null;
}

export interface BookReadInfo {
  doc_id: string;
  name: string;
  total_time: number | null;
  avg_time: number | null;
  reading_progress: number | null;
  token_expired_at: number | null;
}

export interface BookAnnotation {
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

export interface BookBookmark {
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

interface HasUniqueIdAndUpdatedAt {
  unique_id: string;
  updated_at: number | null;
}

export class Send2BooxClient {
  config: AppConfig;
  api: BooxApi;
  user_id: string | null = null;
  bucket_name: string | null = null;
  endpoint: string | null = null;
  uploadImpl: typeof uploadWithAliOss;

  constructor(
    config: AppConfig,
    api?: BooxApi,
    options?: { uploadImpl?: typeof uploadWithAliOss }
  ) {
    this.config = config;
    this.api = api ?? new BooxApi({ cloud: config.cloud, token: config.token });
    this.uploadImpl = options?.uploadImpl ?? uploadWithAliOss;
  }

  setToken(token: string): void {
    this.config.token = token;
    this.api.setToken(token);
  }

  private requireToken(): void {
    if (!this.api.token.trim()) {
      throw new AuthenticationError(
        'Token is not configured. Run `auth login` and `auth code` first.'
      );
    }
  }

  async authenticateWithEmailCode(account: string, code: string): Promise<string> {
    const payload = await this.api.request('users/signupByPhoneOrEmail', {
      jsonData: { mobi: account, code },
      requireAuth: false
    });
    const token = extractNested(payload, ['data', 'token'], 'string');
    if (!token) {
      throw new AuthenticationError('Token is missing in login response.', { payload });
    }
    this.setToken(token);
    return token;
  }

  async requestVerificationCode(account: string): Promise<void> {
    await this.api.request('users/sendMobileCode', {
      jsonData: { mobi: account },
      requireAuth: false
    });
  }

  async initialize(): Promise<void> {
    this.requireToken();
    if (this.user_id && this.bucket_name && this.endpoint) {
      return;
    }

    const userPayload = await this.api.request('users/me');
    this.user_id = extractNested(userPayload, ['data', 'uid'], 'string');

    await this.api.request('users/getDevice');
    await this.api.request('im/getSig', { params: { user: this.user_id } });

    const bucketsPayload = await this.api.request('config/buckets');
    const onyxCloud = extractNested(bucketsPayload, ['data', 'onyx-cloud'], 'object');
    this.bucket_name = extractNested(onyxCloud, ['bucket'], 'string');
    this.endpoint = extractNested(onyxCloud, ['aliEndpoint'], 'string');
  }

  async listFiles(options?: { limit?: number; offset?: number }): Promise<RemoteFile[]> {
    this.requireToken();
    const limit = options?.limit ?? 24;
    const offset = options?.offset ?? 0;
    const where = `{"limit": ${limit}, "offset": ${offset}, "parent": 0}`;
    const payload = await this.api.request('push/message', { params: { where } });
    const entries = payload.list;
    if (!Array.isArray(entries)) {
      throw new ResponseFormatError('Expected list field in push/message response.', { payload });
    }

    const result: RemoteFile[] = [];
    for (const entry of entries) {
      try {
        const data = asObject(entry).data;
        const args = asObject(data).args;
        const argsObj = asObject(args);
        const formats = asArray(argsObj.formats);
        const firstFormat = String(formats[0]);
        const storage = asObject(argsObj.storage);
        const size = Number(asObject(asObject(storage[firstFormat]).oss).size);
        result.push({
          file_id: String(argsObj._id),
          name: String(argsObj.name),
          size: Number.isFinite(size) ? size : 0
        });
      } catch (error) {
        throw new ResponseFormatError('Unexpected file entry in push/message response.', {
          payload: entry
        });
      }
    }
    return result;
  }

  async deleteFiles(fileIds: string[]): Promise<void> {
    this.requireToken();
    if (fileIds.length === 0) {
      throw new Error('file_ids must not be empty');
    }
    const payload = await this.api.request('push/message/batchDelete', {
      jsonData: { ids: fileIds }
    });
    const resultCode = asInt(payload.result_code);
    if (resultCode !== null && resultCode !== 0) {
      const message = asStr(payload.message) ?? 'UNKNOWN';
      throw new ApiError(`Delete request failed with result_code ${resultCode}: ${message}`, {
        payload
      });
    }
  }

  async listLibraryBooks(options?: { includeInactive?: boolean }): Promise<LibraryBook[]> {
    const includeInactive = options?.includeInactive ?? false;
    const docs = await this.listReaderLibraryDocs();
    const booksById = new Map<string, LibraryBook>();

    for (const doc of docs) {
      const modeType = asInt(doc.modeType);
      if (modeType !== 4) {
        continue;
      }
      const uniqueId = doc.uniqueId;
      if (typeof uniqueId !== 'string' || !uniqueId.trim()) {
        continue;
      }
      const status = asInt(doc.status);
      if (!includeInactive && status !== null && status !== 0) {
        continue;
      }
      booksById.set(uniqueId, {
        unique_id: uniqueId,
        name: typeof doc.name === 'string' ? doc.name : '',
        title: typeof doc.title === 'string' ? doc.title : '',
        authors: typeof doc.authors === 'string' ? doc.authors : '',
        status,
        reading_status: asInt(doc.readingStatus)
      });
    }
    return Array.from(booksById.values());
  }

  async listBookAnnotations(
    bookId: string,
    options?: { includeInactive?: boolean }
  ): Promise<BookAnnotation[]> {
    const includeInactive = options?.includeInactive ?? false;
    const normalizedBookId = bookId.trim();
    if (!normalizedBookId) {
      throw new Error('book_id must not be empty');
    }

    const docs = await this.listReaderLibraryDocs();
    const annotationsById = new Map<string, BookAnnotation>();

    for (const doc of docs) {
      if (asInt(doc.modeType) !== 1) {
        continue;
      }
      if (typeof doc.documentId !== 'string' || doc.documentId.trim() !== normalizedBookId) {
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
      const annotation: BookAnnotation = {
        unique_id: uniqueId,
        document_id: doc.documentId.trim(),
        quote: asStr(doc.quote) ?? '',
        note: asStr(doc.note) ?? '',
        chapter: asStr(doc.chapter) ?? '',
        page_number: asInt(doc.pageNumber),
        position: asStr(doc.position),
        start_position: asStr(doc.startPosition),
        end_position: asStr(doc.endPosition),
        color: asInt(doc.color),
        shape: asInt(doc.shape),
        status,
        updated_at: asInt(doc.updatedAt)
      };
      keepLatestByUpdatedAt({
        itemById: annotationsById,
        item: annotation,
        updatedAt: annotation.updated_at
      });
    }

    return Array.from(annotationsById.values()).sort((left, right) => {
      const leftKey = `${left.updated_at ?? 0}:${left.unique_id}`;
      const rightKey = `${right.updated_at ?? 0}:${right.unique_id}`;
      return leftKey.localeCompare(rightKey);
    });
  }

  async listBookBookmarks(
    bookId: string,
    options?: { includeInactive?: boolean }
  ): Promise<BookBookmark[]> {
    const includeInactive = options?.includeInactive ?? false;
    const normalizedBookId = bookId.trim();
    if (!normalizedBookId) {
      throw new Error('book_id must not be empty');
    }

    const docs = await this.listReaderLibraryDocs();
    const bookmarksById = new Map<string, BookBookmark>();

    for (const doc of docs) {
      if (asInt(doc.modeType) !== 2) {
        continue;
      }
      if (typeof doc.documentId !== 'string' || doc.documentId.trim() !== normalizedBookId) {
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
      const bookmark: BookBookmark = {
        unique_id: uniqueId,
        document_id: doc.documentId.trim(),
        quote: asStr(doc.quote) ?? '',
        title: asStr(doc.title) ?? '',
        page_number: asInt(doc.pageNumber),
        position: asStr(doc.position),
        xpath: asStr(doc.xpath),
        position_int: asInt(doc.positionInt),
        status,
        updated_at: asInt(doc.updatedAt)
      };
      keepLatestByUpdatedAt({
        itemById: bookmarksById,
        item: bookmark,
        updatedAt: bookmark.updated_at
      });
    }

    return Array.from(bookmarksById.values()).sort((left, right) => {
      const leftKey = `${left.updated_at ?? 0}:${left.unique_id}`;
      const rightKey = `${right.updated_at ?? 0}:${right.unique_id}`;
      return leftKey.localeCompare(rightKey);
    });
  }

  async getBookReadInfo(bookId: string): Promise<BookReadInfo> {
    this.requireToken();
    const normalizedBookId = bookId.trim();
    if (!normalizedBookId) {
      throw new Error('book_id must not be empty');
    }

    const payload = await this.api.request('statistics/readInfoList', {
      jsonData: { docIds: [normalizedBookId] }
    });
    const data = payload.data;
    if (!Array.isArray(data) || data.length === 0) {
      throw new ResponseFormatError(
        'Expected non-empty list field in statistics/readInfoList response.',
        { payload }
      );
    }
    const first = data[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) {
      throw new ResponseFormatError(
        'Expected object entry in statistics/readInfoList data list.',
        { payload }
      );
    }
    const firstObj = first as JsonObject;
    const responseDocId =
      typeof firstObj.docId === 'string' && firstObj.docId.trim()
        ? firstObj.docId.trim()
        : normalizedBookId;
    const name = typeof firstObj.name === 'string' ? firstObj.name : '';
    return {
      doc_id: responseDocId,
      name,
      total_time: asInt(firstObj.totalTime),
      avg_time: asInt(firstObj.avgTime),
      reading_progress: asFloat(firstObj.readingProgress),
      token_expired_at: asInt(payload.tokenExpiredAt)
    };
  }

  private async listReaderLibraryDocs(): Promise<JsonObject[]> {
    this.requireToken();
    const userPayload = await this.api.request('users/me');
    const userId = extractNested(userPayload, ['data', 'uid'], 'string');
    await this.api.request('users/syncToken');

    let since = '0';
    const visitedSince = new Set<string>();
    const channel = `${userId}-READER_LIBRARY`;
    const docs: JsonObject[] = [];

    while (true) {
      const changesPayload = await this.api.requestPath('neocloud/_changes', {
        params: {
          style: 'all_docs',
          filter: 'sync_gateway/bychannel',
          channels: channel,
          since,
          limit: 1000,
          include_docs: 'true'
        },
        requireAuth: true
      });

      const results = changesPayload.results;
      if (!Array.isArray(results)) {
        throw new ResponseFormatError('Expected list field in neocloud/_changes response.', {
          payload: changesPayload
        });
      }

      for (const entry of results) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          continue;
        }
        const doc = (entry as JsonObject).doc;
        if (doc && typeof doc === 'object' && !Array.isArray(doc)) {
          docs.push(doc as JsonObject);
        }
      }

      if (results.length === 0) {
        break;
      }
      const lastSeq = changesPayload.last_seq;
      if (lastSeq === null || lastSeq === undefined) {
        break;
      }
      const nextSince = String(lastSeq);
      if (nextSince === since || visitedSince.has(nextSince)) {
        break;
      }
      visitedSince.add(since);
      since = nextSince;
    }

    return docs;
  }

  async sendFile(filePathInput: string): Promise<void> {
    const filePath = path.resolve(filePathInput);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePathInput}`);
    }

    await this.initialize();
    if (!this.user_id || !this.bucket_name || !this.endpoint) {
      throw new ResponseFormatError('Client is not fully initialized.');
    }

    const stssPayload = await this.api.request('config/stss');
    const accessKeyId = extractNested(stssPayload, ['data', 'AccessKeyId'], 'string');
    const accessKeySecret = extractNested(stssPayload, ['data', 'AccessKeySecret'], 'string');
    const securityToken = extractNested(stssPayload, ['data', 'SecurityToken'], 'string');

    const suffix = path.extname(filePath).replace(/^\./, '');
    let remoteName = `${this.user_id}/push/${randomUUID()}`;
    if (suffix) {
      remoteName = `${remoteName}.${suffix}`;
    }

    try {
      await this.uploadImpl({
        accessKeyId,
        accessKeySecret,
        securityToken,
        endpoint: this.endpoint,
        bucketName: this.bucket_name,
        remoteName,
        filePath
      });
    } catch (error) {
      throw new UploadError(`Failed to upload file ${filePath}: ${String(error)}`);
    }

    const filename = path.basename(filePath);
    const resourceType = suffix ? suffix.toLowerCase() : 'bin';
    await this.api.request('push/saveAndPush', {
      jsonData: {
        data: {
          bucket: this.bucket_name,
          name: filename,
          parent: null,
          resourceDisplayName: filename,
          resourceKey: remoteName,
          resourceType,
          title: filename
        }
      }
    });
  }
}

export async function uploadWithAliOss(options: {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  endpoint: string;
  bucketName: string;
  remoteName: string;
  filePath: string;
}): Promise<void> {
  const module = (await import('ali-oss')) as unknown as {
    default?: new (options: Record<string, unknown>) => {
      multipartUpload(
        name: string,
        filePath: string,
        options?: { headers?: Record<string, string> }
      ): Promise<unknown>;
    };
  };
  const OSS = module.default;
  if (!OSS) {
    throw new Error('ali-oss default export missing');
  }
  const client = new OSS({
    accessKeyId: options.accessKeyId,
    accessKeySecret: options.accessKeySecret,
    stsToken: options.securityToken,
    endpoint: options.endpoint,
    bucket: options.bucketName
  });
  await client.multipartUpload(options.remoteName, options.filePath, {
    headers: {
      'x-oss-security-token': options.securityToken
    }
  });
}

export function formatFilesTable(files: RemoteFile[]): string {
  const lines = [
    '       File ID           |    Size    | Name',
    '-------------------------|------------|-------------------------------------------------------'
  ];
  for (const item of files) {
    const sizeText = item.size.toLocaleString().padStart(10, ' ');
    lines.push(`${item.file_id} | ${sizeText} | ${item.name}`);
  }
  return lines.join('\n');
}

export function formatLibraryBooksTable(books: LibraryBook[]): string {
  const lines = [
    '      Book ID            | Name',
    '-------------------------|-------------------------------------------------------'
  ];
  for (const item of books) {
    lines.push(`${item.unique_id} | ${item.name}`);
  }
  return lines.join('\n');
}

export function formatBookAnnotationsDump(options: {
  annotations: BookAnnotation[];
  bookTitle: string;
  bookAuthor?: string;
}): string {
  const normalizedTitle = options.bookTitle.trim() || 'Unknown Book';
  const normalizedAuthor = (options.bookAuthor ?? '').trim();
  const nbsp = '\u00a0';
  const lines = [`Reading Notes${nbsp}|${nbsp}<<${normalizedTitle}>>${normalizedAuthor}`];

  const sortedAnnotations = [...options.annotations].sort((left, right) => {
    const leftKey = annotationDumpSortKey(left);
    const rightKey = annotationDumpSortKey(right);
    if (leftKey[0] !== rightKey[0]) {
      return leftKey[0] - rightKey[0];
    }
    if (leftKey[1] !== rightKey[1]) {
      return leftKey[1] - rightKey[1];
    }
    if (leftKey[2] !== rightKey[2]) {
      return leftKey[2] - rightKey[2];
    }
    return leftKey[3].localeCompare(rightKey[3]);
  });

  for (const item of sortedAnnotations) {
    appendMultilineText(lines, item.chapter);
    lines.push(
      `${formatAnnotationDumpTimestamp(item.updated_at)}${nbsp}${nbsp}|${nbsp}${nbsp}Page No.: ${formatDumpPage(item.page_number)}`
    );
    appendMultilineText(lines, item.quote);
    appendAnnotationNote(lines, item.note);
    lines.push('-------------------');
  }

  return `${lines.join('\n')}\n`;
}

function extractNested(
  payload: JsonObject,
  pathKeys: string[],
  expectedType: 'string' | 'object'
): any {
  let current: unknown = payload;
  for (const key of pathKeys) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      throw new ResponseFormatError(`Missing key path: ${pathKeys.join('/')}`, { payload });
    }
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      throw new ResponseFormatError(`Missing key path: ${pathKeys.join('/')}`, { payload });
    }
    current = (current as JsonObject)[key];
  }

  if (expectedType === 'string') {
    if (typeof current !== 'string') {
      throw new ResponseFormatError(`Expected ${pathKeys.join('/')} to be string.`, { payload });
    }
    return current;
  }

  if (current === null || typeof current !== 'object' || Array.isArray(current)) {
    throw new ResponseFormatError(`Expected ${pathKeys.join('/')} to be object.`, { payload });
  }
  return current as JsonObject;
}

function asObject(value: unknown): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected object');
  }
  return value as JsonObject;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected array');
  }
  return value;
}

function asInt(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  if (typeof value === 'string') {
    const clean = value.trim();
    if (!clean) {
      return null;
    }
    const parsed = Number.parseInt(clean, 10);
    if (Number.isNaN(parsed)) {
      return null;
    }
    return parsed;
  }
  return null;
}

function asFloat(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'boolean') {
    return value ? 1 : 0;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'string') {
    const clean = value.trim();
    if (!clean) {
      return null;
    }
    const parsed = Number.parseFloat(clean);
    if (Number.isNaN(parsed)) {
      return null;
    }
    return parsed;
  }
  return null;
}

function asStr(value: unknown): string | null {
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

function resolveUniqueId(doc: JsonObject): string {
  const uniqueId = doc.uniqueId;
  if (typeof uniqueId === 'string' && uniqueId.trim()) {
    return uniqueId.trim();
  }
  const docId = doc._id;
  if (typeof docId === 'string' && docId.trim()) {
    return docId.trim();
  }
  return '';
}

function keepLatestByUpdatedAt<T extends HasUniqueIdAndUpdatedAt>(options: {
  itemById: Map<string, T>;
  item: T;
  updatedAt: number | null;
}): void {
  const existing = options.itemById.get(options.item.unique_id);
  if (!existing) {
    options.itemById.set(options.item.unique_id, options.item);
    return;
  }
  const existingTs = typeof existing.updated_at === 'number' ? existing.updated_at : -1;
  const itemTs = typeof options.updatedAt === 'number' ? options.updatedAt : -1;
  if (itemTs >= existingTs) {
    options.itemById.set(options.item.unique_id, options.item);
  }
}

function annotationDumpSortKey(item: BookAnnotation): [number, number, number, string] {
  const page = typeof item.page_number === 'number' ? item.page_number : 2 ** 31 - 1;
  const position = resolveAnnotationOrderPosition(item);
  const updatedAt = normalizeDumpTimestampSeconds(item.updated_at) ?? 0;
  return [page, position, updatedAt, item.unique_id];
}

function resolveAnnotationOrderPosition(item: BookAnnotation): number {
  for (const candidate of [item.start_position, item.position, item.end_position]) {
    const parsed = extractFirstInteger(candidate);
    if (parsed !== null) {
      return parsed;
    }
  }
  return 2 ** 31 - 1;
}

function extractFirstInteger(value: string | null): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = value.match(/-?\d+/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[0], 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function normalizeDumpTimestampSeconds(value: number | null): number | null {
  if (typeof value !== 'number') {
    return null;
  }
  if (value > 10_000_000_000) {
    return Math.trunc(value / 1000);
  }
  return Math.trunc(value);
}

function formatAnnotationDumpTimestamp(value: number | null): string {
  const seconds = normalizeDumpTimestampSeconds(value);
  if (seconds === null) {
    return '1970-01-01 00:00';
  }
  const date = new Date(seconds * 1000);
  if (Number.isNaN(date.getTime())) {
    return '1970-01-01 00:00';
  }

  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hour = `${date.getHours()}`.padStart(2, '0');
  const minute = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function formatDumpPage(value: number | null): string {
  if (typeof value === 'number') {
    return String(value + 1);
  }
  return '';
}

function appendMultilineText(lines: string[], value: string): void {
  for (const line of value.split('\n')) {
    lines.push(line.replace(/\r$/, ''));
  }
}

function appendAnnotationNote(lines: string[], value: string): void {
  const noteLines = value.split('\n').map((line) => line.replace(/\r$/, ''));
  if (noteLines.length === 0 || (noteLines.length === 1 && noteLines[0] === '')) {
    return;
  }
  lines.push(`【Annotation】${noteLines[0]}`);
  lines.push(...noteLines.slice(1));
}
