# 首次安装：把"应用代码那一层"装进一个应用目录，并把运行时指过去。
#
# 分层见 README（待办 T15）：运行时 4.7GB 一年动几次，应用代码 0.3MB 每天动。
# 这个脚本装的是**首次安装**：完整前端（含 pyodide 与 samples）+ 算子 + 宿主代码 + 桌面壳脚本，
# 加上一份"运行时在哪儿"的记录。之后的日常更新用 `pack-app.ps1` 打出来的 0.3MB 更新包覆盖即可。
#
# 用法：
#   .\install-app.ps1 -App D:\sciviz-app                     # 运行时用仓库根那份 .venv
#   .\install-app.ps1 -App D:\sciviz-app -Runtime E:\envs\sciviz
#   .\install-app.ps1 -App D:\sciviz-app -Build               # 先 npm run build 再装
#
# 刻意不做的事：**不复制 .venv**。虚拟环境里带着绝对路径（pyvenv.cfg、Scripts 里的
# 启动器、editable 安装的 .pth），复制到别处是"看起来能用、某个角落开始报错"的典型来源。
# 目标机器上的运行时用 `setup-env.ps1` 建（那是它自己那台机器上的路径），
# 这个脚本只负责把它记下来（`<App>\runtime.txt`），并让启动脚本第一个就去读它。
param(
    [Parameter(Mandatory = $true)][string]$App,
    [string]$Runtime = '',
    [string]$From = '',
    [switch]$Build,
    [switch]$SkipRuntimeCheck
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
if (-not $From) { $From = $repo }
if (-not $Runtime) { $Runtime = $From }

$web = Join-Path $From 'sciviz-web'
$local = Join-Path $From 'sciviz-local'
$desk = Join-Path $From 'sciviz-desk'
$appFull = [IO.Path]::GetFullPath($App)

if ($Build) {
    Write-Host '打包前端（npm run build）…'
    Push-Location $web
    try { npm run build } finally { Pop-Location }
}

# ---- 检查"要装的东西"在不在。缺什么就说清缺什么，别装出一个半截应用 ----
$need = @{
    '前端（dist/index.html）' = Join-Path $web 'dist\index.html'
    '共享算子'                = Join-Path $web 'src\engine\python\operators.py'
    '共享运行时'              = Join-Path $web 'src\engine\python\runtime.py'
    '宿主代码'                = Join-Path $local 'sciviz_host\__main__.py'
}
foreach ($name in $need.Keys) {
    if (-not (Test-Path -LiteralPath $need[$name])) {
        throw "缺 $name：$($need[$name])。前端要先用 npm run build 打包。"
    }
}

$python = Join-Path $Runtime '.venv\Scripts\python.exe'
if (-not $SkipRuntimeCheck -and -not (Test-Path -LiteralPath $python)) {
    throw "找不到运行时：$python。先在那台机器上按 sciviz-local\README.md 建 venv，再用 -Runtime 指过来。"
}

if ($appFull.StartsWith([IO.Path]::GetFullPath($From), [StringComparison]::OrdinalIgnoreCase)) {
    # 装进源目录里会把两套东西混在一起，之后"哪份是装出来的"说不清
    throw "应用目录不能放在源目录里面：$appFull（源：$From）"
}

Write-Host "源       $From"
Write-Host "应用目录 $appFull"
Write-Host "运行时   $Runtime"

New-Item -ItemType Directory -Force -Path $appFull | Out-Null

# ---- 完整前端（含 pyodide 与 samples：那两样一年也动不了几次，所以只在首次安装时拷） ----
Write-Host '拷贝 前端（dist）…'
Copy-Item -Path (Join-Path $web 'dist') -Destination $appFull -Recurse -Force

# ---- 共享算子（SCIVIZ_PY_DIR 指向它，宿主直接 import） ----
$operators = Join-Path $appFull 'operators'
New-Item -ItemType Directory -Force -Path $operators | Out-Null
foreach ($f in 'operators.py', 'runtime.py') {
    Copy-Item -Path (Join-Path $web "src\engine\python\$f") -Destination $operators -Force
}

# ---- 宿主代码（目录名必须是 sciviz_host：PYTHONPATH 靠模块名赢过 editable 安装） ----
Write-Host '拷贝 宿主（sciviz_host）…'
Copy-Item -Path (Join-Path $local 'sciviz_host') -Destination $appFull -Recurse -Force

# ---- 桌面壳脚本跟着走：装完之后那台机器上不再需要仓库 ----
foreach ($f in 'start-sciviz.ps1', 'install-app.ps1', 'pack-app.ps1', 'README.md') {
    Copy-Item -Path (Join-Path $desk $f) -Destination $appFull -Force
}

# ---- 运行时在哪儿：启动脚本第一个读它 ----
Set-Content -LiteralPath (Join-Path $appFull 'runtime.txt') -Value ([IO.Path]::GetFullPath($Runtime)) -Encoding UTF8

# ---- 这一版装了什么。更新包覆盖之后再跑一次 help 就能对版本 ----
$frontVersion = (Get-Content -LiteralPath (Join-Path $web 'package.json') -Raw | ConvertFrom-Json).version
$lines = @(
    "front   $frontVersion",
    "app     $([DateTime]::Now.ToString('yyyy-MM-dd HH:mm:ss'))",
    "from    $From",
    "runtime $([IO.Path]::GetFullPath($Runtime))",
    # 应用代码那一层的字节数：与 README 里那个 0.31MB 的说法对得上
    "operators $([math]::Round(((Get-ChildItem $operators -File | Measure-Object -Property Length -Sum).Sum) / 1KB, 1)) KB",
    "host    $([math]::Round(((Get-ChildItem (Join-Path $appFull 'sciviz_host') -Recurse -File | Measure-Object -Property Length -Sum).Sum) / 1KB, 1)) KB"
)
Set-Content -LiteralPath (Join-Path $appFull 'VERSION.txt') -Value $lines -Encoding UTF8

Write-Host ''
Write-Host '装好了。两条命令都在这台机器上直接可用：'
Write-Host "  启动：pwsh -File `"$appFull\start-sciviz.ps1`" -App `"$appFull`""
Write-Host "  自检：pwsh -File `"$appFull\start-sciviz.ps1`" -App `"$appFull`" -NoWindow"
Write-Host '（-NoWindow 只起宿主并自检，退出码非 0 即失败 —— 装机后先跑它）'
