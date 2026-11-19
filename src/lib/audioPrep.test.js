import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TARGET_DBFS, MAX_GAIN_DB, measurePcm, highPass, normalize, compactSilence, preparePcm } = require('../../electron/audioPrep.cjs');

const RATE = 16000;

/** Int16-буфер из функции-сэмпла. */
function pcmFrom(fn, seconds = 0.5, rate = RATE) {
  const total = Math.round(seconds * rate);
  const buf = Buffer.alloc(total * 2);
  for (let i = 0; i < total; i += 1) buf.writeInt16LE(fn(i / rate), i * 2);
  return buf;
}

const sine = (hz, amplitude = 0.2) => (t) => Math.round(Math.sin(2 * Math.PI * hz * t) * amplitude * 32767);

describe('measurePcm', () => {
  it('считает RMS, пик и дБFS', () => {
    const stats = measurePcm(pcmFrom(sine(500, 0.5)));
    expect(stats.peak).toBeGreaterThan(15000);
    expect(stats.dbfs).toBeCloseTo(-9, 0); // 0,5 от полной шкалы ≈ −6 дБ на пике
  });

  it('на тишине не выдаёт NaN', () => {
    const stats = measurePcm(Buffer.alloc(1600));
    expect(stats.rms).toBe(0);
    expect(stats.dbfs).toBe(-Infinity);
  });
});

describe('highPass', () => {
  it('постоянную составляющую убирает в ноль', () => {
    const withOffset = pcmFrom(() => 4000);
    const out = highPass(withOffset);
    const stats = measurePcm(out.subarray(Math.round(0.1 * RATE) * 2)); // без переходного процесса
    expect(stats.rms).toBeLessThan(10);
  });

  it('гул 50 Гц ослабляет заметно, речь 1 кГц оставляет', () => {
    const hum = measurePcm(highPass(pcmFrom(sine(50, 0.3)))).rms;
    const speech = measurePcm(highPass(pcmFrom(sine(1000, 0.3)))).rms;
    expect(hum).toBeLessThan(measurePcm(pcmFrom(sine(50, 0.3))).rms * 0.5);
    // речь почти не страдает: не тише 70 % исходной громкости
    expect(speech).toBeGreaterThan(measurePcm(pcmFrom(sine(1000, 0.3))).rms * 0.7);
  });

  it('длина и формат сохраняются', () => {
    const input = pcmFrom(sine(300));
    const out = highPass(input);
    expect(out.length).toBe(input.length);
  });

  it('пустой буфер не ломает фильтр', () => {
    expect(highPass(Buffer.alloc(0)).length).toBe(0);
  });
});

describe('normalize', () => {
  it('тихую речь поднимает до −18 dBFS', () => {
    const quiet = pcmFrom(sine(600, 0.02)); // очень тихо
    const { pcm, gainDb } = normalize(quiet);
    expect(gainDb).toBeGreaterThan(15);
    expect(measurePcm(pcm).dbfs).toBeCloseTo(TARGET_DBFS, 0);
  });

  it('не усиливает больше 24 дБ — иначе вместе с речью шум', () => {
    const whisperQuiet = pcmFrom(sine(600, 0.002));
    const { gainDb } = normalize(whisperQuiet);
    expect(gainDb).toBeLessThanOrEqual(MAX_GAIN_DB + 0.1);
  });

  it('никогда не клиппует: пик остаётся ниже потолка', () => {
    const loud = pcmFrom(sine(600, 0.9));
    const { pcm } = normalize(loud);
    expect(measurePcm(pcm).peak).toBeLessThanOrEqual(Math.round(0.97 * 32767));
  });

  it('громкую запись не трогает', () => {
    const loud = pcmFrom(sine(600, 0.6));
    const { pcm, gainDb } = normalize(loud);
    expect(gainDb).toBe(0);
    expect(pcm.equals(loud)).toBe(true);
  });
});

describe('preparePcm', () => {
  it('делает и фильтр, и громкость за один вызов', () => {
    const input = pcmFrom((t) => sine(700, 0.05)(t) + 3000); // тихо и с DC
    const out = preparePcm(input);
    expect(out.gainDb).toBeGreaterThan(10);
    expect(measurePcm(out.pcm).rms).toBeGreaterThan(measurePcm(input).rms);
  });

  it('тишину не усиливает', () => {
    const quiet = pcmFrom(() => 5);
    const out = preparePcm(quiet);
    expect(out.skipped).toBe('тишина');
    expect(out.gainDb).toBe(0);
    expect(out.pcm).toBe(quiet);
  });

  it('не портит нормальную запись', () => {
    const normal = pcmFrom(sine(800, 0.25));
    const out = preparePcm(normal);
    expect(out.after.peak).toBeLessThanOrEqual(32767);
    expect(out.pcm.length).toBe(normal.length);
  });
});

describe('compactSilence', () => {
  /** Речь (тон) + тишина: [speechMs, pauseMs, speechMs, ...] */
  function speechWithPauses(parts) {
    const chunks = [];
    parts.forEach((ms, i) => {
      const samples = Math.round((RATE * ms) / 1000);
      const buf = Buffer.alloc(samples * 2);
      for (let k = 0; k < samples; k += 1) {
        buf.writeInt16LE(i % 2 === 0 ? Math.round(6000 * Math.sin((2 * Math.PI * 220 * k) / RATE)) : 0, k * 2);
      }
      chunks.push(buf);
    });
    return Buffer.concat(chunks);
  }

  it('длинную паузу сжимает, речь оставляет', () => {
    const input = speechWithPauses([1000, 3000, 1000]);
    const { pcm, removedMs } = compactSilence(input);
    const seconds = pcm.length / 2 / RATE;
    expect(removedMs).toBeGreaterThan(2000);
    expect(seconds).toBeLessThan(3.2); // было 5 с
    expect(seconds).toBeGreaterThan(2.2); // речь и запас на месте
  });

  it('короткие паузы между словами не трогает', () => {
    const input = speechWithPauses([400, 200, 400, 200, 400]);
    const { pcm, removedMs } = compactSilence(input);
    expect(removedMs).toBe(0);
    expect(pcm.length).toBe(input.length);
  });

  it('запись без пауз не меняет', () => {
    const input = speechWithPauses([1500]);
    const { pcm, removedMs } = compactSilence(input);
    expect(removedMs).toBe(0);
    expect(pcm.equals(input)).toBe(true);
  });

  it('громкость речи после сжатия не меняется', () => {
    const input = speechWithPauses([1000, 2000, 1000]);
    const { pcm } = compactSilence(input);
    const before = measurePcm(input.subarray(0, RATE * 2));
    const after = measurePcm(pcm.subarray(0, RATE * 2));
    expect(Math.abs(after.rms - before.rms)).toBeLessThan(500);
  });
});
