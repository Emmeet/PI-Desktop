import type { TFunction } from "i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionSummary, SessionThinkingLevel } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { IconBot, IconSparkles, IconCheck, IconChevronDown, IconSearch } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { api } from "../../../lib/api";

type OmpModel = { provider: string; id: string; name: string; reasoning: boolean; contextWindow?: number; thinkingLevels?: string[] };

const LEVEL_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Highest supported level not above the requested one (omp's own clamp rule). */
export function clampLevel(requested: string, levels: string[]): string {
  if (levels.includes(requested)) return requested;
  const index = LEVEL_ORDER.indexOf(requested);
  let best = levels[0] ?? "off";
  for (const level of levels) if (LEVEL_ORDER.indexOf(level) <= index) best = level;
  return best;
}
type Catalog = Awaited<ReturnType<typeof api.ompListModels>>;

export const OMP_MODEL_EVENT = "omp-desktop:model-applied";

let sharedCatalog: Promise<Catalog> | undefined;
export function loadCatalog(refresh = false): Promise<Catalog> {
  if (!sharedCatalog || refresh) {
    sharedCatalog = api.ompListModels(refresh);
    sharedCatalog.catch(() => { sharedCatalog = undefined; });
  }
  return sharedCatalog;
}

function formatContext(tokens?: number): string | null {
  if (!tokens) return null;
  return tokens >= 1_000_000 ? `${Math.round(tokens / 100_000) / 10}M` : `${Math.round(tokens / 1000)}K`;
}

/**
 * Model + reasoning picker backed by omp's own catalog (models.yml and
 * logins, via `get_available_models`). Selecting a model applies it to the
 * open session through omp's `set_model` and remembers it for new chats.
 */
export function OmpModelPicker({
  t,
  session,
  controlsBlocked,
  onCloseOtherMenus,
  onSessionChanged,
  showToast,
}: {
  t: TFunction;
  session: SessionSummary | null | undefined;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
  onSessionChanged: () => void;
  showToast: (message: string, options?: { variant?: "error" | "info" | "success" }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [levelOpen, setLevelOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draftModel, setDraftModel] = useState<{ provider: string; modelId: string } | null>(null);
  const [draftThinking, setDraftThinking] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback((force = false) => {
    setLoadError(null);
    loadCatalog(force)
      .then((result) => setCatalog(result))
      .catch((error) => setLoadError(error instanceof Error ? error.message : String(error)));
  }, []);
  useEffect(() => { refresh(false); }, [refresh]);
  useEffect(() => { if (open) refresh(false); }, [open, refresh]);
  useEffect(() => {
    // The role switcher applies a role's model; mirror it here.
    const onRoleModel = (event: Event) => {
      const detail = (event as CustomEvent<{ provider: string; modelId: string }>).detail;
      setDraftModel(detail);
      setCatalog((current) => (current ? { ...current, selected: detail } : current));
    };
    window.addEventListener(OMP_MODEL_EVENT, onRoleModel);
    return () => window.removeEventListener(OMP_MODEL_EVENT, onRoleModel);
  }, []);

  const selected = session?.providerId && session?.modelId
    ? { provider: session.providerId, modelId: session.modelId }
    : draftModel ?? catalog?.selected ?? null;
  const thinkingLevel = (session ? session.thinkingLevel : draftThinking ?? catalog?.thinkingLevel) ?? "off";
  const selectedInfo = catalog?.models.find((model) => model.provider === selected?.provider && model.id === selected?.modelId);
  const modelLabel = selectedInfo?.name ?? selected?.modelId ?? (catalog ? "omp default" : "Model");

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const map = new Map<string, OmpModel[]>();
    for (const model of catalog?.models ?? []) {
      if (needle && !`${model.provider}/${model.id} ${model.name}`.toLowerCase().includes(needle)) continue;
      const list = map.get(model.provider) ?? [];
      list.push(model);
      map.set(model.provider, list);
    }
    return [...map.entries()];
  }, [catalog, query]);

  const choose = async (model: OmpModel) => {
    try {
      const result = await api.ompSetModel({ sessionId: session?.id, provider: model.provider, modelId: model.id });
      setDraftModel({ provider: model.provider, modelId: model.id });
      if (catalog) setCatalog({ ...catalog, selected: { provider: model.provider, modelId: model.id } });
      const levels = model.thinkingLevels ?? [];
      const clamped = levels.length ? clampLevel(thinkingLevel, levels) : null;
      if (clamped && clamped !== thinkingLevel) await commitThinking(clamped as SessionThinkingLevel);
      if (result.session) onSessionChanged();
      setOpen(false);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
    }
  };

  const commitThinking = async (level: SessionThinkingLevel): Promise<boolean> => {
    try {
      const result = await api.ompSetThinking({ sessionId: session?.id, level });
      setDraftThinking(level);
      if (result.session) onSessionChanged();
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), { variant: "error" });
      return false;
    }
  };

  const levels = selectedInfo?.thinkingLevels ?? [];

  const shownLevel = levels.length ? clampLevel(thinkingLevel, levels) : null;

  return (
    <>
    {levels.length > 0 && shownLevel ? (
      <AnchoredMenu
        className="composer-model-thinking"
        open={levelOpen}
        onClose={() => setLevelOpen(false)}
        menuClassName="composer-model-menu omp-thinking-menu"
        label={t("chat.reasoningLevel")}
        role="menu"
        align="end"
        side="top"
        trigger={(ref) => (
          <TooltipButton
            ref={ref}
            type="button"
            className={`icon-btn composer-model-thinking-chip ${levelOpen ? "active" : ""}`}
            tooltip={`${t("chat.reasoningLevel")}: ${shownLevel}`}
            ariaLabel={`${t("chat.reasoningLevel")}: ${shownLevel}`}
            aria-haspopup="menu"
            aria-expanded={levelOpen}
            data-omp-thinking-picker="true"
            disabled={controlsBlocked}
            onClick={() => { onCloseOtherMenus(); setOpen(false); setLevelOpen((v) => !v); }}
          >
            <span className="composer-model-thinking-icon" aria-hidden="true"><IconSparkles size={14} /></span>
            <span className="composer-model-thinking-model">{shownLevel}</span>
            <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
          </TooltipButton>
        )}
      >
        <div className="composer-menu-root" data-omp-thinking-list="true">
          {levels.map((level) => (
            <button
              key={level}
              type="button"
              role="menuitemradio"
              aria-checked={level === shownLevel}
              data-omp-thinking={level}
              className={`composer-plus-item composer-model-option ${level === shownLevel ? "active" : ""}`}
              onClick={async () => { if (await commitThinking(level as SessionThinkingLevel)) setLevelOpen(false); }}
            >
              <span className="composer-model-label">{level}</span>
              {level === shownLevel ? <IconCheck size={14} className="composer-model-check" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      </AnchoredMenu>
    ) : null}
    <AnchoredMenu
      className="composer-model-thinking"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-model-menu omp-model-menu"
      label={t("chat.model")}
      role="menu"
      align="end"
      side="top"
      initialFocus="input"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn composer-model-thinking-chip ${open ? "active" : ""}`}
          tooltip={selected ? `${selected.provider}/${selected.modelId}` : modelLabel}
          ariaLabel={`${t("chat.model")}: ${modelLabel}`}
          aria-haspopup="menu"
          aria-expanded={open}
          data-omp-model-picker="true"
          disabled={controlsBlocked}
          onClick={() => {
            onCloseOtherMenus();
            setLevelOpen(false);
            if (!open) setQuery("");
            setOpen((current) => !current);
          }}
        >
          <span className="composer-model-thinking-icon" aria-hidden="true"><IconBot size={14} /></span>
          <span className="composer-model-thinking-model">{modelLabel}</span>
          <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
        </TooltipButton>
      )}
    >
      <div className="composer-menu-root">
        <label className="composer-model-search">
          <IconSearch size={13} aria-hidden="true" />
          <input
            ref={searchRef}
            type="text"
            value={query}
            placeholder={t("chat.searchModels")}
            aria-label={t("chat.searchModels")}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <div className="composer-model-list" data-omp-model-list="true">
          {!catalog && !loadError ? <div className="composer-model-empty">Loading omp models…</div> : null}
          {loadError ? (
            <div className="composer-model-empty">
              {loadError}{" "}
              <button type="button" className="composer-menu-entry" onClick={() => refresh(true)}>Retry</button>
            </div>
          ) : null}
          {catalog && groups.length === 0 ? (
            <div className="composer-model-empty">
              {query ? t("chat.noModelResults") : "omp reports no usable models. Configure one with `omp` (/login or ~/.omp/agent/models.yml)."}
            </div>
          ) : null}
          {groups.map(([provider, models]) => (
            <div key={provider} className="composer-model-group" role="group" aria-label={provider}>
              <div className="composer-model-group-label">{provider}</div>
              {models.map((model) => {
                const active = model.provider === selected?.provider && model.id === selected?.modelId;
                const ctx = formatContext(model.contextWindow);
                return (
                  <button
                    key={`${model.provider}:${model.id}`}
                    type="button"
                    title={`${model.provider}/${model.id}`}
                    className={`composer-plus-item composer-model-option ${active ? "active" : ""}`}
                    role="menuitemradio"
                    aria-checked={active}
                    data-omp-model={`${model.provider}/${model.id}`}
                    onClick={() => void choose(model)}
                  >
                    <span className="composer-model-option-main">
                      <span className="composer-model-label">{model.name}</span>
                      <span className="composer-model-option-meta">
                        {model.id}
                        {ctx ? <span className="composer-model-option-ctx"> · {ctx}</span> : null}
                      </span>
                    </span>
                    {active ? <IconCheck size={14} className="composer-model-check" aria-hidden="true" /> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </AnchoredMenu>
    </>
  );
}
