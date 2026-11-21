import { Component } from 'react';
import { Button } from '../ui/Controls.jsx';

// Ошибка в одном разделе не должна заменять всё приложение аварийным экраном.
export default class SectionErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    try {
      window.zspeakly?.native?.log?.({
        level: 'error',
        scope: 'ui',
        message: `Не удалось открыть раздел настроек: ${String(error?.message || error)}`,
      });
    } catch {
      // Журнал не должен мешать восстановлению интерфейса.
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="settings-section-error" role="alert">
        <p>Не удалось открыть этот раздел настроек.</p>
        <p>Можно выбрать другой раздел или перезагрузить окно. Сохранённые данные не изменятся.</p>
        <Button size="sm" onClick={() => window.location.reload()}>Перезагрузить окно</Button>
      </div>
    );
  }
}
