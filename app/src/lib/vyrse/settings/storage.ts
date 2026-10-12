import { DEFAULT_SETTINGS, type Settings } from "../types";

/**
 * Settings persistence.
 *
 * Deliberately a single seam: swap `adapter` for Foundry's config store and
 * nothing else in the app changes. This is *not* AI memory — it holds only
 * interface preferences.
 */

export interface SettingsStorage {
  read(): string | null;
  write(value: string): void;
  clear(): void;
}

const KEY = "vyrse.settings.v1";

const memory = new Map<string, string>();

const localAdapter: SettingsStorage = {
  read() {
    try {
      return typeof window === "undefined"
        ? (memory.get(KEY) ?? null)
        : window.localStorage.getItem(KEY);
    } catch {
      return memory.get(KEY) ?? null;
    }
  },
  write(value) {
    memory.set(KEY, value);
    try {
      window.localStorage.setItem(KEY, value);
    } catch {
      /* private mode / restricted renderer — memory copy still applies */
    }
  },
  clear() {
    memory.delete(KEY);
    try {
      window.localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  },
};

let adapter: SettingsStorage = localAdapter;

/** Foundry can install its own persistence at boot. */
export function setSettingsStorage(next: SettingsStorage) {
  adapter = next;
}

/** Reads persisted settings, merged over defaults and key-filtered. */
export function loadSettings(): Settings {
  const raw = adapter.read();
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    const merged = { ...DEFAULT_SETTINGS };
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const value = parsed[key];
      if (value !== undefined && typeof value === typeof DEFAULT_SETTINGS[key]) {
        (merged as Record<string, unknown>)[key] = value;
      }
    }
    return merged;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: Settings) {
  try {
    adapter.write(JSON.stringify(settings));
  } catch {
    /* never let persistence break the UI */
  }
}

export function clearSettings() {
  adapter.clear();
}
