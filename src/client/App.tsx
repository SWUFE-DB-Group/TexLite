import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import type { Project, ProjectListPagination, ProjectTag, SiteConfig, User } from "./types";
import {
  isProjectHistoryState, projectIdFromPath, projectIdFromReturn, projectLoginPath, projectPath,
  type TexLiteHistoryState
} from "./routes";
import { loadPdfPreview, preloadWorkspace, type WorkspacePreload } from "./workspacePreload";
import { ChangePassword, Login } from "./pages/AuthPages";
import { Dashboard } from "./pages/Dashboard";
import { ProjectWorkspace } from "./pages/ProjectWorkspace";

export function App() {
  const { t } = useTranslation();
  const [site, setSite] = useState<SiteConfig>({ siteName: "TexLite", adminEmail: "" });
  const [user, setUser] = useState<User | null | undefined>();
  const [projectId, setProjectId] = useState<string | null>(() => typeof window === "undefined" ? null : projectIdFromPath(window.location.pathname));
  const [workspacePreload, setWorkspacePreload] = useState<WorkspacePreload | null>(() => {
    if (typeof window === "undefined") return null;
    const initialProjectId = projectIdFromPath(window.location.pathname);
    return initialProjectId ? preloadWorkspace(initialProjectId) : null;
  });
  const [dashboardCache, setDashboardCache] = useState<{ userId: string; projects: Project[]; tags: ProjectTag[]; pagination: ProjectListPagination } | null>(null);
  const routeCurrentProjectToLogin = () => {
    const returnProjectId = projectIdFromPath(window.location.pathname);
    if (!returnProjectId) return;
    const state: TexLiteHistoryState = { texliteRoute: "dashboard" };
    window.history.replaceState(state, "", projectLoginPath(returnProjectId));
    setProjectId(null);
    setWorkspacePreload(null);
  };
  const completeAuthentication = (authenticatedUser: User) => {
    const returnProjectId = projectIdFromReturn(window.location.search);
    if (returnProjectId) {
      const state: TexLiteHistoryState = { texliteRoute: "project", projectId: returnProjectId, fromDashboard: false };
      window.history.replaceState(state, "", projectPath(returnProjectId));
      setWorkspacePreload(preloadWorkspace(returnProjectId, { force: true }));
      setProjectId(returnProjectId);
    } else if (new URLSearchParams(window.location.search).has("return")) {
      const state: TexLiteHistoryState = { texliteRoute: "dashboard" };
      window.history.replaceState(state, "", "/");
    }
    setUser(authenticatedUser);
  };

  useEffect(() => {
    const initialProjectId = projectIdFromPath(window.location.pathname);
    if (initialProjectId && window.location.pathname !== projectPath(initialProjectId)) {
      const state: TexLiteHistoryState = { texliteRoute: "project", projectId: initialProjectId, fromDashboard: false };
      window.history.replaceState(state, "", projectPath(initialProjectId));
    }
    const handlePopState = () => {
      const nextProjectId = projectIdFromPath(window.location.pathname);
      setProjectId(nextProjectId);
      setWorkspacePreload(nextProjectId ? preloadWorkspace(nextProjectId) : null);
    };
    const handleSessionExpired = () => {
      setDashboardCache(null);
      setUser(null);
      routeCurrentProjectToLogin();
    };
    window.addEventListener("popstate", handlePopState);
    window.addEventListener("texlite:session-expired", handleSessionExpired);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("texlite:session-expired", handleSessionExpired);
    };
  }, []);

  const openProject = (id: string) => {
    const nextPath = projectPath(id);
    if (window.location.pathname !== nextPath) {
      const state: TexLiteHistoryState = { texliteRoute: "project", projectId: id, fromDashboard: true };
      window.history.pushState(state, "", nextPath);
    }
    setWorkspacePreload(preloadWorkspace(id));
    setProjectId(id);
  };
  const leaveProject = () => {
    const state = window.history.state;
    if (isProjectHistoryState(state) && state.fromDashboard) {
      window.history.back();
      return;
    }
    const dashboardState: TexLiteHistoryState = { texliteRoute: "dashboard" };
    window.history.replaceState(dashboardState, "", "/");
    setProjectId(null);
    setWorkspacePreload(null);
  };

  useEffect(() => {
    void api<SiteConfig>("/api/config").then((config) => {
      setSite(config);
      document.title = config.siteName;
    });
    void api<{ user: User }>("/api/me", { suppressSessionExpired: true }).then(({ user }) => completeAuthentication(user)).catch(() => {
      routeCurrentProjectToLogin();
      setUser(null);
    });
  }, []);

  useEffect(() => {
    // PDF preview is a core authenticated feature. Warm only the PDF.js
    // module and worker while the dashboard is idle; no project PDF is
    // fetched until the user actually opens a project.
    if (!user || user.mustChangePassword || projectId) return;
    let cancelled = false;
    let timer: number | null = null;
    let idleHandle: number | null = null;
    const warm = () => {
      if (cancelled) return;
      void loadPdfPreview()
        .then((module) => module.preloadPdfRuntime())
        .catch(() => undefined);
    };
    const idleWindow = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback) idleHandle = idleWindow.requestIdleCallback(warm, { timeout: 1_200 });
    else timer = window.setTimeout(warm, 400);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      if (idleHandle !== null) idleWindow.cancelIdleCallback?.(idleHandle);
    };
  }, [user?.id, user?.mustChangePassword, projectId]);

  if (user === undefined) return <div className="center-card">{t("common.loading")}</div>;
  if (!user) return <Login site={site} onLogin={completeAuthentication} />;
  if (user.mustChangePassword) return <ChangePassword site={site} user={user} onChanged={(updated) => setUser(updated)} />;
  if (projectId) {
    return <ProjectWorkspace key={projectId} site={site} user={user} projectId={projectId}
      preload={workspacePreload?.projectId === projectId ? workspacePreload : null} onBack={leaveProject} />;
  }
  const cachedDashboard = dashboardCache?.userId === user.id ? dashboardCache : null;
  return <Dashboard site={site} user={user}
    initialData={cachedDashboard ? { projects: cachedDashboard.projects, tags: cachedDashboard.tags, pagination: cachedDashboard.pagination } : null}
    onDataChange={(projects, tags, pagination) => setDashboardCache({ userId: user.id, projects, tags, pagination })}
    onUser={(next) => { if (!next || next.id !== user.id) setDashboardCache(null); setUser(next); if (!next) leaveProject(); }}
    onOpenProject={openProject} />;
}
