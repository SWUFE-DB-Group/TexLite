import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { AgentClientMessage, AgentServerMessage, AgentTask } from "../../shared/agentProtocol";
import { agentInputChunks } from "../../shared/agentProtocol";
import { appPath } from "../basePath";
import { useTheme } from "../theme";

export function AgentTerminalSurface({ task, onTask }: { task: AgentTask; onTask: (task: AgentTask) => void }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const root = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const writableRef = useRef(false);
  const onTaskRef = useRef(onTask);
  onTaskRef.current = onTask;
  const [writable, setWritable] = useState(false);
  const [connection, setConnection] = useState<"connecting" | "open" | "closed">("connecting");
  const [errorCode, setErrorCode] = useState("");
  const [reconnect, setReconnect] = useState(0);
  const send = (message: AgentClientMessage) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    if (message.type === "input") {
      for (const data of agentInputChunks(message.data)) socket.current.send(JSON.stringify({ type: "input", data }));
    } else {
      const bounded = message.type === "resize" ? { ...message, cols: Math.max(2, Math.min(500, message.cols)), rows: Math.max(2, Math.min(300, message.rows)) } : message;
      socket.current.send(JSON.stringify(bounded));
    }
  };
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const term = new Terminal({ convertEol: false, scrollback: 1000, fontSize: 12, fontFamily: "Iosevka, ui-monospace, monospace", cursorBlink: true });
    terminal.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    term.attachCustomKeyEventHandler((event) => {
      event.stopPropagation();
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") event.preventDefault();
      return true;
    });
    const input = term.onData((data) => { if (writableRef.current) send({ type: "input", data }); });
    const resize = term.onResize(({ cols, rows }) => { if (writableRef.current) send({ type: "resize", cols, rows }); });
    const observer = new ResizeObserver(() => { try { fit.fit(); } catch { /* Hidden panel. */ } });
    observer.observe(element);
    fit.fit();
    return () => { observer.disconnect(); input.dispose(); resize.dispose(); term.dispose(); terminal.current = null; };
  }, []);
  useEffect(() => {
    if (!terminal.current) return;
    terminal.current.options.theme = theme === "dark"
      ? { background: "#20252d", foreground: "#d7dae0", cursor: "#d7dae0", cursorAccent: "#20252d", selectionBackground: "#3c536f",
        black: "#343b47", red: "#ed8d8d", green: "#8ccf9c", yellow: "#dfc283", blue: "#8fb9ef", magenta: "#c5a0e6", cyan: "#81c7d2", white: "#d7dae0",
        brightBlack: "#929bad", brightRed: "#ffa3a3", brightGreen: "#a5e3b4", brightYellow: "#f3d494", brightBlue: "#a7ceff", brightMagenta: "#dbb9f6", brightCyan: "#a1e0e8", brightWhite: "#eef0f4" }
      : { background: "#fafbf9", foreground: "#1f2328", cursor: "#1f2328", cursorAccent: "#fafbf9", selectionBackground: "#c8dcf0",
        black: "#1f2328", red: "#b43132", green: "#2f6b40", yellow: "#8a6700", blue: "#245da5", magenta: "#873b9f", cyan: "#166f78", white: "#555d69",
        brightBlack: "#6b7280", brightRed: "#c63737", brightGreen: "#357a4b", brightYellow: "#936900", brightBlue: "#2868b3", brightMagenta: "#9047ac", brightCyan: "#167a84", brightWhite: "#5f6875" };
  }, [theme]);
  useEffect(() => {
    let disposed = false;
    let retry: number | undefined;
    const connect = () => {
      if (disposed) return;
      setConnection("connecting"); setErrorCode("");
      writableRef.current = false; setWritable(false);
      const url = new URL(appPath(`/api/agent-tasks/${task.id}/terminal`), window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => { if (!disposed) { terminal.current?.reset(); setConnection("open"); } };
      ws.onmessage = (event) => {
        if (disposed) return;
        let message: AgentServerMessage;
        try { message = JSON.parse(String(event.data)) as AgentServerMessage; } catch { return; }
        if (message.type === "output") terminal.current?.write(message.data);
        if (message.type === "state") onTaskRef.current(message.task);
        if (message.type === "error") setErrorCode(message.code);
        if (message.type === "control") {
          writableRef.current = message.writable; setWritable(message.writable);
          if (message.writable && terminal.current) {
            send({ type: "resize", cols: terminal.current.cols, rows: terminal.current.rows });
            terminal.current.focus();
          }
        }
      };
      ws.onclose = (event) => {
        if (disposed) return;
        writableRef.current = false; setWritable(false); setConnection("closed");
        if (event.code !== 1000 && event.code !== 1008) retry = window.setTimeout(connect, 2_000);
      };
      ws.onerror = () => { if (!disposed) setConnection("closed"); };
    };
    connect();
    return () => { disposed = true; window.clearTimeout(retry); socket.current?.close(); socket.current = null; writableRef.current = false; };
  }, [task.id, reconnect]);
  return <div className="agent-terminal-surface">
    {(connection !== "open" || !writable) && <div className="agent-terminal-status" role="status">
      <span>{errorCode ? t(`errors.codes.${errorCode}`, { defaultValue: t("agents.connectionLost") })
        : connection === "connecting" ? t("agents.connecting") : connection === "closed" ? t("agents.connectionLost") : t("agents.viewOnly")}</span>
      {connection === "closed" ? <button onClick={() => setReconnect((value) => value + 1)}>{t("agents.reconnect")}</button>
        : connection === "open" && <button onClick={() => send({ type: "takeControl" })}>{t("agents.takeControl")}</button>}
    </div>}
    <div className="agent-xterm" ref={root} />
  </div>;
}
