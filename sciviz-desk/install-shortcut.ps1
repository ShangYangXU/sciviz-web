# 在桌面上放一个"应用端启动程序"（Windows 快捷方式）。
#
# 双击它 = 起宿主 + 开一个没有地址栏的窗口（与 `start-sciviz.ps1` 完全同一段逻辑，
# 这里只负责把那个入口摆到桌面上，不复制任何启动逻辑 —— R1：同一件事只有一处实现）。
#
# 用法：
#   .\install-shortcut.ps1                                  # 指向仓库布局，装到当前用户桌面
#   .\install-shortcut.ps1 -App D:\sciviz-app                # 指向装好的应用目录（见 install-app.ps1）
#   .\install-shortcut.ps1 -Name "科研数据图" -Desktop C:\Users\Public\Desktop
#
# 用哪个 PowerShell：优先 PowerShell 7（装了就用），否则用 Windows 自带的
# Windows PowerShell 5.1 —— 仓库里的 .ps1 都带 UTF-8 BOM，5.1 读中文注释不会出岔
# （无 BOM 时 5.1 按 GBK 解码，报的是 `Unexpected token`，看着像脚本写错了）。
param(
    [string]$App = '',
    [string]$Name = 'SciViz 科研数据图',
    [string]$Desktop = '',
    # 先做出来但不写桌面（CI/测试用）
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
$startScript = Join-Path $PSScriptRoot 'start-sciviz.ps1'
if (-not (Test-Path -LiteralPath $startScript)) {
    throw "找不到启动脚本：$startScript"
}

# PowerShell 7 优先（快、原生 UTF-8），没有就用系统自带的 5.1 —— 它一定在
$pwsh7 = @(
    (Join-Path $env:ProgramFiles 'PowerShell\7\pwsh.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'PowerShell\7\pwsh.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
$shell = if ($pwsh7) { $pwsh7 } else { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' }
if (-not (Test-Path -LiteralPath $shell)) { throw "找不到可用的 PowerShell：$shell" }

# 图标：用 Edge 的（这个窗口就是它渲染的）。想换直接右键快捷方式改。
$edge = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe')
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

$arguments = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', "`"$startScript`"",
    '-Build'
)
if ($App) { $arguments += @('-App', "`"$([IO.Path]::GetFullPath($App))`"") }

if (-not $Desktop) { $Desktop = [Environment]::GetFolderPath('Desktop') }
if (-not $Desktop) { throw '取不到桌面路径，用 -Desktop 明确指定一个目录' }
if (-not (Test-Path -LiteralPath $Desktop)) { New-Item -ItemType Directory -Force -Path $Desktop | Out-Null }

$linkPath = Join-Path $Desktop "$Name.lnk"

Write-Host "启动脚本 $startScript"
Write-Host "用哪个   $shell"
Write-Host "快捷方式 $linkPath"
if ($DryRun) {
    Write-Host '（-DryRun：不写桌面）'
    return
}

# 先删旧的：同名快捷方式留着会让人以为是新的（内容却是旧的参数）
if (Test-Path -LiteralPath $linkPath) { Remove-Item -LiteralPath $linkPath -Force }

$shellCom = New-Object -ComObject WScript.Shell
$link = $shellCom.CreateShortcut($linkPath)
$link.TargetPath = $shell
$link.Arguments = ($arguments -join ' ')
# 工作目录给仓库根：脚本自己有 $PSScriptRoot，但"双击时当前目录在哪"仍是调用方的自由，
# 给一个稳定的值，出问题时不会因为当前目录不同而表现不同
$link.WorkingDirectory = $repo
$link.Description = '启动 SciViz：本地执行宿主 + 应用窗口'
if ($edge) { $link.IconLocation = "$edge,0" }
$link.Save()

Write-Host ''
Write-Host '装好了。双击桌面上那个图标就能起应用（宿主就绪约 4 秒后窗口会自动打开）。'
