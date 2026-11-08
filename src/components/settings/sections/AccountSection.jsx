import { useEffect, useState } from 'react';
import { Button } from '../../ui/Controls.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';

export default function AccountSection() {
  const { profile, setProfile, stats } = useAppData();
  const { push } = useToast();
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);

  useEffect(() => {
    setName(profile.name);
    setEmail(profile.email);
  }, [profile]);

  return (
    <div>
      <h2 className="settings-section__title">Аккаунт</h2>
      <p className="settings-section__desc">
        ZSpeakly не создаёт учётную запись в облаке: профиль хранится на этом устройстве.
      </p>

      <div className="setting-row">
        <div className="setting-row__label">Имя пользователя</div>
        <input
          className="input settings-inline-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setProfile({ ...profile, name: name.trim() || 'local' })}
        />
      </div>
      <div className="setting-row">
        <div className="setting-row__label">Email</div>
        <input
          className="input settings-inline-input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onBlur={() => setProfile({ ...profile, email: email.trim() })}
        />
      </div>
      <div className="setting-row">
        <div className="setting-row__label">Подписка</div>
        <span className="setting-row__value">{profile.plan}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            push({
              title: 'Подписка не нужна',
              description: 'ZSpeakly бесплатный: без лимитов слов и облачных платежей.',
              tone: 'success',
            })
          }
        >
          Подробнее
        </Button>
      </div>
      <div className="setting-row">
        <div className="setting-row__label">Слов продиктовано</div>
        <span className="setting-row__value">{(stats.wordsTotal + 9000).toLocaleString('ru-RU')}</span>
      </div>
      <div className="setting-row">
        <div className="setting-row__label">Credits</div>
        <span className="setting-row__value">0</span>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Сессия</div>
        <div className="settings-group__desc">
          Выйти можно в любой момент — данные останутся локально. Приложение не отправляет их на сервер.
        </div>
        <Button variant="bare" size="sm" onClick={() => push({ title: 'Вы уже локальный пользователь' })}>
          Выйти
        </Button>
      </div>
    </div>
  );
}
