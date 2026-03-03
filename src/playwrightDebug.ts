import { Send2BooxError } from './exceptions.js';

const ABSOLUTE_ENDPOINT_RE =
  /https?:\/\/[^\s"'`<>]*(?:\/api\/|\/v\d+\/|\/graphql|\/rest)[^\s"'`<>]*/gi;
const RELATIVE_ENDPOINT_RE = /\/(?:api\/|v\d+\/|graphql|rest)[^\s"'`<>]*/gi;
const TEXTUAL_CONTENT_MARKERS = [
  'application/json',
  'application/javascript',
  'application/x-javascript',
  'application/graphql',
  'application/xml',
  'application/x-www-form-urlencoded',
  'text/'
];
const STATIC_ASSET_SUFFIXES = [
  '.css',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.js',
  '.map',
  '.png',
  '.svg',
  '.woff',
  '.woff2'
];

export interface CapturedRequest {
  url: string;
  method: string;
  status: number | null;
  resource_type: string;
  content_type?: string | null;
  request_body?: string | null;
  response_body?: string | null;
}

export class InterfaceInsight {
  endpoint: string;
  methods: Set<string>;
  hosts: Set<string>;
  seen_in: Set<string>;
  status_codes: Set<number>;
  samples: string[];

  constructor(endpoint: string) {
    this.endpoint = endpoint;
    this.methods = new Set<string>();
    this.hosts = new Set<string>();
    this.seen_in = new Set<string>();
    this.status_codes = new Set<number>();
    this.samples = [];
  }

  toDict(): Record<string, unknown> {
    return {
      endpoint: this.endpoint,
      methods: [...this.methods].sort(),
      hosts: [...this.hosts].sort(),
      seen_in: [...this.seen_in].sort(),
      status_codes: [...this.status_codes].sort((left, right) => left - right),
      samples: this.samples
    };
  }
}

export class PlaywrightDebugReport {
  page_url: string;
  final_url: string;
  page_title: string;
  network_requests: number;
  script_sources: number;
  interfaces: InterfaceInsight[];
  captured_requests: CapturedRequest[];

  constructor(options: {
    page_url: string;
    final_url: string;
    page_title: string;
    network_requests: number;
    script_sources: number;
    interfaces: InterfaceInsight[];
    captured_requests: CapturedRequest[];
  }) {
    this.page_url = options.page_url;
    this.final_url = options.final_url;
    this.page_title = options.page_title;
    this.network_requests = options.network_requests;
    this.script_sources = options.script_sources;
    this.interfaces = options.interfaces;
    this.captured_requests = options.captured_requests;
  }

  toDict(): Record<string, unknown> {
    return {
      page_url: this.page_url,
      final_url: this.final_url,
      page_title: this.page_title,
      network_requests: this.network_requests,
      script_sources: this.script_sources,
      interfaces: this.interfaces.map((item) => item.toDict()),
      captured_requests: this.captured_requests.map((item) => ({
        url: item.url,
        method: item.method,
        status: item.status,
        resource_type: item.resource_type,
        content_type: item.content_type ?? null,
        request_body: item.request_body ?? null,
        response_body: item.response_body ?? null
      }))
    };
  }

  toJson(options?: { indent?: number }): string {
    return JSON.stringify(this.toDict(), null, options?.indent ?? 2);
  }
}

export function extractEndpointCandidates(sourceText: string): Set<string> {
  const candidates = new Set<string>();
  for (const pattern of [ABSOLUTE_ENDPOINT_RE, RELATIVE_ENDPOINT_RE]) {
    for (const match of sourceText.matchAll(pattern)) {
      const cleaned = cleanCandidate(match[0] ?? '');
      if (!cleaned) {
        continue;
      }
      if (isStaticAsset(cleaned)) {
        continue;
      }
      candidates.add(cleaned);
    }
  }
  return candidates;
}

export function analyzeInterfaces(
  networkRequests: CapturedRequest[],
  scriptSources: string[]
): InterfaceInsight[] {
  const insights = new Map<string, InterfaceInsight>();

  for (const request of networkRequests) {
    const endpoint = normalizeToEndpoint(request.url);
    if (!endpoint) {
      continue;
    }
    const item = insights.get(endpoint) ?? new InterfaceInsight(endpoint);
    item.seen_in.add('network');
    item.methods.add(request.method.toUpperCase());
    const host = safeNetloc(request.url);
    if (host) {
      item.hosts.add(host);
    }
    if (typeof request.status === 'number') {
      item.status_codes.add(request.status);
    }
    if (request.request_body) {
      item.samples.push(`request: ${request.request_body}`);
    }
    if (request.response_body) {
      item.samples.push(`response: ${request.response_body}`);
    }
    insights.set(endpoint, item);
  }

  for (const sourceText of scriptSources) {
    for (const candidate of extractEndpointCandidates(sourceText)) {
      const endpoint = normalizeToEndpoint(candidate);
      if (!endpoint) {
        continue;
      }
      const item = insights.get(endpoint) ?? new InterfaceInsight(endpoint);
      item.seen_in.add('script');
      const host = safeNetloc(candidate);
      if (host) {
        item.hosts.add(host);
      }
      insights.set(endpoint, item);
    }
  }

  for (const item of insights.values()) {
    if (item.samples.length > 3) {
      item.samples = item.samples.slice(0, 3);
    }
  }

  return [...insights.values()].sort((left, right) => left.endpoint.localeCompare(right.endpoint));
}

export async function runPlaywrightDebug(options: {
  url: string;
  headless?: boolean;
  timeoutMs?: number;
  settleMs?: number;
  maxRequests?: number;
  maxBodyChars?: number;
}): Promise<PlaywrightDebugReport> {
  let playwrightModule: any;
  try {
    playwrightModule = await import('playwright');
  } catch (error) {
    throw new Send2BooxError(
      "Playwright is not installed. Install with `npm install playwright` and run `npx playwright install chromium`."
    );
  }

  const headless = options.headless ?? true;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const settleMs = options.settleMs ?? 2_000;
  const maxRequests = options.maxRequests ?? 250;
  const maxBodyChars = options.maxBodyChars ?? 1_200;

  const capturedRequests: CapturedRequest[] = [];
  const scriptSources: string[] = [];
  let pageTitle = '';
  let finalUrl = options.url;

  const onResponse = async (response: any): Promise<void> => {
    if (capturedRequests.length >= maxRequests) {
      return;
    }
    const request = response.request();
    const contentType = response.headers()['content-type'];
    const textBody = await readTextResponse({
      response,
      contentType,
      maxChars: maxBodyChars
    });
    const postData = trimText(request.postData?.() ?? null, maxBodyChars);

    capturedRequests.push({
      url: request.url(),
      method: request.method?.() ?? 'GET',
      status: response.status?.() ?? null,
      resource_type: request.resourceType?.() ?? '',
      content_type: contentType ?? null,
      request_body: postData,
      response_body: textBody
    });

    if ((request.resourceType?.() ?? '') === 'script' && textBody) {
      scriptSources.push(textBody);
    }
  };

  try {
    const browser = await playwrightModule.chromium.launch({ headless });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    page.on('response', onResponse);

    await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    if (settleMs > 0) {
      await page.waitForTimeout(settleMs);
    }

    finalUrl = page.url();
    pageTitle = await page.title();
    scriptSources.push(await page.content());
    scriptSources.push(...(await collectInlineScriptTexts({ page, maxBodyChars })));

    await context.close();
    await browser.close();
  } catch (error) {
    throw new Send2BooxError(`Playwright debugging failed: ${String(error)}`);
  }

  const interfaces = analyzeInterfaces(capturedRequests, scriptSources);
  return new PlaywrightDebugReport({
    page_url: options.url,
    final_url: finalUrl,
    page_title: pageTitle,
    network_requests: capturedRequests.length,
    script_sources: scriptSources.length,
    interfaces,
    captured_requests: capturedRequests
  });
}

async function collectInlineScriptTexts(options: {
  page: any;
  maxBodyChars: number;
}): Promise<string[]> {
  let rawScripts: unknown;
  try {
    rawScripts = await options.page.$$eval('script:not([src])', (elements: any[]) =>
      elements.map((element) => element.textContent || '')
    );
  } catch {
    return [];
  }

  if (!Array.isArray(rawScripts)) {
    return [];
  }
  const trimmedScripts: string[] = [];
  for (const script of rawScripts) {
    if (typeof script !== 'string') {
      continue;
    }
    const trimmed = trimText(script, options.maxBodyChars);
    if (trimmed !== null) {
      trimmedScripts.push(trimmed);
    }
  }
  return trimmedScripts;
}

async function readTextResponse(options: {
  response: any;
  contentType?: string | null;
  maxChars: number;
}): Promise<string | null> {
  if (!isTextualContentType(options.contentType ?? null)) {
    return null;
  }
  try {
    const text = await options.response.text();
    return trimText(text, options.maxChars);
  } catch {
    return null;
  }
}

function trimText(value: string | null, maxChars: number): string | null {
  if (value === null) {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}...<truncated>`;
}

function normalizeToEndpoint(candidate: string): string | null {
  let path: string;
  try {
    const parsed = new URL(candidate);
    path = parsed.pathname || '/';
  } catch {
    if (!candidate.startsWith('/')) {
      return null;
    }
    path = candidate.split('?')[0]?.split('#')[0] ?? '';
  }
  path = path.replace(/\/{2,}/g, '/');
  if (path !== '/' && path.endsWith('/')) {
    path = path.slice(0, -1);
  }
  if (isStaticAsset(path)) {
    return null;
  }
  if (!looksLikeEndpoint(path)) {
    return null;
  }
  return path;
}

function looksLikeEndpoint(pathValue: string): boolean {
  const lowered = pathValue.toLowerCase();
  return (
    lowered.startsWith('/api/') ||
    /^\/v\d+\//.test(lowered) ||
    lowered.startsWith('/graphql') ||
    lowered.startsWith('/rest')
  );
}

function isStaticAsset(candidate: string): boolean {
  let pathname = candidate.toLowerCase();
  try {
    pathname = new URL(candidate).pathname.toLowerCase();
  } catch {
    // keep original candidate
  }
  return STATIC_ASSET_SUFFIXES.some((suffix) => pathname.endsWith(suffix));
}

function isTextualContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }
  const lowered = contentType.toLowerCase();
  return TEXTUAL_CONTENT_MARKERS.some((marker) => lowered.includes(marker));
}

function cleanCandidate(candidate: string): string {
  const cleaned = candidate.trim().replace(/[.,;)\]}>]+$/g, '');
  return cleaned;
}

function safeNetloc(candidate: string): string {
  try {
    return new URL(candidate).host.trim();
  } catch {
    return '';
  }
}

