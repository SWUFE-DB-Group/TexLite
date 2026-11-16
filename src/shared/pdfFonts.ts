export interface PdfFont {
  name: string;
  type: string;
  encoding: string;
  embedded: boolean;
  subset: boolean;
  unicode: boolean;
}

export interface PdfFontInspection {
  fonts: PdfFont[];
  /** Poppler reported PDF warnings; do not expose raw diagnostics or host paths. */
  hasWarnings: boolean;
}

export interface PdfFontsResponse extends PdfFontInspection {
  mainFile: string;
  runId: string;
}

export const pdfFontMessages = {
  en: {
    PDF_FONTS_UNAVAILABLE: "Font inspection requires pdffonts (Poppler) on the server. Ask an administrator to install it.",
    PDF_FONTS_FAILED: "Could not inspect PDF fonts. The PDF may be damaged or the inspection exceeded its limits."
  },
  zh: {
    PDF_FONTS_UNAVAILABLE: "字体检查需要服务器安装 pdffonts（Poppler），请联系管理员。",
    PDF_FONTS_FAILED: "无法检查 PDF 字体，文件可能损坏或检查超出限制。"
  },
  "zh-Hant": {
    PDF_FONTS_UNAVAILABLE: "字型檢查需要伺服器安裝 pdffonts（Poppler），請聯絡管理員。",
    PDF_FONTS_FAILED: "無法檢查 PDF 字型，檔案可能損毀或檢查超出限制。"
  }
} as const;
