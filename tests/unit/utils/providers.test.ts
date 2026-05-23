import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ProviderManager, ProviderConfig } from '../../../src/utils/providers';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('ProviderManager', () => {
  let tmpDir: string;
  let providersDir: string;
  let pm: ProviderManager;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'providers-test-'));
    providersDir = join(tmpDir, 'providers');
    mkdirSync(providersDir, { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    pm = new ProviderManager();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty list initially', () => {
    expect(pm.list()).toHaveLength(0);
    expect(pm.getSource()).toBe('none');
  });

  it('resolve returns null for unknown alias', () => {
    expect(pm.resolve('nonexistent')).toBeNull();
  });

  it('resolveByIndex returns null when empty', () => {
    expect(pm.resolveByIndex(0)).toBeNull();
  });

  it('scans manual providers directory', async () => {
    // Create ~/.claude/providers
    const claudeProviders = join(tmpDir, '.claude', 'providers');
    mkdirSync(claudeProviders, { recursive: true });
    writeFileSync(
      join(claudeProviders, 'kimi.json'),
      JSON.stringify({ model: 'opus', env: { ANTHROPIC_MODEL: 'kimi-for-coding' } }),
    );
    writeFileSync(
      join(claudeProviders, 'deepseek.json'),
      JSON.stringify({ model: 'sonnet', env: { ANTHROPIC_MODEL: 'deepseek-v4' } }),
    );

    await pm.scan();

    expect(pm.getSource()).toBe('manual');
    expect(pm.list()).toHaveLength(2);

    const kimi = pm.resolve('kimi');
    expect(kimi).not.toBeNull();
    expect(kimi!.name).toBe('kimi');
    expect(kimi!.isTemp).toBe(false);

    const deepseek = pm.resolve('deepseek');
    expect(deepseek).not.toBeNull();
    expect(deepseek!.alias).toBe('deepseek');

    // Resolve by 1-based index
    const byIndex = pm.resolve('1');
    expect(byIndex).not.toBeNull();
  });

  it('generateShortAlias strips stopwords and shortens long names', async () => {
    // Create providers with display names
    const claudeProviders = join(tmpDir, '.claude', 'providers');
    mkdirSync(claudeProviders, { recursive: true });
    writeFileSync(
      join(claudeProviders, 'Kimi For Coding.json'),
      JSON.stringify({ model: 'opus', env: { ANTHROPIC_MODEL: 'kimi' } }),
    );
    writeFileSync(
      join(claudeProviders, 'bailian-qwen3.6-plus.json'),
      JSON.stringify({ model: 'opus', env: { ANTHROPIC_MODEL: 'qwen' } }),
    );

    await pm.scan();

    // "Kimi For Coding" → stopword "for" removed → "kimi-coding"
    const kimi = pm.resolve('kimi-coding');
    expect(kimi).not.toBeNull();
    expect(kimi!.name).toBe('Kimi For Coding');

    // "bailian-qwen3.6-plus" → suffix "plus" removed, platform "bailian" stripped, dot restored → "qwen3.6"
    const qwen = pm.resolve('qwen3.6');
    expect(qwen).not.toBeNull();
    expect(qwen!.name).toBe('bailian-qwen3.6-plus');
  });

  it('handles invalid provider config gracefully', async () => {
    const claudeProviders = join(tmpDir, '.claude', 'providers');
    mkdirSync(claudeProviders, { recursive: true });
    writeFileSync(join(claudeProviders, 'invalid.json'), 'not json');
    writeFileSync(
      join(claudeProviders, 'valid.json'),
      JSON.stringify({ model: 'opus', env: {} }),
    );

    await pm.scan();

    // Should still scan the valid one
    expect(pm.list()).toHaveLength(1);
    expect(pm.list()[0].alias).toBe('valid');
  });

  it('source is none when no providers or cc-switch db', async () => {
    // No ~/.claude/providers (we didn't create it in the test tmpDir structure)
    // But the test creates HOME = tmpDir, so ~/.claude/providers won't exist
    await pm.scan();
    expect(pm.getSource()).toBe('none');
  });

  it('resolve by alias returns correct provider', async () => {
    const claudeProviders = join(tmpDir, '.claude', 'providers');
    mkdirSync(claudeProviders, { recursive: true });
    writeFileSync(
      join(claudeProviders, 'test-provider.json'),
      JSON.stringify({ model: 'opus', env: { ANTHROPIC_MODEL: 'test' } }),
    );

    await pm.scan();

    const provider = pm.resolve('test-provider');
    expect(provider).not.toBeNull();
    expect(provider!.alias).toBe('test-provider');
    expect(provider!.isTemp).toBe(false);
  });
});
