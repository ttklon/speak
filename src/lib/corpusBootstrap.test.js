// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { pairedSpeakerBootstrap } from '../../scripts/lib/corpus-bootstrap.mjs';

const a = { speaker: 'a', clips: 1, words: 1, characters: 4,
  rawWordDelta: 1, finalWordDelta: 0, rawCharDelta: 2, finalCharDelta: 0 };
const b = { speaker: 'b', clips: 2, words: 9, characters: 36,
  rawWordDelta: 0, finalWordDelta: 0, rawCharDelta: 0, finalCharDelta: 0 };

describe('paired speaker bootstrap', () => {
  it('ресэмплирует диктора целиком и взвешивает по словам и символам, воспроизводимо', () => {
    const report = pairedSpeakerBootstrap([a, b]);
    expect(report).toMatchObject({ method: 'paired-speaker-percentile-v1', replicates: 1000,
      speakers: 2, speechClips: 3, interval: { raw: { wer: [0, 1], cer: [0, 0.5] }, final: { wer: [0, 0], cer: [0, 0] } } });
    expect(pairedSpeakerBootstrap([b, a])).toEqual(report);
    expect(JSON.stringify(report)).not.toMatch(/"speaker"|"a"|"b"/);
  });
  it('считает отношение сумм, а не среднее ошибок разных по длине дикторов', () => {
    const report = pairedSpeakerBootstrap([a, b, { ...b, speaker: 'c' }, { ...b, speaker: 'd' }]);
    // Для этого seed 97,5-й процентиль содержит три копии a и одну b:
    // 3 ошибки / (3*1 + 9) = 0.25, а среднее WER было бы 0.75.
    expect(report.interval.raw.wer[1]).toBe(0.25);
    expect(report.interval.raw.cer[1]).toBe(0.125);
    expect(report.interval.final.wer).toEqual([0, 0]);
  });
  it('сохраняет эталон seed и процентилей для неоднородных групп', () => {
    // Независимая реализация PRNG и линейных процентилей зафиксировала эти значения.
    const counts = [[1, 1], [2, 0], [4, -1], [3, 1], [8, 2], [7, -1]];
    const input = counts.map(([words, delta], i) => ({ speaker: `s${i}`, clips: 1, words, characters: words * 2,
      rawWordDelta: delta, finalWordDelta: 0, rawCharDelta: delta, finalCharDelta: 0 }));
    const report = pairedSpeakerBootstrap(input);
    expect(report.seed).toBe(0x5eedc0de);
    expect(report.interval.raw.wer[0]).toBeCloseTo(-0.12, 14);
    expect(report.interval.raw.wer[1]).toBeCloseTo(1 / 3, 14);
    const swapped = pairedSpeakerBootstrap(input.map((g) => ({ ...g, rawWordDelta: -g.rawWordDelta, rawCharDelta: -g.rawCharDelta })));
    expect(swapped.interval.raw.wer[0]).toBeCloseTo(-report.interval.raw.wer[1], 14);
    expect(swapped.interval.raw.wer[1]).toBeCloseTo(-report.interval.raw.wer[0], 14);
  });
  it('перестановка прогонов обращает знак и границы интервала', () => {
    const invert = (x) => ({ ...x, rawWordDelta: -x.rawWordDelta, finalWordDelta: -x.finalWordDelta,
      rawCharDelta: -x.rawCharDelta, finalCharDelta: -x.finalCharDelta });
    const backwards = pairedSpeakerBootstrap([invert(a), invert(b)]);
    expect(backwards.interval.raw.wer[0]).toBe(-1);
    expect(backwards.interval.raw.wer[1]).toBe(0);
    expect(backwards.interval.raw.cer[0]).toBe(-0.5);
    expect(backwards.interval.raw.cer[1]).toBe(0);
  });
  it('один диктор или пустая когорта не выдают ложный узкий интервал', () => {
    for (const groups of [[], [a]]) {
      const report = pairedSpeakerBootstrap(groups);
      expect(report.interval).toBeNull();
      expect(report.reason).toBe('fewer-than-two-speakers');
      expect(report.speakers).toBe(groups.length);
    }
  });
  it('отклоняет повторные группы и неверные знаменатели', () => {
    expect(() => pairedSpeakerBootstrap([a, a])).toThrow(/speaker/i);
    expect(() => pairedSpeakerBootstrap([a, { ...b, words: 0 }])).toThrow(/bootstrap/i);
    expect(() => pairedSpeakerBootstrap([a, { ...b, characters: NaN }])).toThrow(/bootstrap/i);
  });
});
