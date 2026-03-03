import fs from 'node:fs';
import path from 'node:path';

import { ConfigError } from './exceptions.js';

export const DEFAULT_CLOUD = 'send2boox.com';
export const DEFAULT_CONFIG_PATH = 'config.json';
export const DEFAULT_ENV_PATH = '.env.local';
export const TOKEN_ENV_KEY = 'SEND2BOOX_TOKEN';

export interface AppConfig {
  email: string;
  mobile: string;
  token: string;
  cloud: string;
}

export function buildDefaultConfig(): AppConfig {
  return {
    email: '',
    mobile: '',
    token: '',
    cloud: DEFAULT_CLOUD
  };
}

export function loadConfig(configPath: string = DEFAULT_CONFIG_PATH): AppConfig {
  const normalizedPath = path.resolve(configPath);
  if (!fs.existsSync(normalizedPath)) {
    throw new ConfigError(`Config file not found: ${configPath}.`);
  }

  let raw: string;
  try {
    raw = fs.readFileSync(normalizedPath, 'utf-8');
  } catch (error) {
    throw new ConfigError(`Failed to read config file ${configPath}: ${String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ConfigError(`Config file ${configPath} is not valid JSON: ${String(error)}`);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`Config file ${configPath} must contain a JSON object at root.`);
  }

  const payload = parsed as Record<string, unknown>;
  const server = asStr(payload.server);
  const cloud = asStr(payload.cloud);
  const resolvedCloud = server || cloud || DEFAULT_CLOUD;
  const token = readTokenFromEnv(resolveEnvPath(normalizedPath));

  return {
    email: asStr(payload.email),
    mobile: asStr(payload.mobile),
    token,
    cloud: resolvedCloud
  };
}

export function saveConfig(config: AppConfig, configPath: string = DEFAULT_CONFIG_PATH): void {
  const normalizedPath = path.resolve(configPath);
  const cloud = (config.cloud || DEFAULT_CLOUD).trim() || DEFAULT_CLOUD;
  const payload: Record<string, string> = {
    email: config.email,
    mobile: config.mobile,
    server: cloud
  };
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;

  try {
    fs.mkdirSync(path.dirname(normalizedPath), { recursive: true });
    fs.writeFileSync(normalizedPath, serialized, 'utf-8');
  } catch (error) {
    throw new ConfigError(`Failed to write config file ${configPath}: ${String(error)}`);
  }

  try {
    writeTokenToEnv({
      envPath: resolveEnvPath(normalizedPath),
      token: config.token
    });
  } catch (error) {
    throw new ConfigError(`Failed to write token env file for ${configPath}: ${String(error)}`);
  }
}

export function asStr(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  return '';
}

function resolveEnvPath(normalizedConfigPath: string): string {
  return path.join(path.dirname(normalizedConfigPath), DEFAULT_ENV_PATH);
}

function readTokenFromEnv(envPath: string): string {
  if (!fs.existsSync(envPath)) {
    return '';
  }

  let raw: string;
  try {
    raw = fs.readFileSync(envPath, 'utf-8');
  } catch (error) {
    throw new ConfigError(`Failed to read env file ${envPath}: ${String(error)}`);
  }

  const values = parseEnv(raw);
  return values[TOKEN_ENV_KEY] ?? values.TOKEN ?? '';
}

function writeTokenToEnv(options: { envPath: string; token: string }): void {
  let raw = '';
  if (fs.existsSync(options.envPath)) {
    raw = fs.readFileSync(options.envPath, 'utf-8');
  }
  const lines = raw === '' ? [] : raw.split(/\r?\n/);
  const nextLine = `${TOKEN_ENV_KEY}=${quoteEnvValue(options.token)}`;
  let replaced = false;
  const nextLines = lines
    .filter((line, index, source) => !(index === source.length - 1 && line === ''))
    .map((line) => {
      if (/^\s*SEND2BOOX_TOKEN\s*=/.test(line)) {
        replaced = true;
        return nextLine;
      }
      return line;
    });
  if (!replaced) {
    nextLines.push(nextLine);
  }

  fs.mkdirSync(path.dirname(options.envPath), { recursive: true });
  fs.writeFileSync(options.envPath, `${nextLines.join('\n')}\n`, 'utf-8');
}

function parseEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }
    const key = match[1];
    const valueRaw = match[2] ?? '';
    result[key] = unquoteEnvValue(valueRaw.trim());
  }
  return result;
}

function unquoteEnvValue(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function quoteEnvValue(value: string): string {
  if (value === '' || /[\s#"'\\]/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}
