import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ProjectCollaboration } from "../collaboration";
import type { User } from "../types";

interface Session {
  projectId: string;
  userId: string;
  collaboration: ProjectCollaboration;
}

/** Own browser resources for exactly one mounted user/project workspace. */
export function ProjectCollaborationSession({ projectId, user, children }: {
  projectId: string;
  user: User;
  children: (collaboration: ProjectCollaboration) => ReactNode;
}) {
  const { t } = useTranslation();
  const userRef = useRef(user);
  userRef.current = user;
  const [session, setSession] = useState<Session | null>(null);
  const ownedSession = useRef<Session | null>(null);
  const pendingRelease = useRef<object | null>(null);
  const userId = user.id;

  useEffect(() => {
    // Construction opens IndexedDB and installs browser listeners. Keep it
    // out of render/state initializers, which React may call and discard.
    // Effect replay can immediately reclaim the same live document. Keeping
    // its identity also preserves editor bindings and workspace state during
    // Fast Refresh. A different user/project always gets a fresh session.
    pendingRelease.current = null;
    let current = ownedSession.current;
    if (!current || current.projectId !== projectId || current.userId !== userId) {
      current?.collaboration.destroy();
      current = { projectId, userId, collaboration: new ProjectCollaboration(projectId, userRef.current) };
      ownedSession.current = current;
    }
    setSession(current);
    return () => {
      const token = {};
      pendingRelease.current = token;
      // StrictMode and Fast Refresh re-run setup synchronously after cleanup.
      // Only a real departure remains unclaimed at the next microtask. This
      // also lets descendant editors remove bindings before the doc closes.
      queueMicrotask(() => {
        if (pendingRelease.current !== token || ownedSession.current !== current) return;
        pendingRelease.current = null;
        ownedSession.current = null;
        current.collaboration.destroy();
      });
    };
  }, [projectId, userId]);

  if (!session || session.projectId !== projectId || session.userId !== userId) {
    return <div className="center-card" role="status">{t("common.loading")}</div>;
  }
  // A replacement session must also replace editor bindings and asynchronous
  // workspace workflows that still refer to the previous Yjs document.
  return <Fragment key={session.collaboration.doc.guid}>{children(session.collaboration)}</Fragment>;
}
