import type { Workflow } from './types'

/**
 * 画布批注：表格、思维图、图片。
 *
 * ## 它们**不是算子**，这是整个设计最重要的一条边界
 *
 * 批注不进 `nodeRegistry`，因此不进 `catalog`（那是"人与 agent 共用的动作词汇表"），
 * 不进 `workflow.nodes`，因此 L1 校验器、求值计划、指纹、运行清单都看不见它。
 * 把表格登记成一个算子的代价很具体：agent 会在清单里读到一个叫「表格」的算子，
 * 以为它能跑、能接端口，然后花一轮去试 —— 而它什么都不计算。
 *
 * 但它们又确实与图同处一个坐标系、同一个文件（工程文件顶层的 `annotations:` 段），
 * 因为"一站式"的全部意义就是：**记实验数据的地方和产生这些数据的地方在同一块画布上**。
 *
 * ## 便签不在这里了（2026-09-20）
 *
 * 便签曾经是第四种批注。用起来之后发现病根不在这张纸上：**画布是二维且会被占满的，
 * 而"记录"是一维的** —— 便签一多，画布就被文字占满，于是"缩小看不清内容、放大看不全结构"。
 * 记录搬到了独立的「实验笔记」栏（Markdown，可粘贴图片、可引用节点），画布只留结构
 * （块与连线）和少数大件（表格、思维图、图片）。因此 `kind: 'note'` 不再是合法值，
 * 打开旧工程时这些条目会被忽略并报数（见 `project.ts`）。
 *
 * ## 为什么这一层是纯函数
 *
 * 表格改一格、思维图加一支，这些规则被三个地方用：界面（点击编辑）、工程文件
 * （读进来要能落成合法形状）、测试。写成纯函数是为了**只有一处规则** ——
 * 尤其"行必须与列等长"这条，如果界面一套、解析一套，往返一次就会静默丢数据。
 *
 * 值一律是字符串：批注是**人记下来的读数**，不是数据。要参与计算的东西走数据源节点，
 * 那里有类型、有单位、有身份哈希。这里刻意不做数值解析（"1,024" 是千位分隔还是
 * 两个数？），因为一旦解析，它就成了第二处数据真相，而它没有那些保障。
 */

/** 批注类型。加新的要同时改 `normalizeAnnotation` 与画布上的视图 */
export type AnnotationKind = 'mindmap' | 'table' | 'image'

export const ANNOTATION_KINDS: AnnotationKind[] = ['table', 'mindmap', 'image']

/**
 * 认一个字符串是不是批注类型。
 *
 * 有了它，读文件与读拖拽数据两处都能写"不是这几种就说不要"，而不必各自抄一份
 * 字面量清单 —— 清单加一种时，漏改一处不会变成"这一种拖进来没反应"。
 */
export function isAnnotationKind(v: unknown): v is AnnotationKind {
  return typeof v === 'string' && (ANNOTATION_KINDS as string[]).includes(v)
}

/**
 * 每种批注的**名义尺寸**（画布坐标，不是屏幕像素）。
 *
 * 只用来给新落点让位：算子节点宽 216，而一张表格能长到 460 宽 —— 摆放若还按 216
 * 算碰撞，第三、四个批注就会正好压在第一个身上（实测：便签盖住表格的左下角）。
 *
 * 说是"名义"，因为它不测真实 DOM（那要等渲染完、还要按缩放换算，是画布布局的独立
 * 改动，`placement.ts` 里已登记为已知未修）。估大一点比估准更合适：宁可留白，
 * 也不要两块内容叠在一起让人以为程序坏了。
 */
export const ANNOTATION_NOMINAL: Record<AnnotationKind, { w: number; h: number }> = {
  table: { w: 460, h: 250 },
  mindmap: { w: 430, h: 230 },
  image: { w: 380, h: 260 },
}

/** 图片显示宽高的共同边界；批注读取与画布控件共用，避免范围各写一份。 */
export const ANNOTATION_IMAGE_SIZE_LIMITS = { min: 80, max: 1600 } as const

export interface AnnotationPosition {
  x: number
  y: number
}

interface AnnotationBase {
  id: string
  kind: AnnotationKind
  position: AnnotationPosition
  /** 从主画布到所属子画布的组块 ID 路径；旧文件缺省时归主画布。 */
  groupPath?: string[]
  /** 表名 / 思维图的主题 */
  title: string
}

export interface TableAnnotation extends AnnotationBase {
  kind: 'table'
  /** 表头。列名可以空着（先画格子再想叫什么） */
  columns: string[]
  /** 每行与 columns 等长 —— 由 `fitRow` 保证，见下面那条注释 */
  rows: string[][]
}

export interface MindBranch {
  id: string
  text: string
  children: MindBranch[]
}

export interface MindmapAnnotation extends AnnotationBase {
  kind: 'mindmap'
  /** 根节点就是主题本身。它不能被删 —— 删了这张图就没有根了 */
  root: MindBranch
}

export interface ImageAnnotation extends AnnotationBase {
  kind: 'image'
  /** data URL，既支持剪贴板图片，也支持把 SVG 图表独立保存到工程文件 */
  src: string
  alt: string
  width: number
  height: number
  source?: string
}

export type Annotation = TableAnnotation | MindmapAnnotation | ImageAnnotation

/** 新建批注时给一个能用的起手形状，而不是空白 —— 空白表格没人会去加行列 */
export function createAnnotation(
  kind: AnnotationKind,
  id: string,
  position: AnnotationPosition,
  newBranchId: () => string,
  groupPath: readonly string[] = [],
): Annotation {
  if (kind === 'table') {
    return {
      id,
      kind,
      position,
      groupPath: [...groupPath],
      title: '',
      columns: ['指标', '值'],
      rows: [['', ''], ['', ''], ['', '']],
    }
  }
  if (kind === 'image') {
    return {
      id,
      kind,
      position,
      groupPath: [...groupPath],
      title: '',
      src: '',
      alt: '画布图片',
      width: ANNOTATION_NOMINAL.image.w,
      height: ANNOTATION_NOMINAL.image.h,
    }
  }
  return {
    id,
    kind,
    position,
    groupPath: [...groupPath],
    title: '',
    root: { id: newBranchId(), text: '中心主题', children: [] },
  }
}

/** 创建一张可以直接放到画布上的图片（剪贴板截图 / 图表快照共用）。 */
export function createImageAnnotation(
  id: string,
  position: AnnotationPosition,
  src: string,
  size?: { width?: number; height?: number },
  alt = '画布图片',
  source?: string,
  groupPath: readonly string[] = [],
): ImageAnnotation {
  const width = finiteSize(size?.width, ANNOTATION_NOMINAL.image.w)
  const height = finiteSize(size?.height, ANNOTATION_NOMINAL.image.h)
  return {
    id,
    kind: 'image',
    position,
    groupPath: [...groupPath],
    title: '',
    src,
    alt,
    width,
    height,
    ...(source ? { source } : {}),
  }
}

/** 旧批注没有归属信息时属于主画布。 */
export function annotationGroupPath(annotation: Annotation): readonly string[] {
  return Array.isArray(annotation.groupPath) ? annotation.groupPath : []
}

/**
 * 深拷贝一条批注（可换 id）。
 *
 * "深"是必要的：表格的行数组、思维图的子树都是可变结构，浅拷贝让副本与原件共享同一份
 * 数组 —— 改副表格里的一格，原表格跟着变，而屏幕上两处都刷新，看起来像是"点了两次"。
 * 图片的 `src` 是字符串（不可变），共享它反而是对的：一张截图不该因为复制一次变成两份内存。
 */
export function cloneAnnotation(annotation: Annotation, id = annotation.id): Annotation {
  const base = {
    id,
    position: { ...annotation.position },
    ...(annotation.groupPath ? { groupPath: [...annotation.groupPath] } : {}),
    title: annotation.title,
  }
  if (annotation.kind === 'table') {
    return {
      ...base,
      kind: 'table',
      columns: [...annotation.columns],
      rows: annotation.rows.map((row) => [...row]),
    }
  }
  if (annotation.kind === 'mindmap') {
    return { ...base, kind: 'mindmap', root: cloneBranch(annotation.root) }
  }
  return { ...base, kind: 'image', src: annotation.src, alt: annotation.alt, width: annotation.width, height: annotation.height, ...(annotation.source ? { source: annotation.source } : {}) }
}

function cloneBranch(branch: MindBranch): MindBranch {
  return { id: branch.id, text: branch.text, children: branch.children.map(cloneBranch) }
}

export function annotationGroupPathExists(
  workflow: Workflow,
  groupPath: readonly string[],
): boolean {
  let current = workflow
  for (const id of groupPath) {
    const node = current.nodes.find((candidate) => candidate.id === id)
    if (!node?.group) return false
    current = node.group.workflow
  }
  return true
}

export function annotationsInGroupPath(
  annotations: readonly Annotation[],
  groupPath: readonly string[],
): Annotation[] {
  return annotations.filter((annotation) => sameGroupPath(annotationGroupPath(annotation), groupPath))
}

export function moveAnnotationsIntoGroup(
  annotations: readonly Annotation[],
  annotationIds: ReadonlySet<string>,
  parentPath: readonly string[],
  groupId: string,
): Annotation[] {
  return annotations.map((annotation) =>
    annotationIds.has(annotation.id) && sameGroupPath(annotationGroupPath(annotation), parentPath)
      ? { ...annotation, groupPath: [...parentPath, groupId] }
      : annotation,
  )
}

/** 将批注及其已选组块的后代批注一起纳入刚创建的组块。 */
export function wrapAnnotationScopes(
  annotations: readonly Annotation[],
  parentPath: readonly string[],
  groupId: string,
  selectedAnnotationIds: ReadonlySet<string>,
  selectedGroupIds: ReadonlySet<string>,
): Annotation[] {
  return annotations.map((annotation) => {
    const path = annotationGroupPath(annotation)
    if (selectedAnnotationIds.has(annotation.id) && sameGroupPath(path, parentPath)) {
      return { ...annotation, groupPath: [...parentPath, groupId] }
    }
    const nestedIndex = selectedGroupIds.size
      ? [...selectedGroupIds].find((id) => startsWithGroupPath(path, [...parentPath, id]))
      : undefined
    if (nestedIndex) {
      const prefixLength = parentPath.length
      return {
        ...annotation,
        groupPath: [...parentPath, groupId, ...path.slice(prefixLength)],
      }
    }
    return annotation
  })
}

/** 解散组块时把它及其嵌套组块里的批注路径上提一层。 */
export function ungroupAnnotationScopes(
  annotations: readonly Annotation[],
  parentPath: readonly string[],
  groupId: string,
): Annotation[] {
  const prefix = [...parentPath, groupId]
  return annotations.map((annotation) => {
    const path = annotationGroupPath(annotation)
    return startsWithGroupPath(path, prefix)
      ? { ...annotation, groupPath: [...parentPath, ...path.slice(prefix.length)] }
      : annotation
  })
}

/**
 * 挑出"复制一段画布内容时该跟着走的批注"，并把归属路径换成**相对载荷原点**的路径。
 *
 * 两类入选：① 当前层级里被点名的批注（相对路径为空）；② 被复制的组块内部、任意深度的批注
 * （相对路径以那个组块 id 开头）。相对路径里保留**原组块 id** 是有意的：载荷离开这份工程之后
 * 仍然自洽（"这条批注属于载荷里那个组块"），粘贴到别的层级时也不必回头查来源画布。
 */
export function copyAnnotationScope(
  annotations: readonly Annotation[],
  sourcePath: readonly string[],
  selectedIds: ReadonlySet<string>,
  copiedGroupIds: ReadonlySet<string>,
): { annotation: Annotation; path: string[] }[] {
  const picked: { annotation: Annotation; path: string[] }[] = []
  for (const annotation of annotations) {
    const path = annotationGroupPath(annotation)
    if (!startsWithGroupPath(path, sourcePath)) continue
    const relative = path.slice(sourcePath.length)
    const selectedHere = relative.length === 0 && selectedIds.has(annotation.id)
    const insideCopiedGroup = relative.length > 0 && copiedGroupIds.has(relative[0])
    if (selectedHere || insideCopiedGroup) picked.push({ annotation, path: relative })
  }
  return picked
}

/**
 * 把载荷里的批注粘到目标层级：坐标按落点平移、id 换新、`groupPath` 重挂成
 * `[...目标层级, ...载荷路径映射后的新节点 id]`。
 *
 * 路径里出现"这次没被复制"的组块 id 时**丢掉这一条**：留着它的后果是一条永远显示不出来的
 * 孤儿批注 —— 屏幕上什么都没有，文件里却一直多一条。绝不迁就到别的层级去凑数。
 */
export function reattachCopiedAnnotations(
  items: readonly { annotation: Annotation; path: readonly string[] }[],
  targetPath: readonly string[],
  idMap: ReadonlyMap<string, string>,
  offset: AnnotationPosition,
  newId: () => string,
): { annotations: Annotation[]; ids: string[] } {
  const used = new Set<string>()
  const annotations: Annotation[] = []
  const ids: string[] = []
  for (const item of items) {
    /*
     * 只有**第一段**要重映射：它是载荷里那个被复制的组块，在目标图里换了新 id。
     * 更深的那几段是组块定义**内部**的子组 id —— 组块是整棵复制的，内部 id 原样保留，
     * 所以它们在新图里仍然成立（动手改它们反而会把批注挂到不存在的层上）。
     */
    const [head, ...rest] = item.path
    let path: string[] = []
    if (head !== undefined) {
      const mapped = idMap.get(head)
      // 第一段没被复制 = 这条批注属于一个没跟着走的组块：丢掉，不留孤儿
      if (!mapped) continue
      path = [mapped, ...rest]
    }
    let id = newId()
    for (let guard = 0; used.has(id) && guard < 1000; guard += 1) id = newId()
    used.add(id)
    const copy = cloneAnnotation(item.annotation, id)
    annotations.push({
      ...copy,
      position: {
        x: item.annotation.position.x + offset.x,
        y: item.annotation.position.y + offset.y,
      },
      groupPath: [...targetPath, ...path],
    })
    ids.push(id)
  }
  return { annotations, ids }
}

/** 删除组块时连同其子空间内的批注一起删除。 */
export function removeGroupAnnotations(
  annotations: readonly Annotation[],
  parentPath: readonly string[],
  groupId: string,
): Annotation[] {
  const prefix = [...parentPath, groupId]
  return annotations.filter((annotation) => !startsWithGroupPath(annotationGroupPath(annotation), prefix))
}

function sameGroupPath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function startsWithGroupPath(path: readonly string[], prefix: readonly string[]): boolean {
  return path.length >= prefix.length && prefix.every((id, index) => path[index] === id)
}

function finiteSize(value: number | undefined, fallback: number): number {
  return Number.isFinite(value)
    ? Math.min(ANNOTATION_IMAGE_SIZE_LIMITS.max, Math.max(ANNOTATION_IMAGE_SIZE_LIMITS.min, Number(value)))
    : fallback
}

/* ------------------------------------------------------------------ */
/* 表格                                                                */
/* ------------------------------------------------------------------ */

/**
 * 把一行修成与表头等长。
 *
 * 这条规则只在这里写一遍。它是"往返一次会不会静默丢数据"的关键：文件里若有一行
 * 比列多（人手改 YAML 很常见），截掉；少，补空。**两种情况都必须发生**，
 * 否则渲染层要到处 `?? ''`，而漏一处就是一个 undefined 印在格子里。
 */
function fitRow(columns: string[], row: unknown): string[] {
  const cells = Array.isArray(row) ? row.map((v) => cellText(v)) : []
  const out = columns.map((_, i) => cells[i] ?? '')
  return out
}

function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  // 数字与布尔原样成文：文件里写 `1024` 与写 '1024' 是同一件事，不该丢
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return String(v)
}

export function tableCell(a: TableAnnotation, row: number, col: number, value: string): TableAnnotation {
  const rows = a.rows.map((r, ri) => (ri === row ? r.map((c, ci) => (ci === col ? value : c)) : r))
  return { ...a, rows }
}

export function tableColumnLabel(a: TableAnnotation, col: number, value: string): TableAnnotation {
  const columns = a.columns.map((c, i) => (i === col ? value : c))
  // 改表头不动数据，但行数要照新表头等长（列数没变，这里只是把规则走一遍）
  return { ...a, columns, rows: a.rows.map((r) => fitRow(columns, r)) }
}

export function tableRowAdded(a: TableAnnotation, after?: number): TableAnnotation {
  const at = after === undefined ? a.rows.length : Math.min(a.rows.length, Math.max(0, after + 1))
  const rows = [...a.rows.slice(0, at), a.columns.map(() => ''), ...a.rows.slice(at)]
  return { ...a, rows }
}

export function tableColumnAdded(a: TableAnnotation): TableAnnotation {
  const columns = [...a.columns, '']
  return { ...a, columns, rows: a.rows.map((r) => fitRow(columns, r)) }
}

/** 删行。最后一行也允许删（删空了界面会显示"加一行"的入口，不会变成一张没法用的图） */
export function tableRowRemoved(a: TableAnnotation, row: number): TableAnnotation {
  return { ...a, rows: a.rows.filter((_, i) => i !== row) }
}

/**
 * 删列。**只剩一列时不让删**：一列的表格已经不是表格了，而"手滑删掉最后一列"
 * 会把整张表的表头带走，仍可用画布撤回恢复。
 */
export function tableColumnRemoved(a: TableAnnotation, col: number): TableAnnotation {
  if (a.columns.length <= 1) return a
  const columns = a.columns.filter((_, i) => i !== col)
  /*
   * 每行也要**按同一个下标**挖掉一格，再照新表头修齐。
   *
   * 先只改表头、再拿新表头去 fitRow 是错的：fitRow 从头取格子，于是删掉 A 列之后
   * 每行留下的是 A 的数据挂在 B 的表头下面 —— 数据还在、看着也对，只是**串了一列**。
   * 这种错最难查：它不报错、不缺格，只在某一行数字对不上的时候被人发现。
   */
  const rows = a.rows.map((r) => fitRow(columns, r.filter((_, i) => i !== col)))
  return { ...a, columns, rows }
}

/* ------------------------------------------------------------------ */
/* 思维图                                                              */
/* ------------------------------------------------------------------ */

export function mindFind(root: MindBranch, id: string): MindBranch | null {
  if (root.id === id) return root
  for (const child of root.children) {
    const hit = mindFind(child, id)
    if (hit) return hit
  }
  return null
}

/** 换一支的文字。返回新树（不可变：界面直接依赖引用变化重渲染） */
export function mindText(root: MindBranch, id: string, text: string): MindBranch {
  if (root.id === id) return { ...root, text }
  return { ...root, children: root.children.map((c) => mindText(c, id, text)) }
}

export function mindChild(
  root: MindBranch,
  parentId: string,
  childId: string,
  text = '新想法',
): MindBranch {
  if (root.id === parentId) {
    return { ...root, children: [...root.children, { id: childId, text, children: [] }] }
  }
  return { ...root, children: root.children.map((c) => mindChild(c, parentId, childId, text)) }
}

/** 删一支（连着它的子支一起）。根不删 —— 没有根的思维图不该存在 */
export function mindRemoved(root: MindBranch, id: string): MindBranch {
  if (root.id === id) return root
  return { ...root, children: root.children.filter((c) => c.id !== id).map((c) => mindRemoved(c, id)) }
}

export function mindCount(root: MindBranch): number {
  return 1 + root.children.reduce((n, c) => n + mindCount(c), 0)
}

/* ------------------------------------------------------------------ */
/* 从文件里读回来                                                      */
/* ------------------------------------------------------------------ */

const asText = (v: unknown, fallback = ''): string =>
  v === null || v === undefined ? fallback : typeof v === 'string' ? v : String(v)

function normalizeBranch(raw: unknown, id: () => string): MindBranch {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    id: asText(o.id) || id(),
    text: asText(o.text),
    children: Array.isArray(o.children) ? o.children.map((c) => normalizeBranch(c, id)) : [],
  }
}

/**
 * 读一条批注。形状不对就退回最近能用的解释，并在彻底认不出时返回 null。
 *
 * 这里宽容是有意的：工程文件是给人手改的（它同时是 diff 的对象）。但**宽容不等于装死** ——
 * 调用方（`textToProject`）会把跳过的条数报出来，"这一条没读进来"必须看得见。
 */
export function normalizeAnnotation(raw: unknown, newBranchId: () => string): Annotation | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = asText(o.id)
  if (!id) return null
  const pos = (o.position && typeof o.position === 'object' ? o.position : {}) as Record<string, unknown>
  const x = Number(pos.x)
  const y = Number(pos.y)
  const position: AnnotationPosition = {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  }
  const groupPath = Array.isArray(o.groupPath)
    ? o.groupPath.filter((id): id is string => typeof id === 'string' && id.length > 0)
    : []
  const title = asText(o.title)
  const kind = o.kind

  if (kind === 'table') {
    const rawCols = Array.isArray(o.columns) ? o.columns.map((c) => asText(c)) : []
    // 表头全空时至少给一列：零列的表格在界面上没法操作（没有格子可点）
    const columns = rawCols.length ? rawCols : ['']
    const rawRows = Array.isArray(o.rows) ? o.rows : []
    return {
      id,
      kind,
      position,
      groupPath,
      title,
      columns,
      rows: rawRows.map((r) => fitRow(columns, r)),
    }
  }

  if (kind === 'mindmap') {
    const root =
      o.root && typeof o.root === 'object' ? normalizeBranch(o.root, newBranchId) : null
    return {
      id,
      kind,
      position,
      groupPath,
      title,
      root: root ?? { id: newBranchId(), text: '', children: [] },
    }
  }

  if (kind === 'image') {
    const src = asText(o.src)
    if (!src) return null
    const width = finiteSize(Number(o.width), ANNOTATION_NOMINAL.image.w)
    const height = finiteSize(Number(o.height), ANNOTATION_NOMINAL.image.h)
    const source = asText(o.source)
    return {
      id,
      kind,
      position,
      groupPath,
      title,
      src,
      alt: asText(o.alt, '画布图片'),
      width,
      height,
      ...(source ? { source } : {}),
    }
  }

  return null
}

/** 打开工程时报给人看的那一句：这条批注是什么、有多大 */
export function annotationSummary(a: Annotation): string {
  const name = a.title || (a.kind === 'table' ? '表格' : a.kind === 'mindmap' ? '思维图' : '图片')
  if (a.kind === 'table') return `${name} ${a.rows.length} 行 × ${a.columns.length} 列`
  if (a.kind === 'mindmap') return `${name} ${mindCount(a.root) - 1} 支`
  return `${name} ${a.width} × ${a.height}`
}
