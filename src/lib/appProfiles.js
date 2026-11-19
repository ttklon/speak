/**
 * Профиль под активное окно: в каком приложении на каком языке диктовать.
 *
 * Зачем: один и тот же человек пишет в мессенджере по-русски, а в редакторе
 * кода — по-английски. Переключать язык в настройках перед каждой фразой — это
 * та работа, из-за которой диктовкой перестают пользоваться. VoiceInk называет
 * это Power Mode, Amical — контекстом приложения; у нас уже есть оформление
 * под окно, и язык — следующий шаг той же мысли.
 *
 * Правила намеренно простые и предсказуемые:
 *  1) правило совпадает по имени программы («Telegram») или по части заголовка
 *     окна («Visual Studio Code»);
 *  2) сначала ищется совпадение по имени программы, потом по заголовку — так
 *     «Slack» в заголовке чужого браузера не перебьёт настоящее приложение;
 *  3) внутри прохода работает порядок правил, заданный человеком.
 *
 * Ничего не угадываем: нет правила — остаётся общий язык из настроек.
 */

import { LANGUAGES } from './config.js';

export const APP_PROFILE_LIMITS = {
  /** Длина строки «приложение или часть заголовка». */
  match: 40,
  /** Сколько правил имеет смысл держать: больше — уже не «профиль», а справочник. */
  rules: 12,
};

const LANGUAGE_IDS = new Set(LANGUAGES.map((l) => l.id));

/** Приведение к сравнимому виду: регистр, пробелы, «.exe», кавычки. */
export function normalizeMatch(text = '') {
  return String(text)
    .toLowerCase()
    .replace(/\.exe\b/g, '')
    .replace(/[«»"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Правила в безопасном виде: только известные языки и непустые совпадения. */
export function sanitizeAppProfiles(stored) {
  const list = Array.isArray(stored) ? stored : [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const match = String(item.match || '').trim().slice(0, APP_PROFILE_LIMITS.match);
    const language = String(item.language || '').trim();
    if (!match || !LANGUAGE_IDS.has(language)) continue;
    const key = normalizeMatch(match);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: item.id || `app-${out.length + 1}`,
      match,
      language,
    });
    if (out.length >= APP_PROFILE_LIMITS.rules) break;
  }
  return out;
}

/**
 * Какое правило подходит активному окну.
 * @param {{app?: string, title?: string}} target данные активного окна
 * @param {Array<{match: string, language: string}>} rules правила человека
 */
export function matchAppProfile(target, rules = []) {
  const list = sanitizeAppProfiles(rules);
  if (!list.length) return null;
  const app = normalizeMatch(target?.app || '');
  const title = normalizeMatch(target?.title || '');
  // «своё окно» — это не чужое приложение: профиль не применяем, иначе диктовка
  // внутри ZSpeakly зависела бы от того, что осталось в памяти от прошлого окна
  if (target?.own) return null;

  for (const rule of list) {
    const key = normalizeMatch(rule.match);
    if (!key) continue;
    if (app && (app === key || app.startsWith(`${key} `))) return rule;
  }
  if (title) {
    for (const rule of list) {
      const key = normalizeMatch(rule.match);
      if (key && title.includes(key)) return rule;
    }
  }
  return null;
}

/** Язык для диктовки в этом окне: правило или общий язык настроек. */
export function languageForTarget(target, rules, fallback = 'ru') {
  const rule = matchAppProfile(target, rules);
  return rule?.language || fallback;
}

/** Понятная подпись правила: «Telegram → Английский». */
export function describeAppProfile(rule) {
  const label = LANGUAGES.find((l) => l.id === rule?.language)?.native || rule?.language || '';
  return `${rule?.match || ''} → ${label}`;
}
