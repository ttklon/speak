import { useEffect, useState } from 'react';
import { Button } from '../../ui/Controls.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { APP } from '../../../lib/config.js';

/**
 * «Проверить обновления» — настоящая проверка через electron-updater.
 * В браузере и portable-сборке честно говорит, что автообновление недоступно.
 */
export default function UpdateRow() {
  const { push } = useToast();
  const [state, setState] = useState({ status: 'idle', version: null, percent: 0, reason: '' });
  const bridge = typeof window !== 'undefined' ? window.zspeakly?.native : null;

  useEffect(() => {
    if (!bridge?.onUpdateStatus) return undefined;
    return bridge.onUpdateStatus((next) => setState((prev) => ({ ...prev, ...next })));
  }, [bridge]);

  useEffect(() => {
    if (state.status === 'available') {
      push({
        title: `Доступна версия ${state.version}`,
        description: 'Нажмите «Скачать», приложение обновится само.',
        tone: 'success',
      });
    }
    if (state.status === 'latest') push({ title: 'Обновлений нет', description: `Установлена ${APP.version}.`, tone: 'success' });
    if (state.status === 'downloaded') {
      push({ title: `Версия ${state.version} загружена`, description: 'Перезапустите, чтобы применить.', tone: 'success' });
    }
    if (state.status === 'error') push({ title: 'Не удалось проверить обновления', description: state.reason, tone: 'warn' });
    if (state.status === 'unavailable') push({ title: 'Автообновление недоступно', description: state.reason, tone: 'warn' });
  }, [state.status, state.version, state.reason, push]);

  const check = async () => {
    if (!bridge?.checkUpdates) {
      push({
        title: 'Автообновление только в установленной версии',
        description: 'В браузере проверка недоступна — скачайте exe из GitHub Releases.',
        tone: 'warn',
      });
      return;
    }
    setState({ status: 'checking', version: null, percent: 0, reason: '' });
    // Ошибка сети/обновлятора не должна оставлять кнопку в «Проверяю…» навсегда.
    try {
      const res = await bridge.checkUpdates();
      if (res?.status) setState((prev) => ({ ...prev, ...res }));
      else setState({ status: 'error', version: null, percent: 0, reason: 'главный процесс не ответил' });
    } catch (err) {
      setState({ status: 'error', version: null, percent: 0, reason: String(err?.message || err) });
    }
  };

  // Скачивание и установка тоже могут отказать (нет сети, нет прав) — сообщаем.
  const download = async () => {
    try {
      const res = await bridge?.downloadUpdate?.();
      if (res?.status && res.status !== 'downloaded' && res.status !== 'downloading') {
        setState((prev) => ({ ...prev, ...res }));
      }
    } catch (err) {
      push({ title: 'Не удалось скачать обновление', description: String(err?.message || err), tone: 'warn' });
    }
  };

  const install = async () => {
    try {
      const ok = await bridge?.installUpdate?.();
      if (!ok) push({ title: 'Перезапуск не удался', description: 'Закройте приложение вручную и запустите снова.', tone: 'warn' });
    } catch (err) {
      push({ title: 'Перезапуск не удался', description: String(err?.message || err), tone: 'warn' });
    }
  };

  const busy = state.status === 'checking' || state.status === 'downloading';

  return (
    <div className="row-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
      <Button variant="bare" size="sm" loading={state.status === 'checking'} onClick={check} disabled={busy}>
        Проверить обновления
      </Button>
      {state.status === 'available' ? (
        <Button variant="white" size="sm" onClick={download}>
          Скачать {state.version}
        </Button>
      ) : null}
      {state.status === 'downloading' ? (
        <span className="settings-foot__hint">Скачиваю… {state.percent}%</span>
      ) : null}
      {state.status === 'downloaded' ? (
        <Button variant="white" size="sm" onClick={install}>
          Перезапустить и обновить
        </Button>
      ) : null}
      {state.status === 'unavailable' ? (
        <span className="settings-foot__hint settings-foot__hint--warn">
          {state.reason}. Новую версию можно взять на GitHub — там же, где скачали эту.{' '}
          <button
            type="button"
            className="link-btn"
            onClick={() =>
              window.zspeakly?.native?.openExternal?.('https://github.com/ttklon/speak/releases') ??
              window.open('https://github.com/ttklon/speak/releases', '_blank', 'noreferrer')
            }
          >
            Открыть релизы
          </button>
        </span>
      ) : (
        <span className="settings-foot__hint">Установлено {APP.version} · сборка {APP.build}</span>
      )}
    </div>
  );
}
