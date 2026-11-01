const en = {
  SUGGESTION_INVALID: "Select a passage and provide different replacement text (up to 50,000 characters).",
  SUGGESTION_REVIEWER_INVALID: "Choose a reviewer with write access to this project.",
  SUGGESTION_SELF_REVIEW: "The comment author cannot review their own suggestion.",
  SUGGESTION_REVIEW_FORBIDDEN: "Only the assigned reviewer with write access can review this suggestion.",
  SUGGESTION_SOURCE_CHANGED: "The original passage has changed or can no longer be located. Create a new suggestion from the current source.",
  SUGGESTION_EXISTS: "This discussion already has a suggestion.",
  SUGGESTION_PENDING: "Review the pending suggestion before resolving this discussion.",
  SUGGESTION_DECIDED: "This suggestion has already been reviewed.",
  SUGGESTION_APPLYING: "This change is being saved. Retry accepting it to finish; do not apply it again manually.",
  SUGGESTION_RECOVERY_FAILED: "The saved suggestion could not be recovered. Check the server log before changing this project."
};
const zh: Record<keyof typeof en, string> = {
  SUGGESTION_INVALID: "请选择一段源码，并提供不同的替换内容（最多 50,000 个字符）。",
  SUGGESTION_REVIEWER_INVALID: "请选择对本项目有写权限的审核人。",
  SUGGESTION_SELF_REVIEW: "评论作者不能审核自己的修改建议。",
  SUGGESTION_REVIEW_FORBIDDEN: "只有仍有写权限的指定审核人可以审核此建议。",
  SUGGESTION_SOURCE_CHANGED: "原文已修改或无法定位，请基于当前源码重新提出建议。",
  SUGGESTION_EXISTS: "此讨论已有修改建议。",
  SUGGESTION_PENDING: "请先审核待处理的修改建议，再解决此讨论。",
  SUGGESTION_DECIDED: "此建议已完成审核。",
  SUGGESTION_APPLYING: "修改正在保存，请重试接受以完成操作，不要手动重复应用。",
  SUGGESTION_RECOVERY_FAILED: "无法恢复已保存的修改建议，请先检查服务器日志，再修改此项目。"
};
const zhHant: Record<keyof typeof en, string> = {
  SUGGESTION_INVALID: "請選取一段原始碼，並提供不同的替換內容（最多 50,000 個字元）。",
  SUGGESTION_REVIEWER_INVALID: "請選擇對本專案有寫入權限的審核人。",
  SUGGESTION_SELF_REVIEW: "批註作者不能審核自己的修改建議。",
  SUGGESTION_REVIEW_FORBIDDEN: "只有仍有寫入權限的指定審核人可以審核此建議。",
  SUGGESTION_SOURCE_CHANGED: "原文已修改或無法定位，請根據目前原始碼重新提出建議。",
  SUGGESTION_EXISTS: "此討論已有修改建議。",
  SUGGESTION_PENDING: "請先審核待處理的修改建議，再解決此討論。",
  SUGGESTION_DECIDED: "此建議已完成審核。",
  SUGGESTION_APPLYING: "修改正在儲存，請重試接受以完成操作，不要手動重複套用。",
  SUGGESTION_RECOVERY_FAILED: "無法復原已儲存的修改建議，請先檢查伺服器日誌，再修改此專案。"
};
export const suggestionMessages = { en, zh, "zh-Hant": zhHant };
export const defaultSuggestionComments = { en: "Suggested change", zh: "修改意见", "zh-Hant": "修改意見" };
