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
  it('loadConfig success', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, 'email = "a@b.com"\ntoken = "tkn"\ncloud = "cloud.example"\n');

    const config = loadConfig(configPath);

    expect(config.email).toBe('a@b.com');
    expect(config.token).toBe('tkn');
    expect(config.cloud).toBe('cloud.example');
  });

  it('loadConfig missing file raises', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'missing.toml');
    expect(() => loadConfig(configPath)).toThrow(ConfigError);
  });

  it('saveConfig roundtrip', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.toml');
    const expected: AppConfig = {
      email: 'test@example.com',
      mobile: '',
      token: 'abc123',
      cloud: 'eur.boox.com'
    };

    saveConfig(expected, configPath);
    const loaded = loadConfig(configPath);
    expect(loaded).toEqual(expected);
  });

  it('loadConfig prefers server over cloud', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(
      configPath,
      'email = "a@b.com"\ntoken = "tkn"\nserver = "us.boox.com"\ncloud = "eur.boox.com"\n'
    );

    const config = loadConfig(configPath);
    expect(config.cloud).toBe('us.boox.com');
  });

  it('saveConfig writes server and cloud alias', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.toml');
    saveConfig(
      { email: 'a@b.com', mobile: '', token: 'tkn', cloud: 'us.boox.com' },
      configPath
    );

    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).toContain('server = "us.boox.com"');
    expect(raw).toContain('cloud = "us.boox.com"');
  });

  it('loadConfig reads mobile', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, 'mobile = "13800138000"\ntoken = "tkn"\ncloud = "eur.boox.com"\n');

    const config = loadConfig(configPath);
    expect(config.mobile).toBe('13800138000');
  });

  it('saveConfig writes mobile', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.toml');
    saveConfig(
      { email: 'a@b.com', mobile: '13800138000', token: 'tkn', cloud: 'us.boox.com' },
      configPath
    );

    const raw = fs.readFileSync(configPath, 'utf-8');
    expect(raw).toContain('mobile = "13800138000"');
  });

  it('loadConfig invalid toml raises', () => {
    const dir = makeTempDir();
    const configPath = path.join(dir, 'config.toml');
    fs.writeFileSync(configPath, 'email = "a@b.com"\nserver = "send2boox.com"\nbad = [\n');

    expect(() => loadConfig(configPath)).toThrow(ConfigError);
  });
});
