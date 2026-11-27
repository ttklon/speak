import { describe, expect, it } from 'vitest';
import { analyseQuality, qualityReportText, shortModel } from './qualityReport.js';

const entry = (patch = {}) => ({
  text: 'проверка',
  durationMs: 3000,
  spokenMs: 3000,
  sttMs: 900,
  sttModel: 'ggml-small-q5_1.bin',
  ...patch,
});

describe('shortModel', () => {
  it('убирает префикс и расширение', () => {
    expect(shortModel('ggml-small-q5_1.bin')).toBe('small-q5_1');
    expect(shortModel('')).toBe('');
  });
});

describe('analyseQuality', () => {
  it('мало данных — честно говорит, что разбирать нечего', () => {
    const res = analyseQuality([entry(), entry()]);
    expect(res.enough).toBe(false);
    expect(res.verdicts[0].level).toBe('unknown');
    expect(res.verdicts[0].hint).toMatch(/3/);
  });

  it('записи без служебных полей не считаются данными', () => {
    const res = analyseQuality([
      { text: 'старая запись' },
      { text: 'ещё одна' },
      entry(),
      entry(),
      entry(),
    ]);
    expect(res.analysed).toBe(3);
    expect(res.total).toBe(5);
  });

  it('частый второй проход — это предупреждение с советом', () => {
    const res = analyseQuality([
      entry({ sttSecondPass: true }),
      entry({ sttSecondPass: true }),
      entry({ sttThorough: true }),
    ]);
    const verdict = res.verdicts.find((v) => /Второй проход отмечен/i.test(v.title));
    expect(verdict?.level).toBe('warn');
    expect(verdict?.hint).toMatch(/не доказывает ошибку/);
    expect(res.secondPass.samples).toBe(2);
  });

  it('тихий звук считается по усилению, а не по громкости', () => {
    const res = analyseQuality([
      entry({ sttGainDb: 14 }),
      entry({ sttGainDb: 12 }),
      entry({ sttGainDb: 2 }),
    ]);
    const quiet = res.verdicts.find((v) => /усиление/i.test(v.title));
    expect(quiet?.level).toBe('warn');
    expect(res.quiet.count).toBe(2);
    expect(res.quiet.maxGain).toBe(14);
    expect(quiet?.hint).toContain('+14');
  });

  it('медленный счёт отличается от медленного микрофона', () => {
    const res = analyseQuality([
      entry({ sttMs: 5000, spokenMs: 2000 }),
      entry({ sttMs: 4000, spokenMs: 2000 }),
      entry({ sttMs: 500, spokenMs: 2000 }),
    ]);
    const slow = res.verdicts.find((v) => /Долгое распознавание/i.test(v.title));
    expect(slow?.level).toBe('warn');
    expect(slow?.hint).toMatch(/Причина неизвестна/);
    expect(res.slow.count).toBe(2);
  });

  it('если причин нет — так и говорит, без выдуманных советов', () => {
    const res = analyseQuality([entry(), entry(), entry()]);
    expect(res.verdicts).toHaveLength(1);
    expect(res.verdicts[0].level).toBe('unknown');
    expect(res.verdicts[0].title).toMatch(/точность неизвестна/);
  });

  it('модели считаются по фразам, а не по времени', () => {
    const res = analyseQuality([
      entry(),
      entry({ sttModel: 'ggml-base-q5_1.bin' }),
      entry({ sttModel: 'ggml-base-q5_1.bin', sttSecondPass: true }),
    ]);
    expect(res.models[0]).toEqual({ model: 'base-q5_1', count: 2, secondPass: 1 });
  });

  it('паузы суммируются по всем фразам', () => {
    const res = analyseQuality([
      entry({ sttPausesMs: 1200 }),
      entry({ sttPausesMs: 800 }),
      entry(),
    ]);
    expect(res.pausesMs).toBe(2000);
  });

  it('не падает на пустой истории', () => {
    const res = analyseQuality([]);
    expect(res.analysed).toBe(0);
    expect(res.models).toEqual([]);
  });
});

describe('qualityReportText', () => {
  const report = analyseQuality([
    entry({ sttGainDb: 14, sttSecondPass: true }),
    entry({ sttPausesMs: 1200 }),
    entry(),
  ]);

  it('это текст для чата: числа и модель, без самой диктовки', () => {
    const text = qualityReportText(report, { version: '1.33.0', at: 0 });
    expect(text).toMatch(/ZSpeakly 1\.33\.0/);
    expect(text).toContain('Второй проход отмечен: 1');
    expect(text).toContain('small-q5_1');
    expect(text).not.toContain('проверка');
  });

  it('без истории тоже осмысленный текст', () => {
    const text = qualityReportText(analyseQuality([]));
    expect(text).toMatch(/Фраз в истории: 0/);
    expect(text).toMatch(/нечего разбирать|Пока/);
  });
});

describe('диагностика не выдумывает отсутствующие измерения', () => {
  it('одни имена моделей не говорят ни о громкости, ни о скорости, ни о точности', () => {
    const report = analyseQuality(Array.from({ length: 3 }, () => ({ sttModel: 'small' })));
    const text = qualityReportText(report, { at: 0 });
    expect(report.secondPass.samples).toBe(0);
    expect(report.quiet.samples).toBe(0);
    expect(report.slow.samples).toBe(0);
    expect(text).not.toMatch(/звук громкий|быстрее речи|значит дело/i);
    expect(text).toMatch(/нет данных/i);
    expect(text).toMatch(/не (оценивает|измеряет|измеряют) точность/i);
  });
  it('делит долю вторых проходов только на явно известные значения, не на все записи', () => {
    const report = analyseQuality([
      { sttSecondPass: true }, { sttSecondPass: false }, { sttModel: 'small' },
      { sttSecondPass: null }, { sttSecondPass: 'false' },
    ]);
    expect(report.secondPass.samples).toBe(2);
    expect(qualityReportText(report, { at: 0 })).toMatch(/Второй проход отмечен: 1; отсутствие отметки/);
  });
  it('ноль — известное измерение, null, пустая строка и некорректные значения — нет', () => {
    const report = analyseQuality([
      { sttGainDb: 0, sttMs: 2000, spokenMs: 1000, sttPausesMs: 0 },
      { sttGainDb: null, sttMs: null, spokenMs: 1000, sttPausesMs: null },
      { sttGainDb: '', sttMs: 0, spokenMs: 0 },
      { sttGainDb: '15', sttMs: 500, spokenMs: NaN },
    ]);
    expect(report.quiet.samples).toBe(1);
    expect(report.slow.samples).toBe(1);
    expect(report.pausesSamples).toBe(1);
    expect(report.quiet.count).toBe(0);
    expect(qualityReportText(report, { at: 0 })).toMatch(/Усиление.*0 из 1/);
  });
});


it('старый файл не приписывается выбранной, но неподтверждённой модели', () => {
  const report = analyseQuality([{ source: 'file', sttModel: 'small-q5_1' }]);
  expect(report.models[0].model).toBe('файл: фактическая модель неизвестна');
});
