import { useCallback, useEffect, useState } from 'react';
import { Mic, TriangleAlert } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Button } from '../ui/Controls.jsx';
import { useAppData } from '../../state/AppDataProvider.jsx';
import { keysLabel } from '../../lib/utils.js';
import { APP } from '../../lib/config.js';
import { engineName } from '../../lib/recognition/engine.js';
import { navigate } from '../../lib/router.js';

/**
 * Первый запуск: одно поле — как вас зовут. Никакой регистрации и почты,
 * всё остаётся на компьютере (как просил автор в аудиодорожке).
 *
 * Если движка нет, человека не отправляют искать настройки: одна кнопка
 * «Скачать и начать» скачивает движок и модель прямо здесь, с процентом.
 * Раньше первый запуск стоил трёх шагов — онбординг → настройки → «Скачать».
 */
export default function OnboardingModal() {
  const { settings, updateSettings, profile, setProfile } = useAppData();
  const [mounted, setMounted] = useState(false);
  // портал нельзя рендерить на сервере (тесты SSR) — включаем только в браузере
  useEffect(() => setMounted(true), []);
  const open = mounted && !settings.onboarded;
  // имени может не быть вовсе — тогда поле пустое
  const preset = settings.userName || profile?.name || '';
  const [name, setName] = useState(preset);

  useEffect(() => {
    if (open) setName(preset);
  }, [open, preset]);

  // Офлайн-диктовку даёт только whisper.cpp. Web Speech в браузере требует
  // интернета, поэтому на чистой установке сразу говорим, где взять движок.
  //
  // «Мост есть» ≠ «модель скачана»: transcribePcm живёт в рендерере всегда, а
  // файла модели может не быть. Раньше онбординг из-за этого говорил «готово»,
  // а первая диктовка заканчивалась ошибкой. Поэтому спрашиваем main-процесс.
  const engine = engineName();
  const [engineState, setEngineState] = useState('check');
  const engineHint = /Web Speech/.test(engine)
    ? 'Сейчас доступен только Web Speech — он работает в браузере и требует интернета. Для офлайн-диктовки нажмите «Скачать и начать».'
    : 'Движок распознавания ещё не установлен. «Скачать и начать» поставит его и модель — один раз, дальше всё работает без интернета.';

  // Подготовка к диктовке прямо в окне онбординга: движок, потом модель.
  // Состояния: idle → engine → model → ready, либо failed с причиной.
  const [prep, setPrep] = useState({ state: 'idle', percent: 0, note: '' });

  const bridge = typeof window !== 'undefined' ? window.zspeakly?.native : null;
  const canDownload = Boolean(bridge?.downloadEngine && bridge?.downloadModel);
  const busy = prep.state === 'engine' || prep.state === 'model';

  useEffect(() => {
    if (!open) return undefined;
    if (!bridge?.sttStatus) {
      // В браузере спрашивать некого: решает то, что видно по движку
      setEngineState(/whisper\.cpp/.test(engine) ? 'ready' : 'missing');
      return undefined;
    }
    let alive = true;
    bridge
      .sttStatus(settings.whisperModel)
      .then((res) => {
        if (alive) setEngineState(res?.available ? 'ready' : 'missing');
      })
      .catch(() => {
        if (alive) setEngineState(/whisper\.cpp/.test(engine) ? 'ready' : 'missing');
      });
    return () => {
      alive = false;
    };
    // engine — вычисляемое имя движка, зависит только от наличия моста
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bridge, settings.whisperModel]);

  const engineReady = engineState === 'ready';

  // Процент приходит событием из главного процесса; в браузере его нет
  useEffect(() => {
    if (!open || !bridge?.onModelProgress) return undefined;
    return bridge.onModelProgress((p) => {
      const percent = Math.round(Number(p?.percent) || 0);
      if (!Number.isFinite(percent) || percent <= 0) return;
      setPrep((prev) =>
        prev.state === 'engine' || prev.state === 'model' ? { ...prev, percent } : prev,
      );
    });
  }, [open, bridge]);

  const rememberName = useCallback(() => name.trim().slice(0, 40), [name]);

  // Если скачать не удалось, дальше — обычный путь в настройки
  const openModelSetup = () => {
    const clean = rememberName();
    updateSettings({ onboarded: true, userName: clean });
    if (clean) setProfile({ ...profile, name: clean });
    navigate('settings', { section: 'dictation' });
  };

  const prepare = async () => {
    // имя сохраняем сразу: если человек закроет окно на скачивании, оно останется
    const clean = rememberName();
    updateSettings({ userName: clean });
    if (clean) setProfile({ ...profile, name: clean });

    if (!canDownload) {
      setPrep({
        state: 'failed',
        percent: 0,
        note: 'В браузере скачивания нет — диктовка идёт через Web Speech и требует интернета.',
      });
      return;
    }

    setPrep({ state: 'engine', percent: 0, note: 'Скачиваю движок распознавания' });
    // Движок может быть уже на месте — тогда шаг пропускается сам
    let status = null;
    try {
      status = bridge.sttStatus ? await bridge.sttStatus(settings.whisperModel) : null;
    } catch {
      status = null;
    }
    if (!status?.available) {
      const engine = await bridge.downloadEngine().catch((err) => ({ ok: false, reason: String(err?.message || err) }));
      if (!engine?.ok && !/уже/i.test(String(engine?.reason || ''))) {
        setPrep({
          state: 'failed',
          percent: 0,
          note: `Движок не скачался: ${engine?.reason || 'нет связи'}.`,
        });
        return;
      }
    }

    setPrep({ state: 'model', percent: 0, note: 'Скачиваю модель для этого компьютера' });
    const model = await bridge
      .downloadModel(settings.whisperModel || 'base')
      .catch((err) => ({ ok: false, reason: String(err?.message || err) }));
    if (!model?.ok) {
      setPrep({
        state: 'failed',
        percent: 0,
        note: `Модель не скачалась: ${model?.reason || 'нет связи'}. Можно скачать позже в настройках.`,
      });
      return;
    }
    setEngineState('ready');
    setPrep({ state: 'ready', percent: 100, note: 'Готово: диктовка работает без интернета.' });
  };


  const done = () => {
    const clean = name.trim().slice(0, 40);
    updateSettings({ onboarded: true, userName: clean });
    if (clean) setProfile({ ...profile, name: clean });
  };

  const preparing = busy;
  const needsSetup = canDownload && !engineReady && prep.state === 'idle';
  // Одна кнопка на старте: либо настройка, либо сразу работа.
  const cta = needsSetup
    ? { label: 'Скачать и начать', onClick: prepare }
    : preparing
      ? {
          // процент показываем, только когда он настоящий: без событий
          // прогресса «Скачиваю… 0%» выглядит зависшим
          label: prep.percent > 0 ? `Скачиваю… ${prep.percent}%` : 'Скачиваю…',
          onClick: () => {},
          disabled: true,
        }
      : { label: 'Начать работу', onClick: done };

  return (
    <Modal
      open={open}
      onClose={done}
      title="Как вас называть?"
      width={420}
      hideClose
      footer={
        <>
          {prep.state === 'failed' ? (
            <Button
              variant="ghost"
              onClick={openModelSetup}
              style={{ marginRight: 'auto' }}
            >
              Открыть настройки
            </Button>
          ) : null}
          <Button variant="white" onClick={cta.onClick} disabled={cta.disabled}>
            {cta.label}
          </Button>
        </>
      }
    >
      <div className="onboarding">
        <div className="onboarding__logo">
          <span className="about-logo">Z</span>
        </div>
        <p className="onboarding__text">
          Имя нужно только для приветствия — {APP.name} работает офлайн, без аккаунта, облака и подписки.
        </p>
        <div className="field">
          <label className="field__label" htmlFor="onboarding-name">
            Ваше имя
          </label>
          <input
            id="onboarding-name"
            className="input"
            data-autofocus
            value={name}
            placeholder="Например, Максим"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') done();
            }}
          />
        </div>
        <div className="onboarding__hint">
          <Mic size={12} />
          <span>
            Диктовка — {keysLabel(settings.dictationKeys || ['Ctrl', 'Alt', 'Space'])}. Нажмите, говорите,
            нажмите ещё раз — текст вставится.
          </span>
        </div>
        {needsSetup ? (
          <div className="onboarding__hint onboarding__hint--warn">
            <TriangleAlert size={12} />
            <span>{engineHint}</span>
          </div>
        ) : null}
        {preparing || prep.state === 'ready' || prep.state === 'failed' ? (
          <div className={`onboarding__prep ${prep.state === 'failed' ? 'is-bad' : ''}`}>
            <div className="onboarding__prep-text">{prep.note}</div>
            {preparing ? (
              <div className="onboarding__bar">
                <span style={{ width: `${Math.max(4, prep.percent)}%` }} />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
