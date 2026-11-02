import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { LoaderCircle, LockKeyhole } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api";
import { appPath } from "../basePath";
import { errorMessage } from "../errors";
import { resourceFileKind } from "../../shared/fileTypes";
import type { SharedProjectData } from "../../shared/projectViewLinks";
import { SharedWorkspace, SharedWorkspaceTopbar } from "../shared/SharedWorkspace";
import { createSourceCursorStore } from "../workspace/sourceCursorStore";
import "../shared/sharedProject.css";

const ReadOnlySource = lazy(() => import("../shared/ReadOnlySource").then((module) => ({ default: module.ReadOnlySource })));
const PdfPreview = lazy(() => import("../PdfPreview").then((module) => ({ default: module.PdfPreview })));
const noopViewport = () => undefined;

export function SharedProjectPage({ linkId }: { linkId: string }) {
  const { t } = useTranslation();
  const [data, setData] = useState<SharedProjectData | null>(null);
  const [path, setPath] = useState("");
  const [content, setContent] = useState<{ path: string; content: string } | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [error, setError] = useState("");
  const [fileError, setFileError] = useState("");
  const [loading, setLoading] = useState(true);
  const [fileLoading, setFileLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [sourceJump, setSourceJump] = useState<{ path: string; line: number; nonce: number } | null>(null);
  const jumpSequence = useRef(0);
  const sourceCursorStore = useMemo(() => createSourceCursorStore(), []);
  useEffect(() => () => sourceCursorStore.dispose(), [sourceCursorStore]);
  const generation = useRef(0);
  const lastFragment = useRef(window.location.hash);
  const endpoint = `/api/shared/${linkId}`;
  const failGrant = () => { generation.current++; setInvalid(true); setData(null); setContent(null); };
  const invalidGrant = (reason: unknown) => reason instanceof ApiError && reason.code === "VIEW_LINK_INVALID";

  useEffect(() => {
    // A rotated link keeps its id but changes the fragment. Browsers can open
    // it as a same-document navigation, without remounting the React page.
    const newSecret = () => {
      const fragment = window.location.hash;
      if (!fragment || fragment === lastFragment.current) return;
      lastFragment.current = fragment;
      generation.current++;
      setData(null); setContent(null); setPath(""); setInvalid(false); setError(""); setFileError("");
      setRefresh((value) => value + 1);
    };
    window.addEventListener("hashchange", newSecret);
    return () => window.removeEventListener("hashchange", newSecret);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++generation.current;
    let checking = false;
    const check = async (initial: boolean) => {
      if (checking || controller.signal.aborted || generation.current !== version) return;
      checking = true;
      try {
        if (initial) {
          const token = window.location.hash.slice(1);
          if (token) {
            await api(`${endpoint}/access`, { method: "POST", body: JSON.stringify({ token }), signal: controller.signal, suppressSessionExpired: true });
            if (controller.signal.aborted) return;
            window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
            lastFragment.current = "";
          }
        } else {
          await api(`${endpoint}/access`, { signal: controller.signal, suppressSessionExpired: true });
          return;
        }
        const result = await api<SharedProjectData>(endpoint, { signal: controller.signal, suppressSessionExpired: true });
        if (controller.signal.aborted || generation.current !== version) return;
        setInvalid(false); setError(""); setData(result);
        setPath((previous) => result.files.some((file) => file.type === "file" && file.path === previous) ? previous
          : result.files.some((file) => file.type === "file" && file.path === result.project.mainFile) ? result.project.mainFile
          : result.files.find((file) => file.type === "file")?.path ?? "");
      } catch (reason) {
        if (controller.signal.aborted || generation.current !== version) return;
        if (invalidGrant(reason)) failGrant(); else setError(errorMessage(reason));
      } finally { checking = false; if (!controller.signal.aborted && generation.current === version) setLoading(false); }
    };
    setLoading(true);
    void check(true);
    // Recheck revocation without a collaboration/presence connection. Hidden
    // pages stop polling; returning to the tab immediately revalidates access.
    const interval = window.setInterval(() => { if (document.visibilityState !== "hidden") void check(false); }, 30_000);
    const visible = () => { if (document.visibilityState !== "hidden") void check(false); };
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); window.clearInterval(interval); document.removeEventListener("visibilitychange", visible); };
  }, [endpoint, refresh]);

  useEffect(() => {
    if (!data?.expiresAt) return;
    const remaining = Date.parse(data.expiresAt) - Date.now();
    if (remaining <= 0) { failGrant(); return; }
    // setTimeout overflows beyond ~24 days; checks also cover long-lived links.
    const timer = window.setTimeout(() => { if (Date.parse(data.expiresAt!) <= Date.now()) failGrant(); }, Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [data?.expiresAt]);

  useEffect(() => {
    if (!data || invalid || !path) return;
    const kind = resourceFileKind(path);
    if (kind !== "text" && kind !== "other") { setContent(null); setFileError(""); setFileLoading(false); return; }
    const controller = new AbortController();
    const version = generation.current;
    setContent(null); setFileError(""); setFileLoading(true);
    void api<{ path: string; content: string }>(`${endpoint}/file?path=${encodeURIComponent(path)}`, { signal: controller.signal, suppressSessionExpired: true })
      .then((result) => { if (!controller.signal.aborted && generation.current === version) setContent(result); })
      .catch((reason) => { if (!controller.signal.aborted && generation.current === version) { if (invalidGrant(reason)) failGrant(); else setFileError(errorMessage(reason)); } })
      .finally(() => { if (!controller.signal.aborted && generation.current === version) setFileLoading(false); });
    return () => controller.abort();
  }, [endpoint, path, invalid, Boolean(data), refresh]);

  useEffect(() => {
    const previous = document.title;
    document.title = data ? `TexLite | ${data.project.name}` : "TexLite";
    return () => { document.title = previous; };
  }, [data?.project.name]);

  const resource = appPath(`${endpoint}/resource?path=${encodeURIComponent(path)}`);
  const kind = resourceFileKind(path);
  const waiting = <div className="shared-reader-empty" role="status"><LoaderCircle size={24} className="spin" />{t("common.loading")}</div>;
  const refreshView = () => setRefresh((value) => value + 1);
  return <div className="workspace shared-reader" data-texlite-tooltips="off">
    {invalid || !data ? <>
      <SharedWorkspaceTopbar loading={loading || invalid} onRefresh={refreshView} />
      {invalid ? <div className="shared-reader-empty shared-reader-unavailable" role="alert"><LockKeyhole size={32} /><h1>{t("viewLinks.unavailable")}</h1><p>{t("viewLinks.unavailableHint")}</p></div>
        : loading ? waiting : <div className="shared-reader-empty" role="alert">{error}</div>}
    </> : <SharedWorkspace data={data} path={path} loading={loading} error={error} onRefresh={refreshView} sourceCursorStore={sourceCursorStore}
      onOpenFile={(next) => { sourceCursorStore.reset(); setSourceJump(null); setPath(next); }}
      onJumpToSource={(next, line) => { sourceCursorStore.reset(); setPath(next); setSourceJump({ path: next, line, nonce: ++jumpSequence.current }); }}>
      {!path ? <div className="shared-reader-empty">{t("viewLinks.noFile")}</div> : fileLoading ? waiting : fileError ? <div className="shared-reader-empty" role="alert">{fileError}</div>
        : kind === "image" ? <div className="shared-reader-image"><img src={resource} alt={path} /></div>
        : kind === "pdf" ? <Suspense fallback={waiting}><PdfPreview key={resource} url={resource} loadingMode="range" target={null} onViewportLocation={noopViewport} /></Suspense>
        : kind === "binary" ? <div className="shared-reader-empty">{t("viewLinks.unsupported")}</div>
        : content?.path === path && <Suspense fallback={waiting}><ReadOnlySource path={path} content={content.content} onCursor={sourceCursorStore.update} jumpTo={sourceJump?.path === path ? sourceJump : null} /></Suspense>}
    </SharedWorkspace>}
  </div>;
}
