import { useEffect, useState } from 'react';
import { Button } from '../../ui/Controls.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';

/**
 * Аккаунт здесь не «облачный»: одно имя для приветствия, всё остальное — локально.
 * Почта, подписка и credits из видео-обзора намеренно убраны.
 */
export default function AccountSection() {
  const { profile, setProfile, settings, updateSettings, dictations } = useAppData();
  const { push } = useToast();
  const [name, setName] = useState(settings.userName || profile.name);

  useEffect(() => {
    setName(settings.userName || profile.name);
  }, [profile, settings.userName]);

  const save = () => {
    const clean = name.trim().slice(0, 40);
    updateSettings({ userName: clean });
    setProfile({ ...profile, name: clean });
    push({
      title: clean ? 'Имя сохранено' : 'Имя очищено',
      description: clean || 'Приветствие будет без имени.',
      tone: 'success',
    });
  };

  return (
    <div>
      <h2 className="settings-section__title">Профиль</h2>
      <p className="settings-section__desc">
        ZSpeakly не создаёт учётную запись в облаке: имя и данные хранятся только на этом компьютере.
      </p>

      <div className="setting-row">
        <div className="setting-row__label">Как вас называть</div>
        <input
          className="input settings-inline-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save();
          }}
          placeholder="Ваше имя"
        />
      </div>
      {/* числа считаем по истории: раньше здесь была приписка «+ 9000 слов»
          и «143 секунды», то есть демонстрационные цифры вместо реальных */}
      <div className="setting-row">
        <div className="setting-row__label">Слов в истории</div>
        <span className="setting-row__value">
          {dictations.reduce((sum, d) => sum + (d.words || 0), 0).toLocaleString('ru-RU')}
        </span>
      </div>
      <div className="setting-row">
        <div className="setting-row__label">Секунд речи</div>
        <span className="setting-row__value">
          {Math.round(
            dictations.reduce((sum, d) => sum + (d.durationMs || 0), 0) / 1000,
          ).toLocaleString('ru-RU')}
        </span>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Локальный режим</div>
        <div className="settings-group__desc">
          Ни подписки, ни лимитов, ни отправки данных: приложение целиком работает на вашем ПК.
        </div>
        <Button variant="bare" size="sm" onClick={() => updateSettings({ onboarded: false })}>
          Показать приветствие заново
        </Button>
      </div>
    </div>
  );
}
