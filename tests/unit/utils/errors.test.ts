import { describe, it, expect } from 'bun:test';
import { CCLinkerError } from '../../../src/utils/errors';

describe('CCLinkerError', () => {
  it('creates error with code and message', () => {
    const err = new CCLinkerError('E001', 'Registry not found');
    expect(err.code).toBe('E001');
    expect(err.message).toBe('Registry not found');
    expect(err.name).toBe('CCLinkerError');
  });

  it('includes details when provided', () => {
    const err = new CCLinkerError('E006', 'Multiple matches', { count: 3 });
    expect(err.details).toEqual({ count: 3 });
  });

  it('formats toString correctly', () => {
    const err = new CCLinkerError('E001', 'Registry not found');
    expect(err.toString()).toBe('[E001] Registry not found');
  });
});
