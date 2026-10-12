import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../../stores/app-store";
import type { SessionSummary } from "@pi-desktop/shared";
import { AnchoredMenu } from "../../../components/settings/AnchoredMenu";
import { IconCheck, IconChevronDown } from "../../../components/icons";
import { TooltipButton } from "../../../components/ui";
import { api, type OmpRole } from "../../../lib/api";
import { OMP_MODEL_EVENT } from "./OmpModelPicker";

const THINKING_SUFFIX = /:(off|minimal|low|medium|high|xhigh|max)$/;

/** omp role values may carry a thinking level: "provider/model:high". */
export function splitRoleModel(value: string): { model: string; thinking?: string } {
  const match = THINKING_SUFFIX.exec(value);
  return match ? { model: value.slice(0, match.index), thinking: match[1] } : { model: value };
}

let sharedRoles: Promise<OmpRole[]> | undefined;
export function loadOmpRoles(refresh = false): Promise<OmpRole[]> {
  if (!sharedRoles || refresh) {
    sharedRoles = api.ompListRoles().then((r) => r.roles);
    sharedRoles.catch(() => { sharedRoles = undefined; });
  }
  return sharedRoles;
}

/**
 * Quick switcher for omp model roles (`modelRoles` in omp's config.yml).
 * Choosing a role applies the role's model to the open session (omp
 * `set_model`) or to new chats. Roles are managed in Settings → omp roles.
 */
export function OmpRolePicker({
  session,
  controlsBlocked,
  onCloseOtherMenus,
  onSessionChanged,
  showToast,
}: {
  session: SessionSummary | null | undefined;
  controlsBlocked: boolean;
  onCloseOtherMenus: () => void;
  onSessionChanged: () => void;
  showToast: (message: string, options?: { variant?: "error" | "info" | "success" }) => void;
}) {
  const { t } = useTranslation();
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const [open, setOpen] = useState(false);
  const [roles, setRoles] = useState<OmpRole[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback((force: boolean) => {
    setError(null);
    loadOmpRoles(force).then(setRoles).catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  useEffect(() => { refresh(false); }, [refresh]);
  useEffect(() => { if (open) refresh(true); }, [open, refresh]);

  const sessionModel = session?.providerId && session?.modelId ? `${session.providerId}/${session.modelId}` : null;
  const base = (r: OmpRole) => (r.model ? splitRoleModel(r.model).model : null);
  const matched = roles?.find((r) => r.id === current && r.model && (!sessionModel || base(r) === sessionModel))
    ?? (sessionModel ? roles?.find((r) => base(r) === sessionModel) : undefined);
  const label = matched ? matched.id : t("chat.ompRole");

  const apply = async (role: OmpRole) => {
    if (!role.model) return;
    const { model, thinking } = splitRoleModel(role.model);
    const slash = model.indexOf("/");
    const provider = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    try {
      const result = await api.ompSetModel({ sessionId: session?.id, provider, modelId });
      if (thinking) {
        // omp may not accept every level for every model; keep the model switch either way.
        await api.ompSetThinking({ sessionId: session?.id, level: thinking === "max" ? "xhigh" : thinking }).catch(() => undefined);
      }
      setCurrent(role.id);
      window.dispatchEvent(new CustomEvent(OMP_MODEL_EVENT, { detail: { provider, modelId } }));
      if (result.session) onSessionChanged();
      setOpen(false);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
    }
  };

  const assigned = (roles ?? []).filter((r) => r.model);
  return (
    <AnchoredMenu
      className="composer-model-thinking"
      open={open}
      onClose={() => setOpen(false)}
      menuClassName="composer-model-menu omp-model-menu"
      label={t("chat.ompRole")}
      role="menu"
      align="end"
      side="top"
      trigger={(ref) => (
        <TooltipButton
          ref={ref}
          type="button"
          className={`icon-btn composer-model-thinking-chip ${open ? "active" : ""}`}
          tooltip={matched ? `${matched.id} → ${matched.model}` : t("chat.ompRole")}
          ariaLabel={`${t("chat.ompRole")}: ${label}`}
          aria-haspopup="menu"
          aria-expanded={open}
          data-omp-role-picker="true"
          disabled={controlsBlocked}
          onClick={() => { onCloseOtherMenus(); setOpen((v) => !v); }}
        >
          <span className="composer-model-thinking-model">{label}</span>
          <IconChevronDown size={12} aria-hidden="true" className="composer-model-thinking-chevron" />
        </TooltipButton>
      )}
    >
      <div className="composer-menu-root">
        <div className="composer-model-list">
          {!roles && !error ? <div className="composer-model-empty">Loading omp roles…</div> : null}
          {error ? <div className="composer-model-empty">{error}</div> : null}
          {assigned.map((role) => {
            const active = matched?.id === role.id;
            return (
              <button
                key={role.id}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                data-omp-role={role.id}
                className={`composer-plus-item composer-model-option ${active ? "active" : ""}`}
                onClick={() => void apply(role)}
              >
                <span className="composer-model-option-main">
                  <span className="composer-model-label">{role.id}</span>
                  <span className="composer-model-option-meta">{role.model}</span>
                </span>
                {active ? <IconCheck size={14} className="composer-model-check" aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          role="menuitem"
          data-omp-manage-roles="true"
          className="composer-plus-item composer-menu-entry"
          onClick={() => { setOpen(false); setSettingsTab("agent"); }}
        >
          {t("chat.manageRoles")}
        </button>
      </div>
    </AnchoredMenu>
  );
}
