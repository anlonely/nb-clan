import { t } from './i18n.js';
import { useUiLocale } from './language-switch.jsx';
import React, { Children, isValidElement, useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import './select.css';

function optionsFrom(children, group = '', disabled = false) {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement(child)) return [];
    if (child.type === 'option') return [{ value: String(child.props.value ?? child.props.children ?? ''), label: child.props.children, disabled: disabled || child.props.disabled, group }];
    return optionsFrom(child.props.children, child.type === 'optgroup' ? child.props.label : group, disabled || child.props.disabled);
  });
}

/** One themed, downward-opening single-choice control for desktop forms. */
export function Select({ children, value, defaultValue, onChange, disabled, className = '', name, required, id, form, onBlur, menuWidth = 'trigger', ...props }) {
  const uiLocale = useUiLocale();
  const generatedId = useId(), trigger = useRef(null), menu = useRef(null);
  const [localValue, setLocalValue] = useState(defaultValue ?? ''), [open, setOpen] = useState(false), [active, setActive] = useState(-1), [label, setLabel] = useState('');
  const options = optionsFrom(children), selectedValue = String(value ?? localValue), selected = options.find(option => option.value === selectedValue) ?? options[0];
  const selectedIndex = options.indexOf(selected), optionId = index => `${generatedId}-option-${index}`;
  const position = () => {
    const button = trigger.current, list = menu.current;
    if (!button || !list) return;
    let rect = button.getBoundingClientRect();
    if (window.innerHeight - rect.bottom < 160) {
      button.scrollIntoView({ block: 'center', behavior: 'instant' });
      rect = button.getBoundingClientRect();
    }
    const availableWidth = Math.max(0, window.innerWidth - 16);
    Object.assign(list.style, { top: `${rect.bottom + 6}px`, width: menuWidth === 'content' ? 'max-content' : `${rect.width}px`, minWidth: `${Math.min(rect.width, availableWidth)}px`, maxWidth: `${availableWidth}px`, maxHeight: `${Math.max(48, Math.min(300, window.innerHeight - rect.bottom - 14))}px` });
    const width = list.getBoundingClientRect().width || rect.width;
    list.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  };
  const close = () => { if (menu.current?.matches(':popover-open')) menu.current.hidePopover(); setOpen(false); };
  const show = () => {
    if (trigger.current?.matches(':disabled')) return;
    position(); menu.current.showPopover(); position(); setOpen(true); setActive(selectedIndex);
  };
  const choose = index => {
    const option = options[index]; if (!option || option.disabled) return;
    setLocalValue(option.value);
    onChange?.({ target: { value: option.value, name }, currentTarget: { value: option.value, name } });
    close(); trigger.current.focus();
  };
  useEffect(() => {
    const parent = trigger.current?.closest('label');
    if (parent) setLabel([...parent.childNodes].filter(node => node.nodeType === 3 || node.nodeType === 1 && !node.contains(trigger.current) && node.tagName !== 'SMALL').map(node => node.textContent).join(' ').trim());
  }, [uiLocale]);
  useEffect(() => {
    if (!open) return;
    const reposition = event => { if (!menu.current?.contains(event.target)) position(); };
    window.addEventListener('resize', reposition); window.addEventListener('scroll', reposition, true);
    return () => { window.removeEventListener('resize', reposition); window.removeEventListener('scroll', reposition, true); };
  }, [open]);
  useEffect(() => { if (open && active >= 0) menu.current?.querySelector(`[data-option-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [open, active]);
  const keyDown = event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'Tab') { close(); return; }
    if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (open) choose(active); else show(); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); if (!open) show();
      const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
      const current = enabled.indexOf(open ? active : selectedIndex);
      setActive(event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1) : enabled[(current + (event.key === 'ArrowUp' ? -1 : 1) + enabled.length) % enabled.length]);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const match = options.findIndex(option => !option.disabled && String(option.label).toLocaleLowerCase().startsWith(event.key.toLocaleLowerCase()));
      if (match >= 0) { event.preventDefault(); if (!open) show(); setActive(match); }
    }
  };
  return <span className={`v2-select ${className}`}>
    {(name || required) && <select className="v2-select-native" aria-hidden="true" tabIndex={-1} name={name} form={form} required={required} value={selected?.value ?? ''} disabled={disabled} onChange={onChange} onInvalid={event => { event.preventDefault(); trigger.current.focus(); show(); }}>{children}</select>}
    <button {...props} id={id} ref={trigger} type="button" disabled={disabled} className="v2-select-trigger" role="combobox" aria-label={props['aria-label'] || label || undefined} aria-expanded={open} aria-haspopup="listbox" aria-controls={`${generatedId}-menu`} aria-activedescendant={open && active >= 0 ? optionId(active) : undefined} aria-required={required || undefined} onBlur={onBlur} onClick={() => open ? close() : show()} onKeyDown={keyDown}>
      <span>{selected?.label || t("请选择")}</span><ChevronDown size={16}/>
    </button>
    <span ref={menu} id={`${generatedId}-menu`} popover="auto" role="listbox" className="v2-select-menu" aria-label={props['aria-label'] || label || t("选项")} onToggle={event => setOpen(event.newState === 'open')}>
      {options.map((option, index) => <React.Fragment key={`${option.value}:${index}`}>
        {option.group && option.group !== options[index - 1]?.group && <span className="v2-select-group">{option.group}</span>}
        <span role="option" id={optionId(index)} data-option-index={index} aria-selected={option.value === selected?.value} aria-disabled={option.disabled || undefined} className={`v2-select-option${active === index ? ' focused' : ''}`} onPointerMove={() => !option.disabled && setActive(index)} onMouseDown={event => event.preventDefault()} onClick={event => { event.preventDefault(); event.stopPropagation(); choose(index); }}><span>{option.label}</span>{option.value === selected?.value && <Check size={15}/>}</span>
      </React.Fragment>)}
    </span>
  </span>;
}
