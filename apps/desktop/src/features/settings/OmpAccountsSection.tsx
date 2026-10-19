import "../omp/omp.css";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { Button } from "../../components/ui";
import { IconKey } from "../../components/icons";
import { OmpDialog, errorText } from "../omp/OmpDialog";
import { SettingsCard, SettingsRow } from "./primitives";

type Provider = { id: string; name: string; available: boolean; authenticated: boolean };
type Account = { credentialId: number; provider: string; label: string; detail: string; type: string; active: boolean };
type LoginUi =
  | { kind: "open_url"; url: string; instructions?: string }
  | { kind: "progress"; message: string }
  | { kind: "input"; requestId: string; title: string; placeholder?: string };

/**
 * Provider sign-in through omp (`get_login_providers` / `login` / `logout`).
 * omp runs the OAuth flow; the browser link and any pasted code go through
 * the dialog below. Credentials stay in omp's store.
 */
export function OmpAccountsSection() {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [providers, setProviders] = useState<Provider[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [login, setLogin] = useState<{ provider: Provider; steps: LoginUi[] } | null>(null);
  const [accounts, setAccounts] = useState<{ provider: Provider; list: Account[] } | null>(null);

  const load = useCallback(() => {
    api
      .ompCall<{ providers: Provider[] }>("omp.login.providers")
      .then((result) => setProviders(result.providers ?? []))
      .catch((e) => setError(errorText(e)));
  }, []);
  useEffect(load, [load]);

  // Subscribed for the section's lifetime: omp may emit its login prompt before
  // `omp.login.start` settles, and a subscription keyed on the open dialog drops it.
  useEffect(() =>
    api.onOmpEvent((event) => {
      if (event.method !== "native.login.ui") return;
      const step = event.params;
      // Engine data: only the shapes this dialog renders are accepted.
      if (!step || typeof step !== "object" || !("kind" in step)) return;
      if (step.kind !== "open_url" && step.kind !== "progress" && step.kind !== "input") return;
      setLogin((current) => (current ? { ...current, steps: [...current.steps, step as LoginUi] } : current));
    }), []);

  const start = async (provider: Provider) => {
    setLogin({ provider, steps: [] });
    try {
      await api.ompCall("omp.login.start", { providerId: provider.id });
      showToast(t("settings.ompAccounts.signedIn", { name: provider.name }), { variant: "success" });
      setLogin(null);
      load();
    } catch (e) {
      const message = errorText(e);
      setLogin((current) => (current ? { ...current, steps: [...current.steps, { kind: "progress", message: `✕ ${message}` }] } : current));
    }
  };

  const cancel = async () => {
    await api.ompCall("omp.login.cancel").catch(() => undefined);
    setLogin(null);
  };

  const showAccounts = async (provider: Provider) => {
    try {
      const result = await api.ompCall<{ accounts: Account[] }>("omp.logout.accounts", { providerId: provider.id });
      setAccounts({ provider, list: result.accounts ?? [] });
    } catch (e) {
      showToast(errorText(e), { variant: "error" });
    }
  };

  const logout = async (provider: Provider, account: Account) => {
    try {
      await api.ompCall("omp.logout", { providerId: provider.id, credentialId: account.credentialId });
      showToast(t("settings.ompAccounts.signedOut", { name: account.label || provider.name }), { variant: "success" });
      setAccounts(null);
      load();
    } catch (e) {
      showToast(errorText(e), { variant: "error" });
    }
  };

  return (
    <div data-omp-accounts="true">
      <SettingsCard title={t("settings.ompAccounts.title")} description={t("settings.ompAccounts.description")}>
        {error ? <SettingsRow title={t("settings.ompAccounts.error")}>{error}</SettingsRow> : null}
        {providers === null && !error ? <SettingsRow title={t("common.loading")}>{null}</SettingsRow> : null}
        {providers?.map((provider) => (
          <SettingsRow
            key={provider.id}
            title={provider.name}
            detail={provider.authenticated ? t("settings.ompAccounts.connected") : provider.available ? t("settings.ompAccounts.notConnected") : t("settings.ompAccounts.unavailable")}
          >
            <div className="omp-account-actions" data-omp-provider={provider.id}>
              {provider.authenticated ? (
                <Button type="button" variant="secondary" onClick={() => void showAccounts(provider)}>
                  {t("settings.ompAccounts.signOut")}
                </Button>
              ) : null}
              <Button type="button" variant="secondary" disabled={!provider.available || login !== null} onClick={() => void start(provider)}>
                {provider.authenticated ? t("settings.ompAccounts.addAccount") : t("settings.ompAccounts.signIn")}
              </Button>
            </div>
          </SettingsRow>
        ))}
      </SettingsCard>
      {login ? <LoginDialog provider={login.provider} steps={login.steps} onCancel={() => void cancel()} /> : null}
      {accounts ? (
        <OmpDialog title={t("settings.ompAccounts.accountsTitle", { name: accounts.provider.name })} icon={<IconKey size={15} />} onClose={() => setAccounts(null)}>
          {accounts.list.length === 0 ? <p className="omp-muted">{t("settings.ompAccounts.noAccounts")}</p> : null}
          {accounts.list.map((account) => (
            <div key={account.credentialId} className="omp-account-row">
              <span>
                <strong>{account.label}</strong> <span className="omp-muted">{account.detail} · {account.type}</span>
              </span>
              <Button type="button" variant="secondary" onClick={() => void logout(accounts.provider, account)}>
                {t("settings.ompAccounts.signOut")}
              </Button>
            </div>
          ))}
        </OmpDialog>
      ) : null}
    </div>
  );
}

function LoginDialog({ provider, steps, onCancel }: { provider: Provider; steps: LoginUi[]; onCancel: () => void }) {
  const { t } = useTranslation();
  const showToast = useAppStore((s) => s.showToast);
  const [answer, setAnswer] = useState("");
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const link = [...steps].reverse().find((step): step is Extract<LoginUi, { kind: "open_url" }> => step.kind === "open_url");
  const input = [...steps].reverse().find(
    (step): step is Extract<LoginUi, { kind: "input" }> => step.kind === "input" && !answered.has(step.requestId),
  );
  const progress = steps.filter((step): step is Extract<LoginUi, { kind: "progress" }> => step.kind === "progress");
  return (
    <OmpDialog
      title={t("settings.ompAccounts.loginTitle", { name: provider.name })}
      icon={<IconKey size={15} />}
      className="omp-login-dialog"
      onClose={onCancel}
      footer={<Button type="button" variant="secondary" onClick={onCancel}>{t("common.cancel")}</Button>}
    >
      {!link && !input ? <p className="omp-muted">{t("settings.ompAccounts.starting")}</p> : null}
      {link ? (
        <div className="omp-login-step" data-omp-login-url="true">
          <p>{link.instructions || t("settings.ompAccounts.openBrowser")}</p>
          <code className="omp-login-link" title={link.url}>{link.url}</code>
          <div className="omp-login-row">
            <Button type="button" variant="primary" onClick={() => window.open(link.url, "_blank", "noopener")}>
              {t("settings.ompAccounts.openLink")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => void navigator.clipboard?.writeText(link.url)}>
              {t("chat.copy")}
            </Button>
          </div>
        </div>
      ) : null}
      {input ? (
        <form
          className="omp-login-step"
          onSubmit={async (event) => {
            event.preventDefault();
            const value = answer.trim();
            // One submit at a time; a failed delivery keeps the code editable.
            if (!value || sending) return;
            setSending(true);
            try {
              await api.ompCall("omp.login.respond", { requestId: input.requestId, value });
              setAnswered((current) => new Set(current).add(input.requestId));
              setAnswer("");
              setFailure(null);
            } catch (reason) {
              setFailure(errorText(reason));
              showToast(errorText(reason), { variant: "error" });
            } finally {
              setSending(false);
            }
          }}
        >
          <p>{input.title || t("settings.ompAccounts.pasteCode")}</p>
          <div className="omp-login-row">
            <input className="settings-input omp-login-input" value={answer} placeholder={input.placeholder ?? ""} onChange={(e) => setAnswer(e.target.value)} />
            <Button type="submit" variant="primary" disabled={!answer.trim() || sending}>{t("settings.ompAccounts.submit")}</Button>
          </div>
          {failure ? <div className="omp-error" role="alert">{failure}</div> : null}
        </form>
      ) : null}
      {progress.length ? (
        <ul className="omp-login-progress">
          {progress.slice(-4).map((step, index) => <li key={index}>{step.message}</li>)}
        </ul>
      ) : null}
    </OmpDialog>
  );
}
