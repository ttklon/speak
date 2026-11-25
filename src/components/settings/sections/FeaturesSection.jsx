import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Button, Select } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { LANGUAGES } from '../../../lib/config.js';
import { APP_PROFILE_LIMITS, sanitizeAppProfiles } from '../../../lib/appProfiles.js';
import { uid } from '../../../lib/utils.js';
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
  // черновик нового правила под окно: приложение и язык
  const [appMatch, setAppMatch] = useState('');
  const [appLang, setAppLang] = useState(settings.language || 'ru');
  const appRules = sanitizeAppProfiles(settings.appProfiles);
  const rulesFull = appRules.length >= APP_PROFILE_LIMITS.rules;

  const addAppRule = () => {
    const match = appMatch.trim();
    if (!match || rulesFull) return;
    updateSettings({
      appProfiles: sanitizeAppProfiles([
        ...appRules,
        { id: uid('app'), match, language: appLang },
      ]),
    });
    setAppMatch('');
  };
  const removeAppRule = (id) => {
    updateSettings({ appProfiles: appRules.filter((rule) => rule.id !== id) });
  };
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
          тремя способами, хранит историю месяц, останавливает запись, если вы забыли её
          выключить (двадцать секунд тишины), и подстраивает оформление под окно: в мессенджере
          без точки в конце, в письме с заглавной и точкой. В распознанном редакторе кода
          обычная очистка, исправление оговорок и полировка моделью не применяются. Словарь,
          голосовые команды и быстрые блоки всё ещё могут изменить текст.
        </div>
        <div className="settings-note">
          <strong>Точность без гигабайтов:</strong> язык лучше указать явно (автоопределение на
          короткой фразе ошибается), русскую модель стоит скачать — 226 МБ, и русские слова
          перестают путаться, — а микрофон держать в 10–15 см от рта. Модель «Максимум качества»
          нужна только сильному компьютеру: на слабом она сделает диктовку медленной, а не точной.
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
        {/* Обработка «для звонков» по умолчанию выключена: для диктовки она
            срезает окончания слов, а громкость приложение выравнивает само. */}
        <div className="setting-row">
          <div className="setting-row__label">
            Шумоподавление Windows
            <div className="setting-row__desc">
              Выключено: микрофон отдаёт живой звук, а громкость выравнивает само приложение —
              так распознавание точнее. Включите, если вокруг шумно (вентилятор, кафе) и слова
              теряются.
            </div>
          </div>
          <Toggle
            checked={settings.micCleanup === true}
            onChange={(v) => updateSettings({ micCleanup: v })}
          />
        </div>
        {/* Одна кнопка вместо пяти: «не трогай мой текст» выключает чистку,
            оговорки, оформление под окно и переписывание моделью. Словарь,
            голосовые команды и быстрые блоки остаются — это прямые указания
            человека, а не догадки приложения. */}
        <div className="setting-row">
          <div className="setting-row__label">
            Не трогать мой текст
            <div className="setting-row__desc">
              Без чистки, правки знаков под окно и переписывания моделью. Словарь, голосовые
              команды и быстрые блоки продолжат работать. Распознавание может ошибаться, а защита
              от тишины и известных галлюцинаций — отклонить запись. На стыках
              фрагментов возможны повторы из-за перекрытия звука.
            </div>
          </div>
          <Toggle
            checked={settings.preserveText === true}
            onChange={(v) => updateSettings({ preserveText: v })}
          />
        </div>
        {/* Выключатель позволяет диктовать слово «отмени» как текст. */}
        <div className="setting-row">
          <div className="setting-row__label">
            Команда «отмени»
            <div className="setting-row__desc">
              Автоматическое стирание временно отключено: нельзя проверить курсор в другом приложении.
              Команда подскажет исправить текст вручную. Выключите, чтобы диктовать слово как текст.
            </div>
          </div>
          <Toggle
            checked={settings.undoCommand !== false}
            onChange={(v) => updateSettings({ undoCommand: v })}
          />
        </div>
        <div className="setting-row">
          <div className="setting-row__label">
            Умная полировка
            <div className="setting-row__desc">
              Модель расставляет знаки после офлайн-правил. Если она меняет слова, числа или их порядок, ответ отклоняется. Без модели остаются офлайн-правила.
            </div>
          </div>
          <Toggle
            checked={Boolean(settings.aiDictationRewrite)}
            onChange={(v) => updateSettings({ aiDictationRewrite: v })}
            disabled={settings.preserveText === true}
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

      {/* Язык под активное окно. Один и тот же человек пишет в мессенджере
          по-русски, а в редакторе кода — по-английски; переключать язык перед
          каждой фразой — это та работа, из-за которой диктовкой перестают
          пользоваться. */}
      <div className="settings-group">
        <div className="settings-group__title">Под активное окно</div>
        <div className="settings-group__desc">
          В каком приложении на каком языке диктовать. Правило ищется по имени программы
          («Telegram») или по части заголовка окна («Visual Studio Code»). Нет правила — работает
          язык, выбранный выше.
        </div>
        {appRules.length ? (
          <div className="app-rules">
            {appRules.map((rule) => (
              <div key={rule.id} className="app-rule">
                <span className="app-rule__match">{rule.match}</span>
                <span className="app-rule__lang">
                  {LANGUAGES.find((l) => l.id === rule.language)?.native || rule.language}
                </span>
                <button
                  type="button"
                  className="icon-btn icon-btn--sm icon-btn--danger"
                  aria-label={`Удалить правило для «${rule.match}»`}
                  onClick={() => removeAppRule(rule.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings-note">
            Пока правил нет — язык один, тот, что выбран выше. Пример: «Visual Studio Code» →
            Английский, и в редакторе можно диктовать код, не трогая настройки.
          </div>
        )}
        <div className="app-rule app-rule--new">
          <input
            className="input"
            value={appMatch}
            maxLength={APP_PROFILE_LIMITS.match}
            placeholder="Telegram или Visual Studio Code"
            aria-label="Приложение или часть заголовка окна"
            onChange={(e) => setAppMatch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addAppRule();
            }}
          />
          <Select
            value={appLang}
            onChange={setAppLang}
            options={LANGUAGES.map((l) => ({ value: l.id, label: l.native }))}
            width={150}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus size={13} />}
            disabled={!appMatch.trim() || rulesFull}
            onClick={addAppRule}
          >
            Добавить
          </Button>
        </div>
        {rulesFull ? (
          <div className="settings-note">
            Правил уже {APP_PROFILE_LIMITS.rules} — это предел: больше похоже на справочник, чем на
            профиль. Удалите лишнее.
          </div>
        ) : null}
      </div>

      <ModelManager />
    </div>
  );
}
