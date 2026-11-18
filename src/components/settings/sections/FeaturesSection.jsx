import { Select } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { LANGUAGES } from '../../../lib/config.js';
import { hasNativeStt } from '../../../lib/recognition/engine.js';
import { resolveLiveDraft } from '../../../lib/liveDraftPolicy.js';
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
/** «включена сама: …» → «Включена сама: …» — это начало предложения. */
const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : '');

export default function FeaturesSection() {
  const { settings, updateSettings } = useAppData();
  const live = resolveLiveDraft({
    setting: settings.liveWhisper,
    model: settings.whisperModel,
    hasNative: hasNativeStt(),
  });

  return (
    <div>
      <div className="settings-group">
        <div className="settings-group__title">Что распознавать</div>
        {/* Что приложение решает само. Это не настройки, а объяснение, почему
            их здесь нет: человек не должен искать тумблер «как правильно». */}
        <div className="settings-note">
          <strong>Остальное приложение решает само:</strong> подбирает модель под железо и меняет
          её при тормозах, включает живую расшифровку, когда движок успевает, вставляет текст
          тремя способами, хранит историю месяц и останавливает запись, если вы забыли её
          выключить: двадцать секунд тишины — и она завершается сама. Менять вручную не нужно.
        </div>
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
        {/* Тумблера больше нет: черновик по ходу речи — это лишний проход
            движка, и включать его имеет смысл только когда движок успевает.
            Решает lib/liveDraftPolicy.js, а строка говорит, что решилось. */}
        <div className="setting-row">
          <div className="setting-row__label">
            Живая расшифровка
            <div className="setting-row__desc">
              Черновик по ходу речи, раз в 2,5 секунды. {capitalize(live.why)}.{' '}
              {live.explicit
                ? 'Это ваш выбор — приложение его не меняет.'
                : 'На «Сбалансированно» и «Максимуме» она выключается сама, чтобы не задерживать готовый текст.'}
            </div>
          </div>
          <span className={`setting-row__value ${live.enabled ? 'is-on' : ''}`}>
            {live.enabled ? 'включена' : 'выключена'}
          </span>
        </div>
      </div>

      <ModelManager />
    </div>
  );
}
