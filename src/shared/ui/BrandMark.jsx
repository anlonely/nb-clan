import React, { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { cx } from './cx.js';

export function BrandMark({ logoUrl = '' }) {
  const [failed, setFailed] = useState(false);
  const hasLogo = Boolean(logoUrl && !failed);
  useEffect(() => {
    setFailed(false);
  }, [logoUrl]);
  return (
    <span className={cx('brand-mark', hasLogo && 'brand-mark-image')} aria-hidden="true">
      {hasLogo ? (
        <img src={logoUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        <Sparkles size={18} strokeWidth={2.4} />
      )}
    </span>
  );
}
