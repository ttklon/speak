import { useCallback, useEffect, useState } from 'react';
import { Zap } from 'lucide-react';
import { Button } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { diag, localEvents } from '../../../lib/diagnostics.js';
import { isElectron } from '../../../lib/storage.js';
import { clipboardCopyError, writeClipboard } from '../../../lib/clipboard.js';
import { analyseQuality, qualityReportText } from '../../../lib/qualityReport.js';
import { APP } from '../../../lib/config.js';
import { engineName, hasNativeStt } from '../../../lib/recognition/engine.js';
import { resolveLiveDraft } from '../../../lib/liveDraftPolicy.js';
import { describeTarget } from '../../../lib/appFormat.js';
import { runDictationSelfTest, describeSelfTest } from '../../../lib/selftest.js';
import { analyseSpeed, engineWord } from '../../../lib/speedReport.js';
import { lighterModel, tierForModel } from '../../../lib/modelTiers.js';

const LEVEL_LABEL = { debug: 'отладка', info: 'инфо', warn: 'внимание', error: 'ошибка' };

function timeOf(at) {
  try {
    return new Date(at).toLocaleTimeString('ru-RU');
  } catch {
    return '';
  }
}

/**
 * «Данные → Диагностика». Честно показывает, что собирается, что уходит на
 * сервер и что происходит в последних событиях. Отправку можно выключить.
 */
/** Пробный текст: короткий, узнаваемый, без латиницы на всякий случай. */
const INSERT_PROBE = 'Проверка вставки ZSpeakly — этот текст должен появиться здесь.';

export default function DiagnosticsSection() {
  const { settings, updateSettings, dictations } = useAppData();
  const { push } = useToast();
  const [status, setStatus] = useState(null);
  // «Система и железо» — то, что main реально проверил на этой машине
  const system = status?.system || null;
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState('');
  // черновик адреса приёмника: применяется по кнопке, чтобы не дёргать
  // сеть на каждом нажатии клавиши
  const [endpointDraft, setEndpointDraft] = useState('');
  // «Проверить диктовку»: запись с микрофона и настоящий проход движка
  const [selfTest, setSelfTest] = useState(null);
  const [selfBusy, setSelfBusy] = useState(false);
  // Отчёт о скорости: считается из истории диктовок, ничего дополнительно не
  // измеряет и никуда не ходит. Человеку нужен ответ «успевает или нет», а не
  // ещё одна таблица настроек.
  const speed = analyseSpeed(dictations);
  // «Где теряется точность»: тот же принцип, что у скорости — только история,
  // никаких новых замеров и никакой сети.
  const quality = analyseQuality(dictations);
  // Переключение на режим легче прямо из отчёта: человек видит «долго» и не
  // должен идти искать, где это меняется. Если режим ещё не скачан — качаем
  // и говорим об этом, а не переключаем на отсутствующий файл.
  const [switching, setSwitching] = useState(false);
  // Состояние вставки: чем вставляем и что было в прошлый раз. Без этого
  // «текст не вставляется» невозможно разобрать — только догадываться.
  const [inputStatus, setInputStatus] = useState(null);
  // Состояние русской модели: включится ли она на следующей диктовке. Без этой
  // строки «на русском распознаёт хуже» объяснить нечем — человек не знает,
  // скачана ли модель и видит ли её приложение.
  // В браузере моста нет: без этого флага обе строки навсегда показывали
  // «проверяю…», хотя проверять некому — обещание, которое не выполнится.
  const nativeBridge = typeof window !== 'undefined' ? window.zspeakly?.native : null;
  const [russian, setRussian] = useState(null);
  // Состояние модели европейских языков: та же причина, что и у русской —
  // «почему на английском считает прежний движок» должно быть видно.
  const [european, setEuropean] = useState(null);
  // Куда попадёт текст и как он будет оформлен: одно и то же место, где человек
  // ищет ответ на «почему тут без точки».
  const [target, setTarget] = useState(null);
  const [probe, setProbe] = useState(null);
  const [probeBusy, setProbeBusy] = useState(false);
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.insertTarget) return undefined;
    let alive = true;
    bridge
      .insertTarget()
      .then((info) => {
        if (alive && info && typeof info === 'object') setTarget(info);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.modelsStatus) return undefined;
    let alive = true;
    bridge
      .modelsStatus()
      .then((status) => {
        if (alive && status?.russian) setRussian(status.russian);
        if (alive && status?.european) setEuropean(status.european);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [settings.language]);

  const currentTier = tierForModel(settings.whisperModel);
  const lighterTier = currentTier ? lighterModel(currentTier.model) : '';
  const lighter = lighterTier ? tierForModel(lighterTier) : null;
  const goLighter = useCallback(async () => {
    if (!lighter || switching) return;
    const bridge = window.zspeakly?.native;
    setSwitching(true);
    try {
      const st = bridge?.modelsStatus ? await bridge.modelsStatus().catch(() => null) : null;
      // Ключ в статусе — имя модели (`base-q5_1`), а не id режима (`fast`).
      const downloaded = st?.models?.[lighter.model]?.downloaded === true;
      if (downloaded) {
        updateSettings({ whisperModel: lighter.model });
        await bridge?.modelsWarm?.({ model: lighter.model }).catch(() => {});
        push({
          title: `Режим «${lighter.label.toLowerCase()}» включён`,
          description: `${lighter.size} · продиктуйте ту же фразу и посмотрите на секунды выше`,
          tone: 'success',
          ttl: 9000,
        });
      } else {
        // Скачивание идёт в фоне и само переключит режим по готовности —
        // обещать «включено» до файла нельзя.
        Promise.resolve(bridge?.downloadModel?.(lighter.model)).catch(() => {});
        push({
          title: `Скачиваю «${lighter.label.toLowerCase()}» — ${lighter.size}`,
          description: 'Режим включится, как только файл будет готов. Это один раз.',
          tone: 'info',
          ttl: 9000,
        });
      }
    } finally {
      setSwitching(false);
    }
  }, [lighter, push, switching, updateSettings]);

  const refresh = useCallback(async () => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.diagStatus) {
      setStatus({ enabled: false, browser: true, endpointConfigured: false });
      setEvents(localEvents().slice(-80).reverse());
      return;
    }
    try {
      const [st, list] = await Promise.all([bridge.diagStatus(), bridge.diagRecent(80)]);
      setStatus(st || null);
      setEvents((list || []).slice().reverse());
    } catch (err) {
      setStatus({ enabled: false, error: String(err) });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Статус вставки спрашиваем один раз при открытии: он показывает, собран ли
  // помощник ввода и чем закончилась прошлая вставка.
  useEffect(() => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.inputStatus) return;
    bridge
      .inputStatus()
      .then((st) => setInputStatus(st || null))
      .catch(() => setInputStatus(null));
  }, []);

  /**
   * Проверка вставки «как в жизни»: три секунды на то, чтобы переключиться в
   * нужное окно, потом настоящая вставка пробного текста. Приложение умеет
   * только вставлять — проверить результат за человека оно не может, поэтому
   * спрашиваем прямо «появился ли текст» и пишем ответ в журнал.
   */
  const checkInsert = useCallback(async () => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.insertText) {
      push({ title: 'Только в приложении', description: 'В браузере вставка в другие окна недоступна.', tone: 'warn' });
      return;
    }
    setProbeBusy(true);
    setProbe(null);
    push({
      title: 'Переключитесь в нужное окно',
      description: 'Через три секунды вставлю пробный текст — поставьте курсор туда, где хотите его увидеть.',
      tone: 'info',
      ttl: 3200,
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));
    let res = null;
    try {
      res = await bridge.insertText(INSERT_PROBE);
    } catch (error) {
      res = { ok: false, uncertain: true, reason: 'ответ не получен' };
    }
    setProbeBusy(false);
    setProbe(res || { ok: false, uncertain: true, reason: 'нет ответа' });
    const status = bridge.inputStatus ? await bridge.inputStatus().catch(() => null) : null;
    if (status) setInputStatus(status);
    diag.info('insert', res?.ok ? 'Проверка вставки: текст доставлен' : 'Проверка вставки: отказ', {
      method: res?.method || '',
      reason: res?.reason || '',
    });
  }, [push]);

  const confirmProbe = useCallback(
    (appeared) => {
      diag.info('insert', appeared ? 'Человек подтвердил: текст появился' : 'Человек сообщил: текст не появился', {
        method: probe?.method || '',
      });
      push({
        title: appeared ? 'Вставка работает' : 'Вставка не дошла до окна',
        description: appeared
          ? 'Дальше диктовка будет вставляться так же.'
          : 'Причина и способ записаны в журнал. Проверьте целевое окно и настройки вставки.',
        tone: appeared ? 'success' : 'warn',
        ttl: 10000,
      });
      setProbe(null);
    },
    [probe, push],
  );

  // адрес берём из настроек главного процесса: он же переживает перезапуск
  useEffect(() => {
    const current = status?.endpoint;
    if (typeof current === 'string') setEndpointDraft(current);
  }, [status?.endpoint]);

  const saveEndpoint = async () => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.diagSetEndpoint) {
      push({ title: 'Только в приложении', description: 'В браузере адрес не меняется.', tone: 'warn' });
      return;
    }
    setBusy('endpoint');
    try {
      const res = await bridge.diagSetEndpoint(endpointDraft.trim());
      if (res?.ok) {
        setStatus(res.status || null);
        setEndpointDraft(res.endpoint || '');
        push({
          title: res.endpoint ? 'Адрес приёмника сохранён' : 'Отправка отключена',
          description: res.endpoint
            ? 'Проверьте канал кнопкой «Проверить канал».'
            : 'События останутся только в локальном журнале.',
          tone: 'success',
        });
      } else {
        push({ title: 'Адрес не принят', description: res?.reason || '', tone: 'warn' });
      }
    } catch (err) {
      push({ title: 'Не удалось сохранить', description: String(err?.message || err), tone: 'warn' });
    } finally {
      setBusy('');
    }
  };

  const toggleEnabled = (value) => {
    updateSettings({ diagnostics: value });
    window.zspeakly?.native?.diagSetEnabled?.(value).then(setStatus).catch?.(() => {});
    push({
      title: value ? 'Диагностика включена' : 'Диагностика выключена',
      description: value
        ? 'Ошибки и служебные события уходят разработчику. Текст диктовки — никогда.'
        : 'Наружу больше ничего не уходит. Журнал остаётся на этом компьютере.',
      tone: value ? 'success' : 'warn',
    });
  };

  // Главная кнопка: сохранить отчёт на Рабочий стол. Ничего не нужно
  // настраивать и никуда входить — файл сразу видно в проводнике.
  const saveReport = async () => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.diagSaveReport) {
      // В браузере (превью) отчёт можно честно скачать файлом: Blob + <a download>.
      // Раньше кнопка просто упиралась в «только в приложении».
      try {
        const events = localEvents()
          .slice(-200)
          .map((e) => `[${new Date(e.at).toLocaleString('ru-RU')}] ${e.level}/${e.scope}: ${e.message}`)
          .join('\n');
        const text = [
          'ZSpeakly — отчёт о работе (браузер)',
          `Версия: ${APP?.version || '—'} · ${APP?.build || ''}`,
          `Браузер: ${navigator.userAgent}`,
          `Язык: ${navigator.language} · Платформа: ${navigator.platform || '—'}`,
          `Экран: ${window.screen?.width}×${window.screen?.height}`,
          `Адрес: ${location.origin}`,
          '',
          `Событий в журнале: ${events ? events.split('\n').length : 0}`,
          events || 'журнал пуст',
        ].join('\n');
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'zspeakly-report.txt';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        push({
          title: 'Отчёт скачан',
          description: 'Файл zspeakly-report.txt в папке загрузок браузера.',
          tone: 'success',
        });
      } catch (err) {
        push({ title: 'Не удалось сохранить отчёт', description: String(err?.message || err), tone: 'warn' });
      }
      return;
    }
    setBusy('report');
    try {
      const res = await bridge.diagSaveReport();
      if (res?.ok) {
        push({
          title: 'Отчёт сохранён',
          description: 'Файл на Рабочем столе — его можно отправить в чат поддержки.',
          tone: 'success',
        });
      } else {
        push({ title: 'Не удалось сохранить отчёт', description: res?.reason || '', tone: 'warn' });
      }
    } finally {
      setBusy('');
      refresh();
    }
  };

  const sendNow = async () => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.diagSendNow) {
      push({ title: 'Только в приложении', description: 'В браузере отправка недоступна — откройте Windows-сборку.', tone: 'warn' });
      return;
    }
    setBusy('send');
    try {
      const res = await bridge.diagSendNow();
      if (res?.ok) {
        push({ title: 'Логи отправлены', description: `Событий в пачке: ${res.count}`, tone: 'success' });
      } else {
        push({
          title: 'Отправить не удалось',
          description: res?.reason || 'Приёмник недоступен — события остались в локальном журнале.',
          tone: 'warn',
        });
      }
    } finally {
      setBusy('');
      refresh();
    }
  };

  const ping = async () => {
    const bridge = window.zspeakly?.native;
    if (!bridge?.diagPing) {
      push({ title: 'Только в приложении', description: 'Проверка канала доступна в Windows-сборке.', tone: 'warn' });
      return;
    }
    setBusy('ping');
    try {
      const res = await bridge.diagPing();
      if (res?.ok) push({ title: 'Канал работает', description: 'Тестовое событие дошло до приёмника.', tone: 'success' });
      else push({ title: 'Канал не отвечает', description: res?.reason || 'проверьте интернет', tone: 'warn' });
    } finally {
      setBusy('');
      refresh();
    }
  };

  // Самый быстрый путь, пока приёмник не развёрнут: скопировать хвост журнала
  // и прислать его в чат — без файлов и поиска по папкам.
  const copyLogs = async () => {
    const lines = events
      .slice(0, 60)
      .reverse()
      .map((e) => {
        const data = e.data && Object.keys(e.data).length ? ' ' + JSON.stringify(e.data) : '';
        return `${new Date(e.at).toISOString()} ${e.level} ${e.scope} ${e.message}${data}`;
      });
    const text = lines.join('\n') || 'событий нет';
    try {
      // тот же путь, что у всего приложения: main → системный буфер,
      // с откатом на навигационный clipboard API в браузере
      await writeClipboard(text);
      push({
        title: 'Логи скопированы',
        description: `${lines.length} строк в буфере — вставьте их в чат поддержки.`,
        tone: 'success',
      });
    } catch (err) {
      push(clipboardCopyError(err, String(err?.message || err)));
    }
  };

  const openFolder = async () => {
    const bridge = window.zspeakly?.native;
    if (bridge?.openLogs) {
      const res = await bridge.openLogs();
      if (res && res.ok === false) {
        push({ title: 'Папку открыть не удалось', description: res.reason || '', tone: 'warn' });
      }
      return;
    }
    push({ title: 'Только в приложении', description: 'Журнал лежит в папке профиля ZSpeakly.', tone: 'warn' });
  };

  const clearLogs = async () => {
    const bridge = window.zspeakly?.native;
    if (bridge?.diagClear) await bridge.diagClear();
    else localStorage.removeItem('zs.diagnostics.buffer');
    push({ title: 'Журнал очищен', tone: 'success' });
    refresh();
  };

  const errors = events.filter((e) => e.level === 'error').length;

  // Проверка «здесь и сейчас»: 2 секунды с микрофона → движок → цифры и текст.
  // Это единственный способ честно ответить на «работает или нет» на этом ПК.
  const checkDictation = useCallback(async () => {
    if (selfBusy) return;
    setSelfBusy(true);
    setSelfTest(null);
    push({ title: 'Проверяю диктовку', description: 'Скажите любую фразу — идёт запись 2 секунды.', tone: 'info', ttl: 3000 });
    try {
      const res = await runDictationSelfTest({
        seconds: 2,
        lang: settings.language || 'ru',
        model: settings.whisperModel || '',
      });
      setSelfTest(res);
      push({
        title: res.ok ? 'Диктовка работает' : 'Диктовка не сработала',
        description: describeSelfTest(res),
        tone: res.ok ? 'success' : 'warn',
        ttl: 9000,
      });
    } catch (err) {
      const res = { ok: false, reason: String(err?.message || err) };
      setSelfTest(res);
      push({ title: 'Проверка сорвалась', description: res.reason, tone: 'warn', ttl: 9000 });
    } finally {
      setSelfBusy(false);
    }
  }, [selfBusy, settings.language, settings.whisperModel, push]);

  return (
    <div>
      <div className="settings-group">
        <div className="settings-group__title">Как сейчас работает диктовка</div>
        <div className="settings-group__desc">То, что чаще всего объясняет «почему не так».</div>
        <div className="kv-row">
          <span className="kv-row__key">Движок</span>
          <span className="kv-row__value">{engineName()}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Русский язык</span>
          <span className="kv-row__value">
            {russian === null
              ? nativeBridge?.modelsStatus
                ? 'проверяю…'
                : 'только в приложении'
              : russian.available
                ? 'своя модель, включается сама'
                : russian.reason}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Европейские языки</span>
          <span className="kv-row__value">
            {european === null
              ? nativeBridge?.modelsStatus
                ? 'проверяю…'
                : 'только в приложении'
              : european.available
                ? 'своя модель, включается сама'
                : european.reason}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Модель</span>
          <span className="kv-row__value">
            {tierForModel(settings.whisperModel)?.label || 'Сбалансированно'}
            {settings.keepModelLoaded === true ? ', держится в памяти' : ''}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Живая расшифровка</span>
          <span className="kv-row__value">
            {(() => {
              const live = resolveLiveDraft({
                setting: settings.liveWhisper,
                model: settings.whisperModel,
                hasNative: hasNativeStt(),
              });
              if (!live.enabled) return 'выключена — текст после остановки';
              return live.explicit
                ? 'включена вручную — запись пересчитывается раз в 2,5 с'
                : 'включена сама — движок успевает пересчитывать запись раз в 2,5 с';
            })()}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Горячий микрофон</span>
          <span className="kv-row__value">
            {settings.micPreroll === true
              ? 'включён — микрофон открыт заранее, первые 0,6 с не теряются'
              : 'выключен — запись начинается с нажатия'}
          </span>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Где теряется точность</div>
        <div className="settings-group__desc">
          Разбор по своей же истории: был ли честный проход, усиливался ли звук, не считалась ли
          фраза дольше, чем длилась. Без сети и без новых замеров.
        </div>
        <div className="quality-report">
          {quality.verdicts.map((verdict, index) => (
            <div className={`quality-report__row is-${verdict.level}`} key={`${verdict.level}-${index}`}>
              <span className="quality-report__mark">
                {verdict.level === 'ok' ? 'в порядке' : verdict.level === 'warn' ? 'стоит поправить' : 'мало данных'}
              </span>
              <span className="quality-report__title">{verdict.title}</span>
              <span className="quality-report__hint">{verdict.hint}</span>
            </div>
          ))}
        </div>
        {quality.models.length ? (
          <div className="settings-foot-hint" style={{ marginTop: 6 }}>
            {quality.models
              .map((m) => `${m.model}: ${m.count} фраз${m.secondPass ? `, второй проход ${m.secondPass}` : ''}`)
              .join(' · ')}
          </div>
        ) : null}
        <div className="row-8" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                await writeClipboard(qualityReportText(quality, { version: APP.version }));
                push({
                  title: 'Разбор скопирован',
                  description: 'Только числа и модель — текст диктовок не копируется.',
                  tone: 'success',
                });
              } catch (err) {
                push(clipboardCopyError(err, String(err?.message || err)));
              }
            }}
          >
            Скопировать разбор
          </Button>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Скорость: укладывается ли в пять секунд</div>
        <div className="settings-group__desc">
          Замеры последних диктовок: сколько говорили и сколько считал движок.
        </div>
        {speed.samples.length ? (
          <div className="speed-report">
            {speed.samples.map((row, index) => (
              <div className="speed-report__row" key={`${row.at}-${index}`}>
                <span className="speed-report__main">
                  {row.spoken.toFixed(1)} с речи → {row.total.toFixed(1)} с ожидания
                </span>
                <span className="speed-report__meta">
                  {/* Человеку важно не «сколько считал движок», а сколько он ждал.
                      Счёт показываем рядом, чтобы было видно, где именно секунды. */}
                  {row.tail >= 0.2 ? `счёт ${row.compute.toFixed(1)} с · остальное ${row.tail.toFixed(1)} с · ` : ''}
                  {row.factor ? `×${row.factor.toFixed(1)}` : '—'}
                  {row.mode ? ` · ${engineWord(row.mode)}` : ''}
                  {row.parts > 1 ? ` · ${row.parts} фрагмента` : ''}
                  {row.pre ? ` · заранее посчитано: ${row.pre}` : ''}
                </span>
                <span className={`speed-report__mark ${row.fits ? 'is-ok' : 'is-slow'}`}>
                  {row.fits ? 'в норме' : 'долго'}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="settings-foot-hint" style={{ marginTop: 6 }}>
          {speed.advice}
        </div>
        {speed.verdict === 'slow' && speed.computeBound && lighter ? (
          <div style={{ marginTop: 8 }}>
            <Button
              variant="ghost"
              size="sm"
              icon={<Zap size={12} />}
              onClick={goLighter}
              disabled={switching}
            >
              {switching
                ? 'Переключаю…'
                : `Переключить на «${lighter.label.toLowerCase()}» — ${lighter.size}`}
            </Button>
          </div>
        ) : null}
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Система и железо</div>
        <div className="settings-group__desc">
          Проверенные факты, а не настройки: зарегистрировались ли глобальные сочетания, включён ли
          мониторинг буфера, есть ли движок и модель на диске.
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Глобальные сочетания</span>
          <span className="kv-row__value">
            {system?.hotkeys?.length ? system.hotkeys.join(', ') : 'нет доступа к системе (превью в браузере)'}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Вставка текста</span>
          <span className="kv-row__value">
            {system?.insertMethod === 'sendinput'
              ? system?.insertSupported
                ? 'SendInput, без буфера обмена'
                : 'SendInput выбран, но работает только в Windows — сейчас буфер'
              : 'буфер обмена + Ctrl+V'}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Мониторинг буфера</span>
          <span className="kv-row__value">
            {system ? (system.clipboardWatch
              ? `включён${system.clipboardWatchTextError ? ' · ошибка чтения текста' : ''}${system.clipboardWatchImageIssue === 'error' ? ' · ошибка чтения изображения' : system.clipboardWatchImageIssue === 'size' ? ' · изображение превышает лимит' : ''}`
              : 'выключен') : '—'}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Модель на диске</span>
          <span className="kv-row__value">
            {system
              ? `${system.model} — ${system.modelDownloaded ? 'скачана' : 'нет файла'}${system.vad ? ', VAD на месте' : ', без VAD'}`
              : '—'}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Модель в памяти</span>
          <span className="kv-row__value">
            {!system
              ? '—'
              : system.engineWarm
                ? 'прогрета — распознавание без загрузки весов'
                : system.engineWarming
                  ? 'греется: первая фраза может быть медленнее'
                  : 'не прогрета — каждая фраза начинается с загрузки весов'}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Оформление под окно</span>
          <span className="kv-row__value">
            {!target
              ? 'окно не определено'
              : `${target.app || 'без имени'} — ${describeTarget(target).label}`}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Помощник ввода</span>
          <span className="kv-row__value">
            {!system?.inputHost
              ? '—'
              : !system.inputHost.available
                ? 'системой не поддержан — вставка через буфер'
                : system.inputHost.ready
                  ? 'готов — вставка без запуска программ'
                  : system.inputHost.running
                    ? 'запускается'
                    : 'не запущен — первая вставка будет медленнее'}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Движок вставки</span>
          <span className="kv-row__value">
            {!inputStatus
              ? '—'
              : inputStatus.ready
                ? 'свой помощник SendInput готов — вставка без PowerShell'
                : `помощник SendInput недоступен: ${inputStatus.reason || 'неизвестно'} — вставка через буфер и PowerShell`}
            {inputStatus?.last?.at
              ? ` · прошлая: ${inputStatus.last.ok ? 'получилась' : 'не получилась'}${inputStatus.last.method ? `, способ ${inputStatus.last.method === 'win-input' ? 'SendInput' : inputStatus.last.method === 'powershell' ? 'PowerShell' : 'буфер'}` : ''}${inputStatus.last.reason ? ` (${inputStatus.last.reason})` : ''}`
              : ''}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Запуск окна</span>
          <span className="kv-row__value">
            {!system
              ? '—'
              : system.startupMs
                ? `${(Math.round(system.startupMs / 100) / 10).toLocaleString('ru-RU')} с от запуска приложения до окна`
                : '—'}
          </span>
        </div>

        <div className="kv-row">
          <span className="kv-row__key">Компьютер</span>
          <span className="kv-row__value">
            {system ? `${system.cpus} ядер, ${system.ramGb} ГБ памяти, версия ${system.version}` : '—'}
          </span>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Вставка в другие окна</div>
        <div className="settings-group__desc">
          Текст вставляется в активное окно. Проверка честная: приложение вставит настоящий
          пробный текст, а вы скажете, появился он или нет — приложение не может увидеть чужие окна.
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Проверка вставки
            <div className="setting-row__desc">
              {probeBusy
                ? 'Вставляю через три секунды после нажатия…'
                : probe
                  ? probe.ok
                    ? 'Текст отправлен в активное окно. Появился?'
                    : probe.uncertain || probe.partial > 0
                      ? 'Результат ввода не подтверждён: текст мог попасть в окно полностью или частично. Проверьте окно перед повтором.'
                      : `Вставка отказала: ${probe.reason || 'причина неизвестна'}. Текст остался в буфере — вставьте через Ctrl+V.`
                  : 'Нажмите, переключитесь в Блокнот или Word и дождитесь пробного текста.'}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={checkInsert} disabled={probeBusy}>
            {probeBusy ? 'Вставляю…' : 'Проверить вставку'}
          </Button>
        </div>
        {probe?.ok ? (
          <div className="setting-row">
            <div className="setting-row__label">
              Текст появился?
              <div className="setting-row__desc">Ответ попадёт в журнал — по нему видно, работает ли вставка.</div>
            </div>
            <div className="setting-row__actions">
              <Button variant="white" size="sm" onClick={() => confirmProbe(true)}>
                Да, появился
              </Button>
              <Button variant="ghost" size="sm" onClick={() => confirmProbe(false)}>
                Нет
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Проверить диктовку сейчас</div>
        <div className="settings-group__desc">
          Две секунды записи с микрофона и настоящий проход движка — без вставки в другие окна и без
          записи в историю. Так видно, работает ли диктовка на этом компьютере, и за сколько секунд.
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Самопроверка
            <div className="setting-row__desc">
              {selfTest
                ? describeSelfTest(selfTest)
                : 'Нажмите и скажите любую фразу — результат появится здесь.'}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={checkDictation} disabled={selfBusy}>
            {selfBusy ? 'Проверяю…' : 'Проверить диктовку'}
          </Button>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Отправка отчётов</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Отправлять ошибки и логи
            <div className="setting-row__desc">
              Журнал пишется только на этом компьютере. <strong>Не уходят:</strong> распознанный
              текст, буфер, словарь, имя и звук — даже если отправка включена.
            </div>
          </div>
          <Toggle checked={settings.diagnostics !== false} onChange={toggleEnabled} />
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Состояние</span>
          <span className="kv-row__value">
            {!isElectron()
              ? 'браузерное превью — журнал только в этой вкладке'
              : settings.diagnostics === false
                ? 'выключено: наружу ничего не уходит'
                : status?.endpointConfigured
                  ? 'журнал пишется на этом компьютере, отправка на сервер включена'
                  : 'журнал пишется на этом компьютере; отправка на сервер выключена — отчёт сохраняется одной кнопкой'}
          </span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Журнал на диске</span>
          <span className="kv-row__value">{status?.file || '—'}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Идентификатор установки</span>
          <span className="kv-row__value">{status?.installId || 'локальный'}</span>
        </div>
        <div className="settings-group__desc">
          Что-то не работает? Нажмите «Сохранить отчёт в файл» — получится текстовый файл с
          журналом и окружением, его достаточно приложить к сообщению.
        </div>
        <div className="setting-row setting-row--wrap">
          <div className="setting-row__label">
            Адрес приёмника
            <div className="setting-row__desc">
              По умолчанию пусто — журнал остаётся на компьютере. Можно указать свой приёмник
              (например, развёрнутый из папки server): тогда события дополнительно уйдут туда.
            </div>
          </div>
          <div className="row-8">
            <input
              className="input settings-inline-input"
              style={{ width: 300 }}
              placeholder="https://…/v1/events"
              value={endpointDraft}
              onChange={(e) => setEndpointDraft(e.target.value)}
            />
            <Button
              variant="white"
              size="sm"
              onClick={saveEndpoint}
              disabled={busy === 'endpoint'}
            >
              {busy === 'endpoint' ? 'Сохраняю…' : 'Сохранить'}
            </Button>
            <Button
              variant="bare"
              size="sm"
              onClick={() => {
                // «только на этом компьютере» — состояние по умолчанию
                setEndpointDraft('');
                saveEndpoint('');
              }}
              disabled={busy === 'endpoint'}
            >
              Только на компьютере
            </Button>
          </div>
        </div>
        <div className="kv-row">
          <span className="kv-row__key">Последняя отправка</span>
          <span className="kv-row__value">
            {status?.lastSend
              ? `${timeOf(status.lastSend.at)} · ${status.lastSend.ok ? 'успешно' : `ошибка: ${status.lastSend.reason}`}`
              : 'ещё не было'}
          </span>
        </div>
        <div className="row-8" style={{ flexWrap: 'wrap', marginTop: 8 }}>
          <Button variant="white" size="sm" onClick={saveReport} disabled={busy === 'report'}>
            {busy === 'report' ? 'Сохраняю…' : 'Сохранить отчёт в файл'}
          </Button>
          <Button variant="ghost" size="sm" onClick={sendNow} disabled={busy === 'send'}>
            {busy === 'send' ? 'Отправляю…' : 'Отправить сейчас'}
          </Button>
          <Button variant="ghost" size="sm" onClick={ping} disabled={busy === 'ping'}>
            {busy === 'ping' ? 'Проверяю…' : 'Проверить канал'}
          </Button>
          <Button variant="ghost" size="sm" onClick={copyLogs}>
            Скопировать ошибки
          </Button>
          <Button variant="ghost" size="sm" onClick={openFolder}>
            Открыть папку с логами
          </Button>
          <Button variant="ghost" size="sm" onClick={clearLogs}>
            Очистить журнал
          </Button>
          <Button variant="bare" size="sm" onClick={refresh}>
            Обновить список
          </Button>
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">
          Последние события {events.length ? `· ${events.length}` : ''}{' '}
          {errors ? <span className="settings-foot__hint--warn">· ошибок: {errors}</span> : null}
        </div>
        {events.length === 0 ? (
          <div className="settings-group__desc">
            Пока пусто. События появятся, когда что-то произойдёт: запись, распознавание, обновление
            или ошибка интерфейса.
          </div>
        ) : (
          <div className="diag-list scroll-area">
            {events.map((e, i) => (
              <div key={`${e.at}-${i}`} className={`diag-row diag-row--${e.level}`}>
                <span className="diag-row__time">{timeOf(e.at)}</span>
                <span className="diag-row__level">{LEVEL_LABEL[e.level] || e.level}</span>
                <span className="diag-row__scope">{e.scope}</span>
                <span className="diag-row__msg">
                  {e.message}
                  {e.data && Object.keys(e.data).length ? (
                    <span className="diag-row__data">
                      {Object.entries(e.data)
                        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
                        .join(' · ')}
                    </span>
                  ) : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
