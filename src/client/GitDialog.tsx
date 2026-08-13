import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ChevronDown, ChevronRight, CloudUpload, ExternalLink, Eye, GitBranch, GitCommitHorizontal, Github, KeyRound,
  LoaderCircle, Maximize2, Minimize2, Minus, Plus, RefreshCcw, RotateCcw, Trash2, Undo2
} from "lucide-react";
import { api } from "./api";
import { Modal } from "./Dialog";
import type { GitCommit, Project, ProjectGitStatus } from "./types";

interface GitDiffResult {
  title: string;
  diff: string;
  truncated: boolean;
}

export function GitDialog({ open, project, onOpenChange, onBeforeMutation }: {
  open: boolean;
  project: Project;
  onOpenChange: (open: boolean) => void;
  onBeforeMutation: () => Promise<boolean>;
}) {
  const { t, i18n } = useTranslation();
  const [status, setStatus] = useState<ProjectGitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [token, setToken] = useState("");
  const [repositoryName, setRepositoryName] = useState(() => suggestedRepositoryName(project.name));
  const [isPrivate, setIsPrivate] = useState(true);
  const [commitMessage, setCommitMessage] = useState("");
  const [diff, setDiff] = useState<GitDiffResult | null>(null);
  const [checkoutTarget, setCheckoutTarget] = useState<GitCommit | "branch" | null>(null);
  const [forceCheckout, setForceCheckout] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [authenticationExpanded, setAuthenticationExpanded] = useState(true);
  const [repositoryExpanded, setRepositoryExpanded] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [diffFullscreen, setDiffFullscreen] = useState(false);
  const [diffFontSize, setDiffFontSize] = useState(10);
  const diffSectionRef = useRef<HTMLElement>(null);

  const load = async (resetSections = false) => {
    const result = await api<{ status: ProjectGitStatus }>(`/api/projects/${project.id}/git`);
    setStatus(result.status);
    if (resetSections) {
      setAuthenticationExpanded(!result.status.tokenConfigured);
      setRepositoryExpanded(!result.status.remoteUrl);
    }
    if (result.status.initialized && result.status.latestCommit) {
      const history = await api<{ commits: GitCommit[] }>(`/api/projects/${project.id}/git/history`);
      setCommits(history.commits);
    } else setCommits([]);
  };

  useEffect(() => {
    if (!open) {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      setDiffFullscreen(false);
      setToken("");
      return;
    }
    setError(""); setNotice(""); setDiff(null);
    setDiffFullscreen(false);
    setRepositoryName(suggestedRepositoryName(project.name));
    setBusy("load");
    void onBeforeMutation().then(() => load(true)).catch((reason) => setError(reason instanceof Error ? reason.message : t("errors.generic"))).finally(() => setBusy(""));
  }, [open, project.id]);

  useEffect(() => {
    const onFullscreenChange = () => setDiffFullscreen(document.fullscreenElement === diffSectionRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!diffFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement) setDiffFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diffFullscreen]);

  const run = async (key: string, operation: () => Promise<void>, message?: string, failureMessage?: string) => {
    setBusy(key); setError(""); setNotice("");
    try {
      await operation();
      if (message) setNotice(message);
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : t("errors.generic");
      setError(failureMessage ? `${failureMessage}: ${detail}` : detail);
    } finally { setBusy(""); }
  };

  const saveToken = () => run("token", async () => {
    const result = await api<{ status: ProjectGitStatus }>(`/api/projects/${project.id}/git/token`, {
      method: "PUT", body: JSON.stringify({ token })
    });
    setStatus(result.status); setToken(""); setAuthenticationExpanded(false);
  }, t("git.tokenSaved"));

  const removeToken = () => run("remove-token", async () => {
    const result = await api<{ status: ProjectGitStatus }>(`/api/projects/${project.id}/git/token`, { method: "DELETE" });
    setStatus(result.status); setToken("");
  }, t("git.tokenRemoved"));

  const createRepository = () => run("repository", async () => {
    const result = await api<{ status: ProjectGitStatus }>(`/api/projects/${project.id}/git/repository`, {
      method: "POST", body: JSON.stringify({ name: repositoryName, private: isPrivate })
    });
    setStatus(result.status); setRepositoryExpanded(false);
  }, t("git.repositoryCreated"));

  const commit = () => run("commit", async () => {
    if (!(await onBeforeMutation())) throw new Error(t("errors.collaborationUnavailable"));
    const result = await api<{ status: ProjectGitStatus }>(`/api/projects/${project.id}/git/commit`, {
      method: "POST", body: JSON.stringify({ message: commitMessage })
    });
    setStatus(result.status); setCommitMessage(""); setDiff(null); await load();
  }, t("git.committed"));

  const push = () => run("push", async () => {
    if (!(await onBeforeMutation())) throw new Error(t("errors.collaborationUnavailable"));
    const result = await api<{ status: ProjectGitStatus }>(`/api/projects/${project.id}/git/push`, { method: "POST" });
    setStatus(result.status); await load();
  }, t("git.pushed"), t("git.pushFailed"));

  const showDiff = (revision?: string) => run("diff", async () => {
    if (!(await onBeforeMutation())) throw new Error(t("errors.collaborationUnavailable"));
    const query = revision ? `?revision=${encodeURIComponent(revision)}` : "";
    setDiff(await api<GitDiffResult>(`/api/projects/${project.id}/git/diff${query}`));
  });

  const toggleDiffFullscreen = async () => {
    if (diffFullscreen) {
      if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
      setDiffFullscreen(false);
      return;
    }
    const section = diffSectionRef.current;
    if (section?.requestFullscreen) {
      try { await section.requestFullscreen(); } catch { /* Fall back to the CSS fullscreen layout. */ }
    }
    setDiffFullscreen(true);
  };

  const checkout = () => {
    const target = checkoutTarget;
    if (!target) return;
    setCheckoutTarget(null);
    void run("checkout", async () => {
      if (!(await onBeforeMutation())) throw new Error(t("errors.collaborationUnavailable"));
      await api(`/api/projects/${project.id}/git/checkout`, {
        method: "POST", body: JSON.stringify({ revision: target === "branch" ? null : target.sha, force: forceCheckout })
      });
      window.location.reload();
    });
  };

  const discardChanges = () => {
    setDiscardOpen(false);
    void run("discard", async () => {
      if (!(await onBeforeMutation())) throw new Error(t("errors.collaborationUnavailable"));
      await api(`/api/projects/${project.id}/git/discard`, { method: "POST" });
      window.location.reload();
    });
  };

  const loading = busy === "load" && !status;
  return <><Modal open={open} extraWide className={diffFullscreen ? "git-dialog-modal-fullscreen" : undefined} title={t("git.title")} description={t("git.description")} onOpenChange={onOpenChange}
    footer={<button onClick={() => onOpenChange(false)}>{t("common.close")}</button>}>
    <div className="git-dialog">
      {loading && <div className="git-loading"><LoaderCircle className="spin" size={22} />{t("common.loading")}</div>}
      {error && <p className="git-message error">{error}</p>}
      {notice && <p className="git-message success"><GitBranch size={14} />{notice}</p>}
      {status && <>
        <section className="git-section">
          <button className="git-section-toggle" type="button" aria-expanded={authenticationExpanded} onClick={() => setAuthenticationExpanded((current) => !current)}><span className="git-section-heading"><KeyRound size={16} /><span><strong>{t("git.authentication")}</strong><small>{status.tokenConfigured ? t("git.connectedAs", { login: status.githubLogin }) : t("git.authenticationHint")}</small></span></span>{authenticationExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
          {authenticationExpanded && <div className="git-section-content">
            <div className="git-token-guidance"><strong>{t("git.recommendedAccessTitle")}</strong><span>{t("git.recommendedAccess")}</span></div>
            {status.tokenConfigured && <div className="git-account"><Github size={17} /><span>{t("git.connectedAs", { login: status.githubLogin })}</span><button className="danger-text" disabled={Boolean(busy)} onClick={removeToken}><Trash2 size={14} />{t("git.removeToken")}</button></div>}
            <label className="form-field">{status.tokenConfigured ? t("git.replaceToken") : t("git.token")}
              <input type="password" autoComplete="new-password" spellCheck={false} autoCapitalize="none" autoCorrect="off"
                value={token} placeholder={t("git.tokenPlaceholder")} onChange={(event) => setToken(event.target.value)} />
            </label>
            <div className="git-inline-actions"><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">{t("git.createToken")}<ExternalLink size={12} /></a><button disabled={Boolean(busy) || token.trim().length < 20} onClick={saveToken}>{busy === "token" && <LoaderCircle className="spin" size={13} />}{t("git.saveToken")}</button></div>
          </div>}
        </section>

        <section className="git-section">
          <button className="git-section-toggle" type="button" aria-expanded={repositoryExpanded} onClick={() => setRepositoryExpanded((current) => !current)}><span className="git-section-heading"><Github size={16} /><span><strong>{t("git.repository")}</strong><small>{status.remoteUrl ? status.repositoryName ?? status.remoteUrl : status.initialized ? t("git.localReady") : t("git.localPending")}</small></span></span>{repositoryExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</button>
          {repositoryExpanded && <div className="git-section-content">{status.remoteUrl ? <div className="git-repository-card"><div><strong>{status.repositoryName ?? t("git.origin")}</strong><small>{status.branch ?? t("git.detachedAt", { revision: status.latestCommit?.shortSha ?? "HEAD" })} · {status.dirty ? t("git.changedFiles", { count: status.changedFiles }) : t("git.clean")}</small></div>{status.repositoryHtmlUrl && <a href={status.repositoryHtmlUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />{t("git.openGitHub")}</a>}</div> : <>
              <label className="form-field">{t("git.repositoryName")}<input value={repositoryName} onChange={(event) => setRepositoryName(event.target.value)} /></label>
              <label className="checkbox-field"><input type="checkbox" checked={isPrivate} onChange={(event) => setIsPrivate(event.target.checked)} />{t("git.privateRepository")}</label>
              <button className="git-primary-action" disabled={Boolean(busy) || !status.tokenConfigured || !repositoryName.trim()} onClick={createRepository}>{busy === "repository" ? <LoaderCircle className="spin" size={14} /> : <Github size={14} />}{t("git.createRepository")}</button>
            </>}</div>}
        </section>

        {status.initialized && <section className="git-section">
          <div className="git-section-heading"><GitCommitHorizontal size={16} /><div><strong>{t("git.commitAndPush")}</strong><small>{status.branch ? t("git.identity", { username: project.ownerUsername }) : t("git.detachedHead")}</small></div></div>
          <label className="form-field">{t("git.commitMessage")}<textarea rows={3} value={commitMessage} placeholder={t("git.commitPlaceholder")} onChange={(event) => setCommitMessage(event.target.value)} /></label>
          <div className="git-action-row"><button title={!status.dirty ? t("git.noChangesToCommit") : undefined} disabled={Boolean(busy) || !status.branch || !status.dirty || !commitMessage.trim()} onClick={commit}>{busy === "commit" ? <LoaderCircle className="spin" size={14} /> : <GitCommitHorizontal size={14} />}{t("git.commit")}</button><button disabled={Boolean(busy) || !status.branch || !status.tokenConfigured || !status.remoteUrl || !status.latestCommit} onClick={push}>{busy === "push" ? <LoaderCircle className="spin" size={14} /> : <CloudUpload size={14} />}{t("git.push")}{status.ahead > 0 && <span className="git-count">{status.ahead}</span>}</button><button disabled={Boolean(busy) || !status.latestCommit} onClick={() => void showDiff()}>{busy === "diff" ? <LoaderCircle className="spin" size={14} /> : <Eye size={14} />}{t("git.workingDiff")}</button><button className="git-discard-button" title={!status.restorable ? t("git.noChangesToDiscard") : t("git.discardChanges")} disabled={Boolean(busy) || !status.latestCommit || !status.restorable} onClick={() => setDiscardOpen(true)}><RotateCcw size={14} />{t("git.discardChanges")}</button>{!status.branch && <button disabled={Boolean(busy)} onClick={() => { setForceCheckout(false); setCheckoutTarget("branch"); }}><GitBranch size={14} />{t("git.returnToBranch", { branch: status.defaultBranch })}</button>}<button disabled={Boolean(busy)} onClick={() => void run("refresh", load)}><RefreshCcw className={busy === "refresh" ? "spin" : ""} size={14} />{t("git.refresh")}</button></div>
        </section>}

        {diff && <section ref={diffSectionRef} className={`git-section git-diff-section${diffFullscreen ? " is-fullscreen" : ""}`}><div className="git-diff-heading"><div className="git-section-heading"><Eye size={16} /><div><strong>{t("git.diffTitle")}</strong><small>{diff.title}{diff.truncated ? ` · ${t("git.diffTruncated")}` : ""}</small></div></div><div className="git-diff-controls"><div className="git-diff-font-controls" role="group" aria-label={t("git.diffFontSize")}><button type="button" className="git-diff-font-button" disabled={diffFontSize <= 8} title={t("git.diffFontDecrease")} aria-label={t("git.diffFontDecrease")} onClick={() => setDiffFontSize((current) => Math.max(8, current - 1))}><Minus size={14} /></button><span className="git-diff-font-value" aria-live="polite">{diffFontSize}px</span><button type="button" className="git-diff-font-button" disabled={diffFontSize >= 24} title={t("git.diffFontIncrease")} aria-label={t("git.diffFontIncrease")} onClick={() => setDiffFontSize((current) => Math.min(24, current + 1))}><Plus size={14} /></button></div><button type="button" className="git-diff-fullscreen" title={diffFullscreen ? t("git.exitFullscreenDiff") : t("git.fullscreenDiff")} aria-label={diffFullscreen ? t("git.exitFullscreenDiff") : t("git.fullscreenDiff")} onClick={() => void toggleDiffFullscreen()}>{diffFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button></div></div><GitDiffView content={diff.diff} empty={t("git.noChanges")} fontSize={diffFontSize} /></section>}

        {status.initialized && <section className="git-section">
          <div className="git-section-heading"><GitBranch size={16} /><div><strong>{t("git.history")}</strong><small>{t("git.historyHint")}</small></div></div>
          <div className="git-history">{commits.map((commitItem) => <article key={commitItem.sha}><code>{commitItem.shortSha}</code><div><strong>{commitItem.message}</strong><small>{commitItem.authorName} · {new Date(commitItem.authoredAt).toLocaleString(i18n.resolvedLanguage)}</small></div><span><button title={t("git.viewCommitDiff")} disabled={Boolean(busy)} onClick={() => void showDiff(commitItem.sha)}><Eye size={14} /></button><button title={t("git.checkoutVersion")} disabled={Boolean(busy)} onClick={() => { setForceCheckout(false); setCheckoutTarget(commitItem); }}><Undo2 size={14} /></button></span></article>)}{commits.length === 0 && <p className="muted">{t("git.noCommits")}</p>}</div>
        </section>}
      </>}
    </div>
  </Modal><Modal open={Boolean(checkoutTarget)} title={checkoutTarget === "branch" ? t("git.returnTitle") : t("git.checkoutTitle")}
    description={checkoutTarget === "branch" ? t("git.returnDescription", { branch: status?.defaultBranch ?? "main" }) : t("git.checkoutDescription", { revision: checkoutTarget?.shortSha ?? "", message: checkoutTarget?.message ?? "" })}
    onOpenChange={(next) => { if (!next) setCheckoutTarget(null); }} footer={<><button onClick={() => setCheckoutTarget(null)}>{t("common.cancel")}</button><button className={forceCheckout ? "danger" : "primary"} onClick={checkout}>{t("git.checkout")}</button></>}>
    <label className="git-force-checkout"><input type="checkbox" checked={forceCheckout} onChange={(event) => setForceCheckout(event.target.checked)} /><span><strong>{t("git.forceCheckout")}</strong><small>{t("git.forceCheckoutDescription")}</small></span></label>
  </Modal><Modal open={discardOpen} title={t("git.discardTitle")} description={t("git.discardDescription")}
    onOpenChange={setDiscardOpen} footer={<><button onClick={() => setDiscardOpen(false)}>{t("common.cancel")}</button><button className="danger" onClick={discardChanges}>{t("git.discardConfirm")}</button></>}><></></Modal>
  </>;
}

function GitDiffView({ content, empty, fontSize }: { content: string; empty: string; fontSize: number }) {
  if (!content.trim()) return <div className="git-diff-empty">{empty}</div>;
  return <pre className="git-diff" style={{ fontSize: `${fontSize}px` }}>{content.split("\n").map((line, index) => {
    const tone = line.startsWith("+") && !line.startsWith("+++") ? "addition"
      : line.startsWith("-") && !line.startsWith("---") ? "deletion"
        : line.startsWith("@@") ? "hunk" : line.startsWith("diff ") ? "header" : "";
    return <span className={tone} key={index}>{line}{"\n"}</span>;
  })}</pre>;
}

function suggestedRepositoryName(name: string): string {
  return name.trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-").replace(/^[.-]+|[.-]+$/g, "").slice(0, 100) || "texlite-project";
}
