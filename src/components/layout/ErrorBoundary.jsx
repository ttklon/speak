import { Component } from 'react';
import { RotateCcw, TriangleAlert, Wrench } from 'lucide-react';

/**
 * Страховка от белого экрана.
 *
 * Раньше ошибка в любом компоненте (битые данные истории, отсутствующее поле,
 * редкая ветка отрисовки) размонтировала всё дерево: человек видел пустое окно
 * и не мог ничего нажать — ни настроек, ни диагностики, ни обновления. Теперь
 * показываем, что случилось, и даём три выхода: перезагрузить интерфейс,
 * открыть диагностику, посмотреть текст ошибки.
 *
 * Перезагрузка не трогает данные: настройки и история лежат в хранилище, а не в
 * памяти компонентов, поэтому «перезагрузить» — безопасное действие.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: '' };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    this.setState({ info: String(info?.componentStack || '').slice(0, 1200) });
    // Ошибка должна попасть в журнал, иначе её не будет ни в отчёте, ни в
    // диагностике — только в консоли, которой у человека нет.
    try {
      window.zspeakly?.native?.log?.({
        level: 'error',
        scope: 'ui',
        message: `Падение интерфейса: ${String(error?.message || error)}`,
        data: { stack: String(error?.stack || '').slice(0, 1200) },
      });
    } catch {
      /* журнал не должен ронять страховку */
    }
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="crash" role="alert">
        <div className="crash__card">
          <div className="crash__icon">
            <TriangleAlert size={18} />
          </div>
          <h1 className="crash__title">Что-то сломалось на этом экране</h1>
          <p className="crash__text">
            Диктовка и настройки целы: данные хранятся на этом компьютере. Перезагрузите окно — и
            продолжайте работу.
          </p>
          <div className="crash__actions">
            <button
              type="button"
              className="btn btn--white btn--sm"
              onClick={() => window.location.reload()}
            >
              <RotateCcw size={12} /> Перезагрузить окно
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                window.location.hash = '#/settings?section=diagnostics&from=home';
                window.location.reload();
              }}
            >
              <Wrench size={12} /> Открыть диагностику
            </button>
          </div>
          <details className="crash__details">
            <summary>Что именно сломалось</summary>
            <pre className="crash__stack">
              {String(error?.message || error)}
              {info ? `\n${info}` : ''}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
