import React, { useState } from 'react';
import { RefreshCw, RotateCcw } from 'lucide-react';

class LazyLoadErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Lazy view failed to load', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { onRetry, t } = this.props;
    const translate = typeof t === 'function' ? t : (key) => key;
    return (
      <section className="page-stack lazy-load-error-state" role="alert">
        <div className="tool-panel lazy-load-error-panel">
          <div className="heading-stack">
            <h3>{translate('requestFailed')}</h3>
            <p>{translate('lazyLoadFailed')}</p>
          </div>
          <div className="row-actions">
            <button type="button" className="primary-button fit-button" onClick={onRetry}>
              <RotateCcw size={17} />
              <span>{translate('retry')}</span>
            </button>
            <button type="button" className="ghost-button fit-button" onClick={() => window.location.reload()}>
              <RefreshCw size={17} />
              <span>{translate('refreshPage')}</span>
            </button>
          </div>
        </div>
      </section>
    );
  }
}

const selectDefaultExport = (module) => module.default;

export function createRecoverableLazy(importer, select = selectDefaultExport) {
  const lazyViews = new Map();
  const lazyViewForAttempt = (attempt) => {
    if (!lazyViews.has(attempt)) {
      lazyViews.set(attempt, React.lazy(async () => {
        const module = await importer();
        return { default: select(module) };
      }));
    }
    return lazyViews.get(attempt);
  };
  lazyViewForAttempt(0);

  function RecoverableLazyView(props) {
    const [attempt, setAttempt] = useState(0);
    const LazyView = lazyViewForAttempt(attempt);
    const retry = () => {
      const nextAttempt = attempt + 1;
      lazyViewForAttempt(nextAttempt);
      setAttempt(nextAttempt);
    };

    return (
      <LazyLoadErrorBoundary key={attempt} t={props.t} onRetry={retry}>
        <LazyView {...props} />
      </LazyLoadErrorBoundary>
    );
  }

  RecoverableLazyView.displayName = 'RecoverableLazyView';
  return RecoverableLazyView;
}
