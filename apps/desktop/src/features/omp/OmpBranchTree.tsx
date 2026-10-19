import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useAppStore } from "../../stores/app-store";
import { IconBranch } from "../../components/icons";
import { TooltipButton, cx } from "../../components/ui";
import { OmpDialog, errorText } from "./OmpDialog";
import "./omp.css";

export type OmpTreeNode = {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "system";
  preview: string;
  timestamp?: string;
  onPath: boolean;
  children: OmpTreeNode[];
};

/** Collapse each straight run of the tree into one list; split only where it forks. */
function chainOf(node: OmpTreeNode): { rows: OmpTreeNode[]; forks: OmpTreeNode[] } {
  const rows: OmpTreeNode[] = [node];
  let at = node;
  while (at.children.length === 1) {
    at = at.children[0]!;
    rows.push(at);
  }
  return { rows, forks: at.children };
}

function countBranches(nodes: OmpTreeNode[]): number {
  let leaves = 0;
  const walk = (node: OmpTreeNode) => {
    if (node.children.length === 0) leaves += 1;
    node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return leaves;
}

/** Topbar button + dialog with an omp chat's branch tree (`get_tree`). */
export function OmpBranchTreeButton() {
  const { t } = useTranslation();
  const sessionId = useAppStore((state) => state.activeSessionId);
  const hasMessages = useAppStore((state) => state.messages.length > 0);
  const [open, setOpen] = useState(false);
  if (!sessionId?.startsWith("native-pi:") || !hasMessages) return null;
  return (
    <>
      <TooltipButton
        type="button"
        className="ct-icon-btn omp-tree-btn"
        tooltip={t("chat.ompTree.open")}
        ariaLabel={t("chat.ompTree.open")}
        onClick={() => setOpen(true)}
      >
        <IconBranch size={15} />
      </TooltipButton>
      {open ? <OmpBranchTreeDialog sessionId={sessionId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function OmpBranchTreeDialog({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const forkSessionAt = useAppStore((state) => state.forkSessionAt);
  const showToast = useAppStore((state) => state.showToast);
  // Scoped to the session the request belongs to: a switch must not fork the old chat's nodes.
  const [nodes, setNodes] = useState<{ sessionId: string; value: OmpTreeNode[] } | null>(null);
  const [error, setError] = useState<{ sessionId: string; message: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    api
      .ompCall<{ nodes: OmpTreeNode[]; leafId: string | null }>("omp.tree", { sessionId })
      .then((result) => {
        if (live) setNodes({ sessionId, value: result.nodes ?? [] });
      })
      .catch((reason) => {
        if (live) setError({ sessionId, message: errorText(reason) });
      });
    return () => {
      live = false;
    };
  }, [sessionId]);

  const fork = async (node: OmpTreeNode) => {
    setBusy(node.id);
    try {
      await forkSessionAt(sessionId, node.id);
      onClose();
    } catch (reason) {
      showToast(errorText(reason), { variant: "error" });
    } finally {
      setBusy(null);
    }
  };

  const renderChain = (start: OmpTreeNode, depth: number): ReactNode => {
    const { rows, forks } = chainOf(start);
    return (
      <div className={cx("omp-tree-chain", depth > 0 && "is-branch")} key={start.id}>
        {rows.map((node) => (
          <div key={node.id} className={cx("omp-tree-node", `is-${node.role}`, node.onPath && "is-on-path")}>
            <span className="omp-tree-role">{t(`chat.ompTree.role.${node.role}`)}</span>
            <span className="omp-tree-preview" title={node.preview}>{node.preview || "…"}</span>
            <button
              type="button"
              className="omp-mini-btn"
              disabled={busy !== null}
              onClick={() => void fork(node)}
              title={t("chat.ompTree.forkHint")}
            >
              {busy === node.id ? "…" : t("chat.ompTree.fork")}
            </button>
          </div>
        ))}
        {forks.length > 0 ? (
          <div className="omp-tree-forks">{forks.map((child) => renderChain(child, depth + 1))}</div>
        ) : null}
      </div>
    );
  };

  const shown = nodes?.sessionId === sessionId ? nodes.value : null;
  const failure = error?.sessionId === sessionId ? error.message : null;
  const branches = shown ? countBranches(shown) : 0;
  return (
    <OmpDialog title={t("chat.ompTree.title")} icon={<IconBranch size={15} />} className="omp-tree-dialog" onClose={onClose}>
      <p className="omp-muted">{t("chat.ompTree.hint", { count: branches })}</p>
      {failure ? <div className="omp-error">{failure}</div> : null}
      {shown === null && !failure ? <div className="omp-muted">{t("common.loading")}</div> : null}
      <div className="omp-tree">{shown?.map((node) => renderChain(node, 0))}</div>
    </OmpDialog>
  );
}
