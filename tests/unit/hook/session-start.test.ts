import { describe, it, expect } from 'bun:test';
import { detectSessionId } from '../../../src/hook/session-start';

describe('SessionStart hook helpers', () => {
  it('accepts SESSION_ID as a fallback source for the session uuid', () => {
    const previous = {
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID,
      SESSION_ID: process.env.SESSION_ID,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID,
    };

    delete process.env.CLAUDE_CODE_SESSION_ID;
    delete process.env.CLAUDE_SESSION_ID;
    process.env.SESSION_ID = '11111111-2222-4333-8444-555555555555';

    try {
      expect(detectSessionId()).toBe('11111111-2222-4333-8444-555555555555');
    } finally {
      if (previous.CLAUDE_CODE_SESSION_ID === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
      else process.env.CLAUDE_CODE_SESSION_ID = previous.CLAUDE_CODE_SESSION_ID;
      if (previous.SESSION_ID === undefined) delete process.env.SESSION_ID;
      else process.env.SESSION_ID = previous.SESSION_ID;
      if (previous.CLAUDE_SESSION_ID === undefined) delete process.env.CLAUDE_SESSION_ID;
      else process.env.CLAUDE_SESSION_ID = previous.CLAUDE_SESSION_ID;
    }
  });
});
