import test from 'node:test'
import assert from 'node:assert/strict'
import {
  annotationSummary,
  annotationsInGroupPath,
  cloneAnnotation,
  copyAnnotationScope,
  createAnnotation,
  createImageAnnotation,
  moveAnnotationsIntoGroup,
  mindChild,
  mindCount,
  mindFind,
  mindRemoved,
  mindText,
  normalizeAnnotation,
  reattachCopiedAnnotations,
  removeGroupAnnotations,
  tableCell,
  tableColumnAdded,
  tableColumnLabel,
  tableColumnRemoved,
  tableRowAdded,
  tableRowRemoved,
  ungroupAnnotationScopes,
  wrapAnnotationScopes,
  type ImageAnnotation,
  type MindmapAnnotation,
  type TableAnnotation,
} from './annotations'

/** 分支 id 生成器：测试里要的是"每次都不同"，不是随机 */
let n = 0
const nid = () => `m${++n}`

const table = (columns: string[], rows: string[][]): TableAnnotation => ({
  id: 'a1',
  kind: 'table',
  position: { x: 0, y: 0 },
  title: '',
  columns,
  rows,
})

const mind = (): MindmapAnnotation =>
  createAnnotation('mindmap', 'a2', { x: 0, y: 0 }, nid) as MindmapAnnotation

/* ---------------- 起手形状 ---------------- */

test('新建批注给的是能直接用的形状，不是空白', () => {
  const t = createAnnotation('table', 'a1', { x: 10, y: 20 }, nid) as TableAnnotation
  assert.equal(t.columns.length, 2, '起手就有表头，否则用户面对一张零列的表无从下手')
  assert.equal(t.rows.length, 3)
  for (const r of t.rows) assert.equal(r.length, t.columns.length, '每行与表头等长')

  const m = createAnnotation('mindmap', 'a2', { x: 0, y: 0 }, nid) as MindmapAnnotation
  assert.ok(m.root.id, '根节点要有 id，否则加子支时找不到父')
  assert.equal(m.root.children.length, 0)
})

/* ---------------- 表格 ---------------- */

test('改一格只动那一格', () => {
  const a = table(['指标', '值'], [['液位', '67'], ['流量', '7.7']])
  const b = tableCell(a, 1, 1, '7.8')
  assert.deepEqual(b.rows, [['液位', '67'], ['流量', '7.8']])
  assert.deepEqual(a.rows, [['液位', '67'], ['流量', '7.7']], '原对象不能被改：界面靠引用变化重渲染')
})

test('加行加列之后每一行仍然与表头等长', () => {
  let a = table(['A', 'B'], [['1', '2']])
  a = tableColumnAdded(a)
  assert.deepEqual(a.columns, ['A', 'B', ''])
  assert.deepEqual(a.rows, [['1', '2', '']], '老数据行要补上空列')
  a = tableRowAdded(a, 0)
  assert.equal(a.rows.length, 2)
  assert.deepEqual(a.rows[1], ['', '', ''], '插在指定行之后')
})

test('删列会带走那一列的数据，但最后一列删不掉', () => {
  let a = table(['A', 'B'], [['1', '2']])
  a = tableColumnRemoved(a, 0)
  assert.deepEqual(a.columns, ['B'])
  assert.deepEqual(a.rows, [['2']])
  const b = tableColumnRemoved(a, 0)
  assert.deepEqual(b.columns, ['B'], '只剩一列时不让删：那已经不是表格了，而表头没了恢复不了')
})

test('删行', () => {
  const a = table(['A'], [['1'], ['2'], ['3']])
  assert.deepEqual(tableRowRemoved(a, 1).rows, [['1'], ['3']])
})

test('改表头不动数据', () => {
  const a = table(['A', 'B'], [['1', '2']])
  const b = tableColumnLabel(a, 0, '液位')
  assert.deepEqual(b.columns, ['液位', 'B'])
  assert.deepEqual(b.rows, [['1', '2']])
})

/* ---------------- 思维图 ---------------- */

test('加子支、改文字、删一支', () => {
  let a = mind()
  const rootId = a.root.id
  a = { ...a, root: mindChild(a.root, rootId, 'c1', '工况') }
  assert.equal(mindCount(a.root), 2)
  assert.equal(mindFind(a.root, 'c1')?.text, '工况')

  a = { ...a, root: mindChild(a.root, 'c1', 'c2', '900rpm') }
  assert.equal(mindCount(a.root), 3, '能给子支再加子支')

  a = { ...a, root: mindText(a.root, 'c2', '1200rpm') }
  assert.equal(mindFind(a.root, 'c2')?.text, '1200rpm')

  a = { ...a, root: mindRemoved(a.root, 'c1') }
  assert.equal(mindCount(a.root), 1, '删一支连着它的子支一起删')
})

test('根删不掉', () => {
  const a = mind()
  const kept = mindRemoved(a.root, a.root.id)
  assert.equal(kept.id, a.root.id, '没有根的思维图不该存在')
})

/* ---------------- 从文件读回来 ---------------- */

test('认不出的条目返回 null，而不是编一条出来', () => {
  assert.equal(normalizeAnnotation(null, nid), null)
  assert.equal(normalizeAnnotation({ kind: 'table' }, nid), null, '没有 id 的批注没法被引用，留着只会删不掉')
  assert.equal(
    normalizeAnnotation({ id: 'a9', kind: 'note', text: '旧便签' }, nid),
    null,
    '便签已经下架（记录搬到实验笔记栏）：它不再是一条合法批注，读进来会跳过并报数',
  )
  assert.equal(normalizeAnnotation({ id: 'a1', kind: '折线' }, nid), null)
})

test('行列不等长时按表头修齐（多出来的截掉、缺的补空）', () => {
  const wide = normalizeAnnotation(
    { id: 'a1', kind: 'table', columns: ['A', 'B'], rows: [['1', '2', '3']] },
    nid,
  ) as TableAnnotation
  assert.deepEqual(wide.rows, [['1', '2']], '文件里多出来的那一格不会凭空变成一列')

  const thin = normalizeAnnotation(
    { id: 'a2', kind: 'table', columns: ['A', 'B', 'C'], rows: [['1']] },
    nid,
  ) as TableAnnotation
  assert.deepEqual(thin.rows, [['1', '', '']], '缺的补空，渲染层才不需要到处防 undefined')
})

test('数字与布尔写成裸值也认（人手工改 YAML 时常这么写）', () => {
  const a = normalizeAnnotation(
    { id: 'a1', kind: 'table', columns: ['n'], rows: [[1024], [true]] },
    nid,
  ) as TableAnnotation
  assert.deepEqual(a.rows, [['1024'], ['true']])
})

test('零列的表格退回一列（没有格子可点的图等于没法用）', () => {
  const a = normalizeAnnotation({ id: 'a1', kind: 'table', columns: [], rows: [] }, nid) as TableAnnotation
  assert.equal(a.columns.length, 1, '零列的表格在界面上没有格子可点，等于一张没法用的图')
})

test('position 缺数字时按 0 落位，而不是 NaN 把节点丢进看不见的地方', () => {
  const a = normalizeAnnotation({ id: 'a1', kind: 'table', position: { x: 'abc' } }, nid)!
  assert.equal(Number.isFinite(a.position.x), true)
})

test('图片批注保留源数据与尺寸，并能从文件形状读回', () => {
  const image = createImageAnnotation(
    'a-image',
    { x: 12, y: 18 },
    'data:image/png;base64,abc',
    { width: 240, height: 120 },
    '截图',
    '剪贴板截图',
  )
  assert.equal(image.kind, 'image')
  assert.equal(image.src, 'data:image/png;base64,abc')
  assert.deepEqual({ width: image.width, height: image.height }, { width: 240, height: 120 })
  const back = normalizeAnnotation(image, nid)
  assert.deepEqual(back, image)
})

test('图片标题可多行往返，旧图片缺标题时仍为空', () => {
  const image = createImageAnnotation(
    'titled-image',
    { x: 0, y: 0 },
    'data:image/png;base64,abc',
    { width: 520, height: 360 },
    '截图',
  )
  const titled: ImageAnnotation = { ...image, title: '设备调试截图\n异常点在右上角' }
  const back = normalizeAnnotation(titled, nid) as ImageAnnotation
  assert.equal(back.title, titled.title)
  assert.deepEqual({ width: back.width, height: back.height }, { width: 520, height: 360 })

  const legacy = normalizeAnnotation(
    { id: 'legacy-image', kind: 'image', src: 'data:image/png;base64,old' },
    nid,
  ) as ImageAnnotation
  assert.equal(legacy.title, '')
})

test('批注按组路径隔离，旧文件批注默认归主画布', () => {
  const rootTable = createAnnotation('table', 'root-table', { x: 0, y: 0 }, nid)
  const rootMindmap = createAnnotation('mindmap', 'root-map', { x: 0, y: 0 }, nid)
  const groupImage = createImageAnnotation('group-image', { x: 10, y: 20 }, 'data:image/png;base64,x', undefined, undefined, undefined, ['g1'])
  const nestedTable = { ...table(['A'], [['1']]), id: 'nested-table', groupPath: ['g1', 'g2'] }
  const legacy = normalizeAnnotation({ id: 'legacy', kind: 'table', rows: [['1']] }, nid)!
  const annotations = [rootTable, rootMindmap, groupImage, nestedTable, legacy]

  assert.deepEqual(annotationsInGroupPath(annotations, []).map((annotation) => annotation.id), [
    'root-table', 'root-map', 'legacy',
  ])
  assert.deepEqual(annotationsInGroupPath(annotations, ['g1']).map((annotation) => annotation.id), ['group-image'])
  assert.deepEqual(annotationsInGroupPath(annotations, ['g1', 'g2']).map((annotation) => annotation.id), ['nested-table'])
  assert.deepEqual(legacy.groupPath, [])
})

test('组合、移入、解散、复制和删除组块会同步维护批注层级', () => {
  const root = createAnnotation('table', 'root', { x: 1, y: 2 }, nid)
  const image = createImageAnnotation('image', { x: 3, y: 4 }, 'data:image/png;base64,x', undefined, undefined, undefined, ['inner'])
  const tableInNestedGroup = { ...table(['A'], [['1']]), id: 'table', groupPath: ['inner', 'nested'] }
  const source = [root, image, tableInNestedGroup]

  const moved = moveAnnotationsIntoGroup(source, new Set(['root']), [], 'outer')
  assert.deepEqual(moved[0].groupPath, ['outer'])
  const wrapped = wrapAnnotationScopes(moved, [], 'wrapper', new Set(), new Set(['outer', 'inner']))
  assert.deepEqual(wrapped.map((annotation) => annotation.groupPath), [
    ['wrapper', 'outer'], ['wrapper', 'inner'], ['wrapper', 'inner', 'nested'],
  ])

  assert.deepEqual(ungroupAnnotationScopes(wrapped, [], 'wrapper').map((annotation) => annotation.groupPath), [
    ['outer'], ['inner'], ['inner', 'nested'],
  ])
  assert.deepEqual(removeGroupAnnotations(wrapped, [], 'wrapper'), [])
})

test('复制一块画布内容：组块内部的批注跟着走，路径相对化后可粘到别的层级', () => {
  const rootTable = createAnnotation('table', 'root-table', { x: 0, y: 0 }, nid)
  const rootMindmap = createAnnotation('mindmap', 'root-map', { x: 0, y: 0 }, nid)
  const inGroup = createImageAnnotation('g1-image', { x: 10, y: 20 }, 'data:image/png;base64,x', undefined, undefined, undefined, ['g1'])
  const inNested = { ...table(['A'], [['1']]), id: 'g1-g2-table', groupPath: ['g1', 'g2'] }
  const otherGroup = createImageAnnotation('g9-image', { x: 1, y: 1 }, 'data:image/png;base64,y', undefined, undefined, undefined, ['g9'])
  const source = [rootTable, rootMindmap, inGroup, inNested, otherGroup]

  // 只选中主画布里的思维图 + 组块 g1（g1 内部的批注整棵跟走，g9 的不跟）
  const scope = copyAnnotationScope(source, [], new Set(['root-map']), new Set(['g1']))
  assert.deepEqual(scope.map((item) => item.path), [[], ['g1'], ['g1', 'g2']])
  assert.deepEqual(scope.map((item) => item.annotation.id), ['root-map', 'g1-image', 'g1-g2-table'])

  // 粘到组块 "outer" 里：g1 换成新 id g1-new，嵌套那一层的相对路径原样接上
  let seq = 0
  const { annotations: pasted, ids } = reattachCopiedAnnotations(
    scope,
    ['outer'],
    new Map([['g1', 'g1-new']]),
    { x: 100, y: 200 },
    () => `copy-${++seq}`,
  )
  assert.deepEqual(pasted.map((annotation) => annotation.groupPath), [
    ['outer'], ['outer', 'g1-new'], ['outer', 'g1-new', 'g2'],
  ])
  assert.deepEqual(pasted.map((annotation) => annotation.position), [
    { x: 100, y: 200 }, { x: 110, y: 220 }, { x: 100, y: 200 },
  ])
  assert.equal(new Set(ids).size, 3, '每条副本都要有新 id')
  assert.deepEqual(pasted.map((annotation) => annotation.id), ids)

  // 路径里出现这次没复制的组块 id：丢掉那一条，而不是挂到别的层级上去凑数
  const dangling = reattachCopiedAnnotations(
    [{ annotation: inGroup, path: ['g1'] }],
    [],
    new Map(),
    { x: 0, y: 0 },
    () => 'copy-x',
  )
  assert.deepEqual(dangling.ids, [])
})

test('深拷贝批注：改副本的一格不会串到原件（表格行数组与思维图子树原本是共享的）', () => {
  const original = table(['A', 'B'], [['1', '2']])
  const copy = cloneAnnotation(original, 'a2') as TableAnnotation
  assert.equal(copy.id, 'a2')
  copy.rows[0][0] = '改了'
  assert.equal(original.rows[0][0], '1')

  const mindmap = mind()
  const mindCopy = cloneAnnotation(mindmap) as MindmapAnnotation
  assert.notEqual(mindCopy.root, mindmap.root)
  assert.deepEqual(mindCopy.root, mindmap.root, '子树内容相同但不共享引用')

  const image = createImageAnnotation('img', { x: 0, y: 0 }, 'data:image/png;base64,x')
  const imageCopy = cloneAnnotation(image) as ImageAnnotation
  assert.equal(imageCopy.src, image.src, '图片内容共享同一份 data URL（字符串不可变）')
  assert.notEqual(imageCopy.position, image.position)
})

test('摘要说得出这条批注有多大', () => {
  const t = table(['A', 'B'], [['1', '2'], ['3', '4']])
  assert.equal(annotationSummary({ ...t, title: '读数' }), '读数 2 行 × 2 列')
  let m = mind()
  m = { ...m, root: mindChild(m.root, m.root.id, 'c1') }
  assert.equal(annotationSummary(m), '思维图 1 支', '支数不含根本身')
})
