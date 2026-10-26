import React from 'react';
import { cx } from './cx.js';

export function InfoGrid({ items, className = '' }) {
  return (
    <dl className={cx('info-grid', className)}>
      {items.map(([label, value], index) => (
        <div key={typeof label === 'string' ? label : index}>
          <dt>{label}</dt>
          <dd>{value || '-'}</dd>
        </div>
      ))}
    </dl>
  );
}
