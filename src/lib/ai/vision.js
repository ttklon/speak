/**
 * Контекст экрана для диктовки — «Диктовка с учётом экрана».
 *
 * Кадр экрана (уже снятый в main-процессе, в памяти) отправляется локальной
 * модели Ollama с поддержкой изображений (llava, moondream, qwen2.5vl и т. п.).
 * Модель возвращает только список имён, названий и терминов, которые видно
 * в тексте на экране. Этот список уходит в whisper.cpp как подсказка (`--prompt`),
 * поэтому имена и термины распознаются правильнее.
 *
 * Чего здесь принципиально нет:
 *  • интернета — запрос идёт через main только на локальный адрес;
 *  • записи на диск — кадр живёт в памяти одну диктовку;
 *  • текста диктовки в запросе — модели показывают экран, но не речь.
 */

const PROMPT = [
  'На изображении — экран компьютера с интерфейсом и текстом.',
  'Перечисли через запятую только имена собственные, названия программ,',
  'термины и редкие слова, которые видны в тексте на экране.',
  'Не описывай картинку, не пиши предложений, не добавляй пояснений.',
  'Если текста не видно — ответь пустой строкой.',
].join(' ');

/** Сколько символов контекста имеет смысл отдавать whisper: больше — шум. */
export const MAX_CONTEXT_CHARS = 300;

/**
 * @param {string} dataUrl      data:image/png;base64,… из screen:capture
 * @param {object} opts
 * @param {string} opts.endpoint адрес Ollama (http://localhost:11434)
 * @param {string} opts.model    имя модели (должна уметь изображения)
 * @param {number} opts.timeout  мс
 * @returns {Promise<{ok:boolean, terms:string, reason:string}>}
 */
export async function describeScreen(dataUrl, { endpoint, model, timeout = 15000 } = {}) {
  const bridge = typeof window !== 'undefined' ? window.zspeakly?.native : null;
  if (!bridge?.httpPost) {
    return { ok: false, terms: '', reason: 'локальная модель доступна только в приложении' };
  }
  if (!endpoint) {
    return { ok: false, terms: '', reason: 'адрес локальной модели не задан' };
  }
  const base64 = String(dataUrl || '').replace(/^data:image\/[a-z+]+;base64,/i, '');
  if (!base64) return { ok: false, terms: '', reason: 'кадр пуст' };

  const url = `${String(endpoint).replace(/\/$/, '')}/api/generate`;
  const body = {
    model: model || 'qwen2.5:0.5b',
    prompt: PROMPT,
    images: [base64],
    stream: false,
    options: { temperature: 0, num_predict: 120 },
  };

  let res;
  try {
    res = await bridge.httpPost({ url, body, timeout });
  } catch (err) {
    return { ok: false, terms: '', reason: String(err?.message || err) };
  }
  if (!res?.ok) {
    // 400/404 — модель без поддержки изображений: это не сбой, просто нет контекста
    return {
      ok: false,
      terms: '',
      reason:
        res?.status === 404
          ? `модель «${body.model}» не найдена в Ollama`
          : res?.status === 400
            ? `модель «${body.model}» не принимает изображения`
            : res?.reason || `локальная модель ответила ${res?.status || 'ошибкой'}`,
    };
  }

  const raw = String(res.data?.response || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const terms = raw
    .split(/[,;•\n]/)
    .map((s) => s.replace(/^[-–—\s]+|[-–—\s.]+$/g, '').trim())
    .filter((s) => s.length > 1 && s.length < 40)
    .slice(0, 25)
    .join(', ')
    .slice(0, MAX_CONTEXT_CHARS);

  return terms
    ? { ok: true, terms, reason: '' }
    : { ok: false, terms: '', reason: 'на экране не нашлось текста' };
}

export default describeScreen;
