/**
 * SciViz 当前项目契约的浏览器冒烟测试。
 *
 * 只检查真实产品入口：启动为空白画布、节点库不含已删除的演示节点，
 * 自定义模型可以连接到通用训练函数，固定训练节点仅供旧工程兼容。
 *
 * 用法：
 *   node scripts/e2e.mjs [url] [--headed]
 *   SCIVIZ_E2E_ONLY=报告 node scripts/e2e.mjs     # 只跑名字里含「报告」的用例
 *   npm run e2e
 */
import { existsSync } from 'node:fs'
import { readdirSync, readFileSync } from 'node:fs'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'

const URL = process.argv[2] ?? 'http://localhost:5174/'
/**
 * 只想复现一条用例时用它。完整跑一遍要十几分钟（Pyodide + Matplotlib 每开一个上下文就现加载一次），
 * 排查单条时不必等全量；不设这个变量时行为与从前完全一致。
 */
const ONLY = process.env.SCIVIZ_E2E_ONLY ?? ''
const CHROME = [
  process.env.CHROME_PATH,
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((path) => path && existsSync(path))

class Skip extends Error {}

const REMOVED_LIBRARY_ITEMS = [
  '信号分帧',
  '数据划分',
  '数据增强',
  '时域特征',
  '频域特征',
  '时频特征',
  '训练 MLP（真算）',
  '训练 1D-CNN（真算）',
  '训练自定义模型（真算）',
]

let page
const results = []

/**
 * 对话留存的浏览器端验收要一个真的宿主。这里起一个假 provider 的宿主（8799，避开用户自己的 8765），
 * 状态目录用临时目录 —— 这一条压的是"一个工程多个子对话、切回来还在、磁盘上真有那份 JSONL"，
 * 不是模型回答得好不好。
 */
const CHAT_HOST_PORT = 8799
/**
 * 假宿主的地址。用 `let` 是因为每次起都是**换一个空闲端口** —— 见 `stopChatHost` 那段注释。
 */
let CHAT_HOST_URL = `http://127.0.0.1:${CHAT_HOST_PORT}`

/** 拿一个当前空闲的本地端口：泄漏的旧宿主占着固定端口时，新宿主会静默起不来。 */
async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

async function startChatHost() {
  const python = fileURLToPath(new globalThis.URL('../../.venv/Scripts/python.exe', import.meta.url))
  if (!existsSync(python)) throw new Skip('找不到仓库根 .venv 的 python，跳过对话留存验收')
  const repo = fileURLToPath(new globalThis.URL('../..', import.meta.url))
  const stateDir = mkdtempSync(join(tmpdir(), 'sciviz-e2e-chat-'))
  const port = await freePort()
  CHAT_HOST_URL = `http://127.0.0.1:${port}`
  const child = spawn(python, ['-m', 'uvicorn', 'sciviz_host.server:create_app', '--factory', '--port', String(port), '--host', '127.0.0.1', '--log-level', 'warning'], {
    cwd: join(repo, 'sciviz-local'),
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.endsWith('API_KEY'))), SCIVIZ_STATE_DIR: stateDir, SCIVIZ_AGENT_PROVIDER: 'mock', SCIVIZ_AGENT_MODEL: 'mock-model' },
    stdio: 'ignore',
    windowsHide: true,
  })
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${CHAT_HOST_URL}/agent/config`)
      if (response.ok) return { child, stateDir }
    } catch {
      // 还没起来
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  child.kill()
  throw new Skip('假宿主 30 秒内没起来，跳过对话留存验收')
}

/*
 * 停假宿主必须杀**整棵进程树**：Windows 上 `.venv\Scripts\python.exe` 是个 launcher，
 * 它再起基础解释器（AGENTS.md §6 那条），`child.kill()` 只杀得掉 launcher ——
 * 真正监听端口的那个进程会活下来。实测症状：下一次 `startChatHost()` 绑不上端口，
 * 而 `/agent/config` 由那个泄漏进程应答，于是"宿主起来了、对话栏却是灰的"，
 * 失败信息还指向输入框。端口也顺手改成每次取空闲的，别让上一次的残留决定这次能不能跑。
 */
function stopChatHost(hosting) {
  const pid = hosting?.child?.pid
  if (pid && process.platform === 'win32') {
    /*
     * 用绝对路径找 taskkill：执行回归的那个 shell 不一定把 `C:\Windows\System32` 放进 PATH
     * （实测：Codex 的 exec 环境里裸写 `taskkill` 解析不到）。而且 spawnSync 起不来进程这件事
     * 是**返回值里的 `error`，不抛异常** —— 原先只包 try/catch，于是"杀过了"只是看起来像，
     * 宿主会一直活到下一次运行（顺带让这里的临时目录删不掉）。
     */
    const root = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
    const taskkill = join(root, 'System32', 'taskkill.exe')
    const killed = spawnSync(existsSync(taskkill) ? taskkill : 'taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    })
    if (killed.error) {
      try {
        process.kill(pid)
      } catch {
        // 已经退了
      }
    }
  } else {
    try {
      hosting?.child.kill()
    } catch {
      // 已经退了
    }
  }
  /*
   * 临时目录是**尽力**清理，不是断言的一部分：Windows 上进程刚被杀时可能还攥着文件句柄，
   * 那一刻删目录会抛 ENOTEMPTY —— 那不该把一条已经通过的科学断言变成 FAIL。
   */
  if (hosting?.stateDir) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        rmSync(hosting.stateDir, { recursive: true, force: true })
        break
      } catch {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
      }
    }
  }
}

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

async function check(name, fn) {
  if (ONLY && !name.includes(ONLY)) return
  try {
    record(name, true, (await fn()) ?? '')
  } catch (error) {
    if (error instanceof Skip) {
      results.push({ name, skipped: true, detail: error.message })
      console.log(`  SKIP  ${name}  — ${error.message}`)
      return
    }
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}

const fail = (message) => {
  throw new Error(message)
}

const nodeSel = (id) => `.react-flow__node[data-id="${id}"]`
const nodeCount = () => page.locator('.wf-node').count()

/**
 * 等画布上的块数变成期望值。
 *
 * 不写成"点一下、等 300ms、数一遍"：粘贴这条路上有一次**异步的剪贴板读取**
 * （见 `canvas/blockClipboard.ts`），固定的等待时间在忙的机器上必然偶发失败 ——
 * 而失败信息看起来像"粘贴没生效"，实际只是还没轮完。
 */
async function expectNodeCount(expected, message) {
  try {
    await page.waitForFunction((n) => document.querySelectorAll('.wf-node').length === n, expected, { timeout: 8000 })
  } catch {
    fail(`${message}（期望 ${expected} 个块，实际 ${await nodeCount()} 个）`)
  }
}

/**
 * 等连线数到位再断言。
 *
 * 与 `expectNodeCount` 同一个道理：撤销之后**块**先回来、**边**重渲染晚一拍，直接读一次
 * `.react-flow__edge` 会偶发读到中间态 —— 那条用例本轮闪断过三次，看着像产品缺陷，其实是读数早了一步。
 */
async function expectEdgeCount(expected, message) {
  try {
    await page.waitForFunction((n) => document.querySelectorAll('.react-flow__edge').length === n, expected, { timeout: 8000 })
  } catch {
    const actual = await page.locator('.react-flow__edge').count()
    fail(`${message}（期望 ${expected} 条连线，实际 ${actual} 条）`)
  }
}

/**
 * 等画布上那句一闪而过的提示出现指定内容。
 *
 * 复制是**异步**的（要先把载荷写进系统剪贴板，见 `canvas/blockClipboard.ts`），
 * 而"已复制 …，Ctrl+V 粘贴"这句只会在写成功之后才出现 —— 所以它既是给人看的提示，
 * 也是"现在按 Ctrl+V 一定粘得到"的同步点。抢在它前面按键，粘到的可能是上一次的内容。
 */
async function waitForStatus(text, timeout = 6000) {
  try {
    await page.waitForFunction(
      (expected) => (document.querySelector('.canvas-paste-message')?.textContent ?? '').includes(expected),
      text,
      { timeout },
    )
  } catch {
    const current = await page.locator('.canvas-paste-message').textContent().catch(() => '无')
    fail(`等不到提示「${text}」（当前：${current}）`)
  }
}

const libCard = (label) =>
  page
    .locator('.lib-node')
    .filter({
      // host-only 条目会在名称后显示「检查中 / 需宿主 / 本地模式」徽标；定位卡片时
      // 把状态徽标当作独立元数据，而不是名字的一部分。
      has: page.locator('.lib-node-name', {
        hasText: new RegExp(`^${label}(?:自建|本地模式|需宿主|检查中)?$`),
      }),
    })
    .first()

async function openBlankCanvas() {
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.canvas-host', { timeout: 15000 })
}

async function lastNodeId() {
  const ids = await page
    .locator('.react-flow__node')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('data-id')))
  return ids[ids.length - 1]
}

async function handleCenter(nodeId, portId, kind) {
  const handle = page.locator(
    `${nodeSel(nodeId)} .react-flow__handle.${kind}[data-handleid="${portId}"]`,
  )
  if ((await handle.count()) === 0) fail(`找不到端口 ${nodeId}:${portId}（${kind}）`)
  const box = await handle.first().boundingBox()
  if (!box) fail(`端口 ${nodeId}:${portId} 不可见`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function pointerDrag(from, to, steps = 24) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + 3, from.y + 3, { steps: 2 })
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
}

/**
 * 等画布的位移/缩放停稳。
 *
 * 新加节点会触发一次"贴合内容"的动画（`fitView`，300ms）。在动画中间量节点盒子，
 * 量到的是两个不同时刻的坐标 —— 用它算出来的"缝"必然对不上，而那看起来像是吸附错了。
 */
async function waitForStillViewport(timeoutMs = 4000) {
  const read = () =>
    page.locator('.react-flow__viewport').evaluate((el) => getComputedStyle(el).transform)
  let previous = await read()
  let stable = 0
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && stable < 2) {
    await page.waitForTimeout(120)
    const current = await read()
    stable = current === previous ? stable + 1 : 0
    previous = current
  }
}

async function main() {
  if (!CHROME) throw new Skip('未找到 Chromium / Chrome / Edge，请设置 CHROME_PATH')
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: !process.argv.includes('--headed'),
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  })
  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new globalThis.URL(URL).origin })
  await context.addInitScript(() => {
    localStorage.clear()
    localStorage.setItem('sciviz.engine', 'pyodide')
  })
  page = await context.newPage()
  page.on('pageerror', (error) => console.log(`  [页面异常] ${error.message}`))

  console.log('\n=== SciViz 当前项目 E2E ===\n')

  await check('桌面启动自动读取固定 Sheet1 数据集', async () => {
    let fixedFileRequested = false
    await page.route('http://127.0.0.1:8765/health', (route) => route.fulfill({
      status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ ok: true, fixedDatasetConfigured: true }),
    }))
    await page.route('http://127.0.0.1:8765/fixed-dataset/sheet1.csv', (route) => {
      fixedFileRequested = true
      return route.fulfill({
        status: 200,
        headers: { 'access-control-allow-origin': '*', 'content-type': 'text/csv; charset=utf-8' },
        body: 'time,value\n0,1\n1,2\n',
      })
    })
    const localUrl = new globalThis.URL(URL)
    localUrl.searchParams.set('engine', 'local')
    try {
      await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
      const chip = page.locator('.fixed-dataset-status')
      await page.getByText(/Sheet1 已就绪/).waitFor({ timeout: 10000 })
      const chipText = await chip.textContent()
      if (!chipText?.includes('Sheet1 已就绪')) fail(`固定数据集状态异常：${chipText}`)
      if (!fixedFileRequested) fail('桌面启动没有请求固定 CSV 接口')
      await page.getByRole('button', { name: '导入数据' }).click()
      const tab = page.locator('.dataset-tab').filter({ hasText: 'Sheet1' })
      await tab.waitFor({ timeout: 5000 })
      if (!(await tab.textContent())?.includes('2 行')) fail('固定 CSV 没有按原导入器解析成两行')
      await page.getByRole('button', { name: '完成' }).click()
      return '本地模式启动后自动解析，数据集列表显示 Sheet1（2 行）'
    } finally {
      await page.unroute('http://127.0.0.1:8765/fixed-dataset/sheet1.csv')
      await page.unroute('http://127.0.0.1:8765/health')
    }
  })

  await check('未配置固定数据集时启动不读取私人文件也不报缺文件', async () => {
    let requested = false
    await page.route('http://127.0.0.1:8765/health', (route) => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ ok: true, fixedDatasetConfigured: false }) }))
    await page.route('http://127.0.0.1:8765/fixed-dataset/sheet1.csv', (route) => { requested = true; return route.fulfill({ status: 404 }) })
    try {
      const localUrl = new globalThis.URL(URL)
      localUrl.searchParams.set('engine', 'local')
      await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(700)
      if (requested || await page.locator('.fixed-dataset-status').count()) fail('未配置仍尝试预载固定 CSV')
      return '空配置只显示空白画布，不请求固定文件'
    } finally {
      await page.unroute('http://127.0.0.1:8765/health')
      await page.unroute('http://127.0.0.1:8765/fixed-dataset/sheet1.csv')
    }
  })

  await check('启动为空白画布', async () => {
    await openBlankCanvas()
    const count = await nodeCount()
    if (count !== 0) fail(`启动时画布上有 ${count} 个节点，期望 0`)
    return '0 节点'
  })

  /*
   * 空画布 = 没有任何"要算的东西"。此前这一格里什么都不成立：执行面没选，
   * 顶栏把"这一页还没请求过引擎"渲染成"引擎未启动"（宿主在跑也这么说），
   * 宿主专属节点永远停在「检查中」。执行面是**页面级事实**，页面一起来就该确立。
   *
   * 判据刻意只用浏览器引擎：它按需加载、不需要宿主，因此在任何机器上都可判定。
   */
  await check('空画布上执行面照样说得清：不说"引擎未启动"，宿主专属块标出"需宿主"', async () => {
    await openBlankCanvas()
    const chip = page.locator('.engine-chip').filter({ hasNotText: 'Sheet1' }).first()
    const text = (await chip.textContent()) ?? ''
    if (text.includes('引擎未启动')) fail('空画布上顶栏仍在说"引擎未启动"——执行面应当已经确立')
    if (!text.includes('浏览器引擎待命')) fail(`顶栏没有说清当前执行面：${text}`)
    const badges = await page.locator('.lib-node-tag.host').allInnerTexts()
    if (badges.length === 0) fail('节点库里没有宿主专属块，这条判据失去意义')
    if (badges.some((badge) => badge.includes('检查中'))) {
      fail(`执行面已确立，宿主专属徽标却仍停在"检查中"：${JSON.stringify(badges)}`)
    }
    return `顶栏「${text}」，宿主专属徽标 ${JSON.stringify(badges)}`
  })

  await check('组块可封装步骤、双击进入并通过面包屑返回', async () => {
    await openBlankCanvas()
    await libCard('数据源').click()
    const source = await lastNodeId()
    await libCard('图表').click()
    const chart = await lastNodeId()

    await page.locator(nodeSel(source)).click()
    await page.locator(nodeSel(chart)).click({ modifiers: ['Control'] })
    await page.getByRole('button', { name: /组合为子空间/ }).click()
    await page.waitForTimeout(250)
    if ((await nodeCount()) !== 1) fail('组合后外层画布没有收敛为一个组块')
    await page.getByText('组块参数', { exact: true }).waitFor()

    const group = await lastNodeId()
    const groupNode = page.locator(nodeSel(group))
    if (!(await groupNode.textContent())?.includes('双击编辑内部')) fail('组块没有显示内部编辑提示')
    await groupNode.dblclick()
    await page.getByRole('navigation', { name: '组块路径' }).waitFor()
    if ((await nodeCount()) !== 2) fail('进入组块后没有显示原来的两个内部步骤')

    await page.getByRole('navigation', { name: '组块路径' }).getByRole('button').first().click()
    if ((await nodeCount()) !== 1) fail('点击根路径后没有返回外层组块画布')

    await page.locator(nodeSel(group)).click()
    await page.getByRole('button', { name: '⧉ 复制' }).click()
    await page.getByRole('button', { name: '⧉ 粘贴' }).click()
    await expectNodeCount(2, '复制组块后外层没有出现第二个组块')
    const copy = await lastNodeId()
    await page.locator(nodeSel(copy)).click()
    await page.getByRole('button', { name: '展开组块' }).click()
    await expectNodeCount(3, '展开副本后没有恢复两个内部节点')
    return '封装、进入、返回、复制和展开都可用'
  })

  await check('块与组合块可复制粘贴：内部连线跟着走，Ctrl+Z 一次撤回', async () => {
    await openBlankCanvas()
    await libCard('数据源').click()
    const source = await lastNodeId()
    await libCard('图表').click()
    const chart = await lastNodeId()
    await pointerDrag(
      await handleCenter(source, '__table__', 'source'),
      await handleCenter(chart, 'data', 'target'),
    )
    if ((await page.locator('.react-flow__edge').count()) !== 1) fail('前置：数据源与图表没有连上')
    await waitForStillViewport()

    await page.locator(nodeSel(source)).click()
    await page.locator(nodeSel(chart)).click({ modifiers: ['Control'] })
    await page.keyboard.press('Control+c')
    // 等这一句出现：它说明载荷真的进了系统剪贴板（跨标签页也能粘），同时保证下面按键时粘到的是它
    await waitForStatus('已复制 2 个块 · 1 条内部连线，Ctrl+V 粘贴')

    await page.keyboard.press('Control+v')
    await expectNodeCount(4, '粘贴后应当多出复制的那两个块')
    if ((await page.locator('.react-flow__edge').count()) !== 2) fail('两端都在选择里的连线没有跟着复制')
    // 重名的块加后缀：名字在这个项目里是能被点名的身份（inspect --node 名字）
    if ((await page.getByText('数据源 副本', { exact: true }).count()) === 0) fail('粘贴出来的块没有加「副本」后缀')
    // 粘出来的那一批是唯一选中 —— 接着拖/改的就是刚粘的
    if ((await page.locator('.react-flow__node.selected').count()) !== 2) fail('粘贴后没有把新块选上')

    await page.keyboard.press('Control+z')
    await expectNodeCount(2, 'Ctrl+Z 没有把一次粘贴整个撤回')
    await expectEdgeCount(1, '撤回后连线数没有回到原样')

    // 组合块：整块复制（内联子图跟着走），粘出来的副本可以再展开
    await page.locator(nodeSel(source)).click()
    await page.locator(nodeSel(chart)).click({ modifiers: ['Control'] })
    await page.getByRole('button', { name: /组合为子空间/ }).click()
    await page.waitForTimeout(250)
    if ((await nodeCount()) !== 1) fail('前置：组合后外层应当只剩一个组块')
    await page.keyboard.press('Control+c')
    await waitForStatus('已复制 1 个块，Ctrl+V 粘贴')
    await page.keyboard.press('Control+v')
    await expectNodeCount(2, '粘贴组合块后画布上应当有两个组块')
    await page.getByRole('button', { name: '展开组块' }).click()
    await expectNodeCount(3, '粘贴出来的组块没有带着内部步骤，展开后没有恢复它们')
    return '普通块与组合块都能复制粘贴，内部连线跟走，Ctrl+Z 一次撤回'
  })

  await check('画布批注按组块分层，图片可组合进只含批注的子空间', async () => {
    await openBlankCanvas()
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 2
      const context = canvas.getContext('2d')
      if (!context) throw new Error('无法创建图片测试画布')
      context.fillStyle = '#3677cc'
      context.fillRect(0, 0, 2, 2)
      const blob = await new Promise((resolve, reject) => canvas.toBlob((value) => {
        if (value) resolve(value)
        else reject(new Error('无法生成图片测试素材'))
      }, 'image/png'))
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob }),
      ])
    })
    await page.getByRole('button', { name: /粘贴图片/ }).click()
    const imageNode = page.locator('.react-flow__node').filter({ has: page.locator('.an-image') }).last()
    await imageNode.waitFor({ timeout: 5000 })
    const imageId = await imageNode.getAttribute('data-id')
    if (!imageId) fail('粘贴图片后没有画布节点 ID')
    const imageTitle = '设备启动截图：右上角异常'
    const titleInput = imageNode.getByRole('textbox', { name: '图片标题' })
    await titleInput.fill(imageTitle)
    await titleInput.evaluate((element) => element.blur())
    const widthSlider = imageNode.getByRole('slider', { name: '图片宽度' })
    const widthBefore = Number(await imageNode.locator('.an-image').getAttribute('width'))
    await widthSlider.focus()
    await widthSlider.press('ArrowRight')
    const widthAfter = Number(await imageNode.locator('.an-image').getAttribute('width'))
    if (widthAfter <= widthBefore) fail('调整图片宽度后显示尺寸没有变化')
    const heightSlider = imageNode.getByRole('slider', { name: '图片高度' })
    const heightBefore = Number(await imageNode.locator('.an-image').getAttribute('height'))
    await heightSlider.focus()
    await heightSlider.press('ArrowRight')
    const heightAfter = Number(await imageNode.locator('.an-image').getAttribute('height'))
    if (heightAfter <= heightBefore) fail('调整图片高度后显示尺寸没有变化')
    await libCard('表格').click()
    if (!(await imageNode.locator('.an-image-caption').textContent())?.includes(imageTitle)) {
      fail('粘贴图片标题没有在取消选中后显示')
    }
    const table = await lastNodeId()

    await page.locator(nodeSel(table)).click()
    await page.locator(nodeSel(imageId)).click({ modifiers: ['Control'] })
    await page.getByRole('button', { name: /组合为子空间/ }).click()
    const groupId = await page.locator('.react-flow__node').filter({ has: page.locator('.wf-node') }).last().getAttribute('data-id')
    if (!groupId) fail('图片和表格组合后没有创建工作流组块')
    const group = page.locator(nodeSel(groupId))
    if (!(await group.textContent())?.includes('画布批注子空间')) {
      fail(`图片和表格组合后没有创建批注子空间：${await group.textContent()}`)
    }
    const enterSubspace = async (stage) => {
      const groupNode = page.locator(nodeSel(groupId))
      const box = await groupNode.boundingBox()
      if (!box) fail(`${stage}时组块不在画布上`)
      const header = groupNode.locator('.wf-node-head')
      if (stage === '重新进入') {
        await groupNode.click()
        await page.getByRole('button', { name: '进入组块', exact: true }).click()
      } else {
        await header.dblclick()
      }
      try {
        await page.getByRole('navigation', { name: '组块路径' }).waitFor({ timeout: 5000 })
      } catch {
        const current = await page.locator('.react-flow__node').evaluateAll((elements) =>
          elements.map((element) => {
            const { x, y, width, height } = element.getBoundingClientRect()
            const target = document.elementFromPoint(x + width / 2, y + height - 12)
            return `${element.getAttribute('data-id')}:${element.textContent?.trim().slice(0, 24)}@${Math.round(x)},${Math.round(y)},${Math.round(width)},${Math.round(height)};hit=${target?.className}`
          }),
        )
        fail(`${stage}时双击没有进入子空间，画布内容：${current.join(' | ')}`)
      }
    }
    await enterSubspace('首次进入')
    if (!(await page.locator(nodeSel(table)).count())) fail('进入子空间后没有显示表格')
    if (!(await page.locator(nodeSel(imageId)).count())) fail('进入子空间后没有显示图片')

    await libCard('思维图').click()
    const nestedMindmap = await lastNodeId()
    if (!(await page.locator(nodeSel(nestedMindmap)).count())) fail('在子空间中新建的思维图没有显示')
    await page.getByRole('navigation', { name: '组块路径' }).getByRole('button').first().click()
    await libCard('表格').click()
    const rootTable = await lastNodeId()
    if (!(await page.locator(nodeSel(rootTable)).count())) fail('返回主画布后新建的表格没有显示')
    if (await page.locator(nodeSel(table)).count() || await page.locator(nodeSel(imageId)).count()) {
      fail('子空间的表格或图片泄漏到了主画布')
    }
    if (await page.locator(nodeSel(nestedMindmap)).count()) fail('子空间中新建的思维图泄漏到了主画布')
    await enterSubspace('重新进入')
    await page.waitForTimeout(180)
    const renderedIds = await page.locator('.react-flow__node').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-id')),
    )
    if (!renderedIds.includes(nestedMindmap)) {
      fail(`重新进入子空间后思维图没有保留：当前画布 ${renderedIds.join(', ')}`)
    }
    return '主画布与子空间内容各自隔离，图片、表格、思维图都留在所属层级'
  })

  await check('点一个块就能看清它的链路，点空白或 Esc 退出', async () => {
    await openBlankCanvas()
    await libCard('数据源').click()
    const first = await lastNodeId()
    await libCard('图表').click()
    const second = await page
      .locator('.react-flow__node')
      .filter({ has: page.locator('.wf-node') })
      .last()
      .getAttribute('data-id')
    if (!second) fail('没找到第二个块')
    await waitForStillViewport()

    const dimmed = () => page.locator('.react-flow__node.focus-dim').count()
    if ((await dimmed()) !== 0) fail('还没点就先淡化了')

    await page.locator(nodeSel(first)).locator('.wf-node-head').click()
    // 单击聚焦是延迟 200ms 做的（为了不和双击进组块打架），所以这里要多等一会儿
    await page.waitForTimeout(400)
    if ((await page.locator('.react-flow__node.focus-anchor').count()) !== 1) fail('点了块没有进入聚焦')
    if ((await dimmed()) !== 1) fail(`聚焦后应当只剩另一个块淡出，实际淡出 ${await dimmed()} 个`)
    const banner = await page.locator('.canvas-focus').textContent()
    if (!banner?.includes('链上')) fail('聚焦时没有说清这条链有多大')

    await page.keyboard.press('Escape')
    await page.waitForTimeout(250)
    if ((await dimmed()) !== 0 || (await page.locator('.canvas-focus').count()) !== 0) fail('Esc 没有退出聚焦')

    await page.locator(nodeSel(first)).locator('.wf-node-head').click()
    await page.waitForTimeout(400)
    // 点空白：取画布右上角，避开左上工具条、左下缩放控件和右下图例
    const host = await page.locator('.canvas-host').boundingBox()
    if (!host) fail('找不到画布')
    await page.mouse.click(host.x + host.width - 80, host.y + 70)
    await page.waitForTimeout(250)
    if ((await dimmed()) !== 0) fail('点空白没有退出聚焦')
    return `聚焦提示为「${banner?.replace(/\s+/g, ' ').trim()}」`
  })

  await check('实验笔记：写、引用块、点引用聚焦；卡片可切紧凑档', async () => {
    await openBlankCanvas()
    await libCard('数据源').click()
    const block = await lastNodeId()
    await page.locator(nodeSel(block)).click()
    await page.waitForTimeout(150)

    await page.getByRole('button', { name: '实验笔记' }).click()
    const editor = page.locator('.nb-editor')
    await editor.waitFor({ timeout: 5000 })
    await editor.fill('# 实验 1：原始信号\n\n换了 3 号泵的密封，振动峰值从 0.71 降到 0.42。\n')
    await page.getByRole('button', { name: /引用选中的块/ }).click()
    const written = await editor.inputValue()
    if (!/node:/.test(written)) fail('「引用选中的块」没有把引用写进笔记')
    if ((await page.locator('.nb-outline li').count()) === 0) fail('标题没有生成大纲，记录多了就没法定位')

    await page.getByRole('button', { name: '预览', exact: true }).click()
    const chip = page.locator('.nb-preview button.nb-node').first()
    await chip.waitFor({ timeout: 5000 })
    await chip.click()
    await page.waitForTimeout(400)
    if ((await page.locator('.canvas-focus').count()) === 0) fail('点笔记里的引用没有让画布聚焦到那个块')

    // 卡片密度：紧凑档只留名字与端口
    const dense = page.getByRole('button', { name: /标准/ })
    await dense.click()
    await page.waitForTimeout(250)
    if ((await page.locator('.wf-node-compact').count()) === 0) fail('切到紧凑档之后卡片没有变化')
    const compactBtn = page.getByRole('button', { name: /紧凑/ })
    if ((await compactBtn.count()) === 0) fail('工具条没有显示当前是紧凑档')
    await compactBtn.click()
    await page.waitForTimeout(250)
    if ((await page.locator('.wf-node-compact').count()) !== 0) fail('切回标准档之后卡片没有恢复')

    // 右侧栏能收起来；收起后点窄边上的标签，直接展开到那一页
    const canvasBefore = (await page.locator('.canvas-host').boundingBox())?.width ?? 0
    await page.getByRole('button', { name: '收起右侧栏' }).first().click()
    await page.waitForTimeout(250)
    if ((await page.locator('.panel.right.collapsed').count()) === 0) fail('右侧栏没有收起来')
    if (await page.locator('.nb-preview').first().isVisible()) fail('收起后笔记内容还看得见')
    // 页签清单只有一处（App.tsx 的 RIGHT_TABS）：收起态的窄边与展开态那一排必须一样多。
    // 加了页签却没让它能从窄边上点开，这条就会拦下。
    const railTabs = (await page.locator('.panel-rail-tab:visible').allTextContents()).map((text) => text.trim())
    const expandedTabs = (await page.locator('.panel-tabs .tab').allTextContents()).map((text) => text.trim())
    if (expandedTabs.length !== railTabs.length) {
      fail(`展开态有 ${expandedTabs.length} 个页签（${expandedTabs.join('/')}），收起后窄边上只有 ${railTabs.length} 个（${railTabs.join('/')}）`)
    }
    if (!railTabs.includes('项目报告')) fail(`窄边上没有「项目报告」标签：${railTabs.join('/')}`)
    const canvasAfter = (await page.locator('.canvas-host').boundingBox())?.width ?? 0
    if (canvasAfter - canvasBefore < 200) fail(`收起右侧栏之后画布没有变宽（${Math.round(canvasBefore)} → ${Math.round(canvasAfter)}）`)
    await page.locator('.panel-rail-tab', { hasText: '实验笔记' }).click()
    await page.waitForTimeout(250)
    if ((await page.locator('.panel.right.collapsed').count()) !== 0) fail('点窄边标签没有把右侧栏展开')
    if (!(await page.locator('.nb-preview').first().isVisible())) fail('展开后没有回到实验笔记那一页')
    return '笔记可写可引用、点引用能聚焦；卡片两档可切；右侧栏可收起、点标签直接展开'
  })

  await check('AI 对话脱离到独立窗口后，点画布上的块不会把它拉回来', async () => {
    await openBlankCanvas()
    await libCard('数据源').click()
    const nodeId = await lastNodeId()
    await page.getByRole('tab', { name: 'AI 工作区' }).click()
    await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
    // 先写一句草稿：它是"面板没被卸载重挂"的凭据，比只看窗口还在更硬
    const draft = '独立窗口里的草稿不该被点块冲掉'
    await page.locator('.chat-panel:visible textarea').fill(draft)
    const popupPromise = page.waitForEvent('popup')
    await page.getByRole('button', { name: '独立窗口' }).click()
    const popup = await popupPromise
    await popup.waitForLoadState('domcontentloaded')
    await popup.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
    if (!(await popup.locator('#chat-model-select').isVisible())) fail('独立窗口没有显示模型选择控件')
    if ((await popup.locator('.chat-panel:visible textarea').inputValue()) !== draft) fail('独立窗口没有接上主栏里的那份草稿')
    await page.waitForTimeout(250)
    if ((await page.locator('.panel.right.collapsed').count()) === 0) fail('打开独立窗口后主右栏没有收起')

    // 这条用例守的动作：切回主界面，点一个块
    await page.locator(nodeSel(nodeId)).click()
    await page.waitForTimeout(400)
    if (popup.isClosed()) fail('点画布上的块把独立窗口关掉了')
    if ((await page.locator('.panel.right.collapsed').count()) === 0) fail('点块之后主右栏自己展开了')
    if (!(await page.getByRole('tab', { name: '画布', exact: true }).getAttribute('aria-selected') === 'true')) fail('主界面没有保持画布视图')
    if ((await popup.locator('.chat-panel:visible textarea').inputValue()) !== draft) fail('点块之后独立窗口里的草稿丢了（面板被卸载重挂）')

    // 人真的关掉独立窗口（浏览器那个 ×）之后，对话带着草稿回到项目级 AI 工作区
    await popup.close()
    await page.locator('.chat-workspace-view:not([hidden])').waitFor({ timeout: 4000 })
    if (!(await page.locator('.chat-project-sidebar').isVisible())) fail('独立窗口关闭后没有回到项目级 AI 工作区')
    if ((await page.locator('.chat-panel:visible textarea').inputValue()) !== draft) fail('独立窗口关闭后草稿没有跟回主窗口')
    return '对话可脱离到独立窗口；点画布上的块不关窗、不抢页签；关窗后带着草稿回到 AI 工作区'
  })

  let chatHost = null
  await check('只读问答侧栏独立留存会话且不改变画布', async () => {
    chatHost = await startChatHost()
    try {
      const localUrl = new globalThis.URL(URL)
      localUrl.searchParams.set('host', CHAT_HOST_URL)
      await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
      await page.locator('.canvas-host').waitFor({ timeout: 15000 })
      await page.getByRole('button', { name: '只读问答' }).click()

      const sidebar = page.locator('.chat-panel.sidebar')
      await sidebar.waitFor({ timeout: 5000 })
      if (!(await sidebar.getByText('只读 · 不会修改或运行工程').isVisible())) fail('侧栏没有明确显示只读范围')
      if (await sidebar.locator('.chat-write-mode, .chat-attachment-tools, .chat-task-card').count()) fail('只读侧栏显示了写入、附件或任务操作入口')

      const question = '请说明当前项目的用途'
      await sidebar.locator('textarea').fill(question)
      await sidebar.getByRole('button', { name: '发送' }).click()
      await sidebar.locator('.chat-message.assistant .chat-text').first().waitFor({ timeout: 15000 })
      if (!(await sidebar.locator('.chat-message.assistant .chat-text').first().textContent())?.includes('本地假 provider')) fail('侧栏没有收到模型回答')
      if ((await page.locator('.wf-node').count()) !== 0) fail('发送只读问题后画布内容发生变化')

      const projectIds = readdirSync(join(chatHost.stateDir, 'chat'))
      if (projectIds.length !== 1 || !projectIds[0].endsWith('_sidebar')) fail(`只读问答没有使用独立会话身份：${projectIds.join(' / ')}`)
      return `侧栏回答已落盘到独立会话身份「${projectIds[0]}」，画布仍为空`
    } finally {
      stopChatHost(chatHost)
      chatHost = null
    }
  })

  await check('一个工程多个子对话：切换回来还在，磁盘上真有那份 JSONL', async () => {
    chatHost = await startChatHost()
    const question = '这条留存验收问一句'
    const localUrl = new globalThis.URL(URL)
    localUrl.searchParams.set('host', CHAT_HOST_URL)
    await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
    await page.getByRole('tab', { name: 'AI 工作区' }).click()
    await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
    await page.locator('.chat-panel:visible textarea').fill(question)
    await page.locator('.chat-panel:visible').getByRole('button', { name: '发送' }).click()
    await page.locator('.chat-message.assistant .chat-text').first().waitFor({ timeout: 15000 })
    if (!(await page.locator('.chat-message.assistant .chat-text').first().textContent())?.includes('本地假 provider')) fail('假宿主没有把回答写进气泡')

    const select = page.locator('#chat-session-select')
    // <option> 在 Playwright 眼里永远不是 visible，只能数出来等它出现
    await page.waitForFunction(
      (expected) => Array.from(document.querySelectorAll('#chat-session-select option')).some((option) => option.textContent?.includes(expected)),
      question,
      { timeout: 10000 },
    )
    const options = await select.locator('option').allTextContents()
    if (!options.some((option) => option.includes('这条留存验收问一句'))) fail(`会话列表里没有这次对话的标题：${options.join(' / ')}`)

    // 新对话 → 旧对话内容必须消失；再切回来 → 从 JSONL 重建，一字不差
    await page.locator('.chat-new-session-side').click()
    await page.waitForTimeout(200)
    if ((await page.locator('.chat-message').count()) !== 0) fail('点了新对话之后旧内容还在')
    const sessionValue = await select.locator('option', { hasText: question }).first().getAttribute('value')
    await select.selectOption(sessionValue)
    await page.locator('.chat-message.user').first().waitFor({ timeout: 5000 })
    if (!(await page.locator('.chat-message.user .chat-text').first().textContent())?.includes(question)) fail('切回旧对话没有恢复原来的问题')

    const projectIds = readdirSync(join(chatHost.stateDir, 'chat'))
    const journals = projectIds.flatMap((id) => readdirSync(join(chatHost.stateDir, 'chat', id)).filter((name) => name.endsWith('.jsonl')).map((name) => join(chatHost.stateDir, 'chat', id, name)))
    if (journals.length === 0) fail('状态目录里没有会话 JSONL')
    const events = journals.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    if (!events.some((event) => event.type === 'user' && event.payload?.text === question)) fail('JSONL 里没有那条 user 事件')
    stopChatHost(chatHost)
    chatHost = null
    return `子对话落在 ${journals.length} 份 JSONL 上，切换与恢复都从正文重建`
  })

  await check('长程任务计划按成功证据推进，并在恢复会话后保留实验报告', async () => {
    chatHost = await startChatHost()
    let providerRequests = 0
    let providerFailure = null
    const taskStep = { id: 'baseline', title: '读取当前工作流', successCriteria: '保存校验结果作为基线证据' }
    const report = '# 实验报告\n\n## 基线\n已取得工作流校验结果。\n\n## 改动与实验\n本次回归只验证长程任务记录和证据引用。\n\n## 结论与局限\n计划与报告能跨会话恢复；本例没有改动科研数据或运行科学实验。'
    const toolReply = (callId, name, arguments_) => [
      { type: 'tool_call', callId, name, arguments: arguments_ },
      { type: 'done', finishReason: 'tool_calls' },
    ]
    const textReply = (text) => [
      { type: 'text_delta', text },
      { type: 'done', finishReason: 'stop' },
    ]
    try {
      const localUrl = new globalThis.URL(URL)
      localUrl.searchParams.set('host', CHAT_HOST_URL)
      await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
      await page.getByRole('tab', { name: 'AI 工作区' }).click()
      await page.locator('.chat-panel:visible textarea').fill('请自主检查工作流，记录完成证据，并交一份实验报告')
      await page.route(`${CHAT_HOST_URL}/agent/chat`, async (route) => {
        const request = route.request().postDataJSON()
        const calls = Array.isArray(request?.tools) ? request.tools.map((tool) => tool.function?.name) : []
        if (!calls.includes('task_checkpoint')) providerFailure = '模型工具清单没有 task_checkpoint'
        const messages = Array.isArray(request?.messages) ? request.messages : []
        let reply
        if (providerRequests === 0) {
          reply = toolReply('long-task-plan', 'task_checkpoint', { action: 'plan', goal: '检查当前工作流并保存可核对的实验报告', steps: [taskStep] })
        } else if (providerRequests === 1) {
          const checkpoint = messages.find((message) => message.role === 'tool' && message.tool_call_id === 'long-task-plan')
          if (!checkpoint || JSON.parse(checkpoint.content)?.data?.task?.steps?.[0]?.id !== 'baseline') providerFailure = '新计划没有在工具结果中返回完整任务快照'
          reply = toolReply('task-evidence', 'validate', {})
        } else if (providerRequests === 2) {
          reply = toolReply('long-task-progress', 'task_checkpoint', { action: 'update', stepId: 'baseline', status: 'running', note: '已经取得本步骤需要的校验结果，等待继续分析' })
        } else if (providerRequests === 3) {
          reply = textReply('检查点已保存，可以继续实验分析。')
        } else if (providerRequests === 4) {
          /*
           * 模型只用文字收尾时，客户端会在同一轮里催它继续。历史里的工具结果会被上下文压缩
           * 丢掉（`compactModelMessages` 的历史只留 user/assistant），所以检查点必须**随催问现取现给**。
           * 这一条压的就是"模型还知道目标是什么、哪一步在跑"，而不是"历史里碰巧还留着"。
           */
          const text = messages.map((message) => (typeof message.content === 'string' ? message.content : '')).join('\n')
          const goalCarried = text.includes('检查当前工作流并保存可核对的实验报告')
          const runningCarried = text.includes('"id":"baseline"') && text.includes('"status":"running"')
          if (!goalCarried || !runningCarried) {
            providerFailure = `续跑请求没有带回任务目标与步骤状态：目标=${goalCarried}；在跑的步骤=${runningCarried}；请求正文=${text.length} 字`
          }
          if (!text.includes('请自主检查工作流，记录完成证据，并交一份实验报告')) providerFailure = '续跑请求丢失了用户原始目标'
          reply = toolReply('long-task-step-done', 'task_checkpoint', { action: 'update', stepId: 'baseline', status: 'completed', evidenceRefs: ['task-evidence'], note: '校验结果已记录并用于完成判据' })
        } else if (providerRequests === 5) {
          reply = toolReply('long-task-finish', 'task_checkpoint', { action: 'finish', summary: '已保存工作流校验基线与实验报告。', report, evidenceRefs: ['task-evidence'] })
        } else if (providerRequests === 6) {
          reply = textReply('长程任务已完成，实验报告已保存。')
        } else {
          providerFailure = `模型请求次数超出预期：${providerRequests + 1}`
          reply = textReply('回归收到额外请求。')
        }
        providerRequests += 1
        await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${reply.map((event) => JSON.stringify(event)).join('\n')}\n` })
      })
      await page.locator('.chat-panel:visible').getByRole('button', { name: '发送' }).click()
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.chat-message.assistant .chat-text')).some((node) => node.textContent?.includes('长程任务已完成，实验报告已保存。')))

      await page.waitForFunction(() => document.querySelector('.chat-task-card.completed')?.textContent?.includes('实验报告'))
      if (providerFailure) fail(providerFailure)
      if (providerRequests !== 7) fail(`长程任务模型往返数不对：期望 7，实际 ${providerRequests}`)
      const taskCard = page.locator('.chat-task-card')
      if (!(await taskCard.innerText()).includes('1 / 1 步完成')) fail(`任务卡没有反映已完成步骤：${await taskCard.innerText()}`)
      const downloadPromise = page.waitForEvent('download')
      await taskCard.getByRole('button', { name: '下载实验报告' }).click()
      const download = await downloadPromise
      if (!download.suggestedFilename().endsWith('.md')) fail(`实验报告文件名不正确：${download.suggestedFilename()}`)

      const select = page.locator('#chat-session-select')
      const sessionId = await select.inputValue()
      await page.locator('.chat-new-session-side').click()
      await page.waitForFunction(() => !document.querySelector('.chat-task-card'))
      /*
       * 切回去要**点左侧对话列表里那一条**：工作区模式下 `#chat-session-select` 是被裁成
       * 1×1 像素的兼容 DOM（见 `.chat-panel.workspace .chat-session-bar`），拿它当操作控件
       * 会出现"有时生效、有时静默"的假失败 —— 而它和列表走的是同一个 `openSession`。
       */
      const sessionButtons = page.locator('.chat-project-session-open')
      if ((await sessionButtons.count()) !== 1) fail(`新建对话后左侧列表里应当只剩原来那条：${await sessionButtons.count()} 条`)
      await sessionButtons.first().click()
      try {
        await page.locator('.chat-task-card.completed').waitFor({ timeout: 15000 })
      } catch {
        // 失败信息要说清"是没切回去还是切回去了但卡片没恢复"，否则这条偶发只能靠猜
        const hint = (await page.locator('.chat-session-hint').allInnerTexts()).join(' / ')
        const cards = await page.locator('.chat-task-card').count()
        fail(`切回原对话后任务卡没有恢复：当前选中=${await select.inputValue()}（期望 ${sessionId}）；提示=${hint || '无'}；任务卡=${cards}`)
      }
      await page.locator('.chat-task-report summary').click()
      if (!(await page.locator('.chat-task-report').innerText()).includes('没有改动科研数据')) fail('恢复会话后实验报告正文没有还原')

      const projectIds = readdirSync(join(chatHost.stateDir, 'chat'))
      const journals = projectIds.flatMap((id) => readdirSync(join(chatHost.stateDir, 'chat', id)).filter((name) => name.endsWith('.jsonl')).map((name) => join(chatHost.stateDir, 'chat', id, name)))
      const events = journals.flatMap((file) => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)))
      const checkpoints = events.filter((event) => event.type === 'tool_result' && event.payload?.tool === 'task_checkpoint' && event.payload?.ok === true)
      if (checkpoints.length !== 4 || !checkpoints.some((event) => event.payload.data?.task?.report === report)) fail(`会话 JSONL 没有保存四个任务快照与最终报告：${checkpoints.length}`)
      return '计划、证据与项目报告在同一轮自动推进；新建对话后恢复原会话仍可查看和下载报告'
    } finally {
      await page.unroute(`${CHAT_HOST_URL}/agent/chat`).catch(() => undefined)
      stopChatHost(chatHost)
      chatHost = null
    }
  })

  /*
   * "和 AI 说话，它改不了块" —— 用户报的就是这条。这里让假 provider 提一条真的图补丁
   * （触发词与基线都在假 provider 那侧，见 `agent_gateway._mock_patch_tool_call`），
   * 走完整的一段：模型流 → 工具循环 → 人确认 → applyPatch → applyProjectText → 画布。
   *
   * 压的是两件单元测试压不到的事：**基线真的是从上下文里取来的**（编一个指纹只会
   * 换回"基线不符"），以及**画布上真的多了一个块**（而不是只在 JSONL 里留下一条记录）。
   */
  await check('说一句话，AI 提的补丁真的落进画布（多出一个块）', async () => {
    chatHost = await startChatHost()
    const localUrl = new globalThis.URL(URL)
    localUrl.searchParams.set('host', CHAT_HOST_URL)
    await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(500)
    const before = await nodeCount()

    const acceptDialogs = (dialog) => dialog.accept()
    page.on('dialog', acceptDialogs)
    try {
      await page.getByRole('tab', { name: 'AI 工作区' }).click()
      await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
      await page.locator('.chat-panel:visible textarea').fill('帮我加一个块（假 provider 改图验收）')
      await page.locator('.chat-panel:visible').getByRole('button', { name: '发送' }).click()
      // 补丁落了才会多出那个块；等它出现，等不到就是没改成功
      await page.waitForFunction(
        (id) => !!document.querySelector(`.react-flow__node[data-id="${id}"]`),
        'mock-edited',
        { timeout: 20000 },
      )
      if ((await nodeCount()) !== before + 1) fail(`画布上的块数不对：${before} → ${await nodeCount()}`)

      /*
       * 审计：这条改动要能在会话 JSONL 里找到 tool_call / tool_result / patch 三种事件。
       * 要**轮询**着等，不能读一次就断言：块的 DOM 在 `applyProjectText` 那一刻就出现了，
       * 而那三种事件是在工具返回**之后**才追加的 —— 读早了会看到一个"改了但没记账"的假象。
       */
      const readChatEvents = () => {
        const projectIds = readdirSync(join(chatHost.stateDir, 'chat'))
        const journals = projectIds.flatMap((id) =>
          readdirSync(join(chatHost.stateDir, 'chat', id))
            .filter((name) => name.endsWith('.jsonl'))
            .map((name) => join(chatHost.stateDir, 'chat', id, name)),
        )
        return journals.flatMap((file) =>
          readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        )
      }
      const wanted = ['tool_call', 'tool_result', 'patch']
      const deadline = Date.now() + 20000
      let events = []
      while (Date.now() < deadline) {
        events = readChatEvents()
        if (wanted.every((type) => events.some((event) => event.type === type))) break
        await page.waitForTimeout(300)
      }
      for (const type of wanted) {
        if (!events.some((event) => event.type === type)) fail(`会话 JSONL 里没有 ${type} 事件`)
      }
      const landed = events.find((event) => event.type === 'tool_result' && event.payload?.tool === 'patch')
      if (landed?.payload?.ok !== true) fail(`补丁的工具结果是失败：${JSON.stringify(landed?.payload?.error ?? null)}`)
    } finally {
      page.off('dialog', acceptDialogs)
      stopChatHost(chatHost)
      chatHost = null
    }
    return `画布从 ${before} 个块变成 ${await nodeCount()} 个，审计事件齐全`
  })
  stopChatHost(chatHost)

  await check('Chat agent 改工作段参数后读取最新图像；同一参数仍可手动编辑', async () => {
    chatHost = await startChatHost()
    let providerRequests = 0
    let providerFailure = null
    const imageCharacterCounts = []
    const figureHashes = []
    let figurePromptCount = 0
    const patchToolResults = []
    let acceptDialogs = null
    const toolReply = (callId, name, arguments_) => [
      { type: 'tool_call', callId, name, arguments: arguments_ },
      { type: 'done', finishReason: 'tool_calls' },
    ]
    const textReply = (text) => [
      { type: 'text_delta', text },
      { type: 'done', finishReason: 'stop' },
    ]

    try {
      const localUrl = new globalThis.URL(URL)
      localUrl.searchParams.set('host', CHAT_HOST_URL)
      await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })

      await page.getByRole('button', { name: '导入数据' }).click()
      await page.locator('.modal input[type="file"]').setInputFiles({
        name: 'agent-work-segments.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('x,y\n0,1\n1,2\n2,8\n3,9\n'),
      })
      await page.getByRole('button', { name: '完成' }).click()

      await libCard('数据源').click()
      await page.locator('.panel-body select').first().selectOption({ index: 1 })
      const source = await lastNodeId()
      await libCard('自定义图表').click()
      const chart = await lastNodeId()
      await pointerDrag(await handleCenter(source, '__table__', 'source'), await handleCenter(chart, 'data', 'target'))

      const chartImage = page.locator(`${nodeSel(chart)} img.wf-figure-image`)
      await chartImage.waitFor({ timeout: 90000 })
      const imageBeforeCode = await chartImage.getAttribute('src')
      await page.locator('.panel-body textarea.code-area').first().fill(
        'def plot(data, work_segment: int = 0):\n' +
          '    import matplotlib.pyplot as plt\n' +
          '    start = work_segment * 2\n' +
          '    segment = data.iloc[start:start + 2]\n' +
          '    fig, ax = plt.subplots()\n' +
          '    ax.plot(segment["x"], segment["y"])\n' +
          '    ax.set_title(f"工作段 {work_segment}")\n' +
          '    return {"figure": fig}\n',
      )
      const segmentControls = page.locator('.panel-body .param-control:has(input[type="number"])')
      const segmentInput = segmentControls.locator('input[type="number"]')
      await segmentInput.waitFor({ timeout: 10000 }).catch(async () => {
        fail(`工作段参数未出现；参数栏：${(await page.locator('.panel-body').innerText()).slice(0, 1800)}`)
      })
      if (await page.locator(`${nodeSel(chart)} .wf-row`).filter({ hasText: 'work_segment' }).count()) {
        fail('未接线的工作段参数仍占着节点卡片')
      }
      if (!(await segmentControls.getByRole('button', { name: /工作段编号/ }).isVisible())) {
        fail('右侧栏没有显示工作段参数的简短中文说明')
      }
      await segmentControls.getByRole('button', { name: /工作段编号/ }).click()
      const segmentNote = segmentControls.getByRole('textbox', { name: 'work_segment 的中文说明' })
      await segmentNote.fill('当前工作段')
      await segmentNote.press('Enter')
      if (!(await segmentControls.getByRole('button', { name: /当前工作段/ }).isVisible())) {
        fail('自定义参数说明没有保存到右侧栏')
      }
      await segmentControls.getByRole('button', { name: /显示接线口/ }).click()
      await handleCenter(chart, 'work_segment', 'target')
      await segmentControls.getByRole('button', { name: /收起接线口/ }).click()
      if (await page.locator(`${nodeSel(chart)} .wf-row`).filter({ hasText: 'work_segment' }).count()) {
        fail('收起后参数端口仍占着节点卡片')
      }

      const waitForImageUpdate = async (previousSrc) => {
        await page.waitForFunction(
          ({ selector, oldSrc }) => {
            const image = document.querySelector(`${selector} img.wf-figure-image`)
            const status = document.querySelector(`${selector} .wf-node-status`)
            return image?.getAttribute('src') !== oldSrc && status?.textContent?.trim() === '已算'
          },
          { selector: nodeSel(chart), oldSrc: previousSrc },
          { timeout: 90000 },
        )
      }
      await waitForImageUpdate(imageBeforeCode)
      if (!(await segmentInput.inputValue()).includes('0')) fail('工作段参数没有显示默认值 0')

      await page.route(`${CHAT_HOST_URL}/agent/chat`, async (route) => {
        const request = route.request().postDataJSON()
        const messages = Array.isArray(request?.messages) ? request.messages : []
        let reply
        if (providerRequests === 0) {
          if (!request?.tools?.some((tool) => tool.function?.name === 'inspect_figure')) {
            providerFailure = '模型工具清单没有 Chat 专属 inspect_figure'
          }
          reply = toolReply('work-segment-inspect', 'inspect', { nodeId: chart })
        } else if (providerRequests === 1) {
          const resultMessage = [...messages].reverse().find((message) => message.role === 'tool' && message.tool_call_id === 'work-segment-inspect')
          const result = resultMessage ? JSON.parse(resultMessage.content) : null
          const parameter = result?.data?.editableParams?.find((item) => item.key === 'work_segment')
          if (!result?.data?.editFingerprint || parameter?.currentValue !== 0 || parameter?.editable !== true) {
            providerFailure = `inspect 没有返回可编辑的 work_segment 与当前指纹：${JSON.stringify(result?.data?.editableParams ?? null)}`
            reply = textReply('我没有收到可操作的工作段参数。')
          } else {
            reply = toolReply('work-segment-patch', 'patch', {
              baseFingerprint: result.data.editFingerprint,
              ops: [{ op: 'setParam', id: chart, path: [], key: 'work_segment', value: 1 }],
            })
          }
        } else if (providerRequests === 2) {
          const patchMessage = [...messages].reverse().find((message) => message.role === 'tool' && message.tool_call_id === 'work-segment-patch')
          if (patchMessage) patchToolResults.push(JSON.parse(patchMessage.content))
          reply = [
            { type: 'text_delta', text: '临时猜测：这张图已经证明通道顺序错了。' },
            ...toolReply('work-segment-figure', 'inspect_figure', { nodeId: chart }),
          ]
        } else if (providerRequests === 3) {
          const figureMessage = [...messages].reverse().find((message) => message.role === 'tool' && message.tool_call_id === 'work-segment-figure')
          const figureResult = figureMessage ? JSON.parse(figureMessage.content) : null
          if (figureResult?.data?.sha256) figureHashes.push(figureResult.data.sha256)
          const imageMessage = messages.find((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')))
          const images = imageMessage?.content.filter((part) => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')) ?? []
          if (images.length !== 1) providerFailure = `第一张图送达次数不对：${images.length}`
          else imageCharacterCounts.push(images[0].image_url.url.length)
          reply = toolReply('work-segment-inspect-after-first', 'inspect', { nodeId: chart })
        } else if (providerRequests === 4) {
          const resultMessage = [...messages].reverse().find((message) => message.role === 'tool' && message.tool_call_id === 'work-segment-inspect-after-first')
          const result = resultMessage ? JSON.parse(resultMessage.content) : null
          const parameter = result?.data?.editableParams?.find((item) => item.key === 'work_segment')
          if (!result?.data?.editFingerprint || parameter?.currentValue !== 1 || parameter?.editable !== true) {
            providerFailure = `第二次 inspect 没有返回当前 work_segment 与新指纹：${JSON.stringify(result?.data?.editableParams ?? null)}`
            reply = textReply('我没有收到第二个工作段的最新参数。')
          } else {
            reply = toolReply('work-segment-patch-back', 'patch', {
              baseFingerprint: result.data.editFingerprint,
              ops: [{ op: 'setParam', id: chart, path: [], key: 'work_segment', value: 0 }],
            })
          }
        } else if (providerRequests === 5) {
          const patchMessage = [...messages].reverse().find((message) => message.role === 'tool' && message.tool_call_id === 'work-segment-patch-back')
          if (patchMessage) patchToolResults.push(JSON.parse(patchMessage.content))
          reply = toolReply('work-segment-figure-back', 'inspect_figure', { nodeId: chart })
        } else if (providerRequests === 6) {
          const figureMessage = [...messages].reverse().find((message) => message.role === 'tool' && message.tool_call_id === 'work-segment-figure-back')
          const figureResult = figureMessage ? JSON.parse(figureMessage.content) : null
          if (figureResult?.data?.sha256) figureHashes.push(figureResult.data.sha256)
          const imageMessage = messages.find((message) => message.role === 'user' && Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')))
          const images = imageMessage?.content.filter((part) => part.type === 'image_url' && part.image_url?.url?.startsWith('data:image/png;base64,')) ?? []
          if (images.length !== 2) providerFailure = `两次读图后模型收到的图像数不对：${images.length}`
          else imageCharacterCounts.push(...images.map((part) => part.image_url.url.length))
          reply = textReply('我已看到工作段 1 和工作段 0 的两张最新图像。')
        } else {
          providerFailure = `模型请求次数超出预期：${providerRequests + 1}`
          reply = textReply('测试流程收到意外的额外请求。')
        }
        providerRequests += 1
        await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${reply.map((event) => JSON.stringify(event)).join('\n')}\n` })
      })

      acceptDialogs = (dialog) => {
        if (dialog.message().includes('把图像像素发送给当前模型服务')) figurePromptCount += 1
        dialog.accept()
      }
      page.on('dialog', acceptDialogs)
      await page.getByRole('tab', { name: 'AI 工作区' }).click()
      await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
      await page.waitForFunction(() => {
        const input = document.querySelector('.chat-panel textarea')
        return !!input && !input.disabled
      }, null, { timeout: 10000 })
      await page.locator('.chat-panel:visible textarea').fill('切换到工作段 1，并比较新图')
      await page.locator('.chat-panel:visible').getByRole('button', { name: '发送' }).click()
      try {
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll('.chat-message.assistant .chat-text')).some((element) => element.textContent?.includes('我已看到工作段 1 和工作段 0 的两张最新图像')),
          null,
          { timeout: 45000 },
        )
      } catch {
        const transcript = (await page.locator('.chat-message').allInnerTexts()).join(' | ').slice(-2000)
        fail(`没有收到模型最终回复；requests=${providerRequests}；providerFailure=${providerFailure ?? 'none'}；patches=${JSON.stringify(patchToolResults)}；对话=${transcript}`)
      }
      if (providerFailure) fail(providerFailure)
      if ((await page.locator('.chat-message.assistant .chat-text').last().innerText()).includes('临时猜测：这张图已经证明通道顺序错了')) fail('工具前的临时猜测被拼进最终回答')
      if (providerRequests !== 7) fail(`模型请求次数不对：期望 7，实际 ${providerRequests}`)
      if (patchToolResults.length !== 2 || patchToolResults.some((result) => result?.ok !== true || result?.status !== 'done')) fail(`Agent 两次修改参数没有全部成功：${JSON.stringify(patchToolResults)}`)
      if (imageCharacterCounts.length !== 3 || imageCharacterCounts.some((count) => !count)) fail(`模型收到图像像素的记录不完整：${JSON.stringify(imageCharacterCounts)}`)
      if (figureHashes.length !== 2 || figureHashes[0] === figureHashes[1]) fail(`两个工作段没有产生不同图像：${JSON.stringify(figureHashes)}`)
      if (figurePromptCount !== 0) fail(`读取图像仍弹出确认：${figurePromptCount} 次`)
      const imageAfterAgent = await chartImage.getAttribute('src')
      if (!imageAfterAgent?.startsWith('data:image/png;base64,')) fail('Agent 修改工作段后画布没有显示最新的 Matplotlib 图像')

      await page.getByRole('button', { name: /打开画布/ }).click()
      await page.locator(nodeSel(chart)).click()
      await page.locator('.panel-tabs .tab', { hasText: '节点参数' }).click()
      await segmentInput.waitFor({ timeout: 10000 })
      if ((await segmentInput.inputValue()) !== '0') fail(`Agent 没有恢复工作段 0：${await segmentInput.inputValue()}`)
      await segmentInput.fill('1')
      await segmentInput.press('Enter')
      await waitForImageUpdate(imageAfterAgent)
      if ((await segmentInput.inputValue()) !== '1') fail('人手动修改同一个工作段参数没有落到画布')
      const imageAfterManualEdit = await chartImage.getAttribute('src')
      if (imageAfterManualEdit === imageAfterAgent) fail('人手动切换到工作段 1 后图像没有更新')
      return `Agent 读取参数后依次查看 1 和 0 两个工作段，图像哈希不同且未弹确认；人手动切到 1 也更新了图像`
    } finally {
      if (acceptDialogs) page.off('dialog', acceptDialogs)
      await page.unroute(`${CHAT_HOST_URL}/agent/chat`).catch(() => undefined)
      stopChatHost(chatHost)
      chatHost = null
    }
  })

  /*
   * "agent 做一点活是真的难" —— 三处"看得见但够不着"里的前两处都是界面语义，
   * 单元测试压不到，只有真浏览器能验：@ 选择器得覆盖子空间内部（否则用户点不到里面的块），
   * 读块内代码的授权得按工程记住（否则模型被拦一次，用户就得回输入区再点一次）。
   */
  await check('@ 选择器覆盖子空间内部：菜单列出里面的块并带上层级', async () => {
    chatHost = await startChatHost()
    // 假宿主起在 try 外面、收在 finally 里：断言失败时也要把它收掉，
    // 否则它会占着端口活到下一次运行（本轮就踩过这个坑）
    try {
    const localUrl = new globalThis.URL(URL)
    localUrl.searchParams.set('host', CHAT_HOST_URL)
    await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('.canvas-host', { timeout: 15000 })

    await libCard('数据源').click()
    const source = await lastNodeId()
    await libCard('图表').click()
    const chart = await lastNodeId()
    await page.locator(nodeSel(source)).click()
    await page.locator(nodeSel(chart)).click({ modifiers: ['Control'] })
    await page.getByRole('button', { name: /组合为子空间/ }).click()
    await page.waitForTimeout(250)
    if ((await nodeCount()) !== 1) fail('前置：组合后外层应当只剩一个组块')

    await page.getByRole('tab', { name: 'AI 工作区' }).click()
    await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
    /*
     * 面板是挂载后才去问 `/agent/config` 的，输入框在那一刻还是灰的 —— 所以要**等它变可用**，
     * 不能拍一张快照就断言（那会变成一条看心情的用例）。等不到就是真的没连上假宿主。
     */
    try {
      await page.waitForFunction(
        () => {
          const textarea = document.querySelector('.chat-panel textarea')
          return !!textarea && !textarea.disabled
        },
        null,
        { timeout: 10000 },
      )
    } catch {
      fail('对话栏没连上假宿主：输入框一直是禁用的')
    }
    await page.locator('.chat-panel:visible textarea').fill('@')
    const menu = page.locator('.chat-reference-menu')
    await menu.waitFor({ timeout: 5000 })

    // 带「 · 层级」的那两项就是子空间里的块：根图上的组块自己不在这类里
    // （组块名是「数据源 / 图表」，所以按名字找块时必须先排除它，否则会点到组块本身）
    const nestedButtons = menu.getByRole('button').filter({ hasText: ' · ' })
    const entries = await menu.getByRole('button').allInnerTexts()
    const nested = await nestedButtons.allInnerTexts()
    if (nested.length !== 2) fail(`@ 菜单里带层级的应当是子空间里那两个块：${JSON.stringify(entries)}`)
    if (!nested.some((text) => text.includes('数据源'))) fail(`菜单里没有子空间内部那个数据源块：${JSON.stringify(nested)}`)

    await nestedButtons.filter({ hasText: '数据源' }).first().click()
    const written = await page.locator('.chat-panel:visible textarea').inputValue()
    if (!written.includes(`node:${source}`)) fail(`引用落到了别处，不是子空间里的那个块：${written}`)
    if (!written.includes('@[数据源]')) fail(`引用没有带上名字：${written}`)
    return `@ 菜单 ${entries.length} 项，其中 ${nested.length} 项带层级；引用落到子空间内部的块`
    } finally {
      stopChatHost(chatHost)
      chatHost = null
    }
  })

  /*
   * 代码读取默认开放，但人在输入区关闭后要按工程生效，重新勾选则恢复。
   * 跨刷新那一半在这套 harness 里验不了 —— `context.addInitScript` 每次载入都 `localStorage.clear()`，
   * 所以这里只钉"关闭就落进 localStorage 的阻止名单、重新开放就移除"，
   * 解析与跨工程隔离由 `src/agent/readGrant.test.ts` 覆盖。
   */
  await check('块内代码默认可读，关闭与重新开放按工程生效', async () => {
    await openBlankCanvas()
    await page.evaluate(() => window.localStorage.removeItem('sciviz.chat.blockCodeEgress'))

    // 面板是常挂载的（收起/切页签只隐藏），所以"开没开"要看**可见性**，不是元素有没有
    const openPanel = async () => {
      if (!(await page.locator('.chat-panel:visible').isVisible())) await page.getByRole('tab', { name: 'AI 工作区' }).click()
      await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
    }
    // 外发开关有两个（块内代码 / 运行结果行值），这里要的是第一个 —— 用可见标签定位，别靠下标
    const box = page.locator('.chat-panel:visible .chat-permission', { hasText: '允许读取全部块内代码' }).locator('input[type="checkbox"]')
    await openPanel()
    if (!(await box.isChecked())) fail('当前工程没有显式关闭时，代码读取应默认开放')

    await box.uncheck()
    const blocked = await page.evaluate(() => window.localStorage.getItem('sciviz.chat.blockCodeEgress'))
    if (!blocked) fail('关闭后没有把本工程记入阻止名单')

    await box.check()
    const reopened = await page.evaluate(() => window.localStorage.getItem('sciviz.chat.blockCodeEgress'))
    if (reopened && reopened.split(',').includes(blocked.split(',')[0])) fail('重新开放后仍在阻止名单中')

    /*
     * 行值那一格守的是用户报的「还是会有这种弹窗啊」：默认关（没点头之前不出本机），
     * 勾上就是把本工程记进 `sciviz.chat.rowGrant` —— 之后模型取行值不再逐次问。
     */
    const rows = page.locator('.chat-panel:visible .chat-permission', { hasText: '允许读取运行结果行值' }).locator('input[type="checkbox"]')
    await page.evaluate(() => window.localStorage.removeItem('sciviz.chat.rowGrant'))
    /*
     * 「完全访问权限」（默认档）下这一格是**常开且不可改**的：那一档的语义就是不再问人，
     * 所以行值随取随给；要恢复逐次确认得先切档。
     */
    if (!(await rows.isChecked())) fail('完全访问权限档下行值应当随取随给（那一档不问人）')
    if (await rows.isEnabled()) fail('完全访问权限档下这一格应当不可改 —— 要改先切档')

    await page.locator('.chat-write-mode label', { hasText: '帮我批准' }).locator('input').check()
    if (await rows.isChecked()) fail('切到「帮我批准」后行值应当回到"没点头就是关"')
    if (!(await rows.isEnabled())) fail('切到「帮我批准」后这一格应当可以改')
    await rows.check()
    const granted = await page.evaluate(() => window.localStorage.getItem('sciviz.chat.rowGrant'))
    if (!granted) fail('勾上行值开关后没有记进 sciviz.chat.rowGrant')
    await rows.uncheck()
    if (await page.evaluate(() => window.localStorage.getItem('sciviz.chat.rowGrant'))) fail('取消勾选应当撤销这条授权')
    await page.locator('.chat-write-mode label', { hasText: '完全访问权限' }).locator('input').check()
    return `关闭时记录 ${blocked}，重新开放后移除；行值授权勾上写出 ${granted}、取消即撤销`
  })

  /*
   * 「我每一次让 agent 做改动他都会弹出一个窗口让我确认」
   *
   * 压的是这条反馈修好之后的**界面事实**：三档摆在输入区、默认是「完全访问权限」
   * （不是"每次都问"），以及切换会按工程落到 `sciviz.chat.writeMode`。跨工程隔离、
   * 坏值处理与旧值迁移由 `src/agent/writeMode.test.ts` 覆盖；"最高档真的不弹窗、
   * 中间档只问破坏性动作"由 `graphTools.test.ts` 覆盖（那是纯逻辑，能直接断言
   * confirm 被调了几次）。
   */
  await check('写入档位三档、默认「完全访问权限」，切换后按工程记住', async () => {
    await openBlankCanvas()
    await page.evaluate(() => window.localStorage.removeItem('sciviz.chat.writeMode'))
    if (!(await page.locator('.chat-panel:visible').isVisible())) await page.getByRole('tab', { name: 'AI 工作区' }).click()
    await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })

    const full = page.locator('.chat-write-mode label', { hasText: '完全访问权限' }).locator('input')
    const smart = page.locator('.chat-write-mode label', { hasText: '帮我批准' }).locator('input')
    const ask = page.locator('.chat-write-mode label', { hasText: '请求批准' }).locator('input')
    if (!(await full.isChecked())) fail('默认档必须是「完全访问权限」—— 用户报的正是每一次改动都被拦一下')
    if (await smart.count() !== 1 || await ask.count() !== 1) fail('三档都要在输入区摆出来')
    if (await page.evaluate(() => window.localStorage.getItem('sciviz.chat.writeMode'))) {
      fail('默认档不该落盘：没记过和记成默认必须是同一种状态')
    }

    await ask.check()
    const stored = await page.evaluate(() => window.localStorage.getItem('sciviz.chat.writeMode'))
    if (!stored || !stored.split(',').some((entry) => entry.endsWith('=ask'))) {
      fail(`切到「请求批准」没有按工程记下来：${stored}`)
    }

    await smart.check()
    const smarter = await page.evaluate(() => window.localStorage.getItem('sciviz.chat.writeMode'))
    if (!smarter || !smarter.split(',').some((entry) => entry.endsWith('=smart'))) {
      fail(`切到「帮我批准」没有按工程记下来：${smarter}`)
    }

    await full.check()
    if (await page.evaluate(() => window.localStorage.getItem('sciviz.chat.writeMode'))) {
      fail('切回默认档应该把这条记录删掉')
    }
    return `默认完全访问权限；切到「请求批准」写出 ${stored}、「帮我批准」写出 ${smarter}，切回来即清空`
  })

  /*
   * 「我每次重开这个项目，对话记录又是空白的？」
   *
   * 根因是工程身份：文件里没有 projectId 的旧工程每次打开都新随机一个身份（已修成按文件名派生），
   * 而**已经**散在别的身份下的历史要搬回来。这一条压的就是搬这条路真的走得通：候选认得出来、
   * 点了真的进列表、而且身份不被换掉（换身份只能拿回其中一份 —— 用户手里有五份）。
   * 身份派生本身由 `src/store/projectFile.test.ts` 的三行表钉住，合并的幂等与"源不动"由宿主
   * `test_chat_retention.py` 钉住，这里压的是界面这一侧。
   */
  await check('状态目录里别的身份下的对话：列出标题、点一下搬进来、身份不动', async () => {
    chatHost = await startChatHost()
    try {
      /*
       * 造一份"挂在别的身份下"的历史：另一个工程身份下的一次对话。
       * 身份用真的形状（UUID）—— 真实场景里它就是这么来的，而"名字不合规的目录也看得见、
       * 也搬得动"那条边界由宿主 `test_chat_retention.py` 单独钉住。
       */
      const orphanProject = '3f9a1c2e-5b7d-4e8f-9a1b-2c3d4e5f6a7b'
      const orphanSession = 's-orphan'
      const orphanDir = join(chatHost.stateDir, 'chat', orphanProject)
      mkdirSync(orphanDir, { recursive: true })
      const line = (seq, type, payload) => JSON.stringify({
        schemaVersion: 1,
        seq,
        at: '2026-09-22T07:00:00Z',
        projectId: orphanProject,
        sessionId: orphanSession,
        turnId: 't1',
        type,
        payload,
      })
      writeFileSync(
        join(orphanDir, `${orphanSession}.jsonl`),
        [
          line(1, 'session', { promptVersion: 'test' }),
          line(2, 'user', { text: '把评估块改成只画对比曲线' }),
          line(3, 'assistant', { text: '好' }),
        ].join('\n') + '\n',
        'utf8',
      )

      const localUrl = new globalThis.URL(URL)
      localUrl.searchParams.set('host', CHAT_HOST_URL)
      await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
      await page.getByRole('tab', { name: 'AI 工作区' }).click()
      await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
      // 工程身份要等面板起来才有（`activeProjectId()` 在那一刻落草稿键），所以在这里才取
      const identityBefore = await page.evaluate(() => window.localStorage.getItem('sciviz.draftProjectId'))
      if (!identityBefore) fail('面板起来了却没有工程身份')

      const hint = page.locator('.chat-session-hint')
      await hint.waitFor({ timeout: 10000 })
      const recoverySummary = hint.locator('summary')
      if (await recoverySummary.count()) await recoverySummary.click()
      const title = await hint.locator('.chat-claim-title').first().textContent()
      if (!title?.includes('把评估块改成只画对比曲线')) fail(`候选没有带出标题：${JSON.stringify(title)}`)
      await hint.getByRole('button', { name: '接进当前工程' }).first().click()

      // 搬进来了：会话选择器里出现那条对话
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('#chat-session-select option')).some((option) => option.textContent?.includes('把评估块改成只画对比曲线')),
        null,
        { timeout: 10000 },
      )
      // 身份不动 —— 这一点很要紧：换身份只能拿回其中一份，而用户手里有五份
      const identityAfter = await page.evaluate(() => window.localStorage.getItem('sciviz.draftProjectId'))
      if (identityAfter !== identityBefore) fail(`搬一次历史不该换工程身份：${identityBefore} → ${identityAfter}`)
      // 搬过的候选不再列出来（否则这条提示会一直挂着）
      await page.waitForFunction(() => document.querySelectorAll('.chat-claim-list li').length === 0, null, { timeout: 10000 })
      return `候选带标题「${title}」，搬进当前工程，身份保持 ${identityAfter}`
    } finally {
      stopChatHost(chatHost)
      chatHost = null
    }
  })

  /*
   * 「我切到 opencode 的 ds flash，下次打开应该还是它」——模型/provider 的选择要记在**宿主**里。
   *
   * 这条压的是界面这一侧的接线：换 provider、换模型各自会把选择 POST 给宿主。
   * 写进去之后"下次宿主起来还认它"由 `tests/test_providers.py` 钉住
   * （那边用真的 ProviderStore 验"新开一个 gateway 仍选中同一个"），
   * 因为 e2e 的假宿主是被 `SCIVIZ_AGENT_PROVIDER=mock` 点名的，那个分支本来就该优先。
   */
  await check('换 provider / 模型会把选择写给宿主（下次打开还是它）', async () => {
    chatHost = await startChatHost()
    let upstream = null
    try {
      /*
       * 给这个临时状态目录配一个**回环地址**的自定义兼容服务：`available` 于是为真（不用真密钥），
       * 而它的模型列表由一个真的小上游喂 —— 注意**不能用 `page.route`**：发那条请求的是宿主
       * （Python 进程），浏览器的路由拦截根本管不着它。这条用例也不该真去连 远程服务。
       */
      const upstreamPort = await freePort()
      upstream = createServer((request, response) => {
        if (request.url?.startsWith('/v1/models')) {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ data: [{ id: 'deepseek-v4.1-flash' }, { id: 'kimi-k3' }] }))
          return
        }
        response.writeHead(404).end()
      })
      await new Promise((resolve) => upstream.listen(upstreamPort, '127.0.0.1', resolve))
      const fakeModels = `http://127.0.0.1:${upstreamPort}/v1`
      writeFileSync(
        join(chatHost.stateDir, 'agent-providers.json'),
        JSON.stringify({ version: 1, providers: { custom: { apiKey: null, baseUrl: fakeModels, model: null } } }) + '\n',
        'utf8',
      )
      const sent = []
      await page.route(`${CHAT_HOST_URL}/agent/selection`, async (route) => {
        sent.push(route.request().postDataJSON())
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, provider: 'custom', model: 'deepseek-flash' }) })
      })
      const localUrl = new globalThis.URL(URL)
      localUrl.searchParams.set('host', CHAT_HOST_URL)
      await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
      await page.getByRole('tab', { name: 'AI 工作区' }).click()
      await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
      await page.locator('#chat-provider-select').waitFor({ timeout: 10000 })

      await page.locator('#chat-provider-select').selectOption('custom')
      await page.waitForTimeout(400)
      if (!sent.some((body) => body?.provider === 'custom' && body?.model === undefined)) {
        fail(`换 provider 没有把选择写给宿主：${JSON.stringify(sent)}`)
      }

      /*
       * 模型下拉来自这个 provider 自己的清单；选一个就该把"选的是哪个模型"也写回去。
       * 注意 `<option>` 在 Playwright 眼里**永远不是 visible**（与存储那条用例同一个坑），
       * 所以只能数出来等它出现，不能 `locator.waitFor`。
       */
      await page.waitForFunction(
        () => Array.from(document.querySelectorAll('#chat-model-select option')).some((option) => option.value === 'deepseek-v4.1-flash'),
        null,
        { timeout: 10000 },
      ).catch(async () => {
        const status = await page.locator('.chat-status').innerText()
        const picker = await page.locator('.chat-model-picker').allInnerTexts()
        fail(`模型清单没到面板：status=${JSON.stringify(status)} picker=${JSON.stringify(picker)}`)
      })
      await page.locator('#chat-model-select').selectOption('deepseek-v4.1-flash')
      await page.waitForTimeout(400)
      if (!sent.some((body) => body?.provider === 'custom' && body?.model === 'deepseek-v4.1-flash')) {
        fail(`选中的模型没有被记住：${JSON.stringify(sent)}`)
      }
      return `换 provider 与换模型各写回一次：${JSON.stringify(sent)}`
    } finally {
      await page.unroute(`${CHAT_HOST_URL}/agent/selection`)
      if (upstream) await new Promise((resolve) => upstream.close(resolve))
      stopChatHost(chatHost)
      chatHost = null
    }
  })


  await check('BYOK 配置遮住密钥、保存后清空、重开保留配置并可移除', async () => {
    chatHost = await startChatHost()
    const upstream = createServer((request, response) => {
      if (request.url === '/v1/models') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ data: [{ id: 'fake-byok-model' }] }))
      } else response.writeHead(404).end()
    })
    try {
      await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
      const baseUrl = `http://127.0.0.1:${upstream.address().port}/v1`
      const localUrl = new globalThis.URL(URL)
      localUrl.searchParams.set('host', CHAT_HOST_URL)
      await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
      await page.getByRole('tab', { name: 'AI 工作区' }).click()
      const settings = page.getByRole('button', { name: '模型服务设置', exact: true })
      await settings.waitFor({ timeout: 15000 })
      await settings.click()
      const dialog = page.locator('.provider-settings')
      await dialog.locator('select').selectOption('openai')
      const keyInput = dialog.locator('input[type="password"]')
      const fakeKey = 'FAKE_E2E_BYOK_CREDENTIAL_0123456789'
      await keyInput.fill(fakeKey)
      if (await keyInput.getAttribute('type') !== 'password') fail('密钥未遮住')
      await dialog.getByLabel('API 基础地址').fill(baseUrl)
      await dialog.getByLabel('模型 ID').fill('fake-byok-model')
      const screenshotDir = fileURLToPath(new globalThis.URL('../../.tmp/public-prep-20261002/', import.meta.url))
      mkdirSync(screenshotDir, { recursive: true })
      await page.screenshot({ path: join(screenshotDir, 'byok-settings.png') })
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
      await dialog.waitFor({ state: 'detached', timeout: 10000 })
      await page.waitForFunction(() => document.querySelector('#chat-provider-select')?.value === 'openai')
      const stored = JSON.parse(readFileSync(join(chatHost.stateDir, 'agent-providers.json'), 'utf8'))
      if (stored.providers.openai.apiKey !== fakeKey) fail('宿主未保存 BYOK')
      const config = await (await fetch(`${CHAT_HOST_URL}/agent/config`)).text()
      if (config.includes(fakeKey)) fail('公开配置回传了密钥')
      const browserStorage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))
      if (browserStorage.includes(fakeKey)) fail('密钥进入浏览器持久存储')
      await settings.click()
      if (await dialog.locator('input[type="password"]').inputValue() !== '') fail('重开设置回显了密钥')
      await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
      await dialog.waitFor({ state: 'detached', timeout: 10000 })
      const kept = JSON.parse(readFileSync(join(chatHost.stateDir, 'agent-providers.json'), 'utf8'))
      if (kept.providers.openai.apiKey !== fakeKey) fail('空输入没有保留原密钥')
      await settings.click()
      await dialog.getByRole('button', { name: '移除本地配置', exact: true }).click()
      await dialog.waitFor({ state: 'detached', timeout: 10000 })
      const removed = JSON.parse(readFileSync(join(chatHost.stateDir, 'agent-providers.json'), 'utf8'))
      if (removed.providers.openai) fail('本地配置没有移除')
      return '虚拟密钥仅存临时宿主文件；HTTP、浏览器存储与重开表单均无密钥'
    } finally {
      await new Promise((resolve) => upstream.close(resolve))
      stopChatHost(chatHost)
      chatHost = null
    }
  })

  await check('画布缩放超出旧范围并可深入放大与缩小', async () => {
    await openBlankCanvas()
    const zoomIn = page.locator('.react-flow__controls-zoomin')
    const zoomOut = page.locator('.react-flow__controls-zoomout')
    const scale = () => page.locator('.react-flow__viewport').evaluate((el) => {
      const transform = new DOMMatrixReadOnly(getComputedStyle(el).transform)
      return transform.a
    })
    const clickRepeatedly = (locator, count) => locator.evaluate((button, n) => {
      for (let i = 0; i < n; i += 1) button.click()
    }, count)

    await clickRepeatedly(zoomIn, 45)
    const high = await scale()
    if (high <= 32 || high > 1000.01) fail(`放大后缩放比例 ${high}，预期大于旧上限且不超过 1000`)
    await clickRepeatedly(zoomOut, 85)
    const low = await scale()
    if (low >= 0.01 || low < 0.0009) fail(`缩小后缩放比例 ${low}，预期低于旧下限且不低于 0.001`)
    await clickRepeatedly(zoomIn, 85)
    const restoredHigh = await scale()
    if (restoredHigh <= 32 || restoredHigh > 1000.01) fail(`从极小比例放大后为 ${restoredHigh}，缩放范围异常`)
    return `可缩至 ${low.toFixed(3)} 并放大至 ${restoredHigh.toFixed(2)}`
  })

  await check('节点库不再提供内置数据准备与特征工程节点', async () => {
    await openBlankCanvas()
    const names = await page.locator('.lib-node-name').allTextContents()
    const present = REMOVED_LIBRARY_ITEMS.filter((name) => names.some((item) => item.trim() === name))
    if (present.length > 0) fail(`节点库仍出现已移除入口：${present.join('、')}`)
    return `节点库 ${names.length} 项，旧入口均已移除`
  })

  await check('绘图块未接数据时明确要求连线，不再显示独立数据集入口', async () => {
    for (const [label, expected] of [
      ['图表', '把一张表接到「数据」输入端口'],
      ['概率密度图', '把数据表或拆列后的单列接到「数据列」'],
      ['自定义图表', '把数据接到函数输入端口'],
    ]) {
      await openBlankCanvas()
      await libCard(label).click()
      await page.waitForTimeout(250)
      const id = await lastNodeId()
      const preview = page.locator(`${nodeSel(id)} .wf-node-chart-note`)
      if (!(await preview.first().textContent())?.includes(expected)) {
        fail(`${label} 没显示“${expected}”的接线提示`)
      }
      const fields = await page.locator('.panel-body .field label').allTextContents()
      if (fields.some((text) => text.trim() === '数据源')) {
        fail(`${label} 仍提供独立数据集选择`)
      }
      if (label === '自定义图表') {
        const drawingSettings = fields
          .map((text) => text.trim())
          .filter((text) => ['X 轴', 'Y 轴', '颜色', '图表类型', '配色方案', '元素大小', '显示网格线', '显示图例', '标题'].includes(text))
        if (drawingSettings.length > 0) {
          fail(`自定义图表仍暴露界面绘图设置：${drawingSettings.join('、')}`)
        }
      }
      await handleCenter(id, 'data', 'target')
    }
    return '图表、概率密度图、自定义图表都只从输入连线取数'
  })

  await check('浏览器引擎执行 Matplotlib 自定义函数并直接显示 PNG', async () => {
    // 前面的长链路反复重载页面并创建 Worker；此项单独开干净上下文，
    // 避免累积的 Pyodide/Matplotlib 实例占用内存，让图片加载超时。
    await context.close()
    const pyodideContext = await browser.newContext({ viewport: { width: 1680, height: 1000 } })
    await pyodideContext.addInitScript(() => {
      localStorage.clear()
      localStorage.setItem('sciviz.engine', 'pyodide')
    })
    page = await pyodideContext.newPage()
    page.on('pageerror', (error) => console.log(`  [页面异常] ${error.message}`))
    await openBlankCanvas()

    await page.getByRole('button', { name: '导入数据' }).click()
    await page.locator('.modal input[type="file"]').setInputFiles({
      name: 'matplotlib-smoke.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('x,y\n0,1\n1,3\n2,5\n'),
    })
    await page.getByRole('button', { name: '完成' }).click()

    await libCard('数据源').click()
    await page.locator('.panel-body select').first().selectOption({ index: 1 })
    const source = await lastNodeId()

    await libCard('自定义图表').click()
    const chart = await lastNodeId()
    await pointerDrag(
      await handleCenter(source, '__table__', 'source'),
      await handleCenter(chart, 'data', 'target'),
    )

    const image = page.locator(`${nodeSel(chart)} img.wf-figure-image`)
    // 列名候选取自已经求值的上游表摘要；等首张图出现后再检查动态选择器。
    try {
      await image.waitFor({ timeout: 90000 })
    } catch {
      fail(`绘图节点没有生成 PNG：${(await page.locator(nodeSel(chart)).innerText()).slice(0, 800)}`)
    }
    const initialSrc = await image.getAttribute('src')
    if (!initialSrc?.startsWith('data:image/png;base64,')) fail('自定义函数结果没有作为 Matplotlib PNG 显示')

    await page.locator('.panel-body textarea.code-area').first().fill(
      'def plot(data, feature_name: str = "x"):\n' +
        '    import matplotlib.pyplot as plt\n' +
        '    fig, ax = plt.subplots()\n' +
        '    ax.plot(data[feature_name])\n' +
        '    ax.set_title(feature_name)\n' +
        '    return {"figure": fig}\n',
    )
    const featureControls = page.locator('.panel-body .param-control').filter({ hasText: 'feature_name' })
    const featureSelect = featureControls.locator('select')
    await featureSelect.waitFor({ timeout: 10000 })
    const featureOptions = await featureSelect.locator('option').allTextContents()
    if (!featureOptions.includes('x') || !featureOptions.includes('y')) {
      fail(`列名参数没有显示上游表的列：${featureOptions.join('、')}`)
    }

    const waitForFigureUpdate = async (previousSrc) => {
      await page.waitForFunction(
        ({ selector, previousSrc: oldSrc }) => {
          const img = document.querySelector(`${selector} img.wf-figure-image`)
          const status = document.querySelector(`${selector} .wf-node-status`)
          return img?.getAttribute('src') !== oldSrc && status?.textContent?.trim() === '已算'
        },
        { selector: nodeSel(chart), previousSrc },
        { timeout: 90000 },
      )
    }

    // 先等新绘图函数以默认 x 参数算完，确保接下来比较的是参数切换前的最新 PNG。
    await waitForFigureUpdate(initialSrc)
    const srcBeforeConfigChange = await image.getAttribute('src')
    if (!srcBeforeConfigChange?.startsWith('data:image/png;base64,')) {
      fail('自定义图表参数切换前没有可比较的 PNG')
    }

    await featureSelect.selectOption('y')
    if ((await featureSelect.inputValue()) !== 'y') fail('右侧栏没有保存所选的上游列名')

    await waitForFigureUpdate(srcBeforeConfigChange)
    const updatedSrc = await image.getAttribute('src')
    if (!updatedSrc?.startsWith('data:image/png;base64,')) fail('自定义函数结果没有作为 Matplotlib PNG 显示')
    if (updatedSrc === srcBeforeConfigChange) fail('切换 feature_name 后，节点已算完但 PNG 没有更新')
    return 'Pyodide 加载 Matplotlib，切换 feature_name 后重算并更新 PNG'
  })

  /*
   * "报告跟着工程走"这条闭环的最后一格：一次交代之后，Agent 自己采集画布图像、
   * 把它写进 Markdown、交出一份能在软件里读、能下载、重开工程还在的报告。
   *
   * 用脚本化的假 provider 走完整条链：task_checkpoint 建计划 → report_figure 把当前参数下
   * 的 PNG 收进报告附件 → finish 落成工程报告 → 右侧「项目报告」栏里渲染出图 →
   * 保存工程写进 .sciviz → **把文件里的正文改掉再打开**，界面必须显示文件里那一份
   * （不是内存里的），最后新建/删除也各写回一次。
   *
   * 两条替代：模型换成脚本化回复；File System Access API 用一个内存文件句柄顶替
   * （没有它，保存只会走"下载一份"，验不了"写回同一个文件"）。
   */
  await check('长程任务把画布图像做成项目报告：软件内可预览、可下载、重开工程还在', async () => {
    chatHost = await startChatHost()
    const reportGoal = '比较两个工作段并把图像写进实验报告'
    const diskOnlySentence = '磁盘版结论：这句话只存在于工程文件里。'
    let providerRequests = 0
    let providerFailure = null
    let acceptDialogs = null
    const toolReply = (callId, name, arguments_) => [
      { type: 'tool_call', callId, name, arguments: arguments_ },
      { type: 'done', finishReason: 'tool_calls' },
    ]
    const textReply = (text) => [
      { type: 'text_delta', text },
      { type: 'done', finishReason: 'stop' },
    ]
    const reportContext = await browser.newContext({ viewport: { width: 1680, height: 1000 } })
    await reportContext.addInitScript(() => {
      localStorage.clear()
      localStorage.setItem('sciviz.engine', 'pyodide')
      const file = { text: '', lastModified: Date.now(), name: '工作段对比.sciviz' }
      const handle = {
        name: file.name,
        kind: 'file',
        async getFile() {
          return {
            name: file.name,
            lastModified: file.lastModified,
            size: file.text.length,
            async text() { return file.text },
          }
        },
        async queryPermission() { return 'granted' },
        async requestPermission() { return 'granted' },
        async createWritable() {
          return {
            async write(data) { file.text = typeof data === 'string' ? data : await data.text() },
            async close() { file.lastModified = Date.now() },
          }
        },
      }
      window.__scivizFakeFile = file
      window.showOpenFilePicker = async () => [handle]
      window.showSaveFilePicker = async () => handle
    })
    page = await reportContext.newPage()
    page.on('pageerror', (error) => console.log(`  [页面异常] ${error.message}`))
    try {
      const localUrl = new globalThis.URL(URL)
      localUrl.searchParams.set('host', CHAT_HOST_URL)
      await page.goto(localUrl.toString(), { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.canvas-host', { timeout: 15000 })

      // 先得有一张真的画布图像（Pyodide + Matplotlib 算出来的 PNG），报告才有东西可带
      await page.getByRole('button', { name: '导入数据' }).click()
      await page.locator('.modal input[type="file"]').setInputFiles({
        name: 'report-work-segments.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('x,y\n0,1\n1,2\n2,8\n3,9\n'),
      })
      await page.getByRole('button', { name: '完成' }).click()
      await libCard('数据源').click()
      await page.locator('.panel-body select').first().selectOption({ index: 1 })
      const source = await lastNodeId()
      await libCard('自定义图表').click()
      const chart = await lastNodeId()
      await pointerDrag(await handleCenter(source, '__table__', 'source'), await handleCenter(chart, 'data', 'target'))
      const chartImage = page.locator(`${nodeSel(chart)} img.wf-figure-image`)
      await chartImage.waitFor({ timeout: 90000 })
      if (!(await chartImage.getAttribute('src'))?.startsWith('data:image/png;base64,')) fail('画布上没有可采集的 PNG')

      await page.route(`${CHAT_HOST_URL}/agent/chat`, async (route) => {
        const request = route.request().postDataJSON()
        const messages = Array.isArray(request?.messages) ? request.messages : []
        const reportFigureResult = () => {
          const message = [...messages].reverse().find((item) => item.role === 'tool' && item.tool_call_id === 'report-task-figure')
          return message ? JSON.parse(message.content) : null
        }
        let reply
        if (providerRequests === 0) {
          if (!request?.tools?.some((tool) => tool.function?.name === 'report_figure')) {
            providerFailure = '模型工具清单没有 Chat 专属 report_figure'
          }
          reply = toolReply('report-task-plan', 'task_checkpoint', {
            action: 'plan',
            goal: reportGoal,
            steps: [{ id: 'capture', title: '采集当前参数下的画布图像', successCriteria: '报告里有一张能解析成本地 PNG 的画布图像' }],
          })
        } else if (providerRequests === 1) {
          reply = toolReply('report-task-figure', 'report_figure', { nodeId: chart, caption: '工作段 0 的对比曲线' })
        } else if (providerRequests === 2) {
          const figure = reportFigureResult()
          if (!figure?.data?.markdownRef?.startsWith('![工作段 0 的对比曲线](report-figure:')) {
            providerFailure = `report_figure 没有返回可放进报告的图片引用：${JSON.stringify(figure?.data ?? null)}`
            reply = textReply('我没有拿到图像引用。')
          } else if (figure.data.imageSentToModel !== false) {
            providerFailure = '报告图像被当成模型上下文发送了'
            reply = textReply('图像外发了。')
          } else {
            reply = toolReply('report-task-step', 'task_checkpoint', {
              action: 'update',
              stepId: 'capture',
              status: 'completed',
              evidenceRefs: ['report-task-figure'],
              note: '图像已收入报告附件',
            })
          }
        } else if (providerRequests === 3) {
          const markdownRef = reportFigureResult()?.data?.markdownRef
          if (!markdownRef) {
            providerFailure = '完成步骤之后拿不到图像引用'
            reply = textReply('缺图像引用。')
          } else {
            reply = toolReply('report-task-finish', 'task_checkpoint', {
              action: 'finish',
              summary: '画布图像与结论已收进项目报告。',
              report: [
                '# 工作段对比实验报告', '',
                '## 基线', '数据源是两条工作段的折线；基线是未改动参数时的默认输出。', '',
                '## 改动与实验', '没有改算子实现，只采集当前参数下画布算出来的图像。', '',
                '## 结果', '', markdownRef, '',
                '## 结论与局限', '', '本例只验证报告链路与图像证据的携带，不构成科研结论。', '', diskOnlySentence, '',
              ].join('\n'),
            })
          }
        } else if (providerRequests === 4) {
          reply = textReply('报告已写好，可以打开右侧「项目报告」查看。')
        } else {
          providerFailure = `模型请求次数超出预期：${providerRequests + 1}`
          reply = textReply('回归收到额外请求。')
        }
        providerRequests += 1
        await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: `${reply.map((event) => JSON.stringify(event)).join('\n')}\n` })
      })

      acceptDialogs = (dialog) => dialog.accept()
      page.on('dialog', acceptDialogs)

      await page.getByRole('tab', { name: 'AI 工作区' }).click()
      await page.locator('.chat-panel:visible').waitFor({ timeout: 5000 })
      await page.waitForFunction(() => {
        const input = document.querySelector('.chat-panel textarea')
        return !!input && !input.disabled
      }, null, { timeout: 10000 })
      await page.locator('.chat-panel:visible textarea').fill('比较两个工作段，把图像写进实验报告')
      await page.locator('.chat-panel:visible').getByRole('button', { name: '发送' }).click()
      try {
        await page.waitForFunction(
          () => Array.from(document.querySelectorAll('.chat-message.assistant .chat-text')).some((element) => element.textContent?.includes('报告已写好')),
          null,
          { timeout: 60000 },
        )
      } catch {
        fail(`没等到任务收尾；requests=${providerRequests}；providerFailure=${providerFailure ?? 'none'}`)
      }
      if (providerFailure) fail(providerFailure)
      if (providerRequests !== 5) fail(`模型请求次数不对：期望 5，实际 ${providerRequests}`)

      // 报告得在「项目报告」栏里看得见 —— 图是软件内渲染出来的，不是让人自己去别处打开
      await page.getByRole('button', { name: /打开画布/ }).click()
      await page.locator('.panel-tabs .tab', { hasText: '项目报告' }).click()
      const panel = page.locator('.report-panel')
      await panel.waitFor({ timeout: 5000 })
      if ((await panel.locator('.report-list button', { hasText: reportGoal }).count()) === 0) {
        fail(`报告列表里没有这次任务的报告：${await panel.locator('.report-list').innerText()}`)
      }
      const previewImage = panel.locator('.report-preview img.nb-img')
      await previewImage.waitFor({ timeout: 5000 })
      if (!(await previewImage.getAttribute('src'))?.startsWith('data:image/png;base64,')) fail('报告预览里没有渲染出内嵌图像')
      const previewText = await panel.locator('.report-preview').innerText()
      if (!previewText.includes('图源：') || !previewText.includes('SHA-256')) fail(`报告没有写出图源：${previewText.slice(0, 200)}`)

      const downloadPromise = page.waitForEvent('download')
      await panel.getByRole('button', { name: '下载 MD' }).click()
      const download = await downloadPromise
      if (!download.suggestedFilename().endsWith('.md')) fail(`报告文件名不对：${download.suggestedFilename()}`)

      // 保存工程：报告正文、内嵌图像与 Agent 来源都要真的写进 .sciviz
      await page.getByRole('button', { name: '保存工程' }).click()
      await page.locator('.modal').getByRole('button', { name: '知道了' }).click()
      const savedText = await page.evaluate(() => window.__scivizFakeFile.text)
      if (!/^reports:/m.test(savedText)) fail('写出去的 .sciviz 里没有 reports 段')
      if (!savedText.includes(`title: ${reportGoal}`)) fail('报告标题没有进工程文件')
      if (!savedText.includes('data:image/png;base64,')) fail('报告里的图像没有随工程写进文件')
      if (!savedText.includes('agent-task')) fail('报告没有记下它来自哪个 Agent 任务')

      // 把文件里的报告正文改掉再打开：界面显示的必须是文件里那份，不是内存里的
      const mutated = savedText.replace(diskOnlySentence, '改过之后的文件正文。')
      if (mutated === savedText) fail('工程文件里没有找到报告正文，无法验证"重开显示文件版"')
      await page.evaluate((text) => {
        window.__scivizFakeFile.text = text
        window.__scivizFakeFile.lastModified = Date.now()
      }, mutated)
      await page.getByRole('button', { name: '打开工程' }).click()
      await page.locator('.modal').getByRole('button', { name: '知道了' }).click()
      await page.locator('.panel-tabs .tab', { hasText: '项目报告' }).click()
      await panel.locator('.report-preview').getByText('改过之后的文件正文。').waitFor({ timeout: 5000 })

      // 报告管理：新建一份再删掉，列表与工程文件都要跟着动
      await panel.getByRole('button', { name: '新建' }).click()
      await page.waitForFunction(() => document.querySelectorAll('.report-list button').length === 2)
      await panel.getByRole('button', { name: '删除' }).click()
      await page.waitForFunction(() => document.querySelectorAll('.report-list button').length === 1)
      const afterDelete = await page.evaluate(() => window.__scivizFakeFile.text)
      if (afterDelete.includes('title: 新报告')) fail('删除只改了界面，没有写回工程文件')

      return `报告带图入库：预览渲染内嵌 PNG、可下载 .md、保存工程写出 ${savedText.length} 字符、重开显示文件版、新建与删除都写回`
    } finally {
      if (acceptDialogs) page.off('dialog', acceptDialogs)
      await page.unroute(`${CHAT_HOST_URL}/agent/chat`).catch(() => undefined)
      stopChatHost(chatHost)
      chatHost = null
    }
  })

  /**
   * 写权限还没到手时的那条路 —— 2026-09-27 真机故障的根因。
   *
   * 真机现象：工程明明开着，Agent 的报告却写不回去，工具只报一句
   * 「报告未能写回已打开的工程文件；本地草稿已保留，请检查文件权限或磁盘变化」，
   * 而磁盘、权限、占用都没问题。真原因是两条叠加：① 浏览器只在**用户手势**里弹写权限
   * 授权框，而自动保存与 Agent 写报告那条路上没有点击；② 桌面壳每次启动换一个新的浏览器
   * 配置目录，于是"打开过的文件"每次都要重新授权一次（第二条在 sciviz-desk 里已改成固定目录）。
   *
   * 假句柄把①如实演出来：`requestPermission` 只在 `navigator.userActivation.isActive` 为真时
   * 给 granted，且**开文件那一次手势算在 picker 头上**（`pickerOpened`）—— 于是"打开工程之后
   * 仍然没有写权限"这个处境与真机一致。要压的三件事：
   *   1. 这种处境下人得有得点：工具条上出现「允许写回」并把处境说出来；
   *   2. 不点它，画布怎么变，磁盘上那份一个字都不动（不许静默假成功）；
   *   3. 点它一次，画布与报告就真的写进那个文件。
   */
  await check('工程打开后写权限还没到手：工具条给出「允许写回」，点一次就真的写回', async () => {
    const permissionContext = await browser.newContext({ viewport: { width: 1600, height: 950 } })
    await permissionContext.addInitScript(() => {
      localStorage.clear()
      localStorage.setItem('sciviz.engine', 'pyodide')
      const file = {
        name: '权限工程.sciviz',
        lastModified: Date.now(),
        text: [
          '# SciViz 工程文件 v1 —— 人与 agent 共用这一份',
          'version: 1',
          'name: 权限工程',
          'description: ""',
          'graph:',
          '  nodes:',
          '    - id: src',
          '      type: data.source',
          '      label: 数据',
          '      params:',
          '        datasetId: fixture',
          '      position:',
          '        x: 0',
          '        y: 0',
          '  edges: []',
          '',
        ].join('\n'),
      }
      let pickerOpened = false
      // 真浏览器里，写权限只在"用户手势里"申请得到，而且打开文件的那一次手势会被 picker 用掉。
      // 这里用真实的 pointerdown 给"这一次点击"计数，并在同一轮任务结束后作废 ——
      // 于是"打开工程之后顺手申请"拿不到（与真机一致），而工具条上那一次点击拿得到。
      let armedByFreshClick = false
      document.addEventListener('pointerdown', () => {
        if (!pickerOpened) return
        armedByFreshClick = true
        setTimeout(() => { armedByFreshClick = false }, 0)
      }, true)
      const handle = {
        name: file.name,
        kind: 'file',
        async getFile() {
          return {
            name: file.name,
            lastModified: file.lastModified,
            size: file.text.length,
            async text() { return file.text },
          }
        },
        async queryPermission() { return pickerOpened && window.__scivizWriteGranted ? 'granted' : 'prompt' },
        async requestPermission() {
          if (!armedByFreshClick || !navigator.userActivation?.isActive) return 'prompt'
          window.__scivizWriteGranted = true
          return 'granted'
        },
        async createWritable() {
          return {
            async write(data) { file.text = typeof data === 'string' ? data : await data.text() },
            async close() { file.lastModified = Date.now() },
          }
        },
      }
      window.__scivizFakeFile = file
      window.__scivizWriteGranted = false
      window.showOpenFilePicker = async () => { pickerOpened = true; return [handle] }
      window.showSaveFilePicker = async () => handle
    })
    page = await permissionContext.newPage()
    page.on('pageerror', (error) => console.log(`  [页面异常] ${error.message}`))
    try {
      await openBlankCanvas()
      const diskBefore = await page.evaluate(() => window.__scivizFakeFile.text)

      await page.getByRole('button', { name: '打开工程' }).click()
      const openedHead = await page.locator('.modal .modal-head').innerText()
      if (!openedHead.includes('已打开')) fail(`打开工程没成功：${openedHead}`)
      await page.locator('.modal').getByRole('button', { name: '知道了' }).click()

      // 1. 人得有得点，并且得知道现在是什么处境
      // 限定精确名字：自动保存失败的那条说明里也会带上「允许写回」四个字
      const allow = page.getByRole('button', { name: '允许写回', exact: true })
      if ((await allow.count()) === 0) {
        fail('写权限没到手，工具条上却没有「允许写回」入口 —— 人除了碰巧去点「保存工程」之外没有别的办法')
      }
      if ((await page.locator('.file-change-badge', { hasText: '读权限' }).count()) === 0) {
        fail('没有把"现在只有读权限"这个处境说出来')
      }

      // 2. 不点它，画布变再多也不许动磁盘上那份（自动保存这条路上没有用户手势）
      await libCard('数据源').click()
      await page.waitForTimeout(1500)
      const diskAfterEdit = await page.evaluate(() => window.__scivizFakeFile.text)
      if (diskAfterEdit !== diskBefore) fail('没有写权限却把文件写了：自动保存越过了浏览器授权')

      // 3. 点一次「允许写回」：画布（含刚加的块）就真的落到那个文件里
      await allow.click()
      await page.locator('.modal').getByRole('button', { name: '知道了' }).click()
      const diskAfterAllow = await page.evaluate(() => window.__scivizFakeFile.text)
      if (diskAfterAllow === diskBefore) fail('点了「允许写回」之后文件还是原样')
      if (!diskAfterAllow.includes('name: 权限工程')) fail(`写回把工程名字弄丢了：${diskAfterAllow.slice(0, 120)}`)
      if (diskAfterAllow === diskAfterEdit) fail('写回的不是画布上的内容')

      return `没写权限时给出「允许写回」入口、磁盘一动不动（${diskBefore.length} 字符）；点一次之后写成 ${diskAfterAllow.length} 字符`
    } finally {
      await permissionContext.close()
    }
  })

  await check('自定义模型列表参数可在右侧栏逐项编辑并连接到通用训练函数', async () => {
    // 前面的 Matplotlib 用例刻意锁定 Pyodide；训练控制需要验证真实宿主能力，
    // 另开一个本地模式页面，避免已经缓存的执行后端污染这项断言。
    const localContext = await browser.newContext({ viewport: { width: 1680, height: 1000 } })
    await localContext.addInitScript(() => {
      localStorage.clear()
      localStorage.setItem('sciviz.engine', 'local')
    })
    page = await localContext.newPage()
    page.on('pageerror', (error) => console.log(`  [页面异常] ${error.message}`))
    await openBlankCanvas()
    await libCard('自定义模型').click()
    await page.waitForTimeout(350)
    const model = await lastNodeId()
    const modelCode = page.locator('.panel-body textarea.code-area').first()
    if ((await modelCode.count()) === 0) fail('自定义模型没有代码编辑框')
    await modelCode.fill(`MODEL_PARAMS = {
    "channels": {
        "type": "list[int]",
        "default": [8, 16],
        "minItems": 1,
        "maxItems": 8,
        "itemMin": 1,
    },
}`)
    const listEditor = page.locator('.panel-body .list-param-field').first()
    await listEditor.waitFor({ timeout: 5000 })
    if ((await listEditor.locator('.list-param-row').count()) !== 2) fail('右侧栏没有显示模型列表参数')
    if (await page.locator(nodeSel(model)).locator('.wf-model-params-card').count()) fail('模型参数仍占着节点卡片')
    await listEditor.getByRole('button', { name: '新增一项' }).click()
    if ((await listEditor.locator('.list-param-row').count()) !== 3) fail('右侧栏新增列表项没有生效')
    await listEditor.locator('.list-param-remove').last().click()
    if ((await listEditor.locator('.list-param-row').count()) !== 2) fail('右侧栏删除列表项没有生效')

    await libCard('自定义训练').click()
    await page.waitForTimeout(350)
    const train = await lastNodeId()
    await pointerDrag(
      await handleCenter(model, 'model', 'source'),
      await handleCenter(train, 'model', 'target'),
    )
    if ((await page.locator('.react-flow__edge').count()) === 0) fail('自定义模型无法连接到通用训练函数')
    const startTraining = page.locator(nodeSel(train)).getByRole('button', { name: '▶ 开始训练' })
    await startTraining.waitFor({ timeout: 5000 })
    if (await startTraining.isDisabled()) fail('本地宿主在线时，训练节点的开始按钮不应禁用')
    return '列表项可新增/删除，模型定义端口可连接；训练节点明确显示开始按钮'
  })

  await browser.close()
  const failed = results.filter((result) => !result.ok && !result.skipped)
  const skipped = results.filter((result) => result.skipped)
  console.log(`\n结果：${results.length - failed.length - skipped.length} 通过，${skipped.length} 跳过，${failed.length} 失败`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
