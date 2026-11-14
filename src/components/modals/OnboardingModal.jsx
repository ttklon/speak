import { useEffect, useState } from 'react';
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
  const engine = engineName();
  const engineReady = /whisper\.cpp/.test(engine);
  const engineHint = /Web Speech/.test(engine)
    ? 'Сейчас доступен только Web Speech — он работает в браузере и требует интернета. Для офлайн-диктовки нажмите «Скачать модель».'
    : 'Движок распознавания ещё не установлен. Нажмите «Скачать модель» — это один раз, дальше всё работает без интернета.';

  const openModelSetup = () => {
    const clean = name.trim().slice(0, 40);
    updateSettings({ onboarded: true, userName: clean });
    if (clean) setProfile({ ...profile, name: clean });
    navigate('settings', { section: 'features' });
  };

  const done = () => {
    const clean = name.trim().slice(0, 40);
    updateSettings({ onboarded: true, userName: clean });
    if (clean) setProfile({ ...profile, name: clean });
  };

  return (
    <Modal
      open={open}
      onClose={done}
      title="Как вас называть?"
      width={420}
      hideClose
      footer={
        <>
          {engineReady ? null : (
            <Button variant="ghost" onClick={openModelSetup} style={{ marginRight: 'auto' }}>
              Скачать модель
            </Button>
          )}
          <Button variant="white" onClick={done}>
            Начать работу
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
        {engineReady ? null : (
          <div className="onboarding__hint onboarding__hint--warn">
            <TriangleAlert size={12} />
            <span>{engineHint}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}
