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
    expect(config.get('feishu_bot.app_id', '')).toBe('');
  });

  it('loads config from TOML file', () => {
    const configPath = join(tmpDir, 'config.toml');
    writeFileSync(configPath, '[feishu_bot]\napp_id = "test_app_id"');

    const config = new ConfigManager(configPath);
    expect(config.get('feishu_bot.app_id', '')).toBe('test_app_id');
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
    writeFileSync(configPath, '[feishu_bot]\napp_id = "test_app_id"');

    const customized = new ConfigManager(configPath);
    expect(customized.get('feishu_bot.app_id', '')).toBe('test_app_id');

    const fresh = new ConfigManager(join(tmpDir, 'nonexistent.toml'));
    expect(fresh.get('feishu_bot.app_id', '')).toBe('');
  });
});
