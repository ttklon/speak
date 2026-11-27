/** Эвристики могут принять осознанный повтор за петлю или эхо подсказки.
 * Режим сохранения текста не позволяет им вырезать слова из ответа Whisper.
 * Фильтр тишины/галлюцинаций и остальные стадии работают отдельно. */
const { collapseRepetition, looksLikeLoop } = require('./textGuard.cjs');
const { stripPromptEcho } = require('./textQuality.cjs');

function processWhisperText(text, tail, { preserve = false, partial = false } = {}) {
  const original = String(text || '');
  let result = original;
  let collapsed = false;
  let echoRemoved = false;
  if (!preserve && result) {
    const next = collapseRepetition(result);
    collapsed = next !== result;
    result = next;
  }
  if (!preserve && !partial && result) {
    const next = stripPromptEcho(result, tail);
    // Полное совпадение может быть намеренным повторением сказанного.
    if (next !== result && next.trim().length >= 2) {
      result = next;
      echoRemoved = true;
    }
  }
  return { text: result, collapsed, echoRemoved, loop: collapsed && looksLikeLoop(original) };
}
module.exports = { processWhisperText };
