/**
 * Исполнитель «AI-инструкций»: одна функция на все пресеты и свои инструкции.
 *
 * Порядок: локальная LLM (Ollama), если она включена и ответила, иначе
 * офлайн-правила. Возвращает готовую строку — её сразу можно вставлять.
 */

import { OPS, llmRewrite } from './textops.js';
import { translate } from '../translate.js';

const PRESET_OPS = {
  'to-english': 'translate',
  formal: 'formal',
  shorten: 'shorten',
  'search-mode': 'search',
  'low-terms': 'terms',
  'to-formal': 'formal',
  'to-short': 'shorten',
};

/** Догадка по тексту промпта для инструкций, созданных пользователем. */
function guessOp(prompt = '') {
  const p = String(prompt).toLowerCase();
  if (/перев|translate|англ|english/.test(p)) return 'translate';
  if (/официальн|формальн|formal|делов/.test(p)) return 'formal';
  if (/сократ|короч|shorten|короче/.test(p)) return 'shorten';
  if (/поисков|запрос|search/.test(p)) return 'search';
  if (/термин|прост|объясн/.test(p)) return 'terms';
  if (/пункт|список|bullet|тезис/.test(p)) return 'bullets';
  if (/резюме|итог|summary|кратко/.test(p)) return 'summary';
  return 'clean';
}

function offlineRun(op, text, settings = {}) {
  switch (op) {
    case 'translate': {
      const result = translate(text, {
        from: settings.language || 'ru',
        to: settings.translateTarget || 'en',
        settings,
      });
      return result?.text ?? result;
    }
    case 'formal':
      return OPS.formal(text);
    case 'shorten':
      return OPS.shorten(text);
    case 'search':
      return OPS.searchQuery(text);
    case 'terms':
      return OPS.lowerTerms(text);
    case 'bullets':
      return OPS.bullets(text);
    case 'summary':
      return OPS.summary(text);
    default:
      return OPS.clean(text);
  }
}

/**
 * @param {object} instruction  {id, title, prompt, kind?}
 * @param {string} text         выделенный текст
 * @param {object} settings     настройки приложения (LLM, язык)
 * @returns {Promise<string>}   переписанный текст
 */
export async function runInstruction(instruction, text, settings = {}) {
  const source = String(text || '').trim();
  if (!source) return '';
  const op = PRESET_OPS[instruction?.id] || guessOp(instruction?.prompt || instruction?.title || '');
  const prompt = instruction?.prompt || '';

  if (settings.aiProcessing && settings.aiEndpoint && prompt) {
    const llm = await llmRewrite({
      endpoint: settings.aiEndpoint,
      model: settings.aiModel,
      system: `${prompt} Ответь только результатом, без пояснений.`,
      text: source,
    });
    if (llm) return llm;
  }

  const out = offlineRun(op, source, settings);
  return typeof out === 'string' ? out : '';
}

export default runInstruction;
