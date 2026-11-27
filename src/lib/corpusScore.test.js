import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { alignWords, characterError, wordError } from '../../scripts/lib/word-error.mjs';
import { scoreCorpus } from '../../scripts/lib/corpus-score.mjs';

const sample = (id, reference, raw, final, tags = []) => ({ id, reference, raw: { status: 'ok', text: raw }, final: { status: 'ok', text: final }, tags });
const corpus = (samples) => ({ version: 1, metadata: { corpus: 'синтетика', model: 'тест', revision: 'v1' }, samples });

describe('выравнивание и ошибки распознавания', () => {
  it('считает замену, удаление и вставку и возвращает воспроизводимое выравнивание', () => {
    const result = alignWords('один два три четыре', 'один другой три пять лишнее');
    expect(result).toMatchObject({ errors: 3, substitutions: 2, deletions: 0, insertions: 1, referenceWords: 4, wer: 0.75 });
    expect(result.alignment.filter((x) => x.type !== 'equal')).toHaveLength(3);
    expect(alignWords('один два три', 'один три')).toMatchObject({ errors: 1, deletions: 1 });
    expect(alignWords('Ёж пришёл', 'еж пришел').errors).toBe(0);
  });
  it('разрешает неоднозначности стабильно и выполняет инварианты WER на разных последовательностях', () => {
    expect(alignWords('a b', 'b a').alignment).toEqual([
      { type: 'substitution', reference: 'a', hypothesis: 'b' },
      { type: 'substitution', reference: 'b', hypothesis: 'a' },
    ]);
    const sequences = ['a', 'b', 'a a', 'a b', 'b a', 'a b a', 'b b a', ''];
    for (const ref of sequences.filter(Boolean)) for (const hyp of sequences) {
      const result = alignWords(ref, hyp);
      expect(result.errors).toBe(wordError(ref, hyp).errors);
      expect(result.errors).toBe(result.substitutions + result.deletions + result.insertions);
      expect(result.alignment.filter((step) => step.type !== 'equal')).toHaveLength(result.errors);
      expect(result.alignment.filter((step) => step.reference !== null).map((step) => step.reference).join(' ')).toBe(ref);
      expect(result.alignment.filter((step) => step.hypothesis !== null).map((step) => step.hypothesis).join(' ')).toBe(hyp);
    }
    expect(alignWords('a', 'a b c').wer).toBe(2);
  });
  it('CER считает нормализованные Unicode-кодовые точки, включая пробел между словами', () => {
    expect(characterError('café дом', 'cafe\u0301 дым')).toMatchObject({ errors: 1, referenceCharacters: 8, cer: 1 / 8 });
    expect(() => characterError('', 'текст')).toThrow(/reference/i);
  });
  it('отклоняет слишком большую матрицу, а не зависает или выдаёт усечённую оценку', () => {
    expect(() => alignWords('a '.repeat(2000), 'b '.repeat(2000))).toThrow(/limit/i);
  });
});

describe('парное сравнение корпуса', () => {
  it('раздельно считает речь и ложные срабатывания на тишине, агрегирует по словам, а не средним WER', () => {
    const report = scoreCorpus(corpus([
      sample('one', 'один два три', 'один три', 'один два три', ['negation']),
      sample('two', 'четыре', 'четыре пять', 'шесть', ['number', 'negation']),
      sample('silent', '', 'продолжение следует', '', ['silence']),
      { id: 'failed', reference: 'важная фраза', raw: { status: 'error' }, final: { status: 'ok', text: '' }, tags: [] },
    ]));
    expect(report.summary).toMatchObject({ speechSamples: 3, pairedSpeech: 2, excludedSpeech: 1, silenceSamples: 1, pairedSilence: 1,
      raw: { errors: 2, referenceWords: 4, wer: 0.5, deletions: 1, insertions: 1 },
      final: { errors: 1, referenceWords: 4, wer: 0.25, substitutions: 1 },
      silence: { rawFalsePositives: 1, finalFalsePositives: 0 } });
    expect(report.categories.negation.pairedSpeech).toBe(2);
    expect(JSON.stringify(report)).not.toContain('продолжение следует');
    expect(report.samples.find((s) => s.id === 'failed').raw.status).toBe('error');
  });
  it('не выдаёт ноль ошибок при ошибке одного из этапов и не включает непарные записи в сравнение', () => {
    const result = scoreCorpus(corpus([{ id: 'f', reference: 'один', raw: { status: 'ok', text: 'один' }, final: { status: 'error' }, tags: [] }]));
    expect(result.summary).toMatchObject({ pairedSpeech: 0, excludedSpeech: 1, raw: { wer: null }, final: { wer: null } });
    expect(result.samples[0].final.status).toBe('error');
  });
  it('отдельно учитывает непарную тишину и безопасно обрабатывает имена категорий', () => {
    const result = scoreCorpus(corpus([
      { id: 's', reference: '', raw: { status: 'ok', text: '...' }, final: { status: 'error' }, tags: ['__proto__', '__proto__'] },
    ]));
    expect(result.summary).toMatchObject({ silenceSamples: 1, pairedSilence: 0, excludedSilence: 1, silence: { rawFalsePositives: 0 } });
    expect(Object.hasOwn(result.categories, '__proto__')).toBe(true);
    expect(result.categories.__proto__.silenceSamples).toBe(1);
  });
  it('отклоняет неполные записи, дубли ID и неподдерживаемые версии', () => {
    expect(() => scoreCorpus(corpus([sample('same', 'а', 'а', 'а'), sample('same', 'б', 'б', 'б')]))).toThrow(/ID/i);
    expect(() => scoreCorpus(corpus([{ id: 'incomplete', reference: 'слово', raw: { status: 'ok', text: '' } }]))).toThrow();
    expect(() => scoreCorpus({ ...corpus([]), version: 2 })).toThrow();
  });
  it('по умолчанию не раскрывает текст, выравнивание включается только явно', () => {
    const data = corpus([sample('a', 'секретная фраза', 'секретная ошибка', 'секретная фраза')]);
    expect(JSON.stringify(scoreCorpus(data))).not.toContain('секретная');
    expect(JSON.stringify(scoreCorpus(data, { alignment: true }))).toContain('секретная');
  });
  it('CLI проверяет синтетический fixture, а не выдаёт оценку живой речи', () => {
    const run = spawnSync(process.execPath, [path.resolve('scripts/score-corpus.mjs'), path.resolve('scripts/fixtures/quality-synthetic.json')], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(run.stdout);
    expect(report.metadata.corpus).toBe('synthetic-fixture-not-audio');
    expect(report.summary.pairedSpeech).toBe(2);
  });
});
