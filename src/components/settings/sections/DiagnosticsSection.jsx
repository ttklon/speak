import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { localEvents } from '../../../lib/diagnostics.js';
import { isElectron } from '../../../lib/storage.js';
import { writeClipboard } from '../../../lib/clipboard.js';
import { APP } from '../../../lib/config.js';

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
export default function DiagnosticsSection() {
  const { settings, updateSettings } = useAppData();
  const { push } = useToast();
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState('');
  // черновик адреса приёмника: применяется по кнопке, чтобы не дёргать
  // сеть на каждом нажатии клавиши
  const [endpointDraft, setEndpointDraft] = useState('');

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
      push({ title: 'Скопировать не удалось', description: String(err?.message || err), tone: 'warn' });
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

  return (
    <div>
      <h2 className="settings-section__title">Диагностика</h2>
      <p className="settings-section__desc">
        Чтобы ошибки можно было починить, а не угадывать. По умолчанию журнал пишется только на
        этом компьютере; отправку на сервер можно включить в любой момент, указав адрес приёмника.
      </p>

      <div className="settings-group">
        <div className="settings-group__title">Отправка отчётов</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Отправлять ошибки и логи
            <div className="setting-row__desc">
              Журнал всегда пишется локально. Отправка на сервер происходит только если ниже указан
              адрес приёмника: уходят одни технические события — уровни, тексты ошибок, версия,
              платформа и состояние движка распознавания. <strong>Не уходят:</strong> распознанный
              текст, содержимое буфера обмена, словарь, имя пользователя и звук. Почта и пути вида
              C:\Users\Имя вырезаются перед отправкой.
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
          По умолчанию ничего никуда не уходит: журнал лежит на этом компьютере. Если что-то не
          работает — нажмите «Сохранить отчёт в файл»: на Рабочем столе (в браузере — в папке
          загрузок) появится текстовый файл с журналом и окружением, его достаточно приложить
          к сообщению. Кнопка «Скопировать
          ошибки» делает то же самое, но в буфер обмена. Отправка на сервер нужна только тем,
          у кого он есть.
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
