import { expect, it } from 'vitest';
import { resetCountdown } from '../src/client/usage.js';

it('keeps reset countdowns readable across minute, hour and day boundaries', () => {
  const now = 1_800_000_000_000;
  expect(resetCountdown(now + 1, now)).toBe('1分钟后重置');
  expect(resetCountdown(now + 144 * 60000, now)).toBe('2小时24分钟后重置');
  expect(resetCountdown(now + 60 * 60000, now)).toBe('1小时后重置');
  expect(resetCountdown(now + (5 * 24 + 17) * 3600000, now)).toBe('5天17小时后重置');
  expect(resetCountdown(now + 86400000, now)).toBe('1天后重置');
});

it('does not promise a quota refresh when the observed reset deadline expires', () => {
  expect(resetCountdown(100, 100)).toBe('即将重置');
  expect(resetCountdown(100, 101)).toBe('即将重置');
});
