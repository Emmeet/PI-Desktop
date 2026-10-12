import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, type OmpRole } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { loadCatalog } from "../chat/composer/OmpModelPicker";
import { loadOmpRoles, splitRoleModel } from "../chat/composer/OmpRolePicker";
import { SettingsCard, SettingsRow } from "./primitives";

type Model = { provider: string; id: string; name: string };

function ModelSelect({ value: full, models, onChange, testId }: { value: string; models: Model[]; onChange: (v: string) => void; testId: string }) {
  // Keep a role's ":thinking" suffix when only the model changes.
  const { model: value, thinking } = splitRoleModel(full);
  const known = models.some((m) => `${m.provider}/${m.id}` === value);
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
    <select className="settings-select" data-omp-role-model={testId} value={value} onChange={(e) => onChange(e.target.value && thinking ? `${e.target.value}:${thinking}` : e.target.value)}>
      <option value="">(not set)</option>
      {value && !known ? <option value={value}>{value}</option> : null}
      {models.map((m) => (
        <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.provider}/{m.id}</option>
      ))}
    </select>
    {thinking ? <span className="text-sm" data-omp-role-thinking={testId}>{thinking}</span> : null}
    </span>
  );
}

/**
 * omp model roles, stored by omp itself (`modelRoles` in ~/.omp/agent/config.yml)
 * and edited through `omp config set`. Built-in roles can be assigned or
 * cleared; custom roles can be created and deleted.
 */
export function OmpRolesPage() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [roles, setRoles] = useState<OmpRole[] | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newModel, setNewModel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadOmpRoles(true).then(setRoles).catch((e) => setError(e instanceof Error ? e.message : String(e)));
    loadCatalog(false).then((c) => setModels(c.models)).catch(() => undefined);
  }, []);

  const save = async (role: string, model: string | null) => {
    setBusy(true);
    try {
      const result = await api.ompSetRole({ role, model });
      setRoles(result.roles);
      void loadOmpRoles(true);
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), { variant: "error" });
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-omp-roles-page="true">
      <SettingsCard
        title={t("settings.rolesCard")}
        description={t("settings.rolesDescription")}
      >
        {error ? <SettingsRow title="Error">{error}</SettingsRow> : null}
        {!roles && !error ? <SettingsRow title="Loading…">{null}</SettingsRow> : null}
        {roles?.map((role) => (
          <SettingsRow key={role.id} title={`${role.id}${role.name !== role.id ? ` · ${role.name}` : ""}`} description={role.builtin ? "Built-in omp role" : "Custom role"}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }} data-omp-role-row={role.id}>
              <ModelSelect testId={role.id} value={role.model ?? ""} models={models} onChange={(v) => void save(role.id, v || null)} />
              {!role.builtin ? (
                <Button
                  variant="ghost"
                  data-omp-role-delete={role.id}
                  disabled={busy}
                  onClick={() => { if (window.confirm(`Delete omp role ${role.id}?`)) void save(role.id, null); }}
                >
                  Delete
                </Button>
              ) : null}
            </div>
          </SettingsRow>
        ))}
      </SettingsCard>
      <SettingsCard title={t("settings.rolesNew")}>
        <SettingsRow title="Name and model">
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              className="settings-input"
              data-omp-role-new-name="true"
              placeholder="e.g. reviewer"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <ModelSelect testId="__new" value={newModel} models={models} onChange={setNewModel} />
            <Button
              data-omp-role-create="true"
              disabled={busy || !newName.trim() || !newModel}
              onClick={async () => { if (await save(newName.trim(), newModel)) { setNewName(""); setNewModel(""); } }}
            >
              Create
            </Button>
          </div>
        </SettingsRow>
      </SettingsCard>
    </div>
  );
}
