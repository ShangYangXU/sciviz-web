import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_REPORT_IMAGE_BYTES,
  MAX_REPORT_IMAGE_COUNT,
  materializeReportFigures,
  reportFigureReference,
  validateProjectReports,
  validateReportImages,
  validateReportMarkdown,
  type ReportImage,
  type StagedReportImage,
} from './report'
import type { ProjectReport } from './project'

/**
 * 报告契约的钉子。
 *
 * 报告要能**离开这个软件**：下载成 `.md`、跟着 `.sciviz` 换台机器、贴进别的地方。
 * 所以这里压的不是"能拼出字符串"，而是三件会静默坏掉的事：
 * - 模型看到的引用与最终文件里的图片必须是同一个东西（占位符必须全部解析掉）；
 * - 图片超出体积上限要**拒绝**，不能悄悄裁成一张更小的图（那会让人拿着假证据下结论）；
 * - 图源要写进正文 —— 半年后回看，得知道这张图是哪个块、哪次参数下算出来的。
 */

const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

/** 按真实字节数造一个内嵌 PNG：体积上限是按解码后的字节算的，不是按 base64 字符数 */
const png = (bytes: number, fill = 1): string =>
  `data:image/png;base64,${Buffer.alloc(bytes, fill).toString('base64')}`

const figure = (overrides: Partial<ReportImage> = {}): ReportImage => ({
  dataUrl: png(32),
  sha256: HASH_A,
  width: 320,
  height: 200,
  nodeId: 'chart-1',
  groupPath: [],
  label: '对比曲线',
  runtimeId: 'chart-1',
  portId: 'figure',
  ...overrides,
})

test('图像引用先是一个占位符：标题里的方括号与换行不能换成 Markdown 语法', () => {
  assert.equal(
    reportFigureReference(figure(), '工作段 1'),
    `![工作段 1](report-figure:${HASH_A})`,
  )
  assert.match(reportFigureReference(figure(), '损失 [曲线]\n对比'), /^!\[损失 +曲线 +对比\]\(report-figure:a{64}\)$/)
  assert.equal(reportFigureReference(figure(), ''), `![画布图像](report-figure:${HASH_A})`, '没给说明也要有一个能显示的替代文字')
  assert.throws(() => reportFigureReference({ ...figure(), sha256: 'not-a-hash' }), /SHA-256/)
})

test('显式引用的图展开成可携带的图片，并带上图源', () => {
  const staged: StagedReportImage[] = [{ figure: figure(), caption: '工作段 1' }]
  const { markdown, figures } = materializeReportFigures(
    `# 工作段对比\n\n${reportFigureReference(figure(), '工作段 1')}\n`,
    staged,
  )

  assert.match(markdown, /^# 工作段对比\n\n!\[工作段 1\]\(data:image\/png;base64,/)
  assert.doesNotMatch(markdown, /report-figure:/, '留着占位符的报告在别的软件里就是一张裂图')
  // 图源那句写的是**画布块名**（这张图是哪个块算出来的），与报告作者给的图片说明是两件事
  assert.match(markdown, new RegExp(`图源：对比曲线；节点 \`chart-1\`；画布路径 \`主画布\`；端口 \`figure\`；SHA-256 \`${HASH_A}\``))
  assert.deepEqual(figures.map((item) => item.id), [HASH_A])
  assert.equal(figures[0].caption, '工作段 1')
  assert.equal(figures[0].width, 320)
})

test('采集了却没写进正文的图，进「图像证据」附录而不是被丢掉', () => {
  const staged: StagedReportImage[] = [
    { figure: figure({ groupPath: ['组块 A'], runtimeId: 'g:chart-1' }), caption: '工作段 1' },
    { figure: figure({ sha256: HASH_B, label: '工作段 2', dataUrl: png(48, 2) }), caption: '工作段 2' },
  ]
  const { markdown, figures } = materializeReportFigures(
    `# 报告\n\n${reportFigureReference(staged[0].figure, '工作段 1')}\n`,
    staged,
  )

  assert.match(markdown, /## 图像证据/)
  assert.match(markdown, /### 工作段 2/)
  assert.match(markdown, /!\[工作段 2\]\(data:image\/png;base64,/)
  assert.match(markdown, /画布路径 `组块 A`/, '组块里的图要留下它在哪一层')
  assert.deepEqual(figures.map((item) => item.id), [HASH_A, HASH_B])
  assert.equal(markdown.match(/data:image\/png;base64,/g)?.length, 2, '两张图都得进正文')
})

test('引用了一张没采集过的图：当场报错，不交一份缺图的报告', () => {
  assert.throws(
    () => materializeReportFigures(reportFigureReference(figure(), '缺图'), []),
    /尚未采集/,
  )
})

test('图像数量与体积越界都明确拒绝，不裁剪成功', () => {
  const many: StagedReportImage[] = Array.from({ length: MAX_REPORT_IMAGE_COUNT + 1 }, (_, index) => ({
    figure: figure({ sha256: index.toString(16).padStart(64, '0'), dataUrl: png(16) }),
    caption: `图 ${index}`,
  }))
  assert.throws(() => validateReportImages(many), new RegExp(`最多保存 ${MAX_REPORT_IMAGE_COUNT} 张图`))

  const huge: StagedReportImage[] = [{ figure: figure({ dataUrl: png(MAX_REPORT_IMAGE_BYTES + 4096) }), caption: '大图' }]
  assert.throws(() => validateReportImages(huge), /不能超过 8 MiB/)

  validateReportImages([{ figure: figure(), caption: '小图' }])
})

test('正文里残留未解析的引用：拒绝保存', () => {
  assert.throws(
    () => validateReportMarkdown(`# 报告\n\n![图](report-figure:${HASH_A})\n`),
    /未解析/,
  )
  assert.throws(() => validateReportMarkdown(`# 报告\n\n${'字'.repeat(1024 * 1024)}\n`), /不能超过 1 MiB/)
  validateReportMarkdown('# 报告\n\n普通正文。\n')
})

test('工程报告集合：ID 唯一、标题非空、正文里的图必须是内嵌的', () => {
  const report = (overrides: Partial<ProjectReport> = {}): ProjectReport => ({
    id: 'report-1',
    title: '工作段对比实验报告',
    markdown: '# 报告\n\n普通正文。\n',
    createdAt: '2026-09-26T01:00:00.000Z',
    updatedAt: '2026-09-26T02:00:00.000Z',
    figures: [],
    ...overrides,
  })

  validateProjectReports([report()])
  assert.throws(() => validateProjectReports([report(), report()]), /ID 为空或重复/)
  assert.throws(() => validateProjectReports([report({ title: '   ' })]), /标题不能为空/)
  assert.throws(
    () => validateProjectReports([report({ markdown: `![图](report-figure:${HASH_A})` })]),
    /未解析/,
  )
})
