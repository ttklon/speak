import { Select } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { LANGUAGES } from '../../../lib/config.js';
import ModelManager from './ModelManager.jsx';

/**
 * Экран «Функции» — только то, что действительно зависит от вкуса.
 *
 * Раньше здесь было полтора десятка тумблеров: VAD, «подбирать модель»,
 * «держать модель в памяти», лимиты истории буфера, срок хранения, способ
 * вставки, бюджет ожидания модели, адрес и имя модели, «не тратить время на
 * тишину». Каждый из них имел один правильный ответ, а неправильный делал
 * диктовку медленнее или тише. Теперь эти значения задаёт `lib/autotune.js`,
 * а человек выбирает язык, полировку и качество распознавания.
 */
export default function FeaturesSection() {
  const { settings, updateSettings, presets } = useAppData();

  return (
    <div>
      <h2 className="settings-section__title">Функции</h2>
      <p className="settings-section__desc">
        Остальное приложение настроило за вас: скорость важнее тумблеров.
      </p>

      <div className="settings-group">
        <div className="settings-group__title">Диктовка</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Язык диктовки
            <div className="setting-row__desc">Язык речи. Интерфейс пока русский.</div>
          </div>
          <Select
            value={settings.language}
            onChange={(v) => updateSettings({ language: v })}
            options={LANGUAGES.map((l) => ({ value: l.id, label: l.native }))}
            width={190}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Умная полировка
            <div className="setting-row__desc">
              Модель доводит текст после офлайн-правил; без модели остаются только они.
            </div>
          </div>
          <Toggle
            checked={Boolean(settings.aiDictationRewrite)}
            onChange={(v) => updateSettings({ aiDictationRewrite: v })}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Живая расшифровка
            <div className="setting-row__desc">
              Черновик по ходу речи, раз в 2,5 секунды. Грузит слабый компьютер.
            </div>
          </div>
          <Toggle
            checked={settings.liveWhisper === true}
            onChange={(v) => updateSettings({ liveWhisper: v })}
          />
        </div>
        {presets?.length ? (
          <div className="setting-row">
            <div className="setting-row__label">
              Инструкции по выделенному тексту
              <div className="setting-row__desc">Сочетания — в разделе «Горячие клавиши».</div>
            </div>
          </div>
        ) : null}
      </div>

      <ModelManager />

      <div className="settings-group">
        <div className="settings-group__title">Буфер обмена</div>
        <div className="setting-row">
          <div className="setting-row__label">
            Запоминать скопированное
            <div className="setting-row__desc">Текст, картинки и пароли — только на этом компьютере.</div>
          </div>
          <Toggle
            checked={settings.clipboardMonitor !== false}
            onChange={(v) => updateSettings({ clipboardMonitor: v })}
          />
        </div>
      </div>
    </div>
  );
}
