/** Anonymous reading is a capability, never a user or project membership. */
export interface ProjectViewLink {
  id: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  /** Owner-only copy address; unavailable if the saved secret cannot be recovered. */
  path: string | null;
}

export interface CreatedProjectViewLink {
  link: ProjectViewLink;
  /** Includes the secret fragment; never returned through the guest API. */
  path: string;
}

export interface SharedProjectData {
  siteName: string;
  project: { name: string; mainFile: string; engine: "pdflatex" | "xelatex" | "lualatex" };
  outline: Array<{ path: string; line: number; level: number; title: string }>;
  expiresAt: string | null;
  files: Array<{ path: string; type: "file" | "directory"; size?: number }>;
  pdf: { url: string; size: number; loadingMode: "full" | "range"; compiledAt: string | null } | null;
}

export const viewLinkMessages = {
  en: {
    VIEW_LINK_INVALID: "This read-only link is invalid, expired or revoked.",
    VIEW_LINK_EXISTS: "This project already has an active read-only link. Copy it or revoke it before creating another.",
    VIEW_LINK_EXPIRY_INVALID: "Choose a future expiry time.",
    VIEW_LINK_LABEL_INVALID: "Use a link name of 80 characters or fewer."
  },
  zh: {
    VIEW_LINK_INVALID: "此只读链接无效、已过期或已撤销。",
    VIEW_LINK_EXISTS: "此项目已有有效的只读链接，请复制现有链接，或撤销后再创建。",
    VIEW_LINK_EXPIRY_INVALID: "请选择将来的过期时间。",
    VIEW_LINK_LABEL_INVALID: "链接名称不能超过 80 个字符。"
  },
  "zh-Hant": {
    VIEW_LINK_INVALID: "此唯讀連結無效、已過期或已撤銷。",
    VIEW_LINK_EXISTS: "此專案已有有效的唯讀連結，請複製現有連結，或撤銷後再建立。",
    VIEW_LINK_EXPIRY_INVALID: "請選擇未來的到期時間。",
    VIEW_LINK_LABEL_INVALID: "連結名稱不能超過 80 個字元。"
  }
} as const;
