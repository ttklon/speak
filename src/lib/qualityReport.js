/**
 * Разбор «где теряется точность» — по своей же истории диктовок.
 *
 * Зачем: «распознаёт плохо» — это не диагноз, а жалоба. Приложение уже пишет в
 * историю, как считалось (был ли честный проход, усиливался ли звук, сжимались
 * ли паузы, какая модель считала), но человек видел это по одной фразе за раз и
 * не мог сделать вывод. Здесь из тех же данных собирается ответ: что чаще всего
 * мешало — тихий микрофон, слабый процессор, короткий проход или сама модель.
 *
 * Никаких новых замеров и никаких сетевых запросов: только история на
 * устройстве. Если данных мало — так и говорим, а не делаем вид, что вывод есть.
 */

/** Меньше трёх фраз с данными — это не статистика, а случайность. */
export const QUALITY_MIN_SAMPLES = 3;

/** Насколько должно быть тихо, чтобы это считалось причиной проблем. */
export const QUIET_GAIN_DB = 10;

/** Второй проход в такой доле фраз — уже не «по нужде», а норма. */
export const SECOND_PASS_SHARE = 0.4;

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const round1 = (value) => Math.round(num(value) * 10) / 10;
const share = (part, total) => (total > 0 ? part / total : 0);
const percent = (value) => `${Math.round(num(value) * 100)} %`;

/** Была ли у записи хоть какая-то служебная информация о распознавании. */
function hasData(entry) {
  if (!entry) return false;
  return (
    entry.sttThorough !== undefined ||
    entry.sttSecondPass !== undefined ||
    entry.sttGainDb !== undefined ||
    entry.sttPausesMs !== undefined ||
    entry.sttModel !== undefined ||
    entry.sttMs !== undefined
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

  const secondPass = analysed.filter((e) => e.sttSecondPass === true);
  const thorough = analysed.filter((e) => e.sttThorough === true && e.sttSecondPass !== true);
  const quiet = analysed.filter((e) => num(e.sttGainDb) >= QUIET_GAIN_DB);
  const pausesMs = analysed.reduce((sum, e) => sum + num(e.sttPausesMs), 0);
  const slow = analysed.filter(
    (e) => num(e.sttMs) > 0 && num(e.spokenMs) > 800 && num(e.sttMs) > num(e.spokenMs) * 1.25,
  );
  // Модели: по ним видно, не считает ли «не та» модель — например, базовая
  // вместо русской.
  const byModel = new Map();
  for (const entry of analysed) {
    const model = shortModel(entry.sttModel) || 'не указана';
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
      hint: `Фраз с данными: ${analysed.length}, нужно хотя бы ${minSamples}. Продиктуйте несколько фраз — разбор появится сам.`,
    });
  } else {
    if (share(secondPass.length, analysed.length) >= SECOND_PASS_SHARE) {
      verdicts.push({
        level: 'warn',
        title: `Второй проход в ${secondPass.length} из ${analysed.length} фраз`,
        hint: `${secondPass.length} из ${analysed.length} (${percent(share(secondPass.length, analysed.length))}). Быстрого прохода не хватает: поставьте режим «Точно» или модель уровнем выше — тогда переспрашивать не придётся.`,
      });
    }
    if (quiet.length) {
      const maxGain = quiet.reduce((max, e) => Math.max(max, num(e.sttGainDb)), 0);
      verdicts.push({
        level: 'warn',
        title: 'Звук тихий',
        hint: `${quiet.length} из ${analysed.length} фраз усиливались (до +${round1(maxGain)} дБ). Говорите ближе к микрофону: усиление поднимает и шум.`,
      });
    }
    if (slow.length) {
      verdicts.push({
        level: 'warn',
        title: 'Движку тяжело',
        hint: `${slow.length} из ${analysed.length} фраз считались дольше, чем длилась речь. Это процессор, а не микрофон: режим «Быстро» или модель легче.`,
      });
    }
    if (!secondPass.length && !quiet.length && !slow.length) {
      verdicts.push({
        level: 'ok',
        title: 'Причин в истории не видно',
        hint: `Проверено ${analysed.length} фраз: второй проход не потребовался, звук громкий, счёт быстрее речи. Значит дело в отдельных словах — добавьте их в словарь.`,
      });
    }
  }

  return {
    total: list.length,
    analysed: analysed.length,
    secondPass: { count: secondPass.length, share: share(secondPass.length, analysed.length) },
    thorough: { count: thorough.length },
    quiet: { count: quiet.length, maxGain: quiet.reduce((max, e) => Math.max(max, num(e.sttGainDb)), 0) },
    pausesMs,
    slow: { count: slow.length },
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
    `ZSpeakly ${version || ''} — разбор точности`.trim(),
    new Date(at).toISOString(),
    `Фраз в истории: ${row.total}, с данными о распознавании: ${row.analysed}`,
    `Второй проход: ${row.secondPass.count} (${percent(row.secondPass.share)})`,
    `Честный проход сразу: ${row.thorough.count}`,
    `Тихий звук: ${row.quiet.count}${row.quiet.count ? ` (до +${round1(row.quiet.maxGain)} дБ)` : ''}`,
    `Паузы сжаты: ${round1(row.pausesMs / 1000)} с`,
    `Счёт дольше речи: ${row.slow.count}`,
    `Модели: ${row.models.map((m) => `${m.model} — ${m.count} (второй проход ${m.secondPass})`).join('; ') || 'нет данных'}`,
    '',
    ...row.verdicts.map((v) => `• ${v.title}. ${v.hint}`),
  ];
  return lines.join('\n');
}

export default { analyseQuality, qualityReportText, QUALITY_MIN_SAMPLES, QUIET_GAIN_DB, SECOND_PASS_SHARE };
