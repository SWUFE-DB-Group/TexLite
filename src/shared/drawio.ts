export const EMPTY_DRAWIO = '<mxfile><diagram id="page-1" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel></diagram></mxfile>';
export const isDrawioFile = (path: string): boolean => /\.drawio$/i.test(path);
export const drawioPdfPath = (path: string): string => path.replace(/\.drawio$/i, ".pdf");
export interface DrawioDocument { content: string; revision: string; pdfRevision: string | null }
export const DRAWIO_ORIGIN = "https://embed.diagrams.net";
export interface DrawioExportOptions { scope: "page" | "selection"; margin: number }

export const drawioMessages = {
  en: {
    errors: {
      DRAWIO_LOCKED: "{{name}} is editing this diagram. Close the editor before moving, replacing or deleting its files.",
      DRAWIO_LOCK_LOST: "The diagram editing lock is no longer valid. Reconnect before saving or exporting.",
      DRAWIO_INVALID: "The diagram or exported SVG is invalid or too large.",
      DRAWIO_CONFLICT: "This file changed elsewhere. Reopen the diagram before saving or exporting again.",
      DRAWIO_BROWSER_UNAVAILABLE: "PDF export requires Chromium, Chrome or Edge on the server. Ask your administrator to install one or configure drawio.browserPath.",
      DRAWIO_EXPORT_FAILED: "Could not export the diagram. Check the server browser and fonts, then retry.",
      DRAWIO_EXPORT_BUSY: "Other diagrams are being exported. Try again shortly."
    },
    ui: {
      connecting: "Connecting…", lockedBy: "{{name}} is editing this diagram", lockLost: "Editing connection lost. Your unsaved changes are kept here.", retryEdit: "Try editing",
      new: "draw.io diagram", title: "draw.io", export: "Export PDF", exported: "PDF saved", saved: "Saved",
      exportOptions: "PDF export options", exportScope: "Export range", currentPage: "Current page", selection: "Selected content", margin: "Content margin",
      selectionCheckFailed: "Could not check selection. Reopen this menu to retry.",
      invalidMargin: "Enter a whole number from 0 to 100.", emptySelection: "Select shapes or connectors in the diagram first.",
      loading: "Loading diagram editor…", unavailable: "The editor did not load. Check your connection to embed.diagrams.net and retry.",
      help: "Loaded from diagrams.net. PDFs are generated using a server browser.",
      discard: "Discard unsaved diagram changes?", discardDescription: "Your changes have not been saved.", discardAction: "Discard",
      overwrite: "Replace PDF?", overwriteDescription: "Exporting will replace {{path}}.", overwriteAction: "Replace and export",
      dirty: "Unsaved changes", readOnly: "Read-only"
    }
  },
  zh: {
    errors: {
      DRAWIO_LOCKED: "{{name}} 正在编辑此图表。请先关闭编辑器，再移动、替换或删除相关文件。",
      DRAWIO_LOCK_LOST: "图表编辑锁已失效。请重新连接后再保存或导出。",
      DRAWIO_INVALID: "图表或导出的 SVG 无效，或文件过大。",
      DRAWIO_CONFLICT: "文件已在其他位置修改。请重新打开图表后再保存或导出。",
      DRAWIO_BROWSER_UNAVAILABLE: "导出 PDF 需要服务器安装 Chromium、Chrome 或 Edge。请联系管理员安装，或配置 drawio.browserPath。",
      DRAWIO_EXPORT_FAILED: "无法导出图表。请检查服务器浏览器及字体后重试。",
      DRAWIO_EXPORT_BUSY: "正在导出其他图表，请稍后重试。"
    },
    ui: {
      connecting: "连接中…", lockedBy: "{{name}} 正在编辑此图表", lockLost: "编辑连接已断开，未保存的修改仍保留在此处。", retryEdit: "尝试编辑",
      new: "draw.io 图表", title: "draw.io", export: "导出 PDF", exported: "PDF 已保存", saved: "已保存",
      exportOptions: "PDF 导出选项", exportScope: "导出范围", currentPage: "当前页面", selection: "所选内容", margin: "内容外边距",
      selectionCheckFailed: "无法检查选区，请重新打开菜单重试。",
      invalidMargin: "请输入 0–100 的整数。", emptySelection: "请先在图表中选中图形或连线。",
      loading: "正在加载图表编辑器…", unavailable: "编辑器未能加载。请检查与 embed.diagrams.net 的连接后重试。",
      help: "从 diagrams.net 加载。PDF 使用服务器浏览器生成。",
      discard: "放弃未保存的图表修改？", discardDescription: "当前修改尚未保存。", discardAction: "放弃修改",
      overwrite: "替换 PDF？", overwriteDescription: "导出将替换 {{path}}。", overwriteAction: "替换并导出",
      dirty: "未保存的修改", readOnly: "只读"
    }
  },
  "zh-Hant": {
    errors: {
      DRAWIO_LOCKED: "{{name}} 正在編輯此圖表。請先關閉編輯器，再移動、取代或刪除相關檔案。",
      DRAWIO_LOCK_LOST: "圖表編輯鎖已失效。請重新連線後再儲存或匯出。",
      DRAWIO_INVALID: "圖表或匯出的 SVG 無效，或檔案過大。",
      DRAWIO_CONFLICT: "檔案已在其他位置修改。請重新開啟圖表後再儲存或匯出。",
      DRAWIO_BROWSER_UNAVAILABLE: "匯出 PDF 需要伺服器安裝 Chromium、Chrome 或 Edge。請聯絡管理員安裝，或設定 drawio.browserPath。",
      DRAWIO_EXPORT_FAILED: "無法匯出圖表。請檢查伺服器瀏覽器及字型後重試。",
      DRAWIO_EXPORT_BUSY: "正在匯出其他圖表，請稍後重試。"
    },
    ui: {
      connecting: "連線中…", lockedBy: "{{name}} 正在編輯此圖表", lockLost: "編輯連線已中斷，未儲存的修改仍保留在此處。", retryEdit: "嘗試編輯",
      new: "draw.io 圖表", title: "draw.io", export: "匯出 PDF", exported: "PDF 已儲存", saved: "已儲存",
      exportOptions: "PDF 匯出選項", exportScope: "匯出範圍", currentPage: "目前頁面", selection: "所選內容", margin: "內容外邊距",
      selectionCheckFailed: "無法檢查選取範圍，請重新開啟選單重試。",
      invalidMargin: "請輸入 0–100 的整數。", emptySelection: "請先在圖表中選取圖形或連接線。",
      loading: "正在載入圖表編輯器…", unavailable: "編輯器未能載入。請檢查與 embed.diagrams.net 的連線後重試。",
      help: "從 diagrams.net 載入。PDF 使用伺服器瀏覽器產生。",
      discard: "捨棄未儲存的圖表修改？", discardDescription: "目前修改尚未儲存。", discardAction: "捨棄修改",
      overwrite: "取代 PDF？", overwriteDescription: "匯出將取代 {{path}}。", overwriteAction: "取代並匯出",
      dirty: "未儲存的修改", readOnly: "唯讀"
    }
  }
};
