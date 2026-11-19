import { useEffect, useId, useRef } from 'react';

interface BackEntry {
  id: string;
  onBack: () => void;
}

const backStack: BackEntry[] = [];
let browserDepth = 0;
let pendingTargetDepth: number | null = null;
let syncTimer: ReturnType<typeof setTimeout> | null = null;
let initialized = false;

function getDepthFromState(state: unknown): number {
  if (state && typeof state === 'object' && 'akrobitDepth' in state) {
    const val = (state as { akrobitDepth?: unknown }).akrobitDepth;
    if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
      return val;
    }
  }
  return 0;
}

function initBackListener() {
  if (initialized || typeof window === 'undefined') return;
  initialized = true;

  try {
    const existing =
      window.history.state && typeof window.history.state === 'object'
        ? (window.history.state as Record<string, unknown>)
        : {};
    window.history.replaceState({ ...existing, akrobitDepth: 0 }, '');
    browserDepth = 0;
  } catch {
    browserDepth = 0;
  }

  window.addEventListener('popstate', (event: PopStateEvent) => {
    const nextDepth = getDepthFromState(event.state);
    browserDepth = nextDepth;

    if (pendingTargetDepth !== null) {
      const target = pendingTargetDepth;
      if (nextDepth <= target) {
        pendingTargetDepth = null;
        if (nextDepth >= backStack.length) {
          scheduleSync();
          return;
        }
      } else {
        return;
      }
    }

    while (backStack.length > nextDepth) {
      const top = backStack.pop();
      if (!top) break;
      try {
        top.onBack();
      } catch (err) {
        console.error('Error ejecutando navegación atrás:', err);
      }
    }

    scheduleSync();
  });
}

function syncHistoryDepth() {
  syncTimer = null;
  if (typeof window === 'undefined') return;
  if (pendingTargetDepth !== null) return;

  try {
    while (browserDepth < backStack.length) {
      browserDepth += 1;
      const existing =
        window.history.state && typeof window.history.state === 'object'
          ? (window.history.state as Record<string, unknown>)
          : {};
      window.history.pushState({ ...existing, akrobitDepth: browserDepth }, '');
    }

    if (browserDepth > backStack.length) {
      const delta = backStack.length - browserDepth;
      pendingTargetDepth = backStack.length;
      window.history.go(delta);
    }
  } catch {
    // Ignore history API restrictions in restricted environments
  }
}

function scheduleSync() {
  if (typeof window === 'undefined') return;
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(syncHistoryDepth, 0);
}

function registerBackEntry(id: string, onBack: () => void) {
  initBackListener();
  const existingIdx = backStack.findIndex((item) => item.id === id);
  if (existingIdx !== -1) {
    backStack.splice(existingIdx, 1);
  }
  backStack.push({ id, onBack });
  scheduleSync();
}

function unregisterBackEntry(id: string) {
  const existingIdx = backStack.findIndex((item) => item.id === id);
  if (existingIdx !== -1) {
    backStack.splice(existingIdx, 1);
    scheduleSync();
  }
}

/**
 * Integrates a view, panel, or modal with the device hardware/gesture Back button.
 * When `active` is true, pressing Back invokes `onBack` instead of leaving Akrobit.
 */
export function useBackHandler(active: boolean, onBack: () => void) {
  const id = useId();
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;

  useEffect(() => {
    if (!active) return;
    registerBackEntry(id, () => onBackRef.current());
    return () => {
      unregisterBackEntry(id);
    };
  }, [active, id]);
}
