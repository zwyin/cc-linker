import { existsSync } from 'fs';
import { join } from 'path';
import { expandPath } from '../utils/paths';

export const DaemonProbe = {
  /**
   * 检查 Claude daemon 是否在跑(简化判断:roster.json 文件存在)
   * @param claudeHome 默认 ~/.claude,可通过参数覆盖(测试用)
   */
  check(claudeHome: string = join(expandPath('~'), '.claude')): boolean {
    return existsSync(join(claudeHome, 'daemon', 'roster.json'));
  },
};
