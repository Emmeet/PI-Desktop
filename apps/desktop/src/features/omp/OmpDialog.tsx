import { useLayoutEffect, useRef, type ReactNode } from "react";
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const previousFocus = useRef(typeof document === "undefined" ? null : document.activeElement);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    const initial = dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : dialog.querySelector<HTMLElement>("[autofocus], input:not(:disabled), textarea:not(:disabled)") ?? focusable()[0] ?? dialog;
    initial.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== dialog) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0] ?? dialog;
        const last = elements.at(-1) ?? dialog;
        if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last) || !elements.length) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const previous = previousFocus.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return portalToBody(
    <div
      className="overlay omp-dialog-overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} tabIndex={-1} className={cx("dialog omp-dialog", className)} role="dialog" aria-modal="true" aria-label={title}>
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
