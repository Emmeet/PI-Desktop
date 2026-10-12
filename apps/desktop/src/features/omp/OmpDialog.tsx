import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useBlockingOverlay } from "../../lib/blocking-overlay";
import { portalToBody } from "../../lib/portal-visibility";
import { IconClose } from "../../components/icons";
import { TooltipButton, cx } from "../../components/ui";
import "./omp.css";

/** Plain modal shell for the omp panels (subagent transcript, branch tree, sign-in). */
export function OmpDialog({
  title,
  icon,
  className,
  onClose,
  children,
  footer,
}: {
  title: string;
  icon?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const { t } = useTranslation();
  useBlockingOverlay();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return portalToBody(
    <div
      className="overlay omp-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={cx("dialog omp-dialog", className)} role="dialog" aria-modal="true" aria-label={title}>
        <div className="omp-dialog-head">
          <h2 className="omp-dialog-title">
            {icon}
            <span>{title}</span>
          </h2>
          <TooltipButton type="button" className="omp-dialog-close" tooltip={t("common.close")} ariaLabel={t("common.close")} onClick={onClose}>
            <IconClose size={14} />
          </TooltipButton>
        </div>
        <div className="omp-dialog-body">{children}</div>
        {footer ? <div className="omp-dialog-foot">{footer}</div> : null}
      </div>
    </div>,
  );
}

export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}
