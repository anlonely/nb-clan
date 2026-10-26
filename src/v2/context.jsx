import React, { createContext, useContext } from 'react';
export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);
export function AppLink({ to, children, onClick, ...props }) {
  const { go } = useApp();
  return <a href={to} {...props} onClick={e => {
    onClick?.(e);
    if (!e.defaultPrevented && e.button === 0 && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !props.target) {
      e.preventDefault(); go(to);
    }
  }}>{children}</a>;
}
