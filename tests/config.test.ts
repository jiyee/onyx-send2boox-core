import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { type AppConfig, loadConfig, saveConfig } from '../src/config.js';
import { ConfigError } from '../src/exceptions.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'send2boox-config-'));
}

describe('config', () => {
  it('loadConfig success (json + env local)', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const envPath = path.join(dir, '.env.local');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        email: 'a@b.com',
        mobile: '13800138000',
        server: 'cloud.example'
      })
    );
    fs.writeFileSync(envPath, 'SEND2BOOX_TOKEN=tkn\n');

    const config = loadConfig(configPath);

    expect(config.email).toBe('a@b.com');
    expect(config.mobile).toBe('13800138000');
    expect(config.token).toBe('tkn');
    expect(config.cloud).toBe('cloud.example');
  });

  it('loadConfig missing file raises', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'missing.json');
    expect(() => loadConfig(configPath)).toThrow(ConfigError);
  });

  it('saveConfig roundtrip (json + env local)', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    const expected: AppConfig = {
      email: 'test@example.com',
      mobile: '13800138000',
      token: 'abc123',
      cloud: 'eur.boox.com'
    };

    saveConfig(expected, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded).toEqual(expected);

    const rawJson = fs.readFileSync(configPath, 'utf-8');
    expect(rawJson).toContain('"email": "test@example.com"');
    expect(rawJson).toContain('"mobile": "13800138000"');
    expect(rawJson).toContain('"server": "eur.boox.com"');
    expect(rawJson).not.toContain('abc123');

    const rawEnv = fs.readFileSync(path.join(dir, '.env.local'), 'utf-8');
    expect(rawEnv).toContain('SEND2BOOX_TOKEN=abc123');
  });

  it('loadConfig prefers server over cloud', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        email: 'a@b.com',
        server: 'us.boox.com',
        cloud: 'eur.boox.com'
      })
    );
    fs.writeFileSync(path.join(dir, '.env.local'), 'SEND2BOOX_TOKEN=tkn\n');

    const config = loadConfig(configPath);
    expect(config.cloud).toBe('us.boox.com');
  });

  it('saveConfig writes server in config.json only', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    saveConfig(
      { email: 'a@b.com', mobile: '', token: 'tkn', cloud: 'us.boox.com' } as AppConfig,
      configPath
    );

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, string>;
    expect(raw.server).toBe('us.boox.com');
    expect(raw.cloud).toBeUndefined();
    expect(raw.token).toBeUndefined();
  });

  it('loadConfig reads mobile', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mobile: '13800138000',
        server: 'eur.boox.com'
      })
    );
    fs.writeFileSync(path.join(dir, '.env.local'), 'SEND2BOOX_TOKEN=tkn\n');

    const config = loadConfig(configPath);
    expect(config.mobile).toBe('13800138000');
    expect(config.token).toBe('tkn');
  });

  it('saveConfig writes token to .env.local', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    saveConfig(
      { email: 'a@b.com', mobile: '13800138000', token: 'tkn', cloud: 'us.boox.com' } as AppConfig,
      configPath
    );

    const raw = fs.readFileSync(path.join(dir, '.env.local'), 'utf-8');
    expect(raw).toContain('SEND2BOOX_TOKEN=tkn');
  });

  it('loadConfig invalid json raises', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, '{"email":"a@b.com",');

    expect(() => loadConfig(configPath)).toThrow(ConfigError);
  });
});
