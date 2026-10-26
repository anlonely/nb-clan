import { cx } from './cx.js';

export function PageLoadingState({ title, t, compact = false }) {
  return (
    <div className={cx('page-loading-state', compact && 'compact')} role="status" aria-busy="true" aria-live="polite">
      <div className="page-loading-card">
        <div className="page-loading-visual" aria-hidden="true">
          <span className="page-loading-indicator">
            <span />
          </span>
        </div>
        <div className="page-loading-copy">
          {title && <strong>{title}</strong>}
          <span>{t('loading')}</span>
        </div>
      </div>
    </div>
  );
}
