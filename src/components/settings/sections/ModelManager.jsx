import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Download, Loader, Trash2, TriangleAlert, X } from 'lucide-react';
import { Button } from '../../ui/Controls.jsx';
import { Toggle } from '../../ui/Toggle.jsx';
import ConfirmDialog from '../../ui/ConfirmDialog.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useToast } from '../../../state/ToastProvider.jsx';
import { MODELS } from '../../../lib/config.js';
import { MODEL_TIERS, tierForModel } from '../../../lib/modelTiers.js';

/**
 * Модель распознавания: три режима вместо каталога из десяти моделей.
 *
 * Раньше здесь лежали tiny/base/small/medium/turbo в трёх квантованиях, с
 * подписями «q5_1», «q8_0» и скоростями вида «≈5×». Человек, который просто
 * хочет говорить и получать текст, не мог этим воспользоваться: непонятно,
 * какая строка «лучше», а скачивать все десять, чтобы сравнить, — абсурд.
 *
 * Теперь ровно три понятных варианта по расходам на железо. Один из них
 * приложение уже выбрало само (и переключает, если замеры показывают, что
 * выбранный не успевает). Здесь же видно честное измерение на этом компьютере:
 * сколько секунд речи и сколько секунд счёта.
 */
export default function ModelManager() {
  const { settings, updateSettings, dictations } = useAppData();
  const { push } = useToast();
  const bridge = typeof window !== 'undefined' ? window.zspeakly?.native : null;

  const [status, setStatus] = useState(null); // { models: {...}, bin: bool }
  const [progress, setProgress] = useState({}); // id → percent
  const [busy, setBusy] = useState(null);
  // Одинаковые сообщения приходят и с события прогресса, и с ответа на
  // downloadModel — показываем одно, чтобы не было двух тостов подряд.
  const lastToast = useRef({ key: '', at: 0 });
  const pushOnce = (title, description, tone) => {
    const key = `${title}|${description || ''}`;
    const now = Date.now();
    if (lastToast.current.key === key && now - lastToast.current.at < 2500) return;
    lastToast.current = { key, at: now };
    push({ title, description, tone });
  };
  const cancelAsked = useRef(false);
  // какую модель человек собрался удалить (подтверждение — ниже)
  const [toDelete, setToDelete] = useState(null);

  const refresh = async ({ silent = true } = {}) => {
    if (!bridge?.modelsStatus) {
      if (!silent) {
        push({
          title: 'Модели — в установленном приложении',
          description: 'В браузере нет доступа к файлам модели: скачайте её в Windows-сборке ZSpeakly.',
          tone: 'warn',
        });
      }
      return null;
    }
    try {
      const next = await bridge.modelsStatus();
      // если main вернул не то, что ждём — не роняем плашку в «неизвестно»
      if (next && (next.models || next.bin !== undefined)) setStatus(next);
      if (!silent) {
        const found = next?.models ? Object.values(next.models).filter((m) => m.downloaded).length : 0;
        push({
          title: 'Статус обновлён',
          description: `${next?.bin ? 'движок на месте' : 'движка нет'} · моделей скачано: ${found}`,
          tone: next?.bin ? 'success' : 'warn',
        });
      }
      return next;
    } catch (err) {
      if (!silent) push({ title: 'Не удалось прочитать статус', description: String(err?.message || err), tone: 'warn' });
      return null;
    }
  };

  // Статус перечитываем сразу и по каждому событию загрузки, а не только
  // по «done»: иначе скачанная ранее модель оставалась «не скачанной»,
  // а кнопка «Обновить статус» ничего не перерисовывала.
  useEffect(() => {
    refresh();
  }, []);

  useEffect(() => {
    if (!bridge?.onModelProgress) return undefined;
    return bridge.onModelProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.id]: p.percent }));
      // перечитываем статус на любом прогрессе: диск мог измениться извне
      refresh();
      if (p.done) {
        setBusy(null);
        if (cancelAsked.current && !p.ok) {
          cancelAsked.current = false;
          pushOnce('Скачивание отменено', 'Недокачанный файл удалён — можно попробовать снова.', 'success');
          return;
        }
        if (p.ok) {
          push({
            title: p.id === 'engine' ? 'Движок установлен' : p.id === 'russian' ? 'Русская модель готова' : 'Модель скачана',
            description:
              p.id === 'engine'
                ? 'движок распознавания готов к работе'
                : p.id === 'russian'
                  ? 'теперь русский текст распознаётся точнее — с запятыми и заглавными'
                  : 'Скачано, диктовка работает на новом режиме',
            tone: 'success',
          });
        } else {
          pushOnce('Не удалось скачать', p.reason, 'warn');
        }
      }
    });
  }, [bridge, push]);

  const download = async (id) => {
    if (!bridge?.downloadModel) {
      push({
        title: 'Скачивание доступно в приложении',
        description: 'В браузере моделями управляет установленная версия на Windows.',
        tone: 'warn',
      });
      return;
    }
    setBusy(id);
    setProgress((prev) => ({ ...prev, [id]: 0 }));
    updateSettings({ whisperModel: id });
    let res;
    try {
      res = await bridge.downloadModel(id);
    } catch (err) {
      res = { ok: false, reason: String(err?.message || err) };
    }
    // статус перечитываем в любом случае — даже если ответ потерялся
    await refresh();
    if (!res?.ok) {
      setBusy(null);
      if (cancelAsked.current) {
        cancelAsked.current = false;
        pushOnce('Скачивание отменено', 'Недокачанный файл удалён — можно попробовать снова.', 'success');
      } else {
        pushOnce('Не удалось скачать модель', res?.reason, 'warn');
      }
    }
  };

  /**
   * Русская модель скачивается отдельно: она не «четвёртый режим», а второй
   * движок для русского языка. Человек не выбирает её в обычной жизни —
   * приложение включает её само, как только файлы на месте.
   */
  const downloadRussian = async () => {
    if (!bridge?.downloadRussianModel) {
      push({
        title: 'Скачивание доступно в приложении',
        description: 'В браузере моделями управляет установленная версия на Windows.',
        tone: 'warn',
      });
      return;
    }
    setBusy('russian');
    setProgress((prev) => ({ ...prev, russian: 0 }));
    let res;
    try {
      res = await bridge.downloadRussianModel();
    } catch (err) {
      res = { ok: false, reason: String(err?.message || err) };
    }
    await refresh();
    if (!res?.ok) {
      setBusy(null);
      pushOnce('Не удалось скачать русскую модель', res?.reason, 'warn');
    }
  };

  // Отмена посреди загрузки: модель весит сотни мегабайт, и без этой кнопки
  // остановить её можно было только закрыв приложение.
  const cancelDownload = async () => {
    if (!bridge?.modelsCancel) {
      push({ title: 'Отмена — в установленном приложении', tone: 'warn' });
      return;
    }
    cancelAsked.current = true;
    try {
      const res = await bridge.modelsCancel();
      if (!res?.ok) {
        cancelAsked.current = false;
        pushOnce('Отменять пока нечего', res?.reason || '', 'warn');
        setBusy(null);
      }
    } catch (err) {
      cancelAsked.current = false;
      pushOnce('Не удалось отменить', String(err?.message || err), 'warn');
    }
    await refresh();
  };

  // Модель могли скачать вручную в «Загрузки» — даём подхватить её файлом
  const importModel = async () => {
    if (!bridge?.importModel) {
      push({ title: 'Только в установленном приложении', tone: 'warn' });
      return;
    }
    let res;
    try {
      res = await bridge.importModel();
    } catch (err) {
      res = { ok: false, reason: String(err?.message || err) };
    }
    if (res?.ok) {
      updateSettings({ whisperModel: res.id });
      push({
        title: 'Модель подключена',
        description: `ggml-${res.id}.bin · ${res.sizeMb} МБ`,
        tone: 'success',
      });
    } else if (res?.canceled) {
      push({ title: 'Файл не выбран', tone: 'warn' });
    } else {
      push({ title: 'Не удалось подключить модель', description: res?.reason, tone: 'warn' });
    }
    await refresh();
  };

  const downloadEngine = async () => {
    if (!bridge?.downloadEngine) {
      push({ title: 'Только в установленной версии', tone: 'warn' });
      return;
    }
    setBusy('engine');
    setProgress((prev) => ({ ...prev, engine: 0 }));
    let res;
    try {
      res = await bridge.downloadEngine();
    } catch (err) {
      res = { ok: false, reason: String(err?.message || err) };
    }
    await refresh();
    if (!res?.ok) {
      setBusy(null);
      push({ title: 'Движок не установился', description: res?.reason, tone: 'warn' });
    }
  };

  /**
   * Удаление скачанной модели. Раньше файлы копились навсегда: скачал base,
   * потом small, потом turbo — и убрать старые было нечем, а это гигабайты.
   */
  const removeModel = async (id) => {
    if (!bridge?.deleteModel) {
      push({ title: 'Удаление — в установленном приложении', tone: 'warn' });
      return;
    }
    let res;
    try {
      res = await bridge.deleteModel(id);
    } catch (err) {
      res = { ok: false, reason: String(err?.message || err) };
    }
    await refresh();
    if (!res?.ok) {
      push({ title: 'Модель не удалилась', description: res?.reason || 'файл занят', tone: 'warn' });
      return;
    }
    if (res.switchedTo) {
      // удалили ту, что была выбрана — переключаемся на оставшуюся, чтобы
      // диктовка не осталась «в никуда»
      updateSettings({ whisperModel: res.switchedTo });
      push({
        title: 'Модель удалена',
        description: `Освободилось ${res.freedMb} МБ. Активным стал режим «${tierForModel(res.switchedTo).label.toLowerCase()}» — диктовка продолжит работать.`,
        tone: 'success',
      });
      return;
    }
    push({
      title: 'Модель удалена',
      description: `Освободилось ${res.freedMb} МБ.`,
      tone: 'success',
    });
  };

  const downloaded = status?.models ? Object.values(status.models).filter((m) => m.downloaded).length : 0;
  const activeTier = tierForModel(settings.whisperModel);
  // Старых имён моделей здесь больше нет: `lib/settingsMigration.js` переводит
  // их на ближайший режим ещё при загрузке настроек. Держать в интерфейсе
  // предупреждение про модель, которой уже не существует, значило бы объяснять
  // человеку то, чего он не выбирал.

  /**
   * Честное измерение на этом компьютере: последняя диктовка, где известны и
   * секунды речи, и секунды счёта. Обещания каталога («≈5×») проверяются
   * фактом — именно за это человек и ругался, когда ждал двадцать секунд.
   */
  const measured = useMemo(() => {
    const list = Array.isArray(dictations) ? dictations : [];
    const last = list.find((d) => Number(d?.sttMs) > 0 && Number(d?.spokenMs) >= 1500);
    if (!last) return null;
    const spoken = Number(last.spokenMs) / 1000;
    const count = Number(last.sttMs) / 1000;
    const factor = count > 0 ? spoken / count : 0;
    if (!(factor > 0)) return null;
    return {
      spoken: Math.round(spoken * 10) / 10,
      count: Math.round(count * 10) / 10,
      factor: Math.round(factor * 10) / 10,
    };
  }, [dictations]);

  return (
    <div className="settings-group">
      <div className="settings-group__title">Модель распознавания</div>
      <div className="settings-group__desc">
        {/* на свежей установке движка и модели нет — говорим об этом прямо */}
        {status && (!status.bin || !Object.values(status.models || {}).some((m) => m.downloaded)) ? (
          <span className="model-setup-note">
            Для офлайн-диктовки нужны две вещи: движок whisper.cpp (≈20 МБ) и модель (60–550 МБ).
            Скачиваются сюда же, один раз — дальше всё работает без интернета.
          </span>
        ) : null}
        Сейчас работает режим{' '}
        <strong>«{tierForModel(status?.active || settings.whisperModel).label.toLowerCase()}»</strong>.
        Менять его обычно не нужно — приложение выбрало его под этот компьютер и само переключится,
        если диктовка окажется медленной.
        {tierForModel(status?.active || settings.whisperModel).id === 'fast' ? (
          <>
            {' '}
            <strong>
              Самый быстрый режим путает слова — «Сбалансированно» даёт заметно более читаемый текст.
            </strong>
          </>
        ) : null}
        {status?.bin ? (
          <>
            {' '}
            <span className="model-state model-state--ok">
              <Check size={11} /> Движок установлен
            </span>
          </>
        ) : status ? (
          <>
            {' '}
            <span className="model-state model-state--warn">
              <TriangleAlert size={11} /> Движок не найден
            </span>
          </>
        ) : null}
        {status?.active && status?.preferred && status.active !== status.preferred ? (
          <>
            {' '}
            <span className="model-state model-state--warn">
              <TriangleAlert size={11} /> «{tierForModel(status.preferred).label.toLowerCase()}» ещё не
              скачан
            </span>
          </>
        ) : null}
      </div>


      {measured ? (
        <div className="model-measure">
          На этом компьютере: {measured.spoken.toFixed(1)} с речи → {measured.count.toFixed(1)} с счёта
          {measured.factor >= 2 ? ` (в ${measured.factor.toFixed(1)} раза быстрее реального времени)` : ''}
        </div>
      ) : null}

      {MODELS.map((m) => {
        const info = status?.models?.[m.id];
        const pct = progress[m.id];
        const active = activeTier.id === m.tier;
        const tier = MODEL_TIERS.find((t) => t.id === m.tier);
        return (
          <div key={m.id} className={`model-card ${active ? 'is-active' : ''}`}>
            <button
              type="button"
              className="model-card__pick"
              onClick={() => {
                // выбор режима без скачанного файла оставил бы диктовку без
                // движка, поэтому «не скачано» = «скачать и включить»
                if (info?.downloaded) {
                  updateSettings({ whisperModel: m.id });
                  push({
                    title: `Режим «${tier?.label.toLowerCase() || m.label}»`,
                    description: `${m.size} · ${m.speedText} · точность ${m.quality}`,
                    tone: 'success',
                  });
                  return;
                }
                download(m.id);
              }}
              title={info?.downloaded ? 'Работать в этом режиме' : 'Скачать и включить этот режим'}
            >
              <div className="grow" style={{ textAlign: 'left' }}>
                <div className="model-card__name">
                  {tier?.label || m.label}
                  {tier?.recommended ? <span className="model-badge model-badge--pick">ставится само</span> : null}
                  {info?.downloaded ? (
                    // просто «скачано»: размер уже стоит строкой ниже, а два
                    // разных числа в одной карточке читались как ошибка
                    <span className="model-badge">скачано</span>
                  ) : null}
                </div>
                <div className="model-card__meta">
                  {m.size} · памяти {m.ram} · {m.speedText} · точность {m.quality}
                </div>
                <div className="model-card__desc">{tier?.desc || m.desc}</div>
              </div>
              {active ? <Check size={13} style={{ color: 'var(--green)' }} /> : null}
            </button>

            {info?.downloaded ? (
              <Button
                variant="bare"
                // удалить последнюю модель нельзя: без весов диктовка не работает
                disabled={Boolean(busy) || downloaded <= 1}
                title={
                  downloaded <= 1
                    ? 'Это единственная модель — удалить её нельзя, иначе диктовка перестанет работать'
                    : `Удалить файл модели с диска (${m.size})`
                }
                aria-label={`Удалить модель ${m.label}`}
                onClick={() => setToDelete(m)}
              >
                <Trash2 size={13} />
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                icon={busy === m.id ? <Loader size={12} /> : <Download size={12} />}
                onClick={() => download(m.id)}
                disabled={Boolean(busy)}
              >
                {busy === m.id ? `${pct || 0}%` : 'Скачать'}
              </Button>
            )}
          </div>
        );
      })}

      {/* Русский язык — отдельный движок, а не «ещё один режим»: у него своя
          модель, свой размер и своё правило включения. */}
      <div className={`model-card model-card--russian ${status?.russian?.available ? 'is-active' : ''}`}>
        <div className="grow" style={{ textAlign: 'left' }}>
          <div className="model-card__name">
            Русский язык
            {status?.russian?.available ? <span className="model-badge">скачано</span> : null}
          </div>
          <div className="model-card__meta">
            {status?.russian?.bytes ? `${Math.round(status.russian.bytes / 1024 / 1024)} МБ` : '226 МБ'} · точнее
            понимает русские слова · знаки препинания сам
          </div>
          <div className="model-card__desc">
            {status?.russian?.available
              ? 'Включается сама, когда вы диктуете по-русски. Другие языки остаются на прежнем движке.'
              : status?.russian?.missing?.length && status.russian.reason.includes('не полностью')
                ? 'Прошлое скачивание не закончилось — нажмите «Продолжить», файлы докачаются.'
                : 'Скачать один раз: русские слова перестанут путаться, а запятые и заглавные появятся без правки.'}
          </div>
        </div>
        {status?.russian?.available ? (
          <Check size={13} style={{ color: 'var(--green)' }} aria-label="Русская модель скачана" />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            icon={busy === 'russian' ? <Loader size={12} /> : <Download size={12} />}
            onClick={() => downloadRussian()}
            disabled={Boolean(busy)}
          >
            {busy === 'russian' ? `${progress.russian || 0}%` : status?.russian?.missing?.length < 4 ? 'Продолжить' : 'Скачать'}
          </Button>
        )}
      </div>

      <div className="setting-row">
        <div className="setting-row__label">
          Держать модель в памяти
          <div className="setting-row__desc">
            Диктовка начинается без холодного старта, но занято ≈0,5 ГБ памяти. Выключите на слабом
            ноутбуке.
          </div>
        </div>
        <Toggle
          checked={settings.keepModelLoaded === true}
          onChange={async (v) => {
            updateSettings({ keepModelLoaded: v });
            if (!v) {
              push({
                title: 'Модель выгрузится из памяти',
                description: 'Следующая диктовка снова загрузит её при старте.',
                tone: 'success',
              });
              return;
            }
            if (!bridge?.modelsWarm) {
              push({ title: 'Только в приложении', description: 'В браузере модель не загружается в память.', tone: 'warn' });
              return;
            }
            const res = await bridge.modelsWarm({ model: settings.whisperModel, force: true }).catch(() => null);
            if (res?.ok) {
              push({ title: 'Модель в памяти', description: 'Диктовка начнётся без холодного старта.', tone: 'success' });
            } else {
              push({
                title: 'Модель не загружена в память',
                description: `${res?.reason || 'whisper-server недоступен'} — диктовка работает обычным путём.`,
                tone: 'warn',
              });
            }
          }}
        />
      </div>

      <div className="row-8" style={{ marginTop: 8, flexWrap: 'wrap' }}>
        {busy ? (
          <Button variant="white" size="sm" icon={<X size={12} />} onClick={cancelDownload}>
            Отменить скачивание
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          icon={busy === 'engine' ? <Loader size={12} /> : <Download size={12} />}
          onClick={downloadEngine}
          disabled={Boolean(busy) || Boolean(status?.bin)}
        >
          {busy === 'engine' ? `Движок ${progress.engine || 0}%` : status?.bin ? 'Движок уже стоит' : 'Скачать движок whisper.cpp'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={importModel}
          disabled={Boolean(busy)}
        >
          Указать файл модели
        </Button>
        <Button
          variant="bare"
          size="sm"
          onClick={() => refresh({ silent: false })}
          logo={null}
        >
          Обновить статус
        </Button>
        {!bridge?.modelsStatus ? (
          <span className="settings-foot-hint">
            доступно в установленном приложении — в браузере нет доступа к диску
          </span>
        ) : null}
      </div>
      <div className="settings-foot-hint" style={{ marginTop: 8 }}>
        Модели качаются с официальных адресов (Hugging Face, GitHub) и лежат в %APPDATA%\ZSpeakly\models.
        В установщик они не входят — репозиторий остаётся лёгким. Ненужный режим можно удалить
        корзинкой в его строке: файл стирается с диска, место освобождается сразу.
      </div>
      <ConfirmDialog
        open={Boolean(toDelete)}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && removeModel(toDelete.id)}
        title="Удалить модель с диска?"
        description={
          toDelete
            ? `${toDelete.label} · ${toDelete.size}. Файл будет удалён из профиля. Если понадобится снова — скачается заново.`
            : ''
        }
        confirmLabel="Удалить модель"
      />
    </div>
  );
}
