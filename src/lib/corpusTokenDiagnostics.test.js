// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { summarizeTokenDiagnostics } from '../../scripts/lib/corpus-token-diagnostics.mjs';

const pair = (reference, baseline, candidate = baseline) => ({ reference,
  baseline: { raw: baseline, final: baseline }, candidate: { raw: candidate, final: candidate } });

describe('диагностика буквальных токенов корпуса', () => {
  it('считает разницу количества буквальных токенов по каждому клипу, без вывода текста', () => {
    const result = summarizeTokenDiagnostics([
      pair('не не отправляй 15 15 раз раз', 'не отправляй 15 раз', 'не не отправляй 15 16 раз раз'),
      pair('можно', 'не можно 15', 'можно'),
    ]);
    expect(result).toMatchObject({ speechClips: 2, raw: {
      negation: { referenceOccurrences: 2, baseline: { matched: 1, referenceExcess: 1, hypothesisExcess: 1 },
        candidate: { matched: 2, referenceExcess: 0, hypothesisExcess: 0 }, delta: { referenceExcess: -1, hypothesisExcess: -1 } },
      asciiDigits: { referenceOccurrences: 2, baseline: { matched: 1, referenceExcess: 1, hypothesisExcess: 1 },
        candidate: { matched: 1, referenceExcess: 1, hypothesisExcess: 1 }, delta: { referenceExcess: 0, hypothesisExcess: 0 } },
      adjacentRepeat: { referenceOccurrences: 3, baseline: { matched: 0, referenceExcess: 3, hypothesisExcess: 0 },
        candidate: { matched: 2, referenceExcess: 1, hypothesisExcess: 0 } },
    } });
    const output = JSON.stringify(result);
    expect(output).not.toMatch(/отправляй|можно|"15"|"16"/);
  });
  it('не сводит токены разных клипов и не считает перестановку распознаванием смысла', () => {
    const result = summarizeTokenDiagnostics([pair('не отправляй', 'отправляй'), pair('отправляй', 'не отправляй')]);
    expect(result.raw.negation.baseline).toEqual({ matched: 0, referenceExcess: 1, hypothesisExcess: 1 });
    const reordered = summarizeTokenDiagnostics([pair('не можно', 'можно не')]);
    expect(reordered.raw.negation.baseline).toEqual({ matched: 1, referenceExcess: 0, hypothesisExcess: 0 });
  });
  it('нормализует регистр и ё и считает только соседние пары, а не удалённые повторы', () => {
    const result = summarizeTokenDiagnostics([pair('Ёлка елка елка 42 API42 42 НЕ', 'елка другая елка 42 api42 42 не')]);
    expect(result.raw.adjacentRepeat).toMatchObject({ referenceOccurrences: 2, baseline: { matched: 0, referenceExcess: 2 } });
    expect(result.raw.asciiDigits).toMatchObject({ referenceOccurrences: 2, baseline: { matched: 2, referenceExcess: 0 } });
    expect(result.raw.negation.baseline.matched).toBe(1);
  });
  it('различает точные числовые токены и считает перекрывающиеся повторы', () => {
    const result = summarizeTokenDiagnostics([pair('не нет ни нельзя 03 5 да да да', 'нет нельзя 3 5 да да')]);
    expect(result.raw.negation).toMatchObject({ referenceOccurrences: 4, baseline: { matched: 2, referenceExcess: 2 } });
    expect(result.raw.asciiDigits).toMatchObject({ referenceOccurrences: 2, baseline: { matched: 1, referenceExcess: 1, hypothesisExcess: 1 } });
    expect(result.raw.adjacentRepeat).toMatchObject({ referenceOccurrences: 2, baseline: { matched: 1, referenceExcess: 1 } });
  });
  it('перестановка прогонов обращает знак разницы и повторные прогоны детерминированы', () => {
    const input = [pair('не 15 15', 'нет 15', 'не 15 15')];
    const forward = summarizeTokenDiagnostics(input);
    const reverse = summarizeTokenDiagnostics(input.map(({ reference, baseline, candidate }) => ({ reference, baseline: candidate, candidate: baseline })));
    expect(forward.raw.negation.delta.referenceExcess).toBe(-1);
    expect(reverse.raw.negation.delta.referenceExcess).toBe(1);
    expect(forward.raw.asciiDigits.delta.referenceExcess).toBe(-1);
    expect(reverse.raw.asciiDigits.delta.referenceExcess).toBe(1);
    expect(summarizeTokenDiagnostics(input)).toEqual(forward);
  });
  it('фиксированный набор AI, API, SDK, SaaS, B2B сравнивается буквально и учитывает повторы', () => {
    const result = summarizeTokenDiagnostics([pair('AI API API SDK SaaS B2B api42', 'api SDK ай саас б2б api42', 'ai api api sdk saas b2b')]);
    expect(result.raw.technicalLiterals).toMatchObject({ referenceOccurrences: 6,
      baseline: { matched: 2, referenceExcess: 4, hypothesisExcess: 0 },
      candidate: { matched: 6, referenceExcess: 0, hypothesisExcess: 0 }, delta: { referenceExcess: -4 } });
    expect(JSON.stringify(result)).not.toMatch(/api42|саас|б2б/i);
  });
  it('пустая когорта — null, недопустимые и слишком длинные входы отклоняются', () => {
    expect(summarizeTokenDiagnostics([])).toEqual({ speechClips: 0, raw: null, final: null });
    expect(() => summarizeTokenDiagnostics([pair('x', 'x'.repeat(200001))])).toThrow(/diagnostic/i);
    expect(() => summarizeTokenDiagnostics([pair('x', null)])).toThrow(/diagnostic/i);
  });
});
