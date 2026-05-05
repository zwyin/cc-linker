import { CCBridgeError } from '../utils/errors';
import { logger } from '../utils/logger';
import { config as appConfig } from '../utils/config';

interface BridgeConfig {
  apiUrl: string;
  token: string;
  timeout: number;
}

export interface SwitchSessionParams {
  sessionKey: string;
  target: string;
}

export interface SwitchSessionResult {
  success: boolean;
  message?: string;
}

export async function switchSession(
  params: SwitchSessionParams,
  config: Partial<BridgeConfig> = {}
): Promise<SwitchSessionResult> {
  const cfg: BridgeConfig = {
    apiUrl: appConfig.get<string>('bridge.api_url', process.env.CC_BRIDGE_API_URL ?? 'http://localhost:9810'),
    token: appConfig.get<string>('bridge.token', process.env.CC_BRIDGE_TOKEN ?? ''),
    timeout: appConfig.get<number>('bridge.timeout', 30),
    ...config,
  };
  const url = `${cfg.apiUrl}/bridge/sessions/switch`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (cfg.token) {
    headers['Authorization'] = `Bearer ${cfg.token}`;
  }

  const body = JSON.stringify({
    session_key: params.sessionKey,
    target: params.target,
  });

  logger.debug(`Bridge API: POST ${url} body=${body}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), cfg.timeout * 1000);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new CCBridgeError('E014', `Bridge API 返回错误: ${response.status} ${text}`);
    }

    const data = await response.json().catch(() => ({}));
    logger.debug(`Bridge API 响应: ${JSON.stringify(data)}`);

    return { success: true, message: data.message };
  } catch (err: any) {
    if (err instanceof CCBridgeError) throw err;

    if (err.name === 'AbortError') {
      throw new CCBridgeError('E013', `Bridge API 请求超时（${cfg.timeout}s），请检查 cc-connect 是否运行`);
    }

    if (err.code === 'ECONNREFUSED' || err.message?.includes('fetch failed')) {
      throw new CCBridgeError('E013', `无法连接 Bridge API (${cfg.apiUrl})，请检查 cc-connect 是否运行`);
    }

    throw new CCBridgeError('E014', `Bridge API 请求失败: ${err.message}`);
  }
}
