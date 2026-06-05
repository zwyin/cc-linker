import { describe, it, expect } from 'bun:test';
import { JSONLScanner } from '../../../src/scanner/jsonl';

describe('JSONLScanner.stripMarkdownNoise', () => {
  // 用 (JSONLScanner as any) 访问 private static method
  const strip = (s: string) => (JSONLScanner as any).stripMarkdownNoise(s);

  it('strips line-start heading markers (##, ###, etc.) but keeps text', () => {
    expect(strip('## 0. 内存膨胀分析')).toBe('0. 内存膨胀分析');
    expect(strip('### 0.1 单个 queue item 真实大小')).toBe('0.1 单个 queue item 真实大小');
    expect(strip('# 完整最终 Review 修改意见（决策版）')).toBe('完整最终 Review 修改意见（决策版）');
  });

  it('strips bold markers (**) but keeps text', () => {
    expect(strip('这是 **加粗** 文字')).toBe('这是 加粗 文字');
    expect(strip('**完全加粗**')).toBe('完全加粗');
  });

  it('strips inline code markers (`) but keeps code content', () => {
    expect(strip('看 `traeScanner` 代码')).toBe('看 traeScanner 代码');
    expect(strip('调用 `getCurrentTask` 方法')).toBe('调用 getCurrentTask 方法');
  });

  it('strips code block boundary markers (```)', () => {
    expect(strip('```typescript\nconst x = 1;\n```')).toBe('typescript\nconst x = 1;\n');
  });

  it('preserves list markers (-) and links [text](url)', () => {
    expect(strip('- 第一项\n- 第二项')).toBe('- 第一项\n- 第二项');
    expect(strip('看 [文档](https://example.com) 了解')).toBe('看 [文档](https://example.com) 了解');
  });
});
