import { useEffect, useState } from 'react';
import Modal from '../ui/Modal.jsx';
import { Button } from '../ui/Controls.jsx';
import { useAppData } from '../../state/AppDataProvider.jsx';
import { useToast } from '../../state/ToastProvider.jsx';
import { APP } from '../../lib/config.js';

/** Профиль и аккаунт — раздел «Аккаунт» из настроек в видео. */
export default function ProfileModal({ open, onClose, onOpenSettings }) {
  const { profile, setProfile, dictations, clipboard, storageSize } = useAppData();
  const { push } = useToast();
  const [name, setName] = useState(profile.name);

  useEffect(() => {
    if (open) {
      setName(profile.name);
    }
  }, [open, profile]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Аккаунт"
      width={440}
      footer={
        <>
          <Button variant="bare" onClick={onOpenSettings}>
            Все настройки
          </Button>
          <Button
            variant="white"
            onClick={() => {
              setProfile({ ...profile, name: name.trim() });
              push({ title: 'Профиль сохранён', tone: 'success' });
              onClose?.();
            }}
          >
            Сохранить
          </Button>
        </>
      }
    >
      <div className="profile-modal">
        <div className="profile-modal__hero">
          <span className="profile-modal__avatar">{(name || 'Z')[0].toUpperCase()}</span>
          <div>
            <div className="profile-modal__name">{name || 'Без имени'}</div>
            <div className="profile-modal__plan">локальный профиль</div>
          </div>
        </div>

        <div className="stack-12" style={{ marginTop: 14 }}>
          <div className="field">
            <label className="field__label" htmlFor="profile-name">
              Как вас называть
            </label>
            <input
              id="profile-name"
              className="input"
              data-autofocus
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <div className="profile-stats">
          <div>
            <div className="profile-stats__value">{dictations.length}</div>
            <div className="profile-stats__label">расшифровок</div>
          </div>
          <div>
            <div className="profile-stats__value">
              {dictations.reduce((sum, d) => sum + (d.words || 0), 0)}
            </div>
            <div className="profile-stats__label">слов в истории</div>
          </div>
          <div>
            <div className="profile-stats__value">{clipboard.length}</div>
            <div className="profile-stats__label">в буфере</div>
          </div>
          <div>
            <div className="profile-stats__value">{(storageSize / 1024 / 1024).toFixed(1)}</div>
            <div className="profile-stats__label">МБ данных</div>
          </div>
        </div>

        <div className="profile-modal__foot">
          <span>Версия {APP.version}</span>
          <span className="profile-modal__dot" />
          <span>офлайн, без облака</span>
        </div>
      </div>
    </Modal>
  );
}
