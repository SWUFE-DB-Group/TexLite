/** Stable translated errors shared by HTTP responses and terminal messages. */
export const agentMessages = {
  en: {
    AGENT_DISABLED: "This tool is disabled or project write access is unavailable.",
    AGENT_UNAVAILABLE: "This agent is not installed or cannot run on the server.",
    AGENT_PTY_UNAVAILABLE: "Terminal support is unavailable. Install the optional node-pty dependency on the server and restart TexLite.",
    AGENT_SESSION_NOT_FOUND: "This agent task does not exist or belongs to another user.",
    AGENT_SESSION_BUSY: "Wait for the current task operation to finish.",
    AGENT_PROJECT_BUSY: "Another agent task is active in this project. End it before starting another task.",
    AGENT_SYNC_FAILED: "External file synchronization failed. The agent has been stopped; check the project files and server logs.",
    AGENT_SYNC_CONFLICT: "Concurrent edits conflicted. The editor version was preserved and agent files were saved under .texlite-agent-conflicts in this project. The agent has been stopped.",
    AGENT_NO_CONTEXT: "No supported saved conversation is available for this task.",
    AGENT_START_FAILED: "The agent could not start. Check its installation and server logs.",
    AGENT_STOP_FAILED: "The agent has not stopped. Retry ending execution before cleaning its files.",
    AGENT_CLEANUP_FAILED: "Task cleanup did not finish. Its record has been kept for retry."
  },
  zh: {
    AGENT_DISABLED: "此外部工具未启用，或你已没有项目写入权限。",
    AGENT_UNAVAILABLE: "服务器未安装此 agent，或该命令无法运行。",
    AGENT_PTY_UNAVAILABLE: "终端支持不可用。请在服务器安装可选依赖 node-pty 后重启 TexLite。",
    AGENT_SESSION_NOT_FOUND: "此 agent 任务不存在，或属于其他用户。",
    AGENT_SESSION_BUSY: "请等待当前任务操作完成。",
    AGENT_PROJECT_BUSY: "本项目已有 Agent 任务正在运行，请先结束它再启动其他任务。",
    AGENT_SYNC_FAILED: "外部文件同步失败，Agent 已停止。请检查项目文件和服务器日志。",
    AGENT_SYNC_CONFLICT: "并发修改存在冲突。已保留编辑器版本，Agent 的文件已保存在本项目的 .texlite-agent-conflicts 目录中，Agent 已停止。",
    AGENT_NO_CONTEXT: "此任务暂无可恢复的受支持对话。",
    AGENT_START_FAILED: "无法启动 agent。请检查命令安装情况及服务器日志。",
    AGENT_STOP_FAILED: "Agent 尚未停止。请重试结束运行，再清理其文件。",
    AGENT_CLEANUP_FAILED: "任务清理未完成。已保留记录，可重试清理。"
  },
  "zh-Hant": {
    AGENT_DISABLED: "此外部工具尚未啟用，或你已沒有專案寫入權限。",
    AGENT_UNAVAILABLE: "伺服器未安裝此 agent，或該命令無法執行。",
    AGENT_PTY_UNAVAILABLE: "終端機支援無法使用。請在伺服器安裝選用相依套件 node-pty 後重新啟動 TexLite。",
    AGENT_SESSION_NOT_FOUND: "此 agent 任務不存在，或屬於其他使用者。",
    AGENT_SESSION_BUSY: "請等待目前任務操作完成。",
    AGENT_PROJECT_BUSY: "此專案已有 Agent 任務正在執行，請先結束它再啟動其他任務。",
    AGENT_SYNC_FAILED: "外部檔案同步失敗，Agent 已停止。請檢查專案檔案與伺服器日誌。",
    AGENT_SYNC_CONFLICT: "並行修改發生衝突。已保留編輯器版本，Agent 的檔案已儲存於此專案的 .texlite-agent-conflicts 目錄中，Agent 已停止。",
    AGENT_NO_CONTEXT: "此任務暫無可恢復的受支援對話。",
    AGENT_START_FAILED: "無法啟動 agent。請檢查命令安裝情況及伺服器日誌。",
    AGENT_STOP_FAILED: "Agent 尚未停止。請重試結束執行，再清理其檔案。",
    AGENT_CLEANUP_FAILED: "任務清理未完成。已保留記錄，可重試清理。"
  }
};
