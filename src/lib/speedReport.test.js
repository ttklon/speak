import { describe, expect, it } from 'vitest';
import { SPEED_OK_FACTOR, SPEED_TARGET_SECONDS, analyseSpeed } from './speedReport.js';

const dictation = (spokenSeconds, computeSeconds, extra = {}) => ({
  id: `d-${spokenSeconds}-${computeSeconds}`,
  createdAt: 1,
  spokenMs: Math.round(spokenSeconds * 1000),
  sttMs: Math.round(computeSeconds * 1000),
  ...extra,
});

describe('отчёт о скорости диктовки', () => {
  it('без замеров честно говорит «пока нет», а не «всё хорошо»', () => {
    const report = analyseSpeed([]);
    expect(report.verdict).toBe('unknown');
    expect(report.samples).toEqual([]);
    expect(report.advice).toMatch(/замеров пока нет/i);
  });

  it('двадцать секунд за три — укладывается', () => {
    const report = analyseSpeed([dictation(20, 3)]);
    expect(report.verdict).toBe('ok');
    expect(report.samples[0]).toMatchObject({ spoken: 20, compute: 3 });
    expect(report.medianFactor).toBeGreaterThanOrEqual(SPEED_OK_FACTOR);
  });

  it('двадцать секунд за семь — дольше пяти, значит «не успевает»', () => {
    const report = analyseSpeed([dictation(20, 7)]);
    expect(report.verdict).toBe('slow');
    expect(report.worst.compute).toBe(7);
    expect(report.worst.total).toBe(7);
    // Виноват движок — значит речь про режим легче, а не про тумблеры.
    expect(report.computeBound).toBe(true);
    expect(report.advice).toMatch(/режим легче/i);
  });

  it('судят по полному ожиданию, а не только по счёту движка', () => {
    // Движок считал 2 с, но человек ждал 8: «быстро» тут было бы враньём.
    const report = analyseSpeed([dictation(20, 2, { waitMs: 8000 })]);
    expect(report.samples[0]).toMatchObject({ compute: 2, total: 8, tail: 6 });
    expect(report.verdict).toBe('slow');
    // Виновата не модель: совет про «режим легче» был бы вредным.
    expect(report.computeBound).toBe(false);
    expect(report.advice).toContain('не в распознавание');
    expect(report.advice).not.toMatch(/режим легче/);
  });

  it('видно, сколько кусков посчитали заранее, пока человек говорил', () => {
    const report = analyseSpeed([dictation(20, 1.8, { waitMs: 2100, sttPreParts: 2 })]);
    expect(report.samples[0]).toMatchObject({ pre: 2, total: 2.1, compute: 1.8 });
    expect(report.verdict).toBe('ok');
    // без предварительных кусков — ноль, а не «нет данных»
    expect(analyseSpeed([dictation(20, 3)]).samples[0].pre).toBe(0);
  });

  it('старые записи без полного времени судятся по счёту — как раньше', () => {
    const report = analyseSpeed([dictation(20, 3)]);
    expect(report.samples[0]).toMatchObject({ compute: 3, total: 3, tail: 0 });
    expect(report.verdict).toBe('ok');
  });

  it('полное ожидание чуть больше счёта переводит вердикт в «долго»', () => {
    // 4,9 с счёта проходили границу, 5,3 с ожидания — уже нет.
    expect(analyseSpeed([dictation(20, 4.9, { waitMs: 5300 })]).verdict).toBe('slow');
    expect(analyseSpeed([dictation(20, 4.9, { waitMs: 4900 })]).verdict).toBe('ok');
  });

  it('порог — ровно пять секунд и вчетверо быстрее речи', () => {
    // «максимум пять секунд»: ровно пять — ещё укладывается
    expect(analyseSpeed([dictation(20, SPEED_TARGET_SECONDS)]).verdict).toBe('ok');
    expect(analyseSpeed([dictation(20, 5.4)]).verdict).toBe('slow');
    expect(analyseSpeed([dictation(20, 4)]).verdict).toBe('ok');
    // 4,9 с на двадцатисекундную фразу — это 4,1×, проходит обе границы
    expect(analyseSpeed([dictation(20, 4.9)]).verdict).toBe('ok');
  });

  it('короткую фразу не судим по коэффициенту, но пять секунд остаются границей', () => {
    expect(analyseSpeed([dictation(2, 1.2)]).verdict).toBe('ok');
    expect(analyseSpeed([dictation(2, 6)]).verdict).toBe('slow');
  });

  it('мусор и слишком короткие записи не попадают в отчёт', () => {
    const report = analyseSpeed([
      { id: 'a', spokenMs: 0, sttMs: 3000 },
      { id: 'b', spokenMs: 600, sttMs: 900 },
      { id: 'c', spokenMs: 20000, sttMs: 0 },
      dictation(20, 3),
    ]);
    expect(report.samples).toHaveLength(1);
    expect(report.samples[0].spoken).toBe(20);
  });

  it('берёт последние замеры и считает медиану, а не «средний по больнице»', () => {
    const report = analyseSpeed([
      dictation(20, 2),
      dictation(20, 2.2),
      dictation(20, 9), // одна неудачная фраза не должна портить вывод
      dictation(20, 2.1),
      dictation(20, 2.3),
      dictation(20, 2.4),
    ]);
    expect(report.samples).toHaveLength(5);
    expect(report.medianFactor).toBeGreaterThanOrEqual(8);
    expect(report.verdict).toBe('ok');
  });

  it('одна медленная фраза из многих не объявляет всё медленным, но названа', () => {
    const report = analyseSpeed([dictation(20, 2), dictation(20, 9), dictation(20, 2.1)]);
    expect(report.verdict).toBe('ok');
    expect(report.advice).toMatch(/одна диктовка ждала 9 с/);
    // а когда медленных большинство — вердикт честно плохой
    expect(analyseSpeed([dictation(20, 9), dictation(20, 8), dictation(20, 2)]).verdict).toBe('slow');
  });

  it('сообщает худший случай: где именно человек ждал', () => {
    const report = analyseSpeed([dictation(20, 3), dictation(30, 8), dictation(10, 2)]);
    expect(report.worst.compute).toBe(8);
    expect(report.worst.spoken).toBe(30);
  });

  it('режим и число фрагментов сохраняются в замере', () => {
    const report = analyseSpeed([dictation(20, 3, { sttMode: 'server', sttParts: 1 })]);
    expect(report.samples[0].mode).toBe('server');
    expect(report.samples[0].parts).toBe(1);
    // неизвестный режим не выдумывает значение
    expect(analyseSpeed([dictation(20, 3, { sttMode: 'что-то' })]).samples[0].mode).toBe('');
  });

  it('лимит строк уважается', () => {
    const many = Array.from({ length: 12 }, () => dictation(20, 3));
    expect(analyseSpeed(many, { limit: 3 }).samples).toHaveLength(3);
  });
});
