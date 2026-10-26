import { useEffect, useState } from 'react';

export function useMediaQuery(query) {
  const readMatches = () => (typeof window !== 'undefined' && window.matchMedia(query).matches);
  const [matches, setMatches] = useState(readMatches);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const mediaQuery = window.matchMedia(query);
    const updateMatches = () => {
      const nextMatches = mediaQuery.matches;
      setMatches((current) => (current === nextMatches ? current : nextMatches));
    };
    updateMatches();
    if (mediaQuery.addEventListener) {
      mediaQuery.addEventListener('change', updateMatches);
      return () => mediaQuery.removeEventListener('change', updateMatches);
    }
    mediaQuery.addListener(updateMatches);
    return () => mediaQuery.removeListener(updateMatches);
  }, [query]);

  return matches;
}
