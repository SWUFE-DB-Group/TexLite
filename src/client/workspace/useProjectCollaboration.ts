import { useEffect, useRef, useState } from "react";
import {
  ProjectCollaboration,
  type ActiveSession,
  type CollaborationStatus,
  type FilesEvent,
  type SharedCompileState
} from "../collaboration";
import type { Project, User } from "../types";

function isFilesEvent(value: unknown): value is FilesEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<FilesEvent>;
  return (event.kind === "update" || event.kind === "move" || event.kind === "delete")
    && typeof event.revision === "string";
}

export function useProjectCollaboration(
  projectId: string,
  user: User,
  activeMainFile: string,
  projectPermission: Project["permission"],
  ready: boolean,
  onDisconnected: () => void
) {
  const [collaboration] = useState(() => new ProjectCollaboration(projectId, user));
  const [status, setStatus] = useState<CollaborationStatus>("connecting");
  const [synced, setSynced] = useState(false);
  const [activeSessions, setActiveSessions] = useState<ActiveSession[]>([]);
  const [compileState, setCompileState] = useState<SharedCompileState | null>(null);
  const [filesEvent, setFilesEvent] = useState<FilesEvent | null>(null);
  const [commentsRevision, setCommentsRevision] = useState("");
  const [dictionaryRevision, setDictionaryRevision] = useState("");
  const [localDraftReady, setLocalDraftReady] = useState(false);
  const [permission, setPermission] = useState<Project["permission"]>(projectPermission);
  const activeMainFileRef = useRef(activeMainFile);
  const onDisconnectedRef = useRef(onDisconnected);
  activeMainFileRef.current = activeMainFile;
  onDisconnectedRef.current = onDisconnected;

  useEffect(() => {
    const states = collaboration.compileStates();
    setCompileState(states[activeMainFile] ?? null);
  }, [activeMainFile, collaboration]);

  useEffect(() => {
    const refreshSessions = () => setActiveSessions(collaboration.sessions());
    const clearDisconnectedState = () => {
      setSynced(false);
      setActiveSessions([]);
      setCompileState(null);
      setFilesEvent(null);
      setCommentsRevision("");
      setDictionaryRevision("");
      onDisconnectedRef.current();
    };
    const handleStatus = ({ status: nextStatus }: { status: CollaborationStatus }) => {
      setStatus(nextStatus);
      if (nextStatus !== "connected") clearDisconnectedState();
    };
    const handleSync = (nextSynced: boolean) => {
      setSynced(nextSynced);
      if (!nextSynced) clearDisconnectedState();
    };
    const handleConnectionFailure = () => {
      setStatus("disconnected");
      clearDisconnectedState();
    };
    const handleMeta = () => {
      const nextFilesEvent = collaboration.meta.get("filesEvent");
      if (isFilesEvent(nextFilesEvent)) setFilesEvent(nextFilesEvent);
      const nextCommentsRevision = collaboration.meta.get("commentsRevision");
      if (typeof nextCommentsRevision === "string") setCommentsRevision(nextCommentsRevision);
      const nextDictionaryRevision = collaboration.meta.get("dictionaryRevision");
      if (typeof nextDictionaryRevision === "string") setDictionaryRevision(nextDictionaryRevision);
      const states = collaboration.compileStates();
      setCompileState(states[activeMainFileRef.current] ?? null);
    };
    const handleAuthoritativeCompileStates = () => {
      const states = collaboration.compileStates();
      setCompileState(states[activeMainFileRef.current] ?? null);
    };
    collaboration.awareness.on("change", refreshSessions);
    collaboration.provider.on("status", handleStatus);
    collaboration.provider.on("sync", handleSync);
    collaboration.provider.on("connection-close", handleConnectionFailure);
    collaboration.provider.on("connection-error", handleConnectionFailure);
    collaboration.meta.observe(handleMeta);
    const stopCompileStateListener = collaboration.onCompileStates(handleAuthoritativeCompileStates);
    const stopDraftListener = collaboration.onDraftReady(() => setLocalDraftReady(true));
    const stopPermissionListener = collaboration.onPermissionChanged((nextPermission) => {
      if (nextPermission === "revoked") {
        setStatus("disconnected");
        setSynced(false);
        onDisconnectedRef.current();
        return;
      }
      setPermission(nextPermission);
    });
    refreshSessions();
    handleMeta();
    // The provider starts disconnected intentionally. Once the caller marks
    // the critical-path requests ready, the separate effect below calls
    // connect(), and provider events update these values. Do not capture
    // `ready` here: this listener is installed once and would otherwise keep
    // the initial false value forever.
    setStatus(collaboration.connected ? "connected" : "connecting");
    setSynced(collaboration.synced);
    return () => {
      collaboration.awareness.off("change", refreshSessions);
      collaboration.provider.off("status", handleStatus);
      collaboration.provider.off("sync", handleSync);
      collaboration.provider.off("connection-close", handleConnectionFailure);
      collaboration.provider.off("connection-error", handleConnectionFailure);
      collaboration.meta.unobserve(handleMeta);
      stopCompileStateListener();
      stopDraftListener();
      stopPermissionListener();
      collaboration.destroy();
    };
  }, [collaboration]);

  useEffect(() => {
    if (ready) collaboration.connect();
  }, [collaboration, ready]);

  useEffect(() => {
    collaboration.setPermission(projectPermission);
    setPermission(projectPermission);
  }, [collaboration, projectPermission]);

  const reconnect = () => {
    setStatus("connecting");
    setSynced(false);
    setActiveSessions([]);
    setCompileState(null);
    collaboration.reconnect();
  };

  return {
    collaboration,
    status,
    synced,
    activeSessions,
    compileState,
    setCompileState,
    filesEvent,
    commentsRevision,
    dictionaryRevision,
    localDraftReady,
    permission,
    reconnect
  };
}
