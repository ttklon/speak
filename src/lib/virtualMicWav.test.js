import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createPaddedWav } from '../../scripts/lib/virtual-mic-wav.mjs';
import { readWav } from '../../scripts/lib/engine-cli.mjs';

describe('WAV для виртуального микрофона', () => {
  it('сохраняет звук между тишиной и очищает временный файл', () => {
    const pcm = Buffer.alloc(32000);
    pcm.writeInt16LE(12345, 12);
    const padded = createPaddedWav(pcm, 16000);
    try {
      const parsed = readWav(padded.file);
      expect(padded.seconds).toBe(4);
      expect(parsed.sampleRate).toBe(16000);
      expect(parsed.pcm.subarray(0, 64000).every((byte) => byte === 0)).toBe(true);
      expect(parsed.pcm.subarray(64000, 96000).equals(pcm)).toBe(true);
      expect(parsed.pcm.subarray(96000).every((byte) => byte === 0)).toBe(true);
    } finally {
      padded.cleanup();
    }
    expect(existsSync(padded.file)).toBe(false);
  });

  it('не принимает неподходящий PCM', () => {
    expect(() => createPaddedWav(Buffer.alloc(0), 16000)).toThrow();
    expect(() => createPaddedWav(Buffer.alloc(3), 16000)).toThrow();
    expect(() => createPaddedWav(Buffer.alloc(2), 48000)).toThrow();
  });
});
