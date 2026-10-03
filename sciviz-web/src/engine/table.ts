import type { PreviewTable } from './protocol'

/**
 * 线上传回来的表 → 界面用的表。
 *
 * Python 侧把缺失值发成 null（NaN 不是合法 JSON），这里换回 NaN —— 表格渲染的
 * formatNumber 对非有限值本来就输出"—"，正是缺失值该有的样子。
 *
 * 单独成文件是因为两个适配器（Pyodide / 本地宿主）都要做这一步：转两次的地方
 * 就会有两种转法，而"探针里某个格子显示错了"是最难查的一类毛病。
 */
export function toPreviewTable(raw: PreviewTable): PreviewTable {
  return {
    ...raw,
    // 缺失值 → NaN（表格渲染对非有限值输出"—"，正是缺失值该有的样子）。
    // **字符串原样留着**：输出表里有类别名这类非数值列，以前这里当成 number 传下去，
    // 渲染层就只显示"—"（值是对的，只是没显示出来）
    rows: raw.rows.map((row) => row.map((v) => (v === null ? NaN : v))),
  }
}
