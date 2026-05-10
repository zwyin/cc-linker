export class CCBridgeError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, any>
  ) {
    super(message);
    this.name = 'CCBridgeError';
  }

  override toString(): string {
    return `[${this.code}] ${this.message}`;
  }
}

export function handleError(err: unknown): never {
  if (err instanceof CCBridgeError) {
    console.error(`错误 [${err.code}]: ${err.message}`);
    if (err.details) {
      console.error(`详情: ${JSON.stringify(err.details)}`);
    }

    const suggestions: Record<string, string[]> = {
      'E001': ['运行 cc-bridge init 初始化 registry'],
      'E002': ['会话已被清理，无法恢复', '运行 cc-bridge sync 重新扫描'],
      'E007': ['等待其他进程完成', '或删除 ~/.cc-bridge/registry.json.lock'],
      'E008': ['会话创建目录已被删除，使用 --cwd 指定替代目录'],
      'E010': ['会话处于降级状态，执行 cc-bridge start 触发自动修复'],
      'E011': ['会话仍在创建中，请稍后重试'],
      'E012': ['会话已损坏，请使用 /bridge switch 切换到其他会话'],
      'E013': ['服务正在运行，请先执行 cc-bridge stop 后再执行此命令'],
    };

    if (suggestions[err.code]) {
      console.error('建议:');
      suggestions[err.code].forEach(s => console.error(`  - ${s}`));
    }

    process.exit(1);
  }

  console.error(`未知错误: ${err}`);
  process.exit(1);
}
