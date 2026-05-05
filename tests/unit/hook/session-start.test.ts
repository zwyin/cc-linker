import { describe, it, expect } from 'bun:test';
import { detectOrigin, detectSessionId } from '../../../src/hook/session-start';

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

  it('detects cc-connect origin from sdk-cli entrypoint', () => {
    const previous = {
      CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT,
      ENTRYPOINT: process.env.ENTRYPOINT,
      CLAUDE_ENTRYPOINT: process.env.CLAUDE_ENTRYPOINT,
      CC_CONNECT_SESSION_ID: process.env.CC_CONNECT_SESSION_ID,
    };

    process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
    delete process.env.ENTRYPOINT;
    delete process.env.CLAUDE_ENTRYPOINT;
    delete process.env.CC_CONNECT_SESSION_ID;

    try {
      expect(detectOrigin()).toBe('cc-connect');
    } finally {
      if (previous.CLAUDE_CODE_ENTRYPOINT === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
      else process.env.CLAUDE_CODE_ENTRYPOINT = previous.CLAUDE_CODE_ENTRYPOINT;
      if (previous.ENTRYPOINT === undefined) delete process.env.ENTRYPOINT;
      else process.env.ENTRYPOINT = previous.ENTRYPOINT;
      if (previous.CLAUDE_ENTRYPOINT === undefined) delete process.env.CLAUDE_ENTRYPOINT;
      else process.env.CLAUDE_ENTRYPOINT = previous.CLAUDE_ENTRYPOINT;
      if (previous.CC_CONNECT_SESSION_ID === undefined) delete process.env.CC_CONNECT_SESSION_ID;
      else process.env.CC_CONNECT_SESSION_ID = previous.CC_CONNECT_SESSION_ID;
    }
  });
});
