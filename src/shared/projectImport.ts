/** Errors shared by URL imports and the browser interface. */
export const projectImportMessages = {
  en: {
    TEMPLATE_URL_INVALID: "Enter an HTTP or HTTPS link to a ZIP file, without sign-in credentials.",
    TEMPLATE_DOWNLOAD_FAILED: "Could not download the template. Check that the link downloads a ZIP without signing in.",
    TEMPLATE_DOWNLOAD_TIMEOUT: "Template download timed out. Try again or upload the ZIP manually.",
    TEMPLATE_DOWNLOAD_TOO_LARGE: "The template exceeds the {{size}} MB download limit."
  },
  zh: {
    TEMPLATE_URL_INVALID: "请输入 HTTP 或 HTTPS ZIP 链接，不含登录凭据。",
    TEMPLATE_DOWNLOAD_FAILED: "无法下载模板，请确认链接无需登录即可下载 ZIP。",
    TEMPLATE_DOWNLOAD_TIMEOUT: "模板下载超时，请重试或手动上传 ZIP。",
    TEMPLATE_DOWNLOAD_TOO_LARGE: "模板超过 {{size}} MB 的下载限制。"
  },
  "zh-Hant": {
    TEMPLATE_URL_INVALID: "請輸入 HTTP 或 HTTPS ZIP 連結，不含登入憑證。",
    TEMPLATE_DOWNLOAD_FAILED: "無法下載範本，請確認連結無需登入即可下載 ZIP。",
    TEMPLATE_DOWNLOAD_TIMEOUT: "範本下載逾時，請重試或手動上傳 ZIP。",
    TEMPLATE_DOWNLOAD_TOO_LARGE: "範本超過 {{size}} MB 的下載限制。"
  }
} as const;
