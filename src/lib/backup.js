/** Подготовка резервной копии до изменения состояния приложения. */
import { DEFAULT_SETTINGS } from './config.js';
import { DICTATION_MAX_ITEMS, trimDictations } from './dictationBudget.js';
import { sanitizeDictionary, sanitizeHotkeys, sanitizeInstructions, sanitizePresets, sanitizeStats } from './sanitize.js';
import { sanitizeSnippets } from './snippets.js';
import { APP_PROFILE_LIMITS, sanitizeAppProfiles } from './appProfiles.js';

// Ограничиваем чтение до JSON.parse: история по умолчанию до 8 МиБ UTF-16,
// но в копии есть также настройки и словарь. Большую копию не уничтожаем:
// её можно сохранить и разбирать вручную, автоматический импорт её отклоняет.
export const BACKUP_MAX_BYTES = 32 * 1024 * 1024;
export const BACKUP_FORMAT = 1;

export async function readBackupJsonFile(file) {
  if (!file || typeof file.size !== 'number' || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw new Error('не удалось определить размер файла');
  }
  if (file.size > BACKUP_MAX_BYTES) {
    throw new Error('размер файла больше 32 МиБ: автоматическое восстановление недоступно');
  }
  const text = await file.text();
  try {
    return JSON.parse(text);
  } catch {
    // В ошибке парсера может быть фрагмент частного содержимого файла.
    throw new Error('это не JSON-файл: выберите копию, скачанную из ZSpeakly');
  }
}

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const LIST_SECTIONS = ['dictations', 'dictionary', 'snippets', 'voiceHotkeys', 'presets', 'instructions'];
const OBJECT_SECTIONS = ['settings', 'stats', 'profile'];
const KNOWN_FIELDS = new Set(['app', 'format', 'exportedAt', ...LIST_SECTIONS, ...OBJECT_SECTIONS]);

/** Предупреждение о совместимости без раскрытия неизвестных имён или значений. */
export function describeBackupCompatibility(payload) {
  if (!isObject(payload)) throw new Error('это не файл резервной копии ZSpeakly');
  return {
    legacy: !has(payload, 'app') || !has(payload, 'format'),
    ignoredFields: Object.keys(payload).filter((key) => !KNOWN_FIELDS.has(key)).length,
  };
}

const fail = (section) => { throw new Error(`Некорректный раздел копии: ${section}. Текущие данные не изменены.`); };
const strings = ['rawText', 'language', 'command', 'fileName', 'sttModel', 'sttMode', 'sttModelSource'];
const numbers = ['durationMs', 'words', 'createdAt', 'editedAt', 'sttMs', 'spokenMs', 'sttParts', 'sttPreParts', 'sttGainDb', 'sttPausesMs', 'waitMs'];
const flags = ['undone', 'sttWarm', 'sttThorough', 'sttSecondPass'];

function restoreHistory(list) {
  // Проверяем количество до обхода и выделения второй большой коллекции.
  if (list.length > DICTATION_MAX_ITEMS) {
    throw new Error('История из копии превышает лимит приложения. Текущие данные не изменены.');
  }
  const ids = new Set();
  const result = list.map((item, index) => {
    if (!isObject(item) || typeof item.text !== 'string' || !item.text.trim()) fail('диктовки');
    const id = item.id == null ? `d-import-${Date.now()}-${index}` : item.id;
    if (typeof id !== 'string' || !id || ids.has(id)) fail('идентификаторы диктовок');
    ids.add(id);
    const restored = { id, text: item.text };
    for (const key of strings) {
      if (item[key] == null) continue;
      if (typeof item[key] !== 'string') fail(`диктовки: ${key}`);
      restored[key] = item[key];
    }
    for (const key of numbers) {
      if (item[key] == null) continue;
      if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0) fail(`диктовки: ${key}`);
      restored[key] = item[key];
    }
    for (const key of flags) {
      if (item[key] == null) continue;
      if (typeof item[key] !== 'boolean') fail(`диктовки: ${key}`);
      restored[key] = item[key];
    }
    restored.createdAt = restored.createdAt || Date.now();
    restored.durationMs = restored.durationMs || 0;
    restored.words = restored.words ?? item.text.trim().split(/\s+/).length;
    restored.source = ['dictation', 'file', 'command', 'agent', 'import'].includes(item.source) ? item.source : 'import';
    return restored;
  });
  // Отказ лучше тихого удаления старых записей, в том числе после перезапуска.
  if (trimDictations(result).length !== result.length) {
    throw new Error('История из копии превышает лимит приложения. Текущие данные не изменены.');
  }
  return result;
}

function restoreDictionary(list) {
  const ids = new Set();
  const records = list.map((item, index) => {
    if (!isObject(item) || typeof item.word !== 'string' || !item.word.trim()) fail('словарь');
    const id = item.id == null ? `w-import-${Date.now()}-${index}` : item.id;
    if (typeof id !== 'string' || !id || ids.has(id)) fail('идентификаторы словаря');
    ids.add(id);
    if (item.pronunciation != null && typeof item.pronunciation !== 'string') fail('произношение');
    if (item.pinned != null && typeof item.pinned !== 'boolean') fail('закрепление слова');
    for (const key of ['hits', 'lastUsedAt', 'createdAt']) {
      if (item[key] != null && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0 ||
        (key === 'hits' && !Number.isSafeInteger(item[key])))) fail(`словарь: ${key}`);
    }
    return {
      id, word: item.word.trim(), pronunciation: item.pronunciation || '', pinned: item.pinned === true,
      hits: item.hits || 0, lastUsedAt: item.lastUsedAt || 0, createdAt: item.createdAt || Date.now(),
    };
  });
  return sanitizeDictionary(records);
}

function validateActions(list, section) {
  const ids = new Set();
  for (const item of list) {
    if (!isObject(item)) fail(section);
    if (item.id != null && (typeof item.id !== 'string' || !item.id || ids.has(item.id))) fail(section);
    if (item.id) ids.add(item.id);
    if (section === 'сочетания' && !item.id) fail(section);
    if (section !== 'сочетания' && !(typeof item.title === 'string' && item.title.trim()) && !(section === 'AI-инструкции' && typeof item.name === 'string' && item.name.trim())) fail(section);
    for (const key of ['title', 'description', 'prompt', 'text', 'name']) {
      if (item[key] != null && typeof item[key] !== 'string') fail(section);
    }
    if (item.keys != null && (!Array.isArray(item.keys) || item.keys.some((key) => typeof key !== 'string'))) fail(section);
    if (section === 'сочетания' && !Array.isArray(item.keys)) fail(section);
    if (item.enabled != null && typeof item.enabled !== 'boolean') fail(section);
  }
}

/** Валидирует всё заранее; отсутствующие разделы не заменяют текущие данные. */
export function prepareBackup(payload) {
  if (!isObject(payload)) throw new Error('это не файл резервной копии ZSpeakly');
  // Немаркированные частичные копии поддерживаем ради совместимости. Если
  // метка присутствует, пустое или некорректное значение не означает старую версию.
  if (has(payload, 'app') && payload.app !== 'ZSpeakly') throw new Error('копия от другого приложения или неверная метка приложения');
  if (has(payload, 'format') && payload.format !== BACKUP_FORMAT) throw new Error('неподдерживаемая версия резервной копии');
  if (payload.exportedAt != null && typeof payload.exportedAt !== 'string') throw new Error('некорректная дата резервной копии');
  for (const key of LIST_SECTIONS) if (has(payload, key) && !Array.isArray(payload[key])) fail(key);
  for (const key of OBJECT_SECTIONS) if (has(payload, key) && !isObject(payload[key])) fail(key);
  if (![...LIST_SECTIONS, ...OBJECT_SECTIONS].some((key) => has(payload, key))) throw new Error('в файле нет данных ZSpeakly');
  const result = {};
  if (has(payload, 'settings')) {
    for (const [key, value] of Object.entries(payload.settings)) {
      if (key === '__proto__' || key === 'prototype' || key === 'constructor') fail('настройки: недопустимый ключ');
      if (!has(DEFAULT_SETTINGS, key)) continue;
      const expected = DEFAULT_SETTINGS[key];
      const valid = Array.isArray(expected) ? Array.isArray(value) : typeof expected === typeof value;
      if ((!valid && !(key === 'liveWhisper' && typeof value === 'boolean')) ||
        (typeof value === 'number' && !Number.isFinite(value))) fail(`настройки: ${key}`);
    }
    if (has(payload.settings, 'dictationKeys') && payload.settings.dictationKeys.some((key) => typeof key !== 'string')) fail('настройки: dictationKeys');
    result.settings = { ...DEFAULT_SETTINGS, ...payload.settings };
    if (has(payload.settings, 'appProfiles')) {
      const ids = new Set();
      for (const item of payload.settings.appProfiles) {
        if (!isObject(item) || typeof item.match !== 'string' || typeof item.language !== 'string' ||
          item.match.trim().length > APP_PROFILE_LIMITS.match ||
          (item.id != null && (typeof item.id !== 'string' || !item.id || ids.has(item.id)))) fail('настройки: правила приложений');
        if (item.id) ids.add(item.id);
      }
      const profiles = sanitizeAppProfiles(payload.settings.appProfiles);
      if (profiles.length !== payload.settings.appProfiles.length || new Set(profiles.map((item) => item.id)).size !== profiles.length) fail('настройки: правила приложений');
      result.settings.appProfiles = profiles;
    }
  }
  if (has(payload, 'dictations')) result.dictations = restoreHistory(payload.dictations);
  if (has(payload, 'dictionary')) result.dictionary = restoreDictionary(payload.dictionary);
  if (has(payload, 'snippets')) {
    const ids = new Set();
    for (const item of payload.snippets) {
      if (!isObject(item) || typeof item.trigger !== 'string' || typeof item.body !== 'string' ||
        (item.createdAt != null && (typeof item.createdAt !== 'number' || !Number.isFinite(item.createdAt) || item.createdAt < 0)) ||
        (item.id != null && (typeof item.id !== 'string' || !item.id || ids.has(item.id)))) fail('быстрые блоки');
      if (item.id) ids.add(item.id);
    }
    result.snippets = sanitizeSnippets(payload.snippets);
    if (result.snippets.length !== payload.snippets.length || new Set(result.snippets.map((item) => item.id)).size !== result.snippets.length) fail('быстрые блоки');
  }
  if (has(payload, 'voiceHotkeys')) {
    validateActions(payload.voiceHotkeys, 'сочетания');
    result.voiceHotkeys = sanitizeHotkeys(payload.voiceHotkeys);
  }
  if (has(payload, 'presets')) {
    validateActions(payload.presets, 'AI-инструкции');
    result.presets = sanitizePresets(payload.presets);
  }
  if (has(payload, 'instructions')) {
    validateActions(payload.instructions, 'свои инструкции');
    result.instructions = sanitizeInstructions(payload.instructions);
  }
  if (has(payload, 'stats')) {
    for (const key of ['wordsTotal', 'secondsTotal', 'sessions']) {
      if (!has(payload.stats, key)) continue; // В старой копии поля могло не быть.
      const value = payload.stats[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        (key !== 'secondsTotal' && !Number.isSafeInteger(value))) fail(`счётчики: ${key}`);
    }
    result.stats = sanitizeStats(payload.stats);
  }
  if (has(payload, 'profile')) {
    if (payload.profile.name != null && typeof payload.profile.name !== 'string') fail('профиль');
    // Старый профиль может содержать более длинное имя: не обрезаем его при импорте.
    result.profile = { name: payload.profile.name || '' };
  }
  return result;
}
