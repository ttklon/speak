import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { localEvents } from '../../../lib/diagnostics.js';
import { isElectron } from '../../../lib/storage.js';
import { writeClipboard } from '../../../lib/clipboard.js';
import { LOG_ENDPOINT as DEFAULT_LOG_ENDPOINT } from '../../../lib/config.js';

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
        Чтобы ошибки можно было починить, а не угадывать. По умолчанию отправка включена, её можно
        выключить в любой момент.
      </p>

      <div className="settings-group">
        <div className="settings-group__title">Отправка отчётов</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Отправлять ошибки и логи
            <div className="setting-row__desc">
              Уходят только технические события: уровни, тексты ошибок, версия, платформа и состояние
              движка распознавания. <strong>Не уходят:</strong> распознанный текст, содержимое буфера
              обмена, словарь, имя пользователя и звук. Почта и пути вида C:\Users\Имя вырезаются перед
              отправкой.
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
                  ? 'включено, приёмник настроен'
                  : 'включено, но приёмник ещё не развёрнут — события копятся локально'}
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
          Если приёмник ещё не развёрнут или недоступен, отправка просто не удаётся — события
          остаются в журнале. Кнопка «Скопировать ошибки» кладёт последние строки в буфер: их можно
          прислать разработчику в чат, и этого хватит, чтобы найти причину.
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Адрес приёмника
            <div className="setting-row__desc">
              По умолчанию — сервер ZSpeakly. Можно указать свой (например, развёрнутый из папки
              server) или очистить поле, чтобы ничего не отправлять.
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
              disabled={busy === 'endpoint' || !isElectron()}
            >
              {busy === 'endpoint' ? 'Сохраняю…' : 'Сохранить'}
            </Button>
            <Button
              variant="bare"
              size="sm"
              onClick={() => {
                setEndpointDraft(DEFAULT_LOG_ENDPOINT);
                push({
                  title: 'Адрес по умолчанию подставлен',
                  description: 'Нажмите «Сохранить», чтобы применить.',
                  tone: 'info',
                });
              }}
            >
              По умолчанию
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
          <Button variant="white" size="sm" onClick={sendNow} disabled={busy === 'send' || !isElectron()}>
            {busy === 'send' ? 'Отправляю…' : 'Отправить сейчас'}
          </Button>
          <Button variant="ghost" size="sm" onClick={ping} disabled={busy === 'ping' || !isElectron()}>
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
