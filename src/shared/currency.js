import { useEffect, useMemo, useState } from 'react';
import {
  CURRENCY_RATE_CACHE_KEY,
  SUPPORTED_DISPLAY_CURRENCIES,
  currencyFor,
  localeFor
} from '../i18n/languages.js';

function normalizeCurrencyCode(value, fallback = 'USD') {
  const currency = String(value || fallback || 'USD').trim().toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : fallback;
}

function convertCurrencyValue(value, sourceCurrency = 'USD', targetCurrency = 'USD', exchangeRates = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return { value: null, currency: normalizeCurrencyCode(sourceCurrency) };
  const source = normalizeCurrencyCode(sourceCurrency);
  const target = normalizeCurrencyCode(targetCurrency);
  if (source === target) return { value: numeric, currency: source };
  const sourceRate = source === 'USD' ? 1 : Number(exchangeRates[source]);
  const targetRate = target === 'USD' ? 1 : Number(exchangeRates[target]);
  if (Number.isFinite(sourceRate) && sourceRate > 0 && Number.isFinite(targetRate) && targetRate > 0) {
    return { value: (numeric / sourceRate) * targetRate, currency: target };
  }
  return { value: numeric, currency: source };
}

export function formatCurrencyValue(value, currency = 'USD', lang = 'zh', currencyContext = null) {
  if (value === null || value === undefined || value === '') return '-';
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '-';
  const targetCurrency = currencyContext?.currency || currency;
  const converted = currencyContext
    ? convertCurrencyValue(numeric, currency, targetCurrency, currencyContext.exchangeRates)
    : { value: numeric, currency: normalizeCurrencyCode(currency) };
  return new Intl.NumberFormat(localeFor(lang), {
    style: 'currency',
    currency: converted.currency || 'USD',
    maximumFractionDigits: 2
  }).format(converted.value);
}

export function useCurrencyContext(lang) {
  const currency = currencyFor(lang);
  const [exchangeRates, setExchangeRates] = useState({ USD: 1 });

  useEffect(() => {
    let cancelled = false;
    if (currency === 'USD') {
      setExchangeRates((current) => ({ ...current, USD: 1 }));
      return () => {
        cancelled = true;
      };
    }

    const applyRates = (payload) => {
      if (cancelled || !payload?.rates?.[currency]) return;
      setExchangeRates({ USD: 1, ...payload.rates });
    };

    try {
      const cached = JSON.parse(localStorage.getItem(CURRENCY_RATE_CACHE_KEY) || 'null');
      const now = Date.now();
      if (cached?.rates?.[currency]) {
        applyRates(cached);
        if (cached?.nextUpdateUnix && now < cached.nextUpdateUnix * 1000) {
          return () => {
            cancelled = true;
          };
        }
      }
    } catch {}

    fetch('https://open.er-api.com/v6/latest/USD')
      .then((response) => response.json())
      .then((payload) => {
        if (cancelled || payload?.result !== 'success' || typeof payload?.rates?.[currency] !== 'number') return;
        const nextRates = SUPPORTED_DISPLAY_CURRENCIES.reduce((rates, code) => {
          const rate = code === 'USD' ? 1 : payload.rates?.[code];
          if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) rates[code] = rate;
          return rates;
        }, { USD: 1 });
        const cachePayload = {
          rates: nextRates,
          nextUpdateUnix: payload.time_next_update_unix || 0
        };
        try {
          localStorage.setItem(CURRENCY_RATE_CACHE_KEY, JSON.stringify(cachePayload));
        } catch {}
        applyRates(cachePayload);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [currency]);

  return useMemo(() => ({ currency, exchangeRates }), [currency, exchangeRates]);
}
