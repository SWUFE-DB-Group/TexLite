import { useEffect, useRef, useState } from "react";
import {
  ProjectCollaboration,
  type ActiveSession,
  type CollaborationStatus,
  type FilesEvent,
  type FormatLeaseState,
  type SharedCompileState
} from "../collaboration";
import type { Project, User } from "../types";

export interface PermissionDowngradeNotice {
  previous: Project["permission"];
  localDraftReady: boolean;
  otherTabDraft: boolean;
}

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
  const [formatLeaseStates, setFormatLeaseStates] = useState<FormatLeaseState[]>([]);
  const [localDraftReady, setLocalDraftReady] = useState(false);
  const [permission, setPermission] = useState<Project["permission"]>(projectPermission);
  const [permissionDowngrade, setPermissionDowngrade] = useState<PermissionDowngradeNotice | null>(null);
  const [protocolUpgradeRequired, setProtocolUpgradeRequired] = useState(false);
  const activeMainFileRef = useRef(activeMainFile);
  const onDisconnectedRef = useRef(onDisconnected);
  const readyRef = useRef(ready);
  activeMainFileRef.current = activeMainFile;
  onDisconnectedRef.current = onDisconnected;
  readyRef.current = ready;

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
      setFormatLeaseStates([]);
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
    const stopProtocolUpgradeListener = collaboration.onProtocolUpgrade(() => {
      setProtocolUpgradeRequired(true);
      setStatus("disconnected");
      clearDisconnectedState();
    });
    const refreshFormatLeases = () => setFormatLeaseStates(collaboration.formatLeaseStates());
    const stopFormatLeaseListener = collaboration.onFormatLeaseState(refreshFormatLeases);
    const showStoredDraftNotice = () => {
      if (!readyRef.current || collaboration.currentPermission !== "read") return;
      const localDraftReady = collaboration.hasWritableDraft;
      const otherTabDraft = collaboration.hasOtherWritableDraft;
      if (!localDraftReady && !otherTabDraft) return;
      setPermissionDowngrade({ previous: "edit", localDraftReady, otherTabDraft });
    };
    const stopDraftListener = collaboration.onDraftReady(() => {
      setLocalDraftReady(true);
      // If the page was opened after an offline-capable editor was downgraded
      // and the project metadata has loaded, surface the same explicit draft
      // decision as a live downgrade. The readiness guard avoids interpreting
      // the hook's initial placeholder permission as a real downgrade.
      showStoredDraftNotice();
    });
    const stopPermissionListener = collaboration.onPermissionChanged((nextPermission, previousPermission) => {
      if (nextPermission === "revoked") {
        setStatus("disconnected");
        setSynced(false);
        onDisconnectedRef.current();
        return;
      }
      setPermission(nextPermission);
      if (nextPermission === "read" && previousPermission !== "read") {
        setPermissionDowngrade({
          previous: previousPermission,
          localDraftReady: collaboration.hasWritableDraft,
          otherTabDraft: collaboration.hasOtherWritableDraft
        });
      } else if (nextPermission !== "read") setPermissionDowngrade(null);
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
      stopProtocolUpgradeListener();
      stopFormatLeaseListener();
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
    if (ready && projectPermission === "read"
      && (collaboration.hasWritableDraft || collaboration.hasOtherWritableDraft)) {
      setPermissionDowngrade({
        previous: "edit",
        localDraftReady: collaboration.hasWritableDraft,
        otherTabDraft: collaboration.hasOtherWritableDraft
      });
    } else if (projectPermission !== "read") {
      setPermissionDowngrade(null);
    }
  }, [collaboration, projectPermission, ready]);

  const permissionDowngradeVisible = permissionDowngrade !== null;
  useEffect(() => {
    if (!permissionDowngradeVisible) return;
    const refreshDraftAvailability = () => {
      if (collaboration.currentPermission !== "read") return;
      const nextLocalDraftReady = collaboration.hasWritableDraft;
      const nextOtherTabDraft = collaboration.hasOtherWritableDraft;
      setPermissionDowngrade((current) => {
        if (!current
          || (current.localDraftReady === nextLocalDraftReady && current.otherTabDraft === nextOtherTabDraft)) {
          return current;
        }
        return {
          ...current,
          localDraftReady: nextLocalDraftReady,
          otherTabDraft: nextOtherTabDraft
        };
      });
    };
    refreshDraftAvailability();
    // localStorage does not dispatch a storage event in the tab that wrote it,
    // and a crashed tab cannot announce its departure. Poll only while this
    // rare modal is visible so an expired activity lease becomes actionable.
    const timer = window.setInterval(refreshDraftAvailability, 2_000);
    return () => window.clearInterval(timer);
  }, [collaboration, permissionDowngradeVisible]);

  const reconnect = () => {
    if (protocolUpgradeRequired) return;
    setStatus("connecting");
    setSynced(false);
    setActiveSessions([]);
    setCompileState(null);
    setFormatLeaseStates([]);
    collaboration.reconnect();
  };

  const dismissPermissionDowngrade = () => setPermissionDowngrade(null);
  const discardLocalDraft = async (): Promise<boolean> => {
    const discarded = await collaboration.discardLocalDraft();
    if (!discarded) {
      setPermissionDowngrade((current) => current ? { ...current, otherTabDraft: true } : current);
      return false;
    }
    setPermissionDowngrade(null);
    window.location.reload();
    return true;
  };

  return {
    collaboration,
    status,
    synced,
    activeSessions,
    compileState,
    setCompileState,
    formatLeaseStates,
    filesEvent,
    commentsRevision,
    dictionaryRevision,
    localDraftReady,
    permission,
    protocolUpgradeRequired,
    reconnect,
    permissionDowngrade,
    dismissPermissionDowngrade,
    discardLocalDraft
  };
}
