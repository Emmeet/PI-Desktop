import { useTranslation } from "react-i18next";
import type { SessionThinkingLevel } from "@pi-desktop/shared";
import { SubagentModelPicker } from "../../components/settings/SubagentModelPicker";
import { SettingsMenuSelect } from "../../components/settings/SettingsMenuSelect";
import { useOmpModelChoices } from "../../components/settings/omp-subagent-models";
import type { ScheduledModelSelection } from "./ScheduledExecutionSettings";

/** Role references are stored as providerId "omp-role" + modelId "<role>". */
export const OMP_ROLE_PROVIDER = "omp-role";

function pinOf(value: ScheduledModelSelection): string {
  if (!value.providerId || !value.modelId) return "";
  return value.providerId === OMP_ROLE_PROVIDER ? `@${value.modelId}` : `${value.providerId}/${value.modelId}`;
}

/**
 * Model for a scheduled run, from omp's own catalog and roles. Empty means a
 * new omp session with the `default` role.
 */
export function ScheduledModelPicker({ value, disabled, onChange }: {
  value: ScheduledModelSelection;
  disabled: boolean;
  onChange: (selection: ScheduledModelSelection) => void;
}) {
  const { t } = useTranslation();
  const omp = useOmpModelChoices();
  const pin = pinOf(value);
  const known = omp.groups.some((group) => group.choices.some((choice) => choice.value === pin));
  const levels = omp.levelsFor(pin);
  return (
    <div className="scheduled-omp-model">
      <SubagentModelPicker
        value={pin}
        groups={omp.groups}
        orphanPin={pin && !known ? pin : null}
        disabled={disabled}
        emptyLabel={t("settings.defaultModel")}
        onChange={(next) => {
          if (!next) return onChange({ thinkingLevel: value.thinkingLevel });
          if (next.startsWith("@")) return onChange({ providerId: OMP_ROLE_PROVIDER, modelId: next.slice(1) });
          const slash = next.indexOf("/");
          const nextLevels = omp.levelsFor(next);
          const level = value.thinkingLevel && nextLevels && !nextLevels.includes(value.thinkingLevel) ? undefined : value.thinkingLevel;
          onChange({ providerId: next.slice(0, slash), modelId: next.slice(slash + 1), thinkingLevel: level });
        }}
      />
      {pin && !pin.startsWith("@") ? (
        <SettingsMenuSelect
          label={t("extensions.subagents.thinking")}
          value={value.thinkingLevel ?? ""}
          onChange={(id) => onChange({ ...value, thinkingLevel: (id || undefined) as SessionThinkingLevel | undefined })}
          options={[
            { id: "", label: t("extensions.subagents.thinkingInherit") },
            ...(levels ?? ["off", "minimal", "low", "medium", "high", "xhigh"]).map((level) => ({ id: level, label: level })),
          ]}
        />
      ) : null}
    </div>
  );
}
