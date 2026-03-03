import { describe, expect, it } from 'vitest';

import {
  type CapturedRequest,
  analyzeInterfaces,
  extractEndpointCandidates
} from '../src/playwrightDebug.js';

describe('playwrightDebug', () => {
  it('extractEndpointCandidates finds relative and absolute paths', () => {
    const source = `
      const a = "/api/1/users/me";
      const b = "https://eur.boox.com/api/1/push/message?offset=0";
      const c = "/v1/internal/debug";
      const d = "https://cdn.example.com/static/app.js";
    `;

    const endpoints = extractEndpointCandidates(source);

    expect(endpoints.has('/api/1/users/me')).toBe(true);
    expect(endpoints.has('https://eur.boox.com/api/1/push/message?offset=0')).toBe(true);
    expect(endpoints.has('/v1/internal/debug')).toBe(true);
    expect(endpoints.has('https://cdn.example.com/static/app.js')).toBe(false);
  });

  it('analyzeInterfaces merges network and script signals', () => {
    const network: CapturedRequest[] = [
      {
        url: 'https://eur.boox.com/api/1/users/me',
        method: 'GET',
        status: 200,
        resource_type: 'xhr'
      },
      {
        url: 'https://eur.boox.com/api/1/push/saveAndPush',
        method: 'POST',
        status: 200,
        resource_type: 'fetch'
      }
    ];
    const scriptTexts = [
      `
        const listApi = "/api/1/push/message";
        const deleteApi = "https://eur.boox.com/api/1/push/message/batchDelete";
        const style = "/static/main.css";
      `
    ];

    const insights = analyzeInterfaces(network, scriptTexts);
    const byEndpoint = Object.fromEntries(insights.map((item) => [item.endpoint, item]));

    expect(byEndpoint['/api/1/push/message']?.seen_in).toEqual(new Set(['script']));
    expect(byEndpoint['/api/1/users/me']?.methods).toEqual(new Set(['GET']));
    expect(byEndpoint['/api/1/users/me']?.seen_in).toEqual(new Set(['network']));
    expect(byEndpoint['/api/1/push/saveAndPush']?.methods).toEqual(new Set(['POST']));
    expect(byEndpoint['/api/1/push/saveAndPush']?.hosts).toEqual(new Set(['eur.boox.com']));
    expect(byEndpoint['/api/1/push/message/batchDelete']?.seen_in).toEqual(new Set(['script']));
  });
});
