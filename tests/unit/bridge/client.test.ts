import { describe, it, expect } from 'bun:test';
import { switchSession } from '../../../src/bridge/client';
import { config as appConfig } from '../../../src/utils/config';

describe('Bridge client', () => {
  it('reads bridge api settings from config singleton', async () => {
    const originalGet = appConfig.get.bind(appConfig);
    const originalFetch = globalThis.fetch;

    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    (appConfig as any).get = <T>(path: string, fallback: T): T => {
      if (path === 'bridge.api_url') return 'http://config-host:9910' as T;
      if (path === 'bridge.token') return 'config-token' as T;
      if (path === 'bridge.timeout') return 7 as T;
      return originalGet(path, fallback);
    };

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      capturedUrl = url.toString();
      capturedInit = init;
      return new Response(JSON.stringify({ message: 'ok' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;

    try {
      const result = await switchSession({
        sessionKey: 'feishu:oc_xxx:ou_user1',
        target: 's2',
      });

      expect(result.success).toBe(true);
      expect(capturedUrl).toBe('http://config-host:9910/bridge/sessions/switch');
      expect((capturedInit?.headers as Record<string, string>)['Authorization']).toBe('Bearer config-token');
      expect(capturedInit?.body).toBe(JSON.stringify({
        session_key: 'feishu:oc_xxx:ou_user1',
        target: 's2',
      }));
    } finally {
      (appConfig as any).get = originalGet;
      globalThis.fetch = originalFetch;
    }
  });
});
