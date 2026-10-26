/** Stable translated errors shared by HTTP responses and terminal messages. */
export const agentMessages = {
  en: {
    AGENT_DISABLED: "This tool is disabled or project write access is unavailable.",
    AGENT_UNAVAILABLE: "This agent is not installed or cannot run on the server.",
    AGENT_PTY_UNAVAILABLE: "Terminal support is unavailable. Install the optional node-pty dependency on the server and restart TexLite.",
    AGENT_SESSION_NOT_FOUND: "This agent task does not exist or belongs to another user.",
    AGENT_SESSION_BUSY: "Wait for the current task operation to finish.",
    AGENT_PROJECT_BUSY: "Another agent task is active in this project. It must end before another can start; hiding the terminal does not stop it.",
    AGENT_SYNC_FAILED: "External file synchronization failed. The agent has been stopped; check the project files and server logs.",
    AGENT_SYNC_CONFLICT: "Concurrent edits conflicted. The editor version was preserved and agent files were saved under .texlite-agent-conflicts in this project. The agent has been stopped.",
    AGENT_NO_CONTEXT: "This task's saved conversation cannot be resumed. Create a new task with + to start a new conversation.",
    AGENT_CONTEXT_CHECK_FAILED: "The task's saved conversation could not be verified. Retry, or check the agent's installation and task data. No new conversation was started.",
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
    AGENT_PROJECT_BUSY: "本项目已有 Agent 任务在运行，需先结束该任务才能启动其他任务；收起终端不会停止任务。",
    AGENT_SYNC_FAILED: "外部文件同步失败，Agent 已停止。请检查项目文件和服务器日志。",
    AGENT_SYNC_CONFLICT: "并发修改存在冲突。已保留编辑器版本，Agent 的文件已保存在本项目的 .texlite-agent-conflicts 目录中，Agent 已停止。",
    AGENT_NO_CONTEXT: "无法恢复此任务的对话。请通过＋新建任务以开始新对话。",
    AGENT_CONTEXT_CHECK_FAILED: "无法确认此任务的对话状态。请重试，或检查 Agent 安装及任务数据；尚未创建新对话。",
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
    AGENT_PROJECT_BUSY: "此專案已有 Agent 任務正在執行，須先結束該任務才能啟動其他任務；收起終端機不會停止任務。",
    AGENT_SYNC_FAILED: "外部檔案同步失敗，Agent 已停止。請檢查專案檔案與伺服器日誌。",
    AGENT_SYNC_CONFLICT: "並行修改發生衝突。已保留編輯器版本，Agent 的檔案已儲存於此專案的 .texlite-agent-conflicts 目錄中，Agent 已停止。",
    AGENT_NO_CONTEXT: "無法恢復此任務的對話。請透過＋新增任務以開始新對話。",
    AGENT_CONTEXT_CHECK_FAILED: "無法確認此任務的對話狀態。請重試，或檢查 Agent 安裝及任務資料；尚未建立新對話。",
    AGENT_START_FAILED: "無法啟動 agent。請檢查命令安裝情況及伺服器日誌。",
    AGENT_STOP_FAILED: "Agent 尚未停止。請重試結束執行，再清理其檔案。",
    AGENT_CLEANUP_FAILED: "任務清理未完成。已保留記錄，可重試清理。"
  }
};
