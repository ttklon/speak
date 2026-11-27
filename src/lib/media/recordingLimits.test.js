import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { RECORDING_MAX_BYTES, RECORDING_MAX_DURATION_MS, RECORDING_STOP_BYTES } from './recordingLimits.js';

const require = createRequire(import.meta.url);
const mainLimits = require('../../../electron/recordingLimits.cjs');

describe('предел записи экрана', () => {
  it('совпадает в renderer и main и оставляет запас для финального фрагмента', () => {
    expect(mainLimits.RECORDING_MAX_BYTES).toBe(RECORDING_MAX_BYTES);
    expect(RECORDING_STOP_BYTES).toBe(48 * 1024 * 1024);
    expect(RECORDING_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(RECORDING_MAX_DURATION_MS).toBe(10 * 60 * 1000);
    expect(RECORDING_STOP_BYTES).toBeLessThan(RECORDING_MAX_BYTES);
  });
});
