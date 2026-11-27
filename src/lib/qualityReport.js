/**
 * Разбор «где теряется точность» — по своей же истории диктовок.
 *
 * Зачем: «распознаёт плохо» — это не диагноз, а жалоба. Приложение уже пишет в
 * историю, как считалось (был ли честный проход, усиливался ли звук, сжимались
 * ли паузы, какая модель считала), но человек видел это по одной фразе за раз и
 * не мог сделать вывод. Здесь из тех же данных собирается ответ: что чаще всего
 * происходило во время работы; без эталона он не устанавливает причину ошибок.
 *
 * Никаких новых замеров и никаких сетевых запросов: только история на
 * устройстве. Если данных мало — так и говорим, а не делаем вид, что вывод есть.
 */

/** Меньше трёх фраз с данными — это не статистика, а случайность. */
export const QUALITY_MIN_SAMPLES = 3;

/** Насколько должно быть тихо, чтобы это считалось причиной проблем. */
export const QUIET_GAIN_DB = 10;

const valid = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const num = (value) => (valid(value) ? value : 0);
const round1 = (value) => Math.round(num(value) * 10) / 10;

/** Была ли у записи хоть какая-то служебная информация о распознавании. */
function hasData(entry) {
  if (!entry) return false;
  return (
    typeof entry.sttThorough === 'boolean' ||
    typeof entry.sttSecondPass === 'boolean' ||
    valid(entry.sttGainDb) ||
    valid(entry.sttPausesMs) ||
    (typeof entry.sttModel === 'string' && Boolean(entry.sttModel.trim())) ||
    valid(entry.sttMs)
  );
}

/** Короткое имя модели: ggml-small-q5_1.bin → small-q5_1. */
export function shortModel(name = '') {
  return String(name || '')
    .replace(/^ggml-/, '')
    .replace(/\.bin$/, '');
}

/**
 * @param {Array} entries история диктовок (новые первыми)
 * @param {{limit?: number, minSamples?: number}} opts
 */
export function analyseQuality(entries = [], opts = {}) {
  const { limit = 50, minSamples = QUALITY_MIN_SAMPLES } = opts;
  const list = Array.isArray(entries) ? entries.slice(0, Math.max(1, limit)) : [];
  const analysed = list.filter(hasData);

  // Отсутствующее поле старой записи — не false и не нулевой замер.
  const passSamples = analysed.filter((e) => typeof e.sttSecondPass === 'boolean');
  const secondPass = passSamples.filter((e) => e.sttSecondPass === true);
  const thoroughSamples = analysed.filter((e) => typeof e.sttThorough === 'boolean');
  const thorough = thoroughSamples.filter((e) => e.sttThorough === true);
  const gainSamples = analysed.filter((e) => valid(e.sttGainDb));
  const quiet = gainSamples.filter((e) => e.sttGainDb >= QUIET_GAIN_DB);
  const pauseSamples = analysed.filter((e) => valid(e.sttPausesMs));
  const pausesMs = pauseSamples.reduce((sum, e) => sum + e.sttPausesMs, 0);
  const speedSamples = analysed.filter((e) => valid(e.sttMs) && e.sttMs > 0 && valid(e.spokenMs) && e.spokenMs > 800);
  const slow = speedSamples.filter((e) => e.sttMs > e.spokenMs * 1.25);
  // Модели: по ним видно, не считает ли «не та» модель — например, базовая
  // вместо русской.
  const byModel = new Map();
  for (const entry of analysed) {
    const model = entry.source === 'file' && entry.sttModelSource !== 'file-responses-v1'
      ? 'файл: фактическая модель неизвестна'
      : shortModel(entry.sttModel) || 'не указана';
    if (!byModel.has(model)) byModel.set(model, { model, count: 0, secondPass: 0 });
    const row = byModel.get(model);
    row.count += 1;
    if (entry.sttSecondPass === true) row.secondPass += 1;
  }
  const models = [...byModel.values()].sort((a, b) => b.count - a.count);

  const verdicts = [];
  if (analysed.length < minSamples) {
    verdicts.push({
      level: 'unknown',
      title: 'Пока нечего разбирать',
      hint: `Фраз с данными: ${analysed.length}, нужно хотя бы ${minSamples}. Метаданные не измеряют точность без эталона.`,
    });
  } else {
    if (secondPass.length) {
      verdicts.push({
        level: 'warn',
        title: `Второй проход отмечен: ${secondPass.length}`,
        hint: 'Второй проход не доказывает ошибку. Отсутствие отметки не означает, что его не было; сравните текст вручную.',
      });
    }
    if (quiet.length) {
      const maxGain = Math.max(...quiet.map((e) => e.sttGainDb));
      verdicts.push({
        level: 'warn',
        title: 'Заметное усиление звука',
        hint: `${quiet.length} из ${gainSamples.length} записей с данными усиливались на 10 дБ или больше (до +${round1(maxGain)} дБ). Усиление может поднять и шум; проверьте микрофон и текст.`,
      });
    }
    if (slow.length) {
      verdicts.push({
        level: 'warn',
        title: 'Долгое распознавание',
        hint: `${slow.length} из ${speedSamples.length} записей с данными считались более чем в 1,25 раза дольше речи. Причина неизвестна; сравните время на другой модели.`,
      });
    }
    if (!verdicts.length) {
      verdicts.push({
        level: 'unknown',
        title: 'По этим сведениям точность неизвестна',
        hint: 'В истории нет эталона сказанного. Сравните текст с записью: отсутствие предупреждений не доказывает, что ошибок нет.',
      });
    }
  }

  return {
    total: list.length,
    analysed: analysed.length,
    secondPass: { count: secondPass.length, samples: passSamples.length },
    thorough: { count: thorough.length, samples: thoroughSamples.length },
    quiet: { count: quiet.length, samples: gainSamples.length, maxGain: quiet.reduce((max, e) => Math.max(max, e.sttGainDb), 0) },
    pausesMs,
    pausesSamples: pauseSamples.length,
    slow: { count: slow.length, samples: speedSamples.length },
    models,
    verdicts,
    enough: analysed.length >= minSamples,
  };
}

/**
 * Тот же разбор текстом — чтобы человек мог прислать его в чат, а не пересказывать
 * «распознаёт плохо». Без текста диктовок: только числа и модель.
 */
export function qualityReportText(report, { version = '', at = Date.now() } = {}) {
  const row = report || analyseQuality([]);
  const lines = [
    `ZSpeakly ${version || ''} — сведения о распознавании`.trim(),
    new Date(at).toISOString(),
    `Фраз в истории: ${row.total}, с данными о распознавании: ${row.analysed}`,
    `Второй проход отмечен: ${row.secondPass.count}; отсутствие отметки не означает отсутствие прохода`,
    `Честный проход отмечен: ${row.thorough.count}; отсутствие отметки не означает отсутствие прохода`,
    `Усиление от 10 дБ: ${row.quiet.samples ? `${row.quiet.count} из ${row.quiet.samples} записей с данными${row.quiet.count ? ` (до +${round1(row.quiet.maxGain)} дБ)` : ''}` : 'нет данных'}`,
    `Паузы сжаты: ${row.pausesSamples ? `${round1(row.pausesMs / 1000)} с в ${row.pausesSamples} записях с данными` : 'нет данных'}`,
    `Счёт более чем в 1,25 раза дольше речи: ${row.slow.samples ? `${row.slow.count} из ${row.slow.samples} записей с данными` : 'нет данных'}`,
    `Модели: ${row.models.map((m) => `${m.model} — ${m.count}${m.secondPass ? ` (второй проход отмечен: ${m.secondPass})` : ''}`).join('; ') || 'нет данных'}`,
    'Метаданные не измеряют точность распознавания без эталона.',
    '',
    ...row.verdicts.map((v) => `• ${v.title}. ${v.hint}`),
  ];
  return lines.join('\n');
}

export default { analyseQuality, qualityReportText, QUALITY_MIN_SAMPLES, QUIET_GAIN_DB };
