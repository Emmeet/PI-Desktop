/**
 * Model choices for an omp subagent: omp's role references (`@smol`, …) and
 * every model in omp's own catalog (the same source as the composer picker),
 * with the reasoning levels each model supports.
 */
import { useEffect, useMemo, useState } from "react";
import { api, type OmpRole } from "../../lib/api";
import { loadCatalog } from "../../features/chat/composer/OmpModelPicker";
import type { SubagentModelChoiceGroup } from "./subagent-models";

type Catalog = Awaited<ReturnType<typeof loadCatalog>>;

export function useOmpModelChoices() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [roles, setRoles] = useState<OmpRole[]>([]);
  useEffect(() => {
    let live = true;
    loadCatalog().then((value) => live && setCatalog(value)).catch(() => {});
    api.ompListRoles().then((value) => live && setRoles(value.roles ?? [])).catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  return useMemo(() => {
    const models = (catalog?.models ?? []) as Array<{ provider: string; id: string; thinkingLevels?: string[] }>;
    const groups: SubagentModelChoiceGroup[] = [];
    const roleChoices = roles
      .filter((role) => role.model)
      .map((role) => ({
        value: `@${role.id}`,
        modelId: `@${role.id} → ${role.model}`,
        providerId: "omp-roles",
        providerName: "omp roles",
        vendorKey: "",
      }));
    if (roleChoices.length) groups.push({ providerId: "omp-roles", providerName: "omp roles", choices: roleChoices });
    const byProvider = new Map<string, SubagentModelChoiceGroup>();
    for (const model of models) {
      let group = byProvider.get(model.provider);
      if (!group) {
        group = { providerId: model.provider, providerName: model.provider, choices: [] };
        byProvider.set(model.provider, group);
        groups.push(group);
      }
      group.choices.push({
        value: `${model.provider}/${model.id}`,
        modelId: model.id,
        providerId: model.provider,
        providerName: model.provider,
        vendorKey: model.provider,
      });
    }
    /** Supported levels for a pin, or null when unknown (roles, inherit). */
    const levelsFor = (pin: string): string[] | null => {
      const value = pin.trim();
      if (!value || value.startsWith("@")) return null;
      const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === value);
      return model?.thinkingLevels?.length ? model.thinkingLevels : null;
    };
    return { groups, levelsFor };
  }, [catalog, roles]);
}
