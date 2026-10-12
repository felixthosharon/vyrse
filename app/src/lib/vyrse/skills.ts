import { useCallback, useEffect, useState } from "react";
import { getVyrseApi } from "@/services";
import type { HubSkill, InstalledSkill } from "@/services";

/**
 * Hermes skills for the Settings UI: installed list, toggles, SKILL.md preview, hub search
 * and install/remove. All state lives in Hermes; this hook only mirrors it while the panel is open.
 */
export function useSkills(active: boolean) {
  const api = getVyrseApi().skills;
  const [installed, setInstalled] = useState<InstalledSkill[] | null>(null);
  const [results, setResults] = useState<HubSkill[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setInstalled(await api.list());
    } catch (err) {
      setError(`Couldn't load skills: ${(err as Error).message}`);
    }
  }, [api]);

  useEffect(() => {
    if (active) void refresh();
  }, [active, refresh]);

  const run = useCallback(async (key: string, fn: () => Promise<unknown>, failure: string) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError(`${failure}: ${(err as Error).message}`);
      return false;
    } finally {
      setBusy(null);
    }
  }, []);

  return {
    available: Boolean(api),
    installed,
    results,
    busy,
    error,
    refresh,
    toggle: (name: string, enabled: boolean) => {
      setInstalled((list) => list?.map((s) => (s.name === name ? { ...s, enabled } : s)) ?? list);
      void run(name, () => api!.setEnabled(name, enabled), `Couldn't ${enabled ? "enable" : "disable"} ${name}`).then(
        (ok) => {
          if (!ok) void refresh();
        },
      );
    },
    content: (name: string) => api!.content(name),
    search: (query: string) =>
      run("search", async () => setResults(query.trim() ? await api!.search(query.trim()) : null), "Search failed"),
    install: (skill: HubSkill) =>
      run(skill.identifier, async () => {
        await api!.install(skill.identifier);
        setResults((r) => r?.map((x) => (x.identifier === skill.identifier ? { ...x, installed: true } : x)) ?? r);
        await refresh();
      }, `Couldn't install ${skill.name}`),
    uninstall: (name: string) =>
      run(name, async () => {
        await api!.uninstall(name);
        await refresh();
      }, `Couldn't remove ${name}`),
  };
}
