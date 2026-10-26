import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Sparkles } from 'lucide-react';
import specialtyLaborerIconUrl from '../../assets/specialty-laborer.svg';
import specialtyRichIconUrl from '../../assets/specialty-rich.svg';
import { cx } from '../ui/cx.js';

export const SPECIALTY_OPTIONS = [
  {
    value: 'building',
    labelKey: 'specialtyBuilding',
    itemName: 'Building Plan',
    shortName: 'building.planner',
    iconUrl: 'https://rust-items.com/icons/b92826b3408d84dfb6a7a997d1d0026e.png',
    fallback: 'BP'
  },
  {
    value: 'pipe',
    labelKey: 'specialtyPipe',
    itemName: 'Pipe Tool',
    shortName: 'pipetool',
    iconUrl: 'https://www.corrosionhour.com/wp-content/uploads/2023/01/rust-pipetool-45x45.png',
    fallback: 'PT'
  },
  {
    value: 'electricity',
    labelKey: 'specialtyElectricity',
    itemName: 'Wire Tool',
    shortName: 'wiretool',
    iconUrl: 'https://rust-items.com/icons/3c9a3ea158564a800c156df1a677d2f3.png',
    fallback: 'WT'
  },
  {
    value: 'farming',
    labelKey: 'specialtyFarming',
    itemName: 'Hemp Clone',
    shortName: 'clone.hemp',
    iconUrl: 'https://rust-items.com/icons/8ae2c0a019e63e781148a225dfe15d88.png',
    fallback: 'HC'
  },
  {
    value: 'logistics',
    labelKey: 'specialtyLogistics',
    itemName: 'Large Wood Box',
    shortName: 'box.wooden.large',
    iconUrl: 'https://rust-items.com/icons/ce15e71a2b424191bb0ea3044018db4f.png',
    fallback: 'BOX'
  },
  {
    value: 'translator',
    labelKey: 'specialtyTranslator',
    itemName: 'Translator',
    shortName: 'translator',
    emoji: '🌐',
    fallback: '译'
  },
  {
    value: 'merchant',
    labelKey: 'specialtyMerchant',
    itemName: 'Merchant',
    shortName: 'merchant',
    emoji: '💰',
    fallback: '商'
  },
  {
    value: 'rich',
    labelKey: 'specialtyRich',
    itemName: 'High Roller',
    shortName: 'rich',
    iconUrl: specialtyRichIconUrl,
    fallback: '豪'
  },
  {
    value: 'laborer',
    labelKey: 'specialtyLaborer',
    itemName: 'Laborer',
    shortName: 'laborer',
    iconUrl: specialtyLaborerIconUrl,
    fallback: '黑'
  },
  {
    value: 'pvp',
    labelKey: 'specialtyPvp',
    itemName: 'Assault Rifle',
    shortName: 'rifle.ak',
    iconUrl: 'https://rust-items.com/icons/abcf3b856b26c6b8a7c510b0c745c182.png',
    fallback: 'AK'
  },
  {
    value: 'horse',
    labelKey: 'specialtyHorse',
    itemName: 'Horse Keeper',
    shortName: 'horse',
    emoji: '🐎',
    fallback: '🐎'
  },
  {
    value: 'actor',
    labelKey: 'specialtyActor',
    itemName: 'Actor',
    shortName: 'actor',
    emoji: '🤡',
    fallback: '🤡'
  },
  {
    value: 'appearance',
    labelKey: 'specialtyAppearance',
    itemName: 'Appearance',
    shortName: 'appearance',
    Icon: Sparkles,
    fallback: '美'
  },
  {
    value: 'male_star',
    labelKey: 'specialtyMaleStar',
    itemName: 'Male Star',
    shortName: 'male.star',
    emoji: '🤴',
    fallback: '男'
  },
  {
    value: 'female_star',
    labelKey: 'specialtyFemaleStar',
    itemName: 'Female Star',
    shortName: 'female.star',
    emoji: '👸',
    fallback: '女'
  },
  {
    value: 'shitposter',
    labelKey: 'specialtyShitposter',
    itemName: 'You Came Here to Poop?',
    shortName: 'shitposter',
    emoji: '💩',
    fallback: '💩'
  },
  {
    value: 'other',
    labelKey: 'specialtyOther',
    itemName: 'Scrap',
    shortName: 'scrap',
    iconUrl: 'https://rust-items.com/icons/c0fa952d07bbf02f55ed344b3260763b.png',
    fallback: 'SC'
  }
];

export function specialtyOption(value) {
  return SPECIALTY_OPTIONS.find((item) => item.value === value) || null;
}

export function normalizeSpecialtyValues(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  const known = new Set(SPECIALTY_OPTIONS.map((item) => item.value));
  const values = raw.map((item) => String(item || '').trim()).filter((item) => known.has(item));
  const unique = [...new Set(values)];
  return unique;
}


export function SpecialtyIcon({ value }) {
  const option = specialtyOption(value);
  if (!option) return null;
  const Icon = option.Icon;
  const hasEmoji = Boolean(option.emoji);
  return (
    <span className={cx('specialty-icon', `specialty-${option.value}`, !option.iconUrl && !Icon && !hasEmoji && 'image-failed')} aria-hidden="true">
      {option.iconUrl && (
        <img
          src={option.iconUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={(event) => event.currentTarget.closest('.specialty-icon')?.classList.add('image-failed')}
        />
      )}
      {hasEmoji && !option.iconUrl && <span className="specialty-icon-emoji">{option.emoji}</span>}
      {Icon && !option.iconUrl && !hasEmoji && <Icon size={16} strokeWidth={2.4} />}
      <span className="specialty-icon-fallback">{option.fallback}</span>
    </span>
  );
}

export function SpecialtyOptionLabel({ value, t, showMeta = false }) {
  const option = specialtyOption(value);
  if (!option) return null;
  return (
    <span className="specialty-option-label">
      <SpecialtyIcon value={option.value} />
      <span className="specialty-option-text">
        <span>{t(option.labelKey)}</span>
        {showMeta && <small>{option.itemName} · {option.shortName}</small>}
      </span>
    </span>
  );
}

export function SpecialtyBadge({ value, t }) {
  const values = normalizeSpecialtyValues(value);
  if (!values.length) return <span className="specialty-empty-badge">-</span>;
  return (
    <span className="specialty-badge-group" title={values.map((item) => specialtyOption(item).itemName).join(', ')}>
      {values.map((item) => (
        <span key={item} className="specialty-badge">
          <SpecialtyOptionLabel value={item} t={t} />
        </span>
      ))}
    </span>
  );
}

export function SpecialtySelect({ value, onChange, t, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState({ direction: 'down', maxHeight: 520, top: 0, left: 0, width: 0 });
  const rootRef = useRef(null);
  const selectedValues = normalizeSpecialtyValues(value);
  const selectedSet = new Set(selectedValues);
  const triggerTitle = selectedValues.map((item) => {
    const option = specialtyOption(item);
    return option ? `${t(option.labelKey)} · ${option.itemName}` : '';
  }).filter(Boolean).join('\n') || t('specialtyPlaceholder');

  function openMenu() {
    if (disabled) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 720;
      const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
      const desiredHeight = 430;
      const below = viewportHeight - rect.bottom - 12;
      const above = rect.top - 12;
      const direction = below < desiredHeight && above > below ? 'up' : 'down';
      const available = direction === 'up' ? above : below;
      const maxHeight = Math.max(220, Math.min(520, available));
      const width = Math.max(rect.width, Math.min(360, viewportWidth - 24));
      const left = Math.max(12, Math.min(rect.left, viewportWidth - width - 12));
      const top = direction === 'up'
        ? Math.max(12, rect.top - Math.min(desiredHeight, maxHeight) - 6)
        : Math.min(rect.bottom + 6, viewportHeight - Math.min(desiredHeight, maxHeight) - 12);
      setMenuPlacement({ direction, maxHeight, top, left, width });
    }
    setOpen(true);
  }

  function toggleSpecialty(nextValue) {
    if (disabled) return;
    const next = new Set(selectedValues);
    if (next.has(nextValue)) next.delete(nextValue);
    else next.add(nextValue);
    const normalized = [...next];
    onChange(normalized);
  }

  return (
    <div
      ref={rootRef}
      className="specialty-select"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <button
        type="button"
        className="specialty-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={triggerTitle}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (open) setOpen(false);
          else openMenu();
        }}
      >
        <span className="specialty-trigger-values">
          {selectedValues.length ? selectedValues.map((item) => <SpecialtyOptionLabel key={item} value={item} t={t} />) : <span className="specialty-select-placeholder">{t('specialtyPlaceholder')}</span>}
        </span>
        <ChevronDown size={15} />
      </button>
      {open && createPortal(
        <div
          className={cx('specialty-select-menu', menuPlacement.direction === 'up' && 'open-up')}
          role="listbox"
          aria-label={t('specialty')}
          aria-multiselectable="true"
          onMouseDown={(event) => event.preventDefault()}
          style={{
            '--specialty-menu-max-height': `${menuPlacement.maxHeight}px`,
            '--specialty-menu-top': `${menuPlacement.top}px`,
            '--specialty-menu-left': `${menuPlacement.left}px`,
            '--specialty-menu-width': `${menuPlacement.width}px`
          }}
        >
          {SPECIALTY_OPTIONS.map((option) => (
            <button
              type="button"
              key={option.value}
              className={cx('specialty-select-option', selectedSet.has(option.value) && 'active')}
              role="option"
              aria-selected={selectedSet.has(option.value)}
              onClick={() => toggleSpecialty(option.value)}
            >
              <span className="specialty-check" aria-hidden="true" />
              <SpecialtyOptionLabel value={option.value} t={t} />
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
