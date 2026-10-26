import React, { useEffect, useState } from 'react';
import { t } from './i18n.js';
import defaultLogo from './assets/clan-logo.svg';

export const BRAND_NAME = String(import.meta.env?.VITE_BRAND_NAME || 'Clan Portal').trim().slice(0, 64);
export const DEFAULT_BRAND_LOGO = defaultLogo;

export function brandLogoUrl(logoUrl = '') {
  return logoUrl || DEFAULT_BRAND_LOGO;
}

export function BrandLogo({ logoUrl = '', alt = t('{brand} 战队徽标', { brand: BRAND_NAME }), ...props }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [logoUrl]);
  return <img src={brandLogoUrl(failed ? '' : logoUrl)} alt={alt} onError={() => setFailed(true)} {...props}/>;
}

// Operators of modified deployments must point this at their corresponding source.
export const SOURCE_URL = import.meta.env?.VITE_SOURCE_URL || 'https://github.com/anlonely/nb-clan';
