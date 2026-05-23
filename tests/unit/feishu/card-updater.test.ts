import { test, expect, mock, describe, beforeEach, afterEach } from 'bun:test';
import { CardUpdater } from '../../../src/feishu/card-updater';

function createMockClient() {
  const createFn = mock(async () => ({ data: { message_id: 'om_card_123' } }));
  const patchFn = mock(async () => ({}));
  return {
    im: { v1: { message: { create: createFn, patch: patchFn } } },
    createFn,
    patchFn,
  };
}

test('startProcessing sends initial card and returns message_id', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any);
  const id = await updater.startProcessing('ou_user123');
  expect(id).toBe('om_card_123');
  expect(m.createFn).toHaveBeenCalledTimes(1);
});

test('updateStream patches the card with content', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.startProcessing('ou_user123');
  await updater.updateStream('thinking...', 'reply...', 10);
  expect(m.patchFn).toHaveBeenCalled();
});

test('throttle prevents rapid patches', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 100 });
  await updater.startProcessing('ou_user123');
  await updater.updateStream('t1', '', 5);
  const count1 = m.patchFn.mock.calls.length;
  await updater.updateStream('t2', '', 6);
  const count2 = m.patchFn.mock.calls.length;
  expect(count2).toBe(count1); // throttled
  await new Promise(r => setTimeout(r, 150));
  const count3 = m.patchFn.mock.calls.length;
  expect(count3).toBeGreaterThan(count1);
});

test('complete patches with green header', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.startProcessing('ou_user123');
  await updater.complete('Final answer', 0.05, 2000, 3);
  const lastCall = m.patchFn.mock.calls[m.patchFn.mock.calls.length - 1];
  const card = JSON.parse(lastCall[0].data.content);
  expect(card.header.template).toBe('green');
});

test('error patches with red header', async () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { throttle_ms: 0 });
  await updater.startProcessing('ou_user123');
  await updater.error('Crashed');
  const lastCall = m.patchFn.mock.calls[m.patchFn.mock.calls.length - 1];
  const card = JSON.parse(lastCall[0].data.content);
  expect(card.header.template).toBe('red');
});

test('shouldFallbackToText detects oversized content', () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { max_card_bytes: 100 });
  expect(updater.shouldFallbackToText('x'.repeat(200))).toBe(true);
  expect(updater.shouldFallbackToText('short')).toBe(false);
});

test('truncateContent cuts to max_card_bytes', () => {
  const m = createMockClient();
  const updater = new CardUpdater(m as any, { max_card_bytes: 10 });
  const truncated = updater.truncateContent('Hello World!');
  const encoder = new TextEncoder();
  expect(encoder.encode(truncated).length).toBeLessThanOrEqual(13);
});
