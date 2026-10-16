import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { IconCircleAlert, IconClose } from "../../components/icons";
import { Button, TooltipButton } from "../../components/ui";
import { api } from "../../lib/api";

/** Probe on shell startup, even with dismissed onboarding or no active chat. */
export function OmpCompatibilityNotice() {
  const { t } = useTranslation();
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<string | null>(null);
  const [checking, setChecking] = useState(true);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setChecking(true);
    void api.ompCall("omp.capability.check").then(
      () => { if (!cancelled) setFailure(null); },
      (error: unknown) => {
        if (cancelled) return;
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        setFailure(typeof code === "string" && code.startsWith("OMP_") ? code : "OMP_START_FAILED");
      },
    ).finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [attempt]);
  if (!failure || dismissed) return null;
  const key = `errors.${failure}`;
  const message = t(key) === key ? t("errors.OMP_START_FAILED") : t(key);
  return (
    <div className="update-notice" role="alert" data-testid="omp-compatibility-notice">
      <div className="update-notice-icon" aria-hidden="true"><IconCircleAlert className="size-4" /></div>
      <div className="update-notice-body">
        <div className="update-notice-title">OMP</div>
        <div className="update-notice-message">{message}</div>
        <div className="update-notice-actions">
          <Button size="sm" disabled={checking} onClick={() => setAttempt((value) => value + 1)}>
            {t("errors.action.retry")}
          </Button>
        </div>
      </div>
      <TooltipButton className="update-notice-dismiss" tooltip={t("errors.action.dismiss")}
        ariaLabel={t("errors.action.dismiss")} onClick={() => setDismissed(true)}>
        <IconClose size={13} aria-hidden />
      </TooltipButton>
    </div>
  );
}
