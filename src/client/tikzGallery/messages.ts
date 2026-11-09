const en = {
  title: "TikZ gallery", description: "Add an editable figure to this project.", search: "Search figures",
  typeLabel: "Figure type", categoryLabel: "Icon category", types: { template: "Templates", example: "Examples", icon: "Icons", plot: "Data plots" },
  destination: "Save as", import: "Import", empty: "No figures match your search.",
  selectHint: "Choose a figure to see its details.", requires: "Requires", brandNotice: "Brand marks belong to their owners."
};

export const tikzGalleryMessages = {
  en,
  zh: {
    title: "TikZ 图库", description: "向此项目添加一个可编辑的图。", search: "搜索图",
    typeLabel: "图的类型", categoryLabel: "图标分类", types: { template: "模板", example: "示例", icon: "图标", plot: "数据图" },
    destination: "保存为", import: "导入", empty: "没有符合搜索条件的图。",
    selectHint: "选择一个图以查看详情。", requires: "依赖", brandNotice: "品牌标识归其所有者所有。"
  } satisfies typeof en,
  "zh-Hant": {
    title: "TikZ 圖庫", description: "將可編輯的圖加入此專案。", search: "搜尋圖",
    typeLabel: "圖的類型", categoryLabel: "圖示分類", types: { template: "範本", example: "範例", icon: "圖示", plot: "資料圖" },
    destination: "儲存為", import: "匯入", empty: "沒有符合搜尋條件的圖。",
    selectHint: "選擇一個圖以檢視詳情。", requires: "相依套件", brandNotice: "品牌標識歸其所有者所有。"
  } satisfies typeof en
};
