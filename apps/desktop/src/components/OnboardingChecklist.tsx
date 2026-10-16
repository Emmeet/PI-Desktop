import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../lib/api";
import { useAppStore } from "../stores/app-store";
import { IconCheck } from "./icons";

/** Host step ids (app.getOnboarding) mapped to locale keys under `onboarding.`. */
const STEP_LOCALE_KEY: Record<string, string> = {
  provider: "addProvider",
  secret: "saveKey",
  project: "openProject",
  prompt: "firstPrompt",
  plugin: "loadPlugin",
  ompSetup: "ompSetup",
};

const OMP_HANDLED_STEPS: Readonly<Record<string, true>> = {
  provider: true,
  secret: true,
  prompt: true,
};

/** First-run inline checklist (D021): rendered on the empty chat home until
 * every step is done or the user dismisses it. Optional steps come from the
 * host; critical model availability comes from omp. Actions deep-link to setup. */
export function OnboardingChecklist() {
  const { t } = useTranslation();
  const onboarding = useAppStore((s) => s.onboarding);
  const setPage = useAppStore((s) => s.setPage);
  const setSettingsTab = useAppStore((s) => s.setSettingsTab);
  const openProject = useAppStore((s) => s.openProject);
  const page = useAppStore((s) => s.page);
  const dismissed = useAppStore((s) => s.settings?.onboardingDismissed === true);
  const [locallyDismissed, setLocallyDismissed] = useState(false);
  const [availability, setAvailability] = useState<"loading" | "ready" | "missing" | "error">("loading");

  useEffect(() => {
    if (page !== "chat" || dismissed || locallyDismissed) return;
    let cancelled = false;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void api.ompListModels(true).then(
        ({ models }) => {
          if (!cancelled && request === generation) {
            setAvailability(models.length > 0 ? "ready" : "missing");
          }
        },
        () => {
          if (!cancelled && request === generation) setAvailability("error");
        },
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", refresh);
    };
  }, [page, dismissed, locallyDismissed]);

  const needsOmpSetup = availability === "missing" || availability === "error";
  if (!onboarding || dismissed || locallyDismissed || (!onboarding.showChecklist && !needsOmpSetup)) return null;
  // Host providers and prompt counts do not describe omp's configured models.
  // Keep optional host steps, but derive the critical setup step from omp.
  const steps = (onboarding.showChecklist ? onboarding.steps : [])
    .filter((step) => !OMP_HANDLED_STEPS[step.id]);
  if (needsOmpSetup) {
    steps.unshift({ id: "ompSetup", title: "", done: false, action: "omp.setup" });
  }
  if (steps.length === 0 || steps.every((s) => s.done)) return null;

  const stepLabel = (id: string, fallback: string) => {
    const key = `onboarding.${STEP_LOCALE_KEY[id] ?? id}`;
    const label = t(key);
    return label === key ? fallback : label;
  };

  const runAction = (id: string) => {
    switch (id) {
      case "omp.setup":
        setSettingsTab("accounts");
        setPage("settings");
        break;
      case "settings.providers":
      case "addProvider":
      case "saveKey":
        setSettingsTab("agent");
        setPage("settings");
        break;
      case "project.open":
      case "openProject":
        void openProject();
        break;
      case "chat.focus":
        setPage("chat");
        requestAnimationFrame(() => {
          document
            .querySelector<HTMLTextAreaElement>(".composer-input")
            ?.focus();
        });
        break;
      case "plugins.open":
      case "loadPlugin":
        setPage("plugins");
        break;
      default:
        break;
    }
  };

  const dismiss = () => {
    void api
      .dismissOnboarding()
      .catch(() => undefined)
      .finally(() => {
        setLocallyDismissed(true);
        const { onboarding: current, settings } = useAppStore.getState();
        if (current) {
          useAppStore.setState({
            settings: settings ? { ...settings, onboardingDismissed: true } : undefined,
            onboarding: { ...current, showChecklist: false },
          });
        }
      });
  };

  return (
    <div
      className="home-onboarding-checklist mx-auto w-full max-w-[560px] rounded-lg-plus border border-border-subtle bg-bg-elevated-opaque p-4 text-left shadow-none"
      data-testid="onboarding-checklist"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-md-plus font-medium text-text-primary">
          {t("onboarding.title")}
        </span>
        <button
          type="button"
          className="rounded-md px-1.5 py-0.5 text-xs-plus text-text-muted hover:bg-bg-hover hover:text-text-primary"
          onClick={dismiss}
        >
          {t("onboarding.dismiss")}
        </button>
      </div>
      {needsOmpSetup && (
        <p className="mb-2 text-sm text-text-muted" role="status">
          {t(availability === "error" ? "onboarding.ompUnavailable" : "onboarding.ompSetupHint")}
        </p>
      )}
      <ul className="flex flex-col gap-1.5">
        {steps.map((step) => (
          <li key={step.id}>
            <button
              type="button"
              disabled={step.done}
              onClick={() => runAction(step.action || step.id)}
              className={`flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-md ${
                step.done
                  ? "cursor-default text-text-muted line-through"
                  : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
              }`}
            >
              <span
                className={`flex h-4.5 w-4.5 flex-none items-center justify-center rounded-full border ${
                  step.done
                    ? "border-success bg-success/15 text-success"
                    : "border-border-strong text-transparent"
                }`}
                aria-hidden
              >
                <IconCheck size={10} />
              </span>
              {stepLabel(step.id, step.title)}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
