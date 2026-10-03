# 最小桌面壳：拉起宿主，然后开一个**没有地址栏的窗口**指向它伺服的界面。
#
# 这不是最终形态（最终形态大概是 Tauri 之类）。它存在的理由只有一个：把三个未知变成已知 ——
# 打包后多大、启动链路通不通、WebView2 依赖怎么办。先量出来，再决定要不要上真壳。
#
# 分层（待办 T15）：
#
#   运行时     <runtime>\.venv        Python + torch + CUDA，约 4.7GB，一年动几次
#   应用代码   <app>\dist + operators 前端与算子，约 1MB，每天动
#
# 更新的东西只落在应用代码那一侧 —— 换前端或换算子**不需要重发那个 4.7GB 的运行时**。
#
# 用法：
#   .\start-sciviz.ps1                      # 仓库里的布局（默认）
#   .\start-sciviz.ps1 -App D:\sciviz-app   # 打包后的布局（dist\ 与 operators\）
#   .\start-sciviz.ps1 -Build                # 启动前先构建仓库里的最新前端
#   .\start-sciviz.ps1 -NoWindow            # 只起宿主并自检，不开窗口
#
param(
    [string]$App = '',
    [string]$Runtime = '',
    [int]$Port = 8765,
    [switch]$Build,
    [switch]$NoWindow,
    [switch]$KeepHost
)

$ErrorActionPreference = 'Stop'

function Sync-RegisteredPath {
    # .lnk 从长期运行的 Explorer 启动时，进程 PATH 可能早于 Node 安装或 PATH 更新。
    # 把注册表中的当前用户/系统条目补进来，后续 npm.cmd 与它启动的 node.exe 都能解析。
    $entries = [System.Collections.Generic.List[string]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $sources = @(
        $env:PATH,
        [Environment]::GetEnvironmentVariable('Path', 'Machine'),
        [Environment]::GetEnvironmentVariable('Path', 'User')
    )
    foreach ($source in $sources) {
        if ([string]::IsNullOrWhiteSpace($source)) { continue }
        foreach ($entry in ([string]$source -split ';')) {
            $candidate = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim([char]34))
            if (-not [string]::IsNullOrWhiteSpace($candidate) -and $seen.Add($candidate)) {
                [void]$entries.Add($candidate)
            }
        }
    }
    $env:PATH = $entries -join ';'
}

Sync-RegisteredPath

$script:LaunchId = '{0}-{1}' -f (Get-Date -Format 'yyyyMMdd-HHmmss'), ([guid]::NewGuid().ToString('N').Substring(0, 8))
$stateRoot = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } elseif ($env:TEMP) { $env:TEMP } else { [IO.Path]::GetTempPath() }
$script:LaunchLogDirectory = Join-Path $stateRoot 'SciViz\logs'
$script:LaunchLogPath = Join-Path $script:LaunchLogDirectory 'start.log'

function Write-LauncherLog {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')][string]$Level = 'INFO'
    )

    $line = '[{0}] [{1}] [{2}] {3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $Level, $script:LaunchId, $Message
    try {
        New-Item -ItemType Directory -Force -Path $script:LaunchLogDirectory | Out-Null
        Add-Content -LiteralPath $script:LaunchLogPath -Value $line -Encoding UTF8
    } catch {
        # 日志路径不可写时，启动仍继续；故障提示仍会显示在启动窗口。
    }
    Write-Host $line
}

function Get-UsableHostHealth {
    param([Parameter(Mandatory = $true)][int]$CandidatePort)

    try {
        $candidate = Invoke-RestMethod -Uri "http://127.0.0.1:$CandidatePort/health" -TimeoutSec 2
        if (-not $candidate.ok -or $candidate.backend -ne 'local') { return $null }
        # 新 Chat wire 要求稳定会话头；旧宿主即使算子清单齐全也不能复用。
        if (-not $candidate.agentGatewayVersion -or [int]$candidate.agentGatewayVersion -lt 4) { return $null }
        $required = @('custom.model', 'train.function')
        $missing = @($required | Where-Object { @($candidate.operators) -notcontains $_ })
        if ($missing.Count -gt 0) { return $null }
        return $candidate
    } catch {
        return $null
    }
}

function Test-LocalPortAvailable {
    param([Parameter(Mandatory = $true)][int]$CandidatePort)

    $listener = $null
    try {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $CandidatePort)
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

function Test-SciVizProfileInUse {
    <#
      这份 Edge 配置目录是不是已经有窗口在用。

      判据取进程命令行里的 `--user-data-dir`（进程自己的说法），不去猜 lockfile 的锁。
      这个判断是"再点一次图标"那条路的全部依据：判错就会重演"窗口被转交给旧进程、
      启动器立刻返回、finally 又把宿主收掉"的白窗。配置目录改成固定一处之后，
      **重复双击**成了常态，所以这一条不再可省。
    #>
    param([Parameter(Mandatory = $true)][string]$Path)

    $candidates = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue
    foreach ($candidate in $candidates) {
        if ($candidate.CommandLine -and $candidate.CommandLine.IndexOf($Path, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

trap {
    $record = $_
    $message = ($record | Out-String).Trim()
    Write-LauncherLog -Level 'ERROR' -Message ("启动失败：{0}`n{1}" -f $message, $record.ScriptStackTrace)
    Write-Host "`nSciViz 启动失败。诊断日志：$script:LaunchLogPath" -ForegroundColor Red
    if (-not $NoWindow -and [Environment]::UserInteractive) {
        try { [void](Read-Host '按 Enter 关闭此窗口') } catch { }
    }
    exit 1
}

Write-LauncherLog -Message "开始启动；App='$App' Runtime='$Runtime' Port=$Port Build=$Build NoWindow=$NoWindow"

# 控制台编码：宿主的输出是 UTF-8（设备信息里有中文），而 Windows PowerShell 5.1 的
# 控制台默认按 GBK 解 —— 不解这一下，用户看到的是"GPU NVIDIA GeForce RTX 3050 Laptop GPUï¼4095 MBï¼"
# 这种乱码，像程序坏了。pwsh 7 本来就是 UTF-8，这行对它无害。
try {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
    $env:PYTHONIOENCODING = 'utf-8'
} catch {
    # 拿不到控制台（比如被重定向到文件）也不是错误，继续跑
}

$repo = Split-Path $PSScriptRoot -Parent
if (-not $App) { $App = Join-Path $repo 'sciviz-web' }

# 权重是宿主的持久化数据，不随源码模块相对路径漂移。
# 仓库布局的宿主代码在 <repo>\sciviz-local\sciviz_host，打包布局的宿主代码在
# <app>\sciviz_host；两者的 session.py 层级不同，不能让 Python 自己猜根目录。
$artifactRoot = if (Test-Path (Join-Path $App 'sciviz_host')) {
    Join-Path $App '.artifacts'
} else {
    Join-Path $repo '.artifacts'
}
$env:SCIVIZ_ARTIFACT_DIR = $artifactRoot

# 运行时（含 .venv 的那个目录）按**由近到远**找：装到别处之后，仓库不一定还在，
# 甚至这个脚本自己就住在应用目录里（那时 $repo 是应用目录的上一级，毫无意义）。
# 顺序是刻意的：
#   1. 命令行给的（最明确）
#   2. <App>\.venv                —— 运行时就在应用目录里（自包含安装）
#   3. <App>\runtime.txt 里记的路径 —— 安装时记下来的那台机器上的运行时
#   4. 脚本上一级的 .venv         —— 仓库布局（开发机）
if (-not $Runtime) {
    $recorded = Join-Path $App 'runtime.txt'
    if (Test-Path (Join-Path $PSScriptRoot '.venv\Scripts\python.exe')) {
        $Runtime = $PSScriptRoot
    } elseif (Test-Path (Join-Path $App '.venv\Scripts\python.exe')) {
        $Runtime = $App
    } elseif (Test-Path -LiteralPath $recorded) {
        $Runtime = (Get-Content -LiteralPath $recorded -Raw).Trim()
    } else {
        $Runtime = $repo
    }
}

# 应用代码的两个入口。仓库里的布局与打包后的布局不一样，这里把差异收在一处：
# 打包后的 <app>\dist 与 <app>\operators 是给人替换的，仓库里的路径是给开发的。
$dist = Join-Path $App 'dist'
$operators = if (Test-Path (Join-Path $App 'operators')) {
    Join-Path $App 'operators'
} else {
    Join-Path $App 'src\engine\python'
}
$python = Join-Path $Runtime '.venv\Scripts\python.exe'
$distArgument = '"{0}"' -f $dist

if ($Build) {
    $package = Join-Path $App 'package.json'
    if (-not (Test-Path -LiteralPath $package)) {
        throw "-Build 只能用于源码目录；找不到前端工程：$package。打包应用请先更新 dist。"
    }

    $buildLog = Join-Path $script:LaunchLogDirectory "build-$script:LaunchId.log"
    $buildStdout = Join-Path $script:LaunchLogDirectory "build-$script:LaunchId.stdout.log"
    $buildStderr = Join-Path $script:LaunchLogDirectory "build-$script:LaunchId.stderr.log"
    $npmCommand = Get-Command 'npm.cmd' -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $npmCommand) {
        throw '找不到 npm.cmd。请确认 Node.js/npm 已安装，并且 npm.cmd 所在目录在 PATH 中。'
    }
    Write-LauncherLog -Message "开始构建前端：$App；输出记录到 $buildLog"
    Push-Location $App
    try {
        # 快捷方式使用 Windows PowerShell 5.1；直接执行 npm.ps1 会把 Node 的 stderr
        # 当作 PowerShell 错误并受 ErrorActionPreference=Stop 影响。用 cmd.exe 调 npm.cmd，
        # 独立重定向输出，再按真实进程退出码判断构建结果。
        $buildCommand = 'call "{0}" run build' -f $npmCommand.Source
        $buildProcess = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') `
            -ArgumentList @('/d', '/c', $buildCommand) `
            -WorkingDirectory $App `
            -RedirectStandardOutput $buildStdout `
            -RedirectStandardError $buildStderr `
            -WindowStyle Hidden -PassThru -Wait
        $buildExitCode = $buildProcess.ExitCode
        $buildOutput = @()
        if (Test-Path -LiteralPath $buildStdout) {
            $buildOutput += '[stdout]'
            $buildOutput += @(Get-Content -LiteralPath $buildStdout -Encoding UTF8)
        }
        if (Test-Path -LiteralPath $buildStderr) {
            $buildOutput += '[stderr]'
            $buildOutput += @(Get-Content -LiteralPath $buildStderr -Encoding UTF8)
        }
        $buildOutput | Set-Content -LiteralPath $buildLog -Encoding UTF8
        Get-Content -LiteralPath $buildLog -Encoding UTF8 | ForEach-Object { Write-Host $_ }
        if ($buildExitCode -ne 0) {
            throw "前端构建失败（退出码 $buildExitCode）。详见 $buildLog；没有启动旧版本。"
        }
    } finally {
        Pop-Location
    }
    Write-LauncherLog -Message '前端构建完成'
}

if (-not (Test-Path -LiteralPath $python)) {
    throw "找不到运行时：$python。先按 sciviz-local\README.md 建 venv 并装 CUDA 版 torch。"
}
if (-not (Test-Path -LiteralPath $operators)) {
    throw "找不到算子目录：$operators"
}
if (-not (Test-Path (Join-Path $dist 'index.html'))) {
    throw "前端还没打包：$dist。先在 sciviz-web 里跑 npm run build（或 npm run dev 用另一个终端）。"
}

# 宿主只认「共享算子目录在哪」这一个环境变量（见 sciviz_host/bridge.py）
$env:SCIVIZ_PY_DIR = $operators

# 打包后的应用目录里自带一份 sciviz_host\（宿主代码也在"每天动"的那一层）。
# 让它赢过开发机上那份 editable 安装（.venv 里那个 .pth 指向仓库）：
# PYTHONPATH 在 sys.path 里排在 site-packages 之前，而 editable 的 finder 是 **append**
# 到 sys.meta_path 的，所以普通路径查找先命中。仓库布局下没有这个目录，什么也不改。
if (Test-Path (Join-Path $App 'sciviz_host')) {
    $env:PYTHONPATH = $App
}

Write-Host "运行时   $python"
Write-Host "前端     $dist"
Write-Host "算子     $operators"
Write-Host "制品     $artifactRoot"

$started = Get-Date
$host_ = $null
$ownsHost = $false
$edge_ = $null
$shellProfileRoot = Join-Path $stateRoot 'SciViz\shell'
$shellProfile = $null
$hostStdout = Join-Path $script:LaunchLogDirectory "host-$script:LaunchId.log"
$hostStderr = Join-Path $script:LaunchLogDirectory "host-$script:LaunchId.err.log"
$health = Get-UsableHostHealth -CandidatePort $Port
$ready = $null -ne $health

if ($ready) {
    Write-LauncherLog -Message "复用已就绪的 SciViz 宿主：127.0.0.1:$Port；算子与 Chat 网关版本满足当前启动要求"
} else {
    $requestedPort = $Port
    if (-not (Test-LocalPortAvailable -CandidatePort $Port)) {
        $foundPort = $false
        $lastPort = [Math]::Min(65535, $Port + 32)
        for ($candidatePort = $Port + 1; $candidatePort -le $lastPort; $candidatePort++) {
            $candidateHealth = Get-UsableHostHealth -CandidatePort $candidatePort
            if ($null -ne $candidateHealth) {
                $Port = $candidatePort
                $health = $candidateHealth
                $ready = $true
                $foundPort = $true
                break
            }
            if (Test-LocalPortAvailable -CandidatePort $candidatePort) {
                $Port = $candidatePort
                $foundPort = $true
                break
            }
        }
        if (-not $foundPort) {
            throw "端口 $requestedPort 到 $lastPort 均不可用，也没有可复用的当前版本宿主。关闭占用端口的程序后重试。"
        }
        if ($Port -ne $requestedPort) {
            Write-LauncherLog -Level 'WARN' -Message "端口 $requestedPort 被其他进程或旧版宿主占用，改用 127.0.0.1:$Port"
        }
    }

    if (-not $ready) {
        Write-LauncherLog -Message "启动本次宿主：$python；端口 $Port；标准输出和错误分别写入 $hostStdout 与 $hostStderr"
        $host_ = Start-Process -FilePath $python `
            -ArgumentList @('-m', 'sciviz_host', '--port', "$Port", '--dist', $distArgument) `
            -RedirectStandardOutput $hostStdout `
            -RedirectStandardError $hostStderr `
            -WindowStyle Hidden -PassThru
        $ownsHost = $true
    }
}

try {
    # 等它就绪。torch 的 import 要一两秒，第一次跑还要读 CUDA 的 DLL —— 这条链路到底多久，
    # 正是这个壳要量出来的东西之一
    if (-not $ready) {
        $deadline = (Get-Date).AddSeconds(120)
        while ((Get-Date) -lt $deadline) {
            $health = Get-UsableHostHealth -CandidatePort $Port
            if ($null -ne $health) {
                $ready = $true
                break
            }
            if ($host_ -and $host_.HasExited) {
                # 并行双击时，另一份启动器可能刚好先绑定端口；健康复查后安全复用。
                $health = Get-UsableHostHealth -CandidatePort $Port
                if ($null -ne $health) {
                    $ready = $true
                    $ownsHost = $false
                    $host_ = $null
                    Write-LauncherLog -Message "检测到另一启动器已先启动当前版本宿主，复用 127.0.0.1:$Port"
                    break
                }
                $hostDetail = if (Test-Path -LiteralPath $hostStderr) { (Get-Content -LiteralPath $hostStderr -Encoding UTF8 -Tail 25) -join "`n" } else { '宿主错误日志为空。' }
                throw "宿主进程提前退出（退出码 $($host_.ExitCode)）。错误日志：$hostStderr`n$hostDetail"
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) { throw "等待宿主就绪超过 120 秒。端口 $Port；宿主日志：$hostStdout；错误日志：$hostStderr" }
    }

    $elapsed = ((Get-Date) - $started).TotalMilliseconds
    Write-Host ("就绪     {0:N0} ms · {1}" -f $elapsed, $health.engine)
    Write-LauncherLog -Message ("宿主就绪；端口 $Port；耗时 {0:N0} ms；{1}" -f $elapsed, $health.engine)

    if ($NoWindow) {
        Write-Host '自检通过（-NoWindow：不开窗口）'
        return
    }

    # 窗口。用 Edge 的 --app 模式：没有地址栏与标签页，看起来就是一个应用窗口，
    # 而它用的正是 WebView2 那个引擎 —— 所以"WebView2 依赖"这件事在这里就是真的。
    $edge = @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
    ) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $edge) { throw '找不到 Microsoft Edge。WebView2 依赖见 sciviz-desk\README.md。' }

    Write-Host '窗口     关闭它即退出'
    # 配置目录**固定一处**，不再每次启动换一个新的。
    #
    # 换新的代价远不止"多点一次打开工程"：浏览器对某个文件的**写权限**、localStorage
    # （写入档位、草稿工程身份）与 IndexedDB 里的报告草稿全都挂在配置目录上。工程一旦
    # 用新目录重新打开，写权限就要再申请一次，而授权框只在用户手势里弹得出来 ——
    # 自动保存与 Agent 写报告都没有手势，于是"报告写回失败，请检查文件权限或磁盘"，
    # 而磁盘、权限、占用其实都没问题（2026-09-27 实测；见 docs/开发日志.md）。
    #
    # 固定目录带来的"重复双击被转交给旧进程"由下面 Test-SciVizProfileInUse 判掉。
    New-Item -ItemType Directory -Force -Path $shellProfileRoot | Out-Null
    $shellProfile = Join-Path $shellProfileRoot 'profile'
    New-Item -ItemType Directory -Force -Path $shellProfile | Out-Null
    $userDataArgument = '--user-data-dir="{0}"' -f $shellProfile
    $edgeArguments = @(
        "--app=http://127.0.0.1:$Port/?engine=local&host=http%3A%2F%2F127.0.0.1%3A$Port",
        '--window-size=1440,960',
        $userDataArgument,
        # 第一次用这份配置目录时，Edge 会弹首次运行向导盖在界面前面
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-mode'
    )

    if (Test-SciVizProfileInUse -Path $shellProfile) {
        # 已经有一个 SciViz 窗口在用这份配置目录：再点一次图标应当**只多开一个窗口**，
        # 宿主与配置目录都不动。这里必须直接放行 —— 若继续走下面的"等窗口出现"，
        # Start-Process 会立刻返回（窗口由旧进程开），finally 随即把宿主收掉，界面就成了白窗。
        Write-LauncherLog -Message "已有窗口在使用配置目录 $shellProfile：只再开一个窗口，宿主与配置目录保持原样"
        Start-Process -FilePath $edge -ArgumentList $edgeArguments | Out-Null
        $ownsHost = $false
        $edge_ = $null
        return
    }

    Write-LauncherLog -Message "启动 Edge 窗口；端口 $Port；配置目录 $shellProfile"
    $edge_ = Start-Process -FilePath $edge `
        -ArgumentList $edgeArguments `
        -PassThru

    $windowReady = $false
    $windowDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $windowDeadline) {
        $edge_.Refresh()
        if ($edge_.HasExited) {
            throw "Edge 窗口进程提前退出（退出码 $($edge_.ExitCode)）。宿主仍可在 $script:LaunchLogPath 查询启动记录。"
        }
        if ($edge_.MainWindowHandle -ne [IntPtr]::Zero) {
            $windowReady = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $windowReady) { throw "Edge 已启动但 30 秒内没有出现应用窗口。Edge 进程号：$($edge_.Id)；配置目录：$shellProfile" }
    Write-LauncherLog -Message "应用窗口已创建；Edge 进程号 $($edge_.Id)"
    $edge_.WaitForExit()
    Write-LauncherLog -Message '应用窗口已关闭'
}
finally {
    if ($edge_ -and -not $edge_.HasExited) {
        # 这次没等到窗口（启动失败或等待超时）才收掉自己的进程树。
        # 配置目录是**共用的那一份**，所以一个字都不删 —— 里面是窗口的写入档位与报告草稿。
        & taskkill.exe /PID $edge_.Id /T /F | Out-Null
        $edge_.WaitForExit(5000) | Out-Null
    }

    # 配置目录不再清理。从前每次启动换一个 `run-<时间戳>` 新目录、退出时删掉它，
    # 代价就是每次启动都丢写权限与草稿（2026-09-27 那次"报告写回失败"的根因）。
    # 历史遗留的 `run-*` 目录一律保留：里面可能还躺着一份没写回工程的报告草稿，
    # 要不要删由人决定，启动器不许替人做这个决定。

    if (-not $KeepHost -and $ownsHost -and $host_ -and -not $host_.HasExited) {
        # 窗口没了就把宿主收掉：留着它，下一次启动会撞端口，而那条报错看不出是谁占的
        # .venv\Scripts\python.exe 在 Windows 上会再启动真正的 Python 子进程。
        # 只停启动器会把监听 8765 的子进程留在后台，下一次桌面启动就撞端口。
        & taskkill.exe /PID $host_.Id /T /F | Out-Null
        Write-LauncherLog -Message '本次启动的宿主已停止'
    } elseif ($host_ -and -not $ownsHost) {
        Write-LauncherLog -Message '复用的宿主不由本次启动器持有，保留运行以免中断其他窗口或命令行任务'
    }
}
