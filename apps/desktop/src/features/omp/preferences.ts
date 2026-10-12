export type OmpValues = Record<string, unknown>;

export interface OmpPreferenceApi {
  ompConfigGet(): Promise<{ values: OmpValues }>;
  ompConfigSet(key: string, value: unknown): Promise<unknown>;
  onOmpEvent(listener: (event: { method: string }) => void): () => void;
}

/** Reads are deliberately not cached: the engine and other windows can edit config. */
export function subscribeOmpConfig(api: OmpPreferenceApi, refresh: () => void): () => void {
  const stop = api.onOmpEvent((event) => {
    if (event.method === "omp.config.changed") refresh();
  });
  window.addEventListener("focus", refresh);
  return () => {
    stop();
    window.removeEventListener("focus", refresh);
  };
}

/** The persisted, normalized value wins over the requested value. */
export async function saveOmpPreference(api: OmpPreferenceApi, key: string, value: unknown): Promise<OmpValues> {
  await api.ompConfigSet(key, value);
  return (await api.ompConfigGet()).values;
}

export function parsePreferenceCount(draft: string): number | null {
  if (!draft.trim()) return null;
  const value = Number(draft);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
