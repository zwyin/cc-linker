import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ConfigManager } from '../../../src/utils/config';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ConfigManager', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `cc-bridge-config-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads default config when no file exists', () => {
    const config = new ConfigManager(join(tmpDir, 'nonexistent.toml'));
    expect(config.get('bridge.api_url', '')).toBe('http://localhost:9810');
  });

  it('loads config from TOML file', () => {
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, '[bridge]\napi_url = "http://custom:9999"');

    const config = new ConfigManager(configPath);
    expect(config.get('bridge.api_url', '')).toBe('http://custom:9999');
  });

  it('returns fallback for missing keys', () => {
    const config = new ConfigManager(join(tmpDir, 'nonexistent.toml'));
    expect(config.get('nonexistent.key', 'fallback')).toBe('fallback');
  });

  it('loads registry path from config file', () => {
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, '[general]\nregistry_path = "/tmp/custom-registry.json"');

    const config = new ConfigManager(configPath);
    expect(config.get('general.registry_path', '')).toBe('/tmp/custom-registry.json');
  });

  it('does not leak nested config mutations between instances', () => {
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, '[bridge]\napi_url = "http://custom:9999"');

    const customized = new ConfigManager(configPath);
    expect(customized.get('bridge.api_url', '')).toBe('http://custom:9999');

    const fresh = new ConfigManager(join(tmpDir, 'nonexistent.toml'));
    expect(fresh.get('bridge.api_url', '')).toBe('http://localhost:9810');
  });
});
