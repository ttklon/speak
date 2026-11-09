import { useEffect, useState } from 'react';
import { Mic } from 'lucide-react';
import Modal from '../ui/Modal.jsx';
import { Button } from '../ui/Controls.jsx';
import { useAppData } from '../../state/AppDataProvider.jsx';
import { keysLabel } from '../../lib/utils.js';
import { APP } from '../../lib/config.js';

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
        <Button variant="white" onClick={done}>
          Начать работу
        </Button>
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
            Диктовка — {keysLabel(settings.dictationKeys || ['Ctrl', 'Alt', 'Space'])}. Удерживайте клавишу и
            говорите.
          </span>
        </div>
      </div>
    </Modal>
  );
}
