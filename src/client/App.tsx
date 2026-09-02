import { lazy, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "./api";
import type { Project, ProjectListPagination, ProjectTag, SiteConfig, User } from "./types";
import {
  isProjectHistoryState, projectIdFromPath, projectIdFromReturn, projectLoginPath, projectPath,
  type TexLiteHistoryState
} from "./routes";
import { loadPdfPreview, loadProjectWorkspace, preloadWorkspace, type WorkspacePreload } from "./workspacePreload";
import { ChangePassword, Login } from "./pages/AuthPages";
import { LazyPage } from "./LazyLoadBoundary";

const loadDashboard = () => import("./pages/Dashboard");
const Dashboard = lazy(() => loadDashboard().then((module) => ({ default: module.Dashboard })));
const ProjectWorkspace = lazy(() => loadProjectWorkspace().then((module) => ({ default: module.ProjectWorkspace })));

function preloadRoute(loader: () => Promise<unknown>): void {
  void loader().catch(() => undefined);
}

export function App() {
  const { t } = useTranslation();
  const [site, setSite] = useState<SiteConfig | null>(null);
  const [user, setUser] = useState<User | null | undefined>();
  const userRef = useRef<User | null | undefined>(user);
  userRef.current = user;
  const [projectId, setProjectId] = useState<string | null>(() => typeof window === "undefined" ? null : projectIdFromPath(window.location.pathname));
  // Do not start project or PDF runtime work before /api/me confirms that the
  // current browser session may access the requested project.
  const [workspacePreload, setWorkspacePreload] = useState<WorkspacePreload | null>(null);
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
    const canOpenWorkspace = !authenticatedUser.mustChangePassword;
    const returnProjectId = projectIdFromReturn(window.location.search);
    let targetProjectId: string | null = null;
    if (returnProjectId) {
      const state: TexLiteHistoryState = { texliteRoute: "project", projectId: returnProjectId, fromDashboard: false };
      window.history.replaceState(state, "", projectPath(returnProjectId));
      setProjectId(returnProjectId);
      targetProjectId = returnProjectId;
    } else if (new URLSearchParams(window.location.search).has("return")) {
      const state: TexLiteHistoryState = { texliteRoute: "dashboard" };
      window.history.replaceState(state, "", "/");
      setProjectId(null);
    } else if (projectIdFromPath(window.location.pathname)) {
      // Authenticated deep links mount the workspace immediately below.
      targetProjectId = projectIdFromPath(window.location.pathname);
    }
    if (canOpenWorkspace && targetProjectId) {
      preloadRoute(loadProjectWorkspace);
      setWorkspacePreload(preloadWorkspace(targetProjectId));
    } else if (canOpenWorkspace) {
      preloadRoute(loadDashboard);
    } else {
      setWorkspacePreload(null);
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
      const currentUser = userRef.current;
      if (nextProjectId && currentUser && !currentUser.mustChangePassword) {
        preloadRoute(loadProjectWorkspace);
        setWorkspacePreload(preloadWorkspace(nextProjectId));
      } else {
        setWorkspacePreload(null);
      }
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
    preloadRoute(loadProjectWorkspace);
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

  if (user === undefined || !site) return <div className="center-card">{t("common.loading")}</div>;
  if (!user) return <Login site={site} onLogin={completeAuthentication} />;
  if (user.mustChangePassword) return <ChangePassword site={site} user={user} onChanged={(updated) => setUser(updated)} />;
  if (projectId) {
    return <LazyPage key={`project:${projectId}`} onClose={leaveProject}><ProjectWorkspace key={projectId} site={site} user={user} projectId={projectId}
      preload={workspacePreload?.projectId === projectId ? workspacePreload : null} onBack={leaveProject} /></LazyPage>;
  }
  const cachedDashboard = dashboardCache?.userId === user.id ? dashboardCache : null;
  return <LazyPage key="dashboard"><Dashboard site={site} user={user}
    initialData={cachedDashboard ? { projects: cachedDashboard.projects, tags: cachedDashboard.tags, pagination: cachedDashboard.pagination } : null}
    onDataChange={(projects, tags, pagination) => setDashboardCache({ userId: user.id, projects, tags, pagination })}
    onUser={(next) => { if (!next || next.id !== user.id) setDashboardCache(null); setUser(next); if (!next) leaveProject(); }}
    onOpenProject={openProject} /></LazyPage>;
}
