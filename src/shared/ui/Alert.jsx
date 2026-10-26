import { cx } from './cx.js';

export function Alert({ children, tone = 'info', className = '' }) {
  return <div className={cx('alert', tone, className)}>{children}</div>;
}
