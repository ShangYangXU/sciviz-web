/**
 * 环境诊断：本机浏览器取不到 zip 内容时，先跑这个。
 *
 * 只做一件事：起一个本地 http 服务把项目自带的 python_stdlib.zip 原样吐出，
 * 然后让 Node 和 e2e 用的同一个 Chromium 各 fetch 一次，打印状态码与字节数。
 *
 * 判读（2026-09-12 实测过一次，就是靠它定位的）：
 *   Node 200 + 浏览器 200 = 链路正常；e2e 若仍跳过就是应用问题
 *   Node 200 + 浏览器 204 = 被本机软件拦掉，不是应用问题。
 *                           实测元凶是 IDM 的内核网络过滤驱动 IDMWFP.sys；
 *                           卸载后恢复 200。同类下载器 / 安全软件都可能这样。
 *
 * 用法：node scripts/check-zip-fetch.mjs
 */
import fs from 'node:fs'
import http from 'node:http'

import { chromium } from 'playwright-core'

const ZIP = new URL('../public/pyodide/python_stdlib.zip', import.meta.url)
const CHROME =
  'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe'

const payload = fs.readFileSync(ZIP)
console.log(`磁盘上的 python_stdlib.zip：${payload.length} 字节`)

const server = http.createServer((req, res) => {
  if (req.url === '/x.zip') {
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Length': String(payload.length),
    })
    res.end(payload)
    return
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><meta charset="utf-8"><title>zip 取数检查</title>ok')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const url = `http://127.0.0.1:${port}/x.zip`

// 1) Node 自己的 fetch（绕过浏览器）：拦它 = 网络层过滤；不拦 = 浏览器侧行为
const nodeRes = await fetch(url)
const nodeBody = await nodeRes.arrayBuffer()
console.log(`Node fetch   ：status=${nodeRes.status} bytes=${nodeBody.byteLength}`)

// 2) 浏览器（e2e 用的同一个）
const browser = await chromium.launch({ executablePath: CHROME })
const page = await browser.newPage()
await page.goto(`http://127.0.0.1:${port}/`)
const result = await page.evaluate(async (p) => {
  const res = await fetch(`http://127.0.0.1:${p}/x.zip`)
  const body = await res.arrayBuffer()
  return { status: res.status, bytes: body.byteLength, type: res.headers.get('content-type') }
}, port)
console.log(`Chromium fetch：${JSON.stringify(result)}`)

await browser.close()
server.close()
