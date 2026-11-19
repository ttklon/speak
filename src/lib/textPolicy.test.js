import { describe, expect, it } from 'vitest';
import { textPolicy } from './textPolicy.js';

describe('что приложение делает с текстом', () => {
  it('по умолчанию чистит, правит оговорки, оформляет и зовёт модель', () => {
    const p = textPolicy({});
    expect(p).toMatchObject({
      preserve: false,
      clean: true,
      fixSelfCorrections: true,
      formatForApp: true,
      rewriteWithModel: true,
    });
  });

  it('«не трогать мой текст» выключает все правки, но не указания человека', () => {
    const p = textPolicy({ preserveText: true });
    expect(p).toMatchObject({
      preserve: true,
      clean: false,
      fixSelfCorrections: false,
      formatForApp: false,
      rewriteWithModel: false,
      keepDictionary: true,
      keepVoiceCommands: true,
      keepSnippets: true,
    });
  });

  it('выключенная постобработка тоже убирает чистку и модель', () => {
    const p = textPolicy({ aiProcessing: false });
    expect(p.clean).toBe(false);
    expect(p.rewriteWithModel).toBe(false);
  });

  it('модель не зовётся, если её выключили отдельно', () => {
    expect(textPolicy({ aiDictationRewrite: false }).rewriteWithModel).toBe(false);
    expect(textPolicy({ aiDictationRewrite: false }).clean).toBe(true);
  });

  it('«не трогать» сильнее остальных тумблеров', () => {
    const p = textPolicy({ preserveText: true, aiProcessing: true, aiDictationRewrite: true });
    expect(p.clean).toBe(false);
    expect(p.formatForApp).toBe(false);
    expect(p.rewriteWithModel).toBe(false);
  });
});
