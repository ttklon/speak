import { useState } from 'react';
import { Check } from 'lucide-react';
import { Button, Select } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { LANGUAGES } from '../../../lib/config.js';
import { engineName } from '../../../lib/recognition/engine.js';
import ModelManager from './ModelManager.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';

export default function FeaturesSection() {
  const { settings, updateSettings } = useAppData();
  const { push } = useToast();
  const [showLanguages, setShowLanguages] = useState(false);

  return (
    <div>
      <h2 className="settings-section__title">Функции</h2>
      <p className="settings-section__desc">Выберите, как речь преобразуется в текст.</p>

      <div className="settings-group">
        <div className="settings-group__title">Обработка ИИ</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Постобработка текста
            <div className="setting-row__desc">
              Убирает слова-паразиты, расставляет пунктуацию и заглавные буквы. Работает офлайн-правилами.
            </div>
          </div>
          <Toggle checked={settings.aiProcessing} onChange={(v) => updateSettings({ aiProcessing: v })} />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Локальная модель (Ollama)
            <div className="setting-row__desc">
              Адрес локального сервера. Если недоступен — ZSpeakly тихо вернётся к офлайн-правилам.
            </div>
          </div>
          <input
            className="input settings-inline-input"
            value={settings.aiEndpoint}
            onChange={(e) => updateSettings({ aiEndpoint: e.target.value })}
            placeholder="http://localhost:11434"
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Модель</div>
          <input
            className="input settings-inline-input"
            value={settings.aiModel}
            onChange={(e) => updateSettings({ aiModel: e.target.value })}
            placeholder="qwen2.5:0.5b"
          />
        </div>
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Разговорные языки</div>
        <div className="settings-group__desc">
          Выберите языки, на которых вы можете говорить. Это повышает точность распознавания.
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Язык диктовки</div>
          <Select
            value={settings.language}
            onChange={(v) => updateSettings({ language: v })}
            options={LANGUAGES.map((l) => ({ value: l.id, label: l.native }))}
            width={190}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Дополнительные варианты</div>
          <Button variant="ghost" size="sm" onClick={() => setShowLanguages((v) => !v)}>
            {showLanguages ? 'Скрыть' : 'Выбрать варианты'}
          </Button>
        </div>
        {showLanguages ? (
          <div className="lang-list">
            {LANGUAGES.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`lang-item ${settings.language === l.id ? 'is-active' : ''}`}
                onClick={() => updateSettings({ language: l.id })}
              >
                <span>{l.label}</span>
                <span className="lang-item__native">{l.native}</span>
                {settings.language === l.id ? <Check size={12} style={{ color: 'var(--green)' }} /> : null}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div className="settings-group">
        <div className="settings-group__title">Язык перевода для инструкций</div>
        <div className="settings-group__desc">
          Куда переводить выделенный текст, когда срабатывает инструкция «Перевести на английский»
          (Ctrl+Alt+E).
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Переводить на</div>
          <Select
            value={settings.translateTarget}
            onChange={(v) => updateSettings({ translateTarget: v })}
            options={LANGUAGES.map((l) => ({ value: l.id, label: l.native }))}
            width={190}
          />
        </div>
      </div>

      <ModelManager />

      <div className="settings-group">
        <div className="settings-group__title">Буфер обмена</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Мониторить буфер обмена
            <div className="setting-row__desc">
              Сохраняет всё, что вы копируете, и форматирует для быстрого поиска.
            </div>
          </div>
          <Toggle
            checked={settings.clipboardMonitor}
            onChange={(v) => updateSettings({ clipboardMonitor: v })}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Максимальный размер истории</div>
          <Select
            value={String(settings.clipboardMaxItems)}
            onChange={(v) => updateSettings({ clipboardMaxItems: Number(v) })}
            options={[1000, 5000, 10000, 50000].map((n) => ({ value: String(n), label: n.toLocaleString('ru-RU') }))}
            width={130}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Хранить</div>
          <Select
            value={String(settings.clipboardRetentionDays)}
            onChange={(v) => updateSettings({ clipboardRetentionDays: Number(v) })}
            options={[
              { value: '1', label: '24 часа' },
              { value: '7', label: '1 неделя' },
              { value: '30', label: '1 месяц' },
              { value: '0', label: 'Не хранить' },
            ]}
            width={130}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">Скрывать пароли</div>
          <Toggle
            checked={settings.hidePasswords}
            onChange={(v) => updateSettings({ hidePasswords: v })}
          />
        </div>
      </div>
    </div>
  );
}
