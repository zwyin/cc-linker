import { describe, it, expect, mock } from 'bun:test';
import { restart } from '../../../../src/cli/commands/restart';

describe('restart', () => {
  it('stops and starts when daemon is running', async () => {
    const isDaemonRunning = mock(() => true);
    const stop = mock(() => Promise.resolve());
    const start = mock(() => Promise.resolve());

    const registry = { sessions: {} } as any;
    await restart(registry, { isDaemonRunning, stop, start });

    expect(isDaemonRunning).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]).toEqual({ daemon: true });
  });

  it('starts directly when daemon is not running', async () => {
    const isDaemonRunning = mock(() => false);
    const stop = mock(() => Promise.resolve());
    const start = mock(() => Promise.resolve());

    const registry = { sessions: {} } as any;
    await restart(registry, { isDaemonRunning, stop, start });

    expect(isDaemonRunning).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]).toEqual({ daemon: true });
  });
});
