import { useEffect, useState } from 'react';
import { Button, Select } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { APP, LANGUAGES } from '../../../lib/config.js';
import { isElectron } from '../../../lib/storage.js';
import MicTester from './MicTester.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import ConfirmDialog from '../../ui/ConfirmDialog.jsx';

export default function AppSection() {
  const { settings, updateSettings, resetAll } = useAppData();
  const { push } = useToast();
  // сброс удаляет историю, буфер и словарь — спрашиваем подтверждение
  const [confirmReset, setConfirmReset] = useState(false);
  // голоса Windows подгружаются асинхронно — слушаем onvoiceschanged
  const [voices, setVoices] = useState([]);
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return undefined;
    const load = () => setVoices(speechSynthesis.getVoices?.() || []);
    load();
    speechSynthesis.addEventListener?.('voiceschanged', load);
    return () => speechSynthesis.removeEventListener?.('voiceschanged', load);
  }, []);

  return (
    <div>
      <h2 className="settings-section__title">Приложение</h2>
      <p className="settings-section__desc">
        Внешний вид, запуск и поведение окна. Всё применяется сразу.
      </p>

      <div className="settings-group">
        <div className="settings-group__title">Интерфейс</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Язык диктовки
            <div className="setting-row__desc">
              Язык распознавания речи. Сам интерфейс пока на русском — здесь выбор на него не влияет.
            </div>
          </div>
          <Select
            value={settings.language}
            onChange={(v) => updateSettings({ language: v })}
            options={LANGUAGES.map((l) => ({ value: l.id, label: l.native }))}
            width={170}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Тема</div>
          <Select
            value={settings.theme}
            onChange={(v) => updateSettings({ theme: v })}
            options={[
              { value: 'dark', label: 'Тёмная' },
              { value: 'light', label: 'Светлая' },
              { value: 'system', label: 'Как в системе' },
            ]}
            width={170}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Плавающий индикатор записи
            <div className="setting-row__desc">
              Показывает «Слушаю…» с уровнем микрофона поверх окон. Выключите, если мешает, —
              запись при этом работает как обычно.
            </div>
          </div>
          <Toggle
            checked={settings.showFloatingIndicator !== false}
            onChange={(v) => updateSettings({ showFloatingIndicator: v })}
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Предпросмотр диктовки</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Читать результат голосом
            <div className="setting-row__desc">
              После диктовки ZSpeakly озвучит текст системным голосом Windows — удобно проверить, что
              распознано верно.
            </div>
          </div>
          <Toggle
            checked={Boolean(settings.readAloud)}
            onChange={(v) => {
              updateSettings({ readAloud: v });
              if (v && typeof speechSynthesis !== 'undefined') {
                const v0 = new SpeechSynthesisUtterance('Предпросмотр диктовки включён');
                v0.lang = 'ru-RU';
                const chosen = voices.find((x) => x.voiceURI === settings.readAloudVoice);
                if (chosen) v0.voice = chosen;
                speechSynthesis.speak(v0);
              }
            }}
          />
        </div>
        {settings.readAloud ? (
          <div className="setting-row">
            <div className="setting-row__label">
              Голос
              <div className="setting-row__desc">
                {voices.length
                  ? 'Каким голосом читать результат. Список — из установленных в Windows.'
                  : 'Системные голоса ещё не загрузились — читать будет голос по умолчанию.'}
              </div>
            </div>
            <Select
              value={settings.readAloudVoice || ''}
              onChange={(v) => updateSettings({ readAloudVoice: v })}
              options={[
                { value: '', label: 'Системный' },
                ...voices.map((v) => ({ value: v.voiceURI, label: v.name })),
              ]}
              width={200}
            />
          </div>
        ) : null}
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Звук и ввод</div>
        <MicTester />
        <div className="setting-row">
          <div className="setting-row__label">
            Звуковой отклик
            <div className="setting-row__desc">Короткий сигнал при старте и остановке записи.</div>
          </div>
          <Toggle checked={settings.soundFeedback} onChange={(v) => updateSettings({ soundFeedback: v })} />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Эффект печати
            <div className="setting-row__desc">Текст появляется по словам, а не целиком.</div>
          </div>
          <Toggle checked={settings.typingEffect} onChange={(v) => updateSettings({ typingEffect: v })} />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Запуск</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Автозапуск с Windows
            <div className="setting-row__desc">
              {isElectron()
                ? 'Добавляет ZSpeakly в HKCU\\…\\Run при входе в систему.'
                : 'Доступно в установленной Windows-сборке.'}
            </div>
          </div>
          <Toggle
            checked={settings.autoLaunch}
            // сам вызов main делает эффект в App.jsx — он же синхронизирует
            // автозапуск при старте, поэтому здесь только настройка
            onChange={(v) => updateSettings({ autoLaunch: v })}
            disabled={!isElectron()}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Свернуть в трей при закрытии</div>
          <Toggle
            checked={settings.closeToTray !== false}
            onChange={(v) => updateSettings({ closeToTray: v })}
            disabled={!isElectron()}
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Сброс</div>
        <div className="settings-group__desc">
          Удаляет историю диктовок, буфер, словарь и заметки на этом устройстве.
        </div>
        <Button variant="danger" size="sm" onClick={() => setConfirmReset(true)}>
          Сбросить все данные
        </Button>
        <div className="settings-foot-hint" style={{ marginTop: 10 }}>
          Версия {APP.version} · сборка {APP.build}
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={() => {
          resetAll();
          push({ title: 'Данные сброшены', description: 'ZSpeakly вернулся к настройкам по умолчанию.', tone: 'warn' });
        }}
        title="Сбросить все данные?"
        description="История диктовок, буфер обмена, словарь и заметки будут удалены с этого компьютера. Вернуть их не получится."
        confirmLabel="Сбросить"
      />
    </div>
  );
}
