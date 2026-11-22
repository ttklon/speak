/** Подготовка резервной копии до изменения состояния приложения. */
import { DEFAULT_SETTINGS } from './config.js';
import { trimDictations } from './dictationBudget.js';
import { sanitizeDictionary, sanitizeHotkeys, sanitizeInstructions, sanitizePresets, sanitizeStats } from './sanitize.js';
import { sanitizeSnippets, SNIPPET_LIMITS } from './snippets.js';
import { sanitizeAppProfiles } from './appProfiles.js';

const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const fail = (section) => { throw new Error(`Некорректный раздел копии: ${section}. Текущие данные не изменены.`); };
const strings = ['rawText', 'language', 'command', 'fileName', 'sttModel', 'sttMode'];
const numbers = ['durationMs', 'words', 'createdAt', 'editedAt', 'sttMs', 'spokenMs', 'sttParts', 'sttPreParts', 'sttGainDb', 'sttPausesMs', 'waitMs'];
const flags = ['undone', 'sttWarm', 'sttThorough', 'sttSecondPass'];

function restoreHistory(list) {
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
      if (item[key] != null && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0)) fail(`словарь: ${key}`);
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
  if (payload.app && payload.app !== 'ZSpeakly') throw new Error('копия от другого приложения');
  if (payload.format != null && payload.format !== 1) throw new Error('неподдерживаемая версия резервной копии');
  const lists = ['dictations', 'dictionary', 'snippets', 'voiceHotkeys', 'presets', 'instructions'];
  for (const key of lists) if (has(payload, key) && !Array.isArray(payload[key])) fail(key);
  for (const key of ['settings', 'stats', 'profile']) if (has(payload, key) && !isObject(payload[key])) fail(key);
  if (!lists.some((key) => has(payload, key)) && !has(payload, 'settings')) throw new Error('в файле нет данных ZSpeakly');
  const result = {};
  if (has(payload, 'settings')) {
    for (const [key, value] of Object.entries(payload.settings)) {
      if (!has(DEFAULT_SETTINGS, key)) continue;
      const expected = DEFAULT_SETTINGS[key];
      const valid = Array.isArray(expected) ? Array.isArray(value) : typeof expected === typeof value;
      if (!valid && !(key === 'liveWhisper' && typeof value === 'boolean')) fail(`настройки: ${key}`);
    }
    if (has(payload.settings, 'dictationKeys') && payload.settings.dictationKeys.some((key) => typeof key !== 'string')) fail('настройки: dictationKeys');
    result.settings = { ...DEFAULT_SETTINGS, ...payload.settings };
    if (has(payload.settings, 'appProfiles')) {
      const profiles = sanitizeAppProfiles(payload.settings.appProfiles);
      if (profiles.length !== payload.settings.appProfiles.length) fail('настройки: правила приложений');
      result.settings.appProfiles = profiles;
    }
  }
  if (has(payload, 'dictations')) result.dictations = restoreHistory(payload.dictations);
  if (has(payload, 'dictionary')) result.dictionary = restoreDictionary(payload.dictionary);
  if (has(payload, 'snippets')) {
    for (const item of payload.snippets) {
      if (!isObject(item) || typeof item.trigger !== 'string' || typeof item.body !== 'string' ||
        item.trigger.replace(/\s+/gu, ' ').trim().length > SNIPPET_LIMITS.trigger || item.body.length > SNIPPET_LIMITS.body) fail('быстрые блоки');
    }
    result.snippets = sanitizeSnippets(payload.snippets);
    if (result.snippets.length !== payload.snippets.length) fail('быстрые блоки');
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
  if (has(payload, 'stats')) result.stats = sanitizeStats(payload.stats);
  if (has(payload, 'profile')) {
    if (payload.profile.name != null && typeof payload.profile.name !== 'string') fail('профиль');
    result.profile = { name: String(payload.profile.name || '').slice(0, 40) };
  }
  return result;
}
