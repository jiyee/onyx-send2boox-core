import fs from 'node:fs';
import path from 'node:path';

import TOML from '@iarna/toml';

import { ConfigError } from './exceptions.js';

export const DEFAULT_CLOUD = 'send2boox.com';

export interface AppConfig {
  email: string;
  mobile: string;
  token: string;
  cloud: string;
}

function buildDefaultConfig(): AppConfig {
  return {
    email: '',
    mobile: '',
    token: '',
    cloud: DEFAULT_CLOUD
  };
}

export function loadConfig(configPath: string = 'config.toml'): AppConfig {
  const normalizedPath = path.resolve(configPath);
  if (!fs.existsSync(normalizedPath)) {
    throw new ConfigError(
      `Config file not found: ${configPath}. Create it from config.example.toml.`
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(normalizedPath, 'utf-8');
  } catch (error) {
    throw new ConfigError(`Failed to read config file ${configPath}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(raw);
  } catch (error) {
    throw new ConfigError(`Config file ${configPath} is not valid TOML: ${String(error)}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`Config file ${configPath} must contain a TOML table at root.`);
  }

  const payload = parsed as Record<string, unknown>;
  const server = asStr(payload.server);
  const cloud = asStr(payload.cloud);
  const resolvedCloud = server || cloud || DEFAULT_CLOUD;

  return {
    email: asStr(payload.email),
    mobile: asStr(payload.mobile),
    token: asStr(payload.token),
    cloud: resolvedCloud
  };
}

export function saveConfig(config: AppConfig, configPath: string = 'config.toml'): void {
  const normalizedPath = path.resolve(configPath);
  const cloud = (config.cloud || DEFAULT_CLOUD).trim() || DEFAULT_CLOUD;
  const payload: Record<string, string> = {
    email: config.email,
    mobile: config.mobile,
    token: config.token,
    server: cloud,
    cloud
  };
  const lines = Object.entries(payload).map(([key, value]) => `${key} = ${toTomlString(value)}`);
  const serialized = `${lines.join('\n')}\n`;

  try {
    fs.writeFileSync(normalizedPath, serialized, 'utf-8');
  } catch (error) {
    throw new ConfigError(`Failed to write config file ${configPath}: ${String(error)}`);
  }
}

export function asStr(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

export function toTomlString(value: string): string {
  return JSON.stringify(value);
}

export { buildDefaultConfig };
