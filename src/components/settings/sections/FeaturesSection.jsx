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
            <div className="setting-row__desc">
              На нём распознаётся речь. Интерфейс пока русский — на него выбор не влияет.
            </div>
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
              Локальная модель доводит формулировки после офлайн-правил: ждём её не дольше 0,9
              секунды, а если её нет — работают правила, они включены всегда.
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
              Текст появляется по ходу речи: раз в 2,5 секунды — отдельный проход движка. На
              слабом компьютере это заметная нагрузка; по умолчанию выключено, чтобы вставка
              была максимально быстрой.
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
              <div className="setting-row__desc">
                «Перевести на английский», «Сделать формально» и остальные — в разделе «Горячие
                клавиши». Там же их сочетания.
              </div>
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
            <div className="setting-row__desc">
              История текста, картинок и паролей хранится на этом компьютере; срок и лимит
              подобраны автоматически — за месяц набирается несколько тысяч записей.
            </div>
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
