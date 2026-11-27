/** Разделы, которые разрешено заменить за одну запись профиля. */
const ARRAY_KEYS = new Set(['zs.dictations', 'zs.dictionary', 'zs.snippets', 'zs.hotkeys', 'zs.presets', 'zs.instructions']);
const OBJECT_KEYS = new Set(['zs.settings', 'zs.stats', 'zs.profile']);

function buildBackupChanges(data, previousSettings = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.keys(data).length) throw new Error('invalid sections');
  for (const [key, value] of Object.entries(data)) {
    if (ARRAY_KEYS.has(key)) {
      if (!Array.isArray(value)) throw new Error('invalid section');
    } else if (OBJECT_KEYS.has(key)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid section');
    } else throw new Error('invalid section');
  }
  const changes = { ...data };
  if (Object.hasOwn(data, 'zs.settings')) {
    const settings = data['zs.settings'];
    changes['zs:settings'] = settings;
    if ((previousSettings.whisperModel && settings.whisperModel && previousSettings.whisperModel !== settings.whisperModel) ||
        (previousSettings.recognitionEngine !== 'whisper' && settings.recognitionEngine === 'whisper')) {
      changes['zs:modelPinned'] = true;
      changes['zs:autoDowngraded'] = false;
    }
  }
  if (Object.hasOwn(data, 'zs.dictionary')) {
    // Соответствует src/lib/dictionary/rank.js; тест сверяет оба порядка.
    changes['zs:dictionary'] = [...data['zs.dictionary']].sort((a, b) =>
      Number(Boolean(b?.pinned)) - Number(Boolean(a?.pinned)) ||
      Number(b?.hits || 0) - Number(a?.hits || 0) ||
      Number(b?.lastUsedAt || 0) - Number(a?.lastUsedAt || 0) ||
      Number(b?.createdAt || 0) - Number(a?.createdAt || 0));
  }
  return changes;
}
module.exports = { buildBackupChanges };
