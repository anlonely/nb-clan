import React, { useEffect } from 'react';
import { cx } from './cx.js';

export function ModalFrame({ children, onClose, className = '', labelledBy = '', as: Component = 'div', ...props }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose?.();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <Component className={cx('modal', className)} role="dialog" aria-modal="true" aria-labelledby={labelledBy || undefined} {...props}>
        {children}
      </Component>
    </div>
  );
}
