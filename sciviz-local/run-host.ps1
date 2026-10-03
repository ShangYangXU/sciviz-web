# 用项目自带的 venv 启动本地执行宿主。
#
# 之所以要一个脚本而不是让人记住一行命令："用哪个 python" 这件事必须只有一个答案。
# 全局 Python 3.12 里装的是 CPU-only 的 torch，用它启动会**静默地**跑在 CPU 上 ——
# 结果是对的，只是你以为用了 GPU。

$ErrorActionPreference = 'Stop'

$root = Split-Path $PSScriptRoot -Parent
$python = Join-Path $root '.venv\Scripts\python.exe'
$env:SCIVIZ_ARTIFACT_DIR = Join-Path $root '.artifacts'
$env:SCIVIZ_WORKSPACE_ROOT = $root

if (-not (Test-Path $python)) {
    Write-Error "找不到 $python。先按 sciviz-local/README.md 建 venv 并装 CUDA 版 torch。"
}

& $python -m sciviz_host @args
