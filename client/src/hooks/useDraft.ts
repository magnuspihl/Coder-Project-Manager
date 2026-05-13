import { useState, useEffect, useCallback } from 'react';

/**
 * Like useState, but persists the value to sessionStorage so it survives
 * hot-reloads and page refreshes. Clears automatically when the tab closes.
 */
export function useDraft(key: string, initial = ''): [string, (v: string) => void, () => void] {
  const storageKey = `draft:${key}`;

  const [value, setValue] = useState(() => {
    try {
      return sessionStorage.getItem(storageKey) ?? initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      if (value) {
        sessionStorage.setItem(storageKey, value);
      } else {
        sessionStorage.removeItem(storageKey);
      }
    } catch {
      // quota exceeded or unavailable — ignore
    }
  }, [storageKey, value]);

  const clear = useCallback(() => {
    setValue('');
    try { sessionStorage.removeItem(storageKey); } catch { /* ignore */ }
  }, [storageKey]);

  return [value, setValue, clear];
}

/**
 * Like useState, but persists to localStorage so the value survives across
 * tab closes and browser restarts. Per-device (each device has its own copy).
 */
export function useLocalStorageState<T>(key: string, initial: T): [T, (v: T) => void] {
  const storageKey = `state:${key}`;

  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(storageKey);
      return stored !== null ? JSON.parse(stored) as T : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      if (value === null || value === undefined) {
        localStorage.removeItem(storageKey);
      } else {
        localStorage.setItem(storageKey, JSON.stringify(value));
      }
    } catch { /* ignore */ }
  }, [storageKey, value]);

  return [value, setValue];
}

/**
 * Persist a simple value (like an open panel ID) to sessionStorage.
 */
export function useSessionState<T>(key: string, initial: T): [T, (v: T) => void] {
  const storageKey = `state:${key}`;

  const [value, setValue] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(storageKey);
      return stored !== null ? JSON.parse(stored) : initial;
    } catch {
      return initial;
    }
  });

  useEffect(() => {
    try {
      if (value === null || value === undefined || value === initial) {
        sessionStorage.removeItem(storageKey);
      } else {
        sessionStorage.setItem(storageKey, JSON.stringify(value));
      }
    } catch { /* ignore */ }
  }, [storageKey, value]);

  return [value, setValue];
}
