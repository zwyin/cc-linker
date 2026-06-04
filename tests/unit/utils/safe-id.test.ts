import { describe, it, expect } from 'bun:test';
import { SAFE_ID_REGEX, isSafeId } from '../../../src/utils/safe-id';

describe('safe-id', () => {
  it('exports SAFE_ID_REGEX with {1,80} cap (PR 2 review: prevents ENAMETOOLONG at cmd: serialKey boundary)', () => {
    // 4 cmd + 80 openId + 1 + 80 msgId + 1 + 80 msgId + 5 .json = 251
    // + 4 .tmp suffix during writeAtomic = 255 = NAME_MAX boundary
    expect(SAFE_ID_REGEX.source).toBe('^[a-zA-Z0-9_-]{1,80}$');
  });

  it('isSafeId accepts typical Feishu om_ / ou_ IDs', () => {
    expect(isSafeId('om_msg_001')).toBe(true);
    expect(isSafeId('ou_user1')).toBe(true);
    expect(isSafeId('om_valid_123-abc')).toBe(true);
    expect(isSafeId('a')).toBe(true); // {1,80} requires at least 1
  });

  it('isSafeId rejects path separators and shell specials', () => {
    expect(isSafeId('om:bad:id')).toBe(false);
    expect(isSafeId('om/bad/id')).toBe(false);
    expect(isSafeId('om\\bad\\id')).toBe(false);
    expect(isSafeId('om.dot.id')).toBe(false);
    expect(isSafeId('om bad id')).toBe(false);
  });

  it('isSafeId rejects empty and over-length strings', () => {
    expect(isSafeId('')).toBe(false);
    expect(isSafeId('a'.repeat(81))).toBe(false);
    expect(isSafeId('a'.repeat(128))).toBe(false);
  });

  it('boundary: 80 chars is accepted, 81 rejected', () => {
    expect(isSafeId('a'.repeat(80))).toBe(true);
    expect(isSafeId('a'.repeat(81))).toBe(false);
  });
});
