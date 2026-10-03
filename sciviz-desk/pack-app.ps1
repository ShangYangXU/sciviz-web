# 把「应用代码」打成一个可替换的小包：前端 + 算子 + 版本号。
#
# 待办 T15 的判据是"更新前端与算子**不需要重发安装包**"。这句话要成立，
# 前提是这两样东西能被单独替换 —— 所以这里把它们单独装一个 zip（约 1MB），
# 而 4.7GB 的运行时原地不动。
#
# 用法：
#   .\pack-app.ps1                 # 用现成的 dist
#   .\pack-app.ps1 -Build          # 先跑一次 npm run build
#
param(
    [string]$Repo = '',
    [switch]$Build,
    [string]$OutDir = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Repo) { $Repo = Split-Path $PSScriptRoot -Parent }
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot 'out' }

$web = Join-Path $Repo 'sciviz-web'
$dist = Join-Path $web 'dist'
$operators = Join-Path $web 'src\engine\python'
$hostCode = Join-Path $Repo 'sciviz-local\sciviz_host'

if ($Build) {
    Push-Location $web
    try { npm run build } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $dist 'index.html'))) {
    throw "前端还没打包：$dist。先 npm run build，或加 -Build。"
}

# 版本号：前端 asset 的文件名带内容哈希，所以用它们的哈希当版本 —— 内容一变它就变
$assets = Get-ChildItem (Join-Path $dist 'assets') -File | Sort-Object Name
$stamp = (($assets | ForEach-Object { $_.Name }) -join '|')
$hash = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash(
        [System.Text.Encoding]::UTF8.GetBytes($stamp)
    )
).Replace('-', '').Substring(0, 12).ToLower()
$version = "$(Get-Date -Format 'yyyyMMdd')-$hash"

$stage = Join-Path $OutDir "sciviz-app-$version"
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null

# dist 里有两块**不是代码**的东西：pyodide（38MB，浏览器引擎）与 samples（56MB，示例数据）。
# 把它们留在包里会让"每天更新"变成"每天传 95MB"。所以：
#   - pyodide 属于运行时：它一年动几次，装一次就够；
#   - samples 属于数据：它不该进包，也不该进 git（待办 T20）。
# 只打 assets / index.html / 算子。
foreach ($name in 'assets', 'index.html') {
    Copy-Item (Join-Path $dist $name) (Join-Path $stage $name) -Recurse -Force
}
New-Item -ItemType Directory -Path (Join-Path $stage 'operators') -Force | Out-Null
Copy-Item (Join-Path $operators '*.py') (Join-Path $stage 'operators') -Force
# 宿主代码也放这一层：目录名必须是 `sciviz_host`（启动脚本会把应用目录放进 PYTHONPATH，
# 于是它赢过 .venv 里那份指向开发仓库的 editable 安装）。改名成 `host` 就 import 不到了。
$stageHost = Join-Path $stage 'sciviz_host'
New-Item -ItemType Directory -Path $stageHost -Force | Out-Null
Copy-Item (Join-Path $hostCode '*.py') $stageHost -Force

@(
    "版本      $version",
    "前端      dist/assets + index.html",
    "算子      operators/*.py（共享算子，两个执行面同一份）",
    "宿主      sciviz_host/*.py（宿主专属算子与协议；目录名固定）",
    "",
    "这是**更新包**，不是完整安装：覆盖到应用目录即可（同名目录替换）。",
    "首次安装还需要完整的前端目录（含 pyodide 与 samples）与运行时（.venv），",
    "那两样一年也动不了几次 —— 它们不进这个包，正是为了让「每天更新」只有 0.3MB。"
) | Set-Content -Path (Join-Path $stage 'VERSION.txt') -Encoding UTF8

$zip = Join-Path $OutDir "sciviz-app-$version.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip

$size = (Get-Item $zip).Length
Write-Host ("应用代码包  {0}（{1:N2} MB）" -f (Split-Path $zip -Leaf), ($size / 1MB))
Get-ChildItem $stage -Recurse -File | Group-Object { $_.Directory.Name } | ForEach-Object {
    $sum = ($_.Group | Measure-Object -Property Length -Sum).Sum
    Write-Host ("  {0,-10} {1,8:N0} KB（{2} 个文件）" -f $_.Name, ($sum / 1KB), $_.Count)
}
