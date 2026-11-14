import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { Button, Select } from '../../ui/Controls.jsx';
import Toggle from '../../ui/Toggle.jsx';
import { useAppData } from '../../../state/AppDataProvider.jsx';
import { useDictation } from '../../../state/DictationProvider.jsx';
import { createLevelMeter, listDevices } from '../../../lib/audio/devices.js';
import { hasNativeStt } from '../../../lib/recognition/engine.js';

/**
 * Тест микрофона как в видео: «Начать тест» → полоска уровня 5 секунд →
 * «Слышу вас» или «Микрофон молчит». Без записи на диск.
 */
export default function MicTester() {
  const { settings, updateSettings } = useAppData();
  // честный статус «горячего микрофона»: держим ли устройство открытым сейчас
  const { micWarmState } = useDictation();
  const [devices, setDevices] = useState([]);
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [message, setMessage] = useState('');

  const streamRef = useRef(null);
  const meterRef = useRef(null);
  const rafRef = useRef(0);
  const timerRef = useRef(0);
  const peakRef = useRef(0);

  useEffect(() => {
    listDevices().then(setDevices);
  }, []);

  const stop = () => {
    cancelAnimationFrame(rafRef.current);
    clearTimeout(timerRef.current);
    meterRef.current?.dispose?.();
    meterRef.current = null;
    streamRef.current?.getTracks?.().forEach((t) => t.stop());
    streamRef.current = null;
    setTesting(false);
    setLevel(0);
    setMessage(peakRef.current > 0.06 ? 'Слышу вас — микрофон работает.' : 'Микрофон молчит: проверьте, не занят ли он другим приложением.');
  };

  const start = async () => {
    setMessage('');
    peakRef.current = 0;
    setPeak(0);
    try {
      const constraints = {
        audio:
          settings.audioDeviceId && settings.audioDeviceId !== 'default'
            ? { deviceId: { exact: settings.audioDeviceId } }
            : true,
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      const meter = await createLevelMeter(stream);
      meterRef.current = meter;
      setTesting(true);
      const tick = () => {
        const v = meter.level?.() || 0;
        peakRef.current = Math.max(peakRef.current, v);
        setLevel(v);
        setPeak(peakRef.current);
        rafRef.current = requestAnimationFrame(tick);
      };
      tick();
      timerRef.current = setTimeout(stop, 5000);
    } catch (err) {
      setTesting(false);
      setMessage(
        err?.name === 'NotAllowedError'
          ? 'Windows не дал доступ к микрофону: Параметры → Конфиденциальность → Микрофон.'
          : `Не удалось открыть микрофон: ${err?.message || err}`,
      );
    }
  };

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="mic-tester">
      <div className="setting-row">
        <div className="setting-row__label">
          Устройство микрофона
          <div className="setting-row__desc">Список берётся из Windows.</div>
        </div>
        <Select
          value={settings.audioDeviceId}
          onChange={(v) => updateSettings({ audioDeviceId: v })}
          options={[
            { value: 'default', label: 'Системный по умолчанию' },
            ...devices.map((d) => ({ value: d.id, label: d.label })),
          ]}
          width={220}
        />
      </div>

      <div className="setting-row">
        <div className="setting-row__label">
          Горячий микрофон (предролл)
          <div className="setting-row__desc">
            Микрофон открыт, пока приложение запущено: первые ~0,6 секунды фразы не теряются. Пока
            настройка включена, система показывает, что микрофон работает.
            {settings.micPreroll === true ? (
              <span className="setting-row__state">
                {' '}
                {!hasNativeStt()
                  ? 'Сейчас: предролл работает только с whisper.cpp в приложении, в браузере — запись с нажатия.'
                  : micWarmState === 'open'
                    ? 'Сейчас: микрофон открыт.'
                    : micWarmState === 'failed'
                      ? 'Сейчас: открыть микрофон не удалось — запись начнётся с нажатия.'
                      : 'Сейчас: открываю микрофон…'}
              </span>
            ) : (
              <span className="setting-row__state"> Сейчас: микрофон закрыт, откроется при диктовке.</span>
            )}
          </div>
        </div>
        <Toggle checked={settings.micPreroll === true} onChange={(v) => updateSettings({ micPreroll: v })} />
      </div>

      <div className="setting-row">
        <div className="setting-row__label">
          Тест микрофона
          <div className="setting-row__desc">
            {testing ? 'Говорите что-нибудь 5 секунд.' : 'Проверим, что ZSpeakly слышит вас.'}
          </div>
        </div>
        <Button
          variant={testing ? 'ghost' : 'white'}
          size="sm"
          icon={testing ? <Square size={11} fill="currentColor" /> : <Mic size={12} />}
          onClick={() => (testing ? stop() : start())}
        >
          {testing ? 'Остановить' : 'Начать тест'}
        </Button>
      </div>

      <div className={`mic-level ${testing ? 'is-live' : ''}`} aria-hidden>
        <span style={{ width: `${Math.round(Math.min(1, (testing ? level : peak)) * 100)}%` }} />
      </div>
      {message ? <div className="mic-tester__hint">{message}</div> : null}
    </div>
  );
}
