<#
把整个项目要用的 Python 环境装到一个地方：仓库根目录的 .venv。

为什么要一个脚本，而不是一串手敲的命令：

1. CUDA 版 torch 不在 PyPI 上，得单独从 PyTorch 的索引装，且版本要和驱动、已有的
   torch 对上。敲错一次的表现是「装上了，但静默跑在 CPU 上」—— 结果是对的，
   所以没有任何东西会提醒你。
2. 本机直连 PyPI 与 download.pytorch.org 会被重置，每条 pip 都要带代理。
3. 系统 Python 在 C 盘，而 C 盘只剩不到 3GB —— CUDA 版 torch 解压后就有 4GB 以上。
   所以 pip 的缓存也必须指到别的盘，否则光缓存就把那点剩余空间吃光。

用法：
  .\setup-env.ps1             从零重建
  .\setup-env.ps1 -Update     只按 requirements.txt 补齐/升级，不重建 venv
  .\setup-env.ps1 -NoProxy    网络正常的地方用这个去掉代理

重建（想彻底重来）：
  Remove-Item .\.venv -Recurse -Force; .\setup-env.ps1
#>

[CmdletBinding()]
param(
    [switch]$Update,
    [switch]$NoProxy,
    # 按 requirements.lock.txt 装，而不是按 requirements.txt 解析最新版本。
    # 换机器复现同一份环境用这个；日常改库用 -Update。
    [switch]$Locked,
    [string]$Proxy = 'http://127.0.0.1:7890',
    [string]$TorchIndex = 'https://download.pytorch.org/whl/cu126',
    [string]$TorchSpec = 'torch==2.13.0+cu126',
    # torchvision 的版本必须与 torch 配对（2.13.0 ↔ 0.28.0），而且它和 torch 一样
    # 只在 PyTorch 自己的索引上 —— 放进 requirements.txt 会因找不到而安装失败。
    [string]$TorchVisionSpec = 'torchvision==0.28.0+cu126'
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$venv = Join-Path $root '.venv'
$python = Join-Path $venv 'Scripts\python.exe'
$cache = Join-Path $root '.pip-cache'
$temp = Join-Path $root '.tmp'

# 缓存与临时目录都放仓库所在的盘：pip 默认全写 C 盘，而 C 盘装不下
$env:TEMP = $temp
$env:TMP = $temp
New-Item -ItemType Directory -Force -Path $cache, $temp | Out-Null

function Test-LocalProxy {
    param([string]$Url)
    # 重试三次、每次给足 1.5 秒：单次 500ms 的探测会把一个正常工作的代理判成不可用，
    # 然后退回直连 —— 而直连在这里是"卡住几分钟才失败"，比探测本身贵得多。
    $uri = [Uri]$Url
    foreach ($attempt in 1..3) {
        try {
            $client = [System.Net.Sockets.TcpClient]::new()
            $finished = $client.ConnectAsync($uri.Host, $uri.Port).Wait(1500)
            $ok = $finished -and $client.Connected
            $client.Close()
            if ($ok) { return $true }
        } catch {
            # 偶发拒绝，换一次就好；三次都不行才判定不可用
        }
    }
    return $false
}

$pipArgs = @('--cache-dir', $cache)
if (-not $NoProxy) {
    if (Test-LocalProxy -Url $Proxy) {
        Write-Host "使用代理 $Proxy" -ForegroundColor DarkGray
        $pipArgs += @('--proxy', $Proxy)
    } else {
        Write-Warning "本地代理 $Proxy 连不上，改为直连。若卡住或报 Connection was reset，用 -Proxy 指定一个能用的。"
    }
}

if (Test-Path $python) {
    if (-not $Update) {
        Write-Host "复用已有的 $venv（要重建就先删掉它）" -ForegroundColor DarkGray
    }
} else {
    Write-Host "创建 venv：$venv" -ForegroundColor Cyan
    & py -3.12 -m venv $venv
}

$manifest = if ($Locked) { 'requirements.lock.txt' } else { 'requirements.txt' }

if (-not $Locked) {
    # 先装 torch：它最慢也最容易失败，让它先失败，别装完一堆依赖才炸。
    # -Locked 时跳过这步：锁文件里已经写了带 +cu126 的 torch 与 torchvision。
    Write-Host '安装 CUDA 版 torch / torchvision' -ForegroundColor Cyan
    & $python -m pip install @pipArgs --index-url $TorchIndex `
        --extra-index-url https://pypi.org/simple $TorchSpec $TorchVisionSpec
    if ($LASTEXITCODE -ne 0) { throw 'torch 安装失败' }
}

Write-Host "安装 $manifest" -ForegroundColor Cyan
Push-Location $root
try {
    # 带上 PyTorch 索引：锁文件里的 torch / torchvision 只有那里有
    & $python -m pip install @pipArgs --index-url https://pypi.org/simple `
        --extra-index-url $TorchIndex -r $manifest
    if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
} finally {
    Pop-Location
}

Write-Host "`n环境自查：" -ForegroundColor Cyan
& $python -m sciviz_host.doctor
if ($LASTEXITCODE -ne 0) { throw "环境不完整，见上面的报告" }

Write-Host "`n完成。跑宿主：sciviz-local\run-host.ps1" -ForegroundColor Green
