import { describe, expect, it } from 'vitest';
import { localIsoTimestamp } from './local-time';

describe('localIsoTimestamp', () => {
  it('keeps local wall-clock fields and a numeric offset', () => {
    const date = new Date(2026, 9, 23, 14, 5, 6, 7);
    const text = localIsoTimestamp(date);
    expect(text).toMatch(/^2026-10-23T14:05:06\.007[+-]\d{2}:\d{2}$/);
    expect(new Date(text).getTime()).toBe(date.getTime());
  });
});
