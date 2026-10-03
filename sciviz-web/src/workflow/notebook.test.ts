import test from 'node:test'
import assert from 'node:assert/strict'
import { nodeReference, notebookLength, notebookOutline, renderNotebook } from './notebook'

const none = () => null
const alive = (id: string) => (id === 'n1' ? '数据源' : null)

test('大纲从标题生成，代码块里的井号不算标题', () => {
  const outline = notebookOutline(
    ['# 实验 1', '正文', '## 现象', '```', '# 这不是标题', '```', '### 结论'].join('\n'),
  )
  assert.deepEqual(
    outline.map((item) => `${item.level}:${item.title}`),
    ['1:实验 1', '2:现象', '3:结论'],
  )
  assert.equal(outline[1].offset, '# 实验 1\n正文\n'.length, 'offset 是行首下标，点大纲要跳到这里')
})

test('空笔记没有大纲、字数为 0', () => {
  assert.deepEqual(notebookOutline(''), [])
  assert.equal(notebookLength('  \n\n '), 0)
  assert.equal(notebookLength('换密封之后 振动 减半'), 9, '按去空白后的字符数算，中文一个字一个')
})

test('渲染：标题、段落、列表、代码块都认得', () => {
  const html = renderNotebook(
    ['# 标题', '', '一段话', '', '- 甲', '- 乙', '', '1. 一', '2. 二', '', '```py', 'print(1)', '```'].join('\n'),
    none,
  )
  assert.match(html, /<h1>标题<\/h1>/)
  assert.match(html, /<p>一段话<\/p>/)
  assert.match(html, /<ul><li>甲<\/li><li>乙<\/li><\/ul>/)
  assert.match(html, /<ol><li>一<\/li><li>二<\/li><\/ol>/)
  assert.match(html, /<pre class="nb-code"><code>print\(1\)<\/code><\/pre>/)
})

test('渲染：模型常见的表格、引用块和删除线不把 Markdown 符号原样露出来', () => {
  const html = renderNotebook(
    ['| 指标 | 数值 |', '| --- | ---: |', '| RMSE | **0.42** |', '', '> 这是结论', '', '~~旧结论~~'].join('\n'),
    none,
  )
  assert.match(html, /<table class="nb-table">/)
  assert.match(html, /<th>指标<\/th>/)
  assert.match(html, /<td><strong>0\.42<\/strong><\/td>/)
  assert.match(html, /<blockquote><p>这是结论<\/p><\/blockquote>/)
  assert.match(html, /<del>旧结论<\/del>/)
  assert.equal(html.includes('| --- |'), false)
})

test('渲染：一切文本先转义 —— 笔记会跟着工程文件在人与人之间传', () => {
  const html = renderNotebook('<img src=x onerror=alert(1)> 与 **粗** 与 `a<b`', none)
  assert.equal(html.includes('<img src=x'), false, '内联 HTML 不该被当成 HTML 执行')
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
  assert.match(html, /<strong>粗<\/strong>/)
  assert.match(html, /<code>a&lt;b<\/code>/)
})

test('图片只放行 data:image 与 http(s)，别的原样留成文字', () => {
  const ok = renderNotebook('![谱](data:image/png;base64,AAA)', none)
  assert.match(ok, /<img class="nb-img" src="data:image\/png;base64,AAA"/)
  const bad = renderNotebook('![x](javascript:alert(1))', none)
  assert.equal(bad.includes('<img'), false)

  const link = renderNotebook('[主页](https://example.com)', none)
  assert.match(link, /<a href="https:\/\/example.com"/)
  assert.equal(renderNotebook('[坏](javascript:alert(1))', none).includes('<a '), false)
})

test('节点引用：活的能点（带 data-node），删掉的只是灰字', () => {
  const html = renderNotebook('上游用 @[时域特征](node:n1) 和 @[没了](node:n9)', alive)
  assert.match(html, /<button type="button" class="nb-node" data-node="n1">时域特征<\/button>/)
  assert.match(html, /<span class="nb-node gone"/)
  assert.equal(html.includes('data-node="n9"'), false, '已经不在图里的块不该还能点')
})

test('插入引用的写法与渲染认得的那种一致', () => {
  const text = nodeReference('n7', '时域特征')
  assert.equal(text, '@[时域特征](node:n7)')
  assert.match(renderNotebook(text, () => '时域特征'), /data-node="n7"/)
})
