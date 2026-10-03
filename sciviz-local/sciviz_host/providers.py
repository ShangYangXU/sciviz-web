"""本机 provider 凭据：读、写、合并，以及那个只认标准输入的写入入口（HOST-7）。

为什么要落盘而不是只认环境变量：一个人装一次就该能用。要求用户"每次开宿主前先在 PowerShell 里
`$env:DEEPSEEK_API_KEY=...`"，实际上等于把配置工作推给了一个不会记住它的地方 —— 换台机器、
重开一个终端就没了，而界面上只会显示"未配置"。

三条边界：

1. 密钥只存在状态目录（默认 `<仓库>/.sciviz-state/`，已 gitignore），文件权限收紧到当前用户；
2. CLI 密钥只从标准输入读；界面仅通过受保护的 BYOK 设置提交，不接受命令行明文参数；
3. 环境变量优先于文件：临时换 key 的人不必先去改文件。
"""

from __future__ import annotations

import getpass
import functools
import ipaddress
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Final
from urllib.parse import urlsplit, urlunsplit

from .state_dir import state_root

CONFIG_NAME = "agent-providers.json"
CONFIG_VERSION = 1
_WRITE_LOCK = threading.RLock()


def _serialized_write(function):
    """Keep each read/merge/replace transaction intact within this host process."""
    @functools.wraps(function)
    def wrapped(*args, **kwargs):
        with _WRITE_LOCK:
            return function(*args, **kwargs)
    return wrapped

OPENCODE_GO_PROVIDER: Final = "opencode"
OPENCODE_GO_BASE_URL: Final = "https://opencode.ai/zen/go/v1"
OPENCODE_GO_MODEL: Final = "deepseek-v4.1-flash"

#: 与 [对话栏设计](docs/对话栏设计.md) §9.1 的表同源；界面标签也在这里定。
PROVIDER_PRESETS: dict[str, dict[str, Any]] = {
    "deepseek": {
        "label": "DeepSeek 官方",
        "baseUrl": "https://api.deepseek.com",
        "envKeys": ("DEEPSEEK_API_KEY",),
        "defaultModel": "deepseek-flash",
    },
    OPENCODE_GO_PROVIDER: {
        "label": "OpenCode Go",
        "baseUrl": OPENCODE_GO_BASE_URL,
        "envKeys": ("OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"),
        "defaultModel": OPENCODE_GO_MODEL,
    },
    "openai": {
        "label": "OpenAI", "baseUrl": "https://api.openai.com/v1",
        "envKeys": ("OPENAI_API_KEY",), "defaultModel": None,
    },
    "gemini": {
        "label": "Google Gemini", "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai",
        "envKeys": ("GEMINI_API_KEY", "GOOGLE_API_KEY"), "defaultModel": None,
    },
    "qwen": {
        "label": "通义千问", "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "envKeys": ("DASHSCOPE_API_KEY",), "defaultModel": None,
    },
    "moonshot": {
        "label": "Moonshot", "baseUrl": "https://api.moonshot.cn/v1",
        "envKeys": ("MOONSHOT_API_KEY",), "defaultModel": None,
    },
    "openrouter": {
        "label": "OpenRouter", "baseUrl": "https://openrouter.ai/api/v1",
        "envKeys": ("OPENROUTER_API_KEY",), "defaultModel": None,
    },
    "custom": {
        "label": "自定义兼容服务", "baseUrl": None,
        "envKeys": ("SCIVIZ_CUSTOM_API_KEY",), "defaultModel": None,
    },
}


def default_model(provider_id: str) -> str | None:
    """界面上"还没选模型"时的第一选择。

    不能拿 `/models` 的第一项当默认：那份列表的顺序是 provider 自己的字典序，
    实测第一项可能是个账户没有权限的名字，症状是"一上来就 401"。
    """
    return (PROVIDER_PRESETS.get(provider_id) or {}).get("defaultModel")


class ProviderStoreError(RuntimeError):
    code = "E_CHAT_CONFIG_MISSING"


def config_path() -> Path:
    return state_root() / CONFIG_NAME


def mask(secret: str | None) -> str:
    """列表里只给尾部四位；密钥本体没有任何理由出现在屏幕上。"""
    if not secret:
        return ""
    return f"…{secret[-4:]}" if len(secret) > 4 else "…"


def _is_loopback(url: str | None) -> bool:
    if not url:
        return False
    try:
        host = urlsplit(url).hostname
        if host == "localhost":
            return True
        return bool(host and ipaddress.ip_address(host).is_loopback)
    except ValueError:
        return False


def validate_base_url(value: str) -> str:
    """Validate a user setting without echoing credentials or URL input."""
    value = value.strip().rstrip("/")
    try:
        parsed = urlsplit(value)
        valid = bool(parsed.hostname) and parsed.port != 0
    except ValueError:
        valid = False
    if not valid or len(value) > 2048 or any(char.isspace() for char in value):
        raise ProviderStoreError("API 地址无效，请填写完整的服务基础地址")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ProviderStoreError("API 地址不能包含凭据、查询参数或片段；密钥请填入 API key")
    if parsed.scheme != "https" and not (parsed.scheme == "http" and _is_loopback(value)):
        raise ProviderStoreError("远程 API 必须使用 HTTPS；HTTP 仅限本机回环地址")
    return value


def load() -> tuple[dict[str, dict[str, Any]], str | None]:
    """返回 (配置内容, 读取失败原因)。解析失败按"没有这份配置"处理，但把原因交回去。"""
    path = config_path()
    if not path.exists():
        return {}, None
    try:
        decoded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        return {}, f"{CONFIG_NAME} 无法读取（{exc}），本次按未配置处理"
    providers = decoded.get("providers") if isinstance(decoded, dict) else None
    if not isinstance(providers, dict):
        return {}, f"{CONFIG_NAME} 缺少 providers 段，本次按未配置处理"
    cleaned: dict[str, dict[str, Any]] = {}
    for provider_id, entry in providers.items():
        if not isinstance(entry, dict):
            continue
        cleaned[str(provider_id)] = {
            "apiKey": str(entry["apiKey"]) if entry.get("apiKey") else None,
            "baseUrl": str(entry["baseUrl"]) if entry.get("baseUrl") else None,
            "model": str(entry["model"]) if entry.get("model") else None,
        }
    return cleaned, None


def load_selection() -> dict[str, Any]:
    """界面里最后选中的是哪个 provider（配置文件里的 `selection.provider`）。

    存在理由：模型与 provider 是**用户做过的一次决定**，不该每次重开都回到默认。
    它不属于浏览器（换浏览器/清缓存就丢），也不该只活在内存里 —— 所以跟 provider 配置放同一处。
    这里只回 provider，模型本身已经在每个 provider 的 `model` 字段上了。
    """
    path = config_path()
    if not path.exists():
        return {}
    try:
        decoded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    selection = decoded.get("selection") if isinstance(decoded, dict) else None
    if not isinstance(selection, dict):
        return {}
    provider_id = selection.get("provider")
    return {"provider": str(provider_id)} if isinstance(provider_id, str) and provider_id.strip() else {}


def _current_account() -> str | None:
    """当前进程**真正**跑在哪个账户下（优先给 SID）。

    不能用 `USERNAME`：在这个项目里实测过，进程可能被另一个账户
    （`...\\codexsandboxoffline`）跑着，而环境变量还写着 `Administrator` ——
    按后者收紧权限的结果，是把自己锁在门外、还顺便把文件给了另一个账户。
    """
    try:
        completed = subprocess.run(["whoami", "/user"], check=False, capture_output=True, text=True, timeout=10)
        for line in completed.stdout.splitlines():
            fields = line.split()
            if fields and fields[-1].upper().startswith("S-1-"):
                return fields[-1]
    except (OSError, subprocess.SubprocessError):
        pass
    try:
        completed = subprocess.run(["whoami"], check=False, capture_output=True, text=True, timeout=10)
        return completed.stdout.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def _icacls(path: Path, *args: str) -> None:
    try:
        subprocess.run(["icacls", str(path), *args], check=False, capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        pass


def _inside_workspace(path: Path) -> bool:
    """这份配置是不是躺在仓库/工作区里（开发模式），而不是用户自己的目录里。"""
    root = os.environ.get("SCIVIZ_WORKSPACE_ROOT", "").strip()
    if not root:
        return False
    try:
        return Path(root).resolve() in path.resolve().parents
    except OSError:
        return False


def _restrict_permissions(path: Path) -> None:
    """把文件权限收到当前用户。失败不阻断写入，但绝不能把文件锁成自己也读不了。"""
    if os.name == "nt":
        account = _current_account()
        if not account:
            return
        principal = f"*{account}" if account.upper().startswith("S-1-") else account
        # 开发模式下状态目录在仓库里，而一个仓库常被多个账户碰（用户的 shell 一个、
        # 自动化工具一个）。这时候**不能**去掉继承：去掉之后，写这份文件的那个账户成了唯一
        # 能删它的人，别的账户连"删掉重来"都做不到 —— 实测留下过一个谁都删不掉的文件。
        # 严谨的收紧留给安装版（`%LOCALAPPDATA%\SciViz\`，本来就是按用户隔离的）。
        loose = _inside_workspace(path)
        if loose:
            _icacls(path, "/grant", f"{principal}:(M)", "*S-1-5-32-544:(F)", "*S-1-5-18:(F)")
            if not os.access(path, os.R_OK | os.W_OK):
                _icacls(path, "/reset")
            return
        # 先给当前账户显式授权，再去掉继承 —— 顺序反过来的话，中间那一刻自己是没有权限的。
        # 本机管理员与 SYSTEM 一并保留：这台机器上跑宿主的可能是另一个登录会话，
        # 收紧的意图是"别的用户读不到"，不是"换自己一个账户就打不开"。
        # 当前账户给 (M) 而不是 (R,W)：覆盖文件时缺 DELETE，配置就再也改不动了（实测踩过）。
        _icacls(path, "/grant:r", f"{principal}:(M)", "*S-1-5-32-544:(F)", "*S-1-5-18:(F)")
        _icacls(path, "/inheritance:r")
        if not os.access(path, os.R_OK | os.W_OK):
            _icacls(path, "/reset")
        return
    try:
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    except OSError:
        pass


def save(providers: dict[str, dict[str, Any]], selection: dict[str, Any] | None = None) -> Path:
    # 不传就沿用磁盘上那一份：只改 provider（比如 set / remove）不该把"界面里选中的是谁"顺手抹掉
    if selection is None:
        selection = load_selection()
    path = config_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": CONFIG_VERSION,
        "providers": {
            provider_id: {
                "apiKey": entry.get("apiKey"),
                "baseUrl": entry.get("baseUrl"),
                "model": entry.get("model"),
            }
            for provider_id, entry in providers.items()
        },
        "selection": selection,
    }
    # Unique, owner-readable staging file: concurrent requests cannot share a plaintext temp file.
    descriptor, name = tempfile.mkstemp(prefix=".providers-", suffix=".tmp", dir=path.parent)
    tmp = Path(name)
    try:
        _restrict_permissions(tmp)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")
        try:
            tmp.replace(path)
        except PermissionError:
            _restrict_permissions(path)
            tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)
    _restrict_permissions(path)
    return path


@_serialized_write
def set_provider(
    provider_id: str,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> Path:
    if provider_id not in PROVIDER_PRESETS:
        raise ProviderStoreError(f"未知 provider「{provider_id}」；可选：{'、'.join(PROVIDER_PRESETS)}")
    providers, _ = load()
    entry = dict(providers.get(provider_id) or {"apiKey": None, "baseUrl": None, "model": None})
    if api_key:
        if len(api_key) > 8192 or any(ord(char) < 32 or ord(char) == 127 for char in api_key):
            raise ProviderStoreError("API key 过长或包含控制字符")
        entry["apiKey"] = api_key.strip()
    if base_url:
        entry["baseUrl"] = validate_base_url(base_url)
    if model:
        if len(model) > 120 or any(ord(char) < 32 or ord(char) == 127 for char in model):
            raise ProviderStoreError("模型 ID 过长或包含控制字符")
        entry["model"] = model.strip()
    providers[provider_id] = entry
    return save(providers)


@_serialized_write
def remove_provider(provider_id: str) -> Path:
    providers, _ = load()
    providers.pop(provider_id, None)
    return save(providers)


@_serialized_write
def select_provider(provider_id: str, model: str | None = None) -> Path:
    """记住"界面里现在选的是哪个 provider、哪个模型"。

    为什么写在宿主的配置文件里、而不是浏览器 localStorage：模型是**这个 provider 用哪个模型**
    这一件事实，而那份事实本来就住在这里（每个 provider 的 `model` 字段，`/agent/config` 的
    `providers[].model` 就是它）。写两处就会出现"界面记得、命令行不记得"这种不一致 ——
    而命令行（`sciviz chat` / MCP）用的正是宿主这份默认。换浏览器、清缓存都不该让它丢。

    `model` 省略时只改 provider 选择，不动这个 provider 已有的模型。
    """
    if provider_id not in PROVIDER_PRESETS:
        raise ProviderStoreError(f"未知 provider「{provider_id}」；可选：{'、'.join(PROVIDER_PRESETS)}")
    wanted = OPENCODE_GO_MODEL if provider_id == OPENCODE_GO_PROVIDER else (model or "").strip()
    if model is not None and not wanted:
        raise ProviderStoreError("模型 id 不能是空的")
    if len(wanted) > 120:
        raise ProviderStoreError("模型 id 太长（上限 120 字符）")
    providers, _ = load()
    entry = dict(providers.get(provider_id) or {"apiKey": None, "baseUrl": None, "model": None})
    if wanted:
        entry["model"] = wanted
    providers[provider_id] = entry
    return save(providers, {"provider": provider_id})


def resolve(provider_id: str, *, use_global_env: bool) -> dict[str, Any]:
    """环境变量 > 本地配置文件 > preset 默认。

    `use_global_env` 只在调用方没点名 provider（即用默认 provider）时为真：`SCIVIZ_AGENT_BASE_URL`
    这类全局覆盖描述的是"默认那一份"，把它套到用户显式点名的另一个 provider 上会让
    "我选了 A，请求却打到 B 的网关"这种问题无法解释。
    """
    preset = PROVIDER_PRESETS.get(provider_id, {})
    file_entries, _ = load()
    file_entry = file_entries.get(provider_id) or {}
    env_keys = tuple(preset.get("envKeys", ()))

    api_key = None
    source = "preset"
    for env_key in env_keys:
        candidate = os.environ.get(env_key, "").strip()
        if candidate:
            api_key, source = candidate, "env"
            break
    if not api_key and file_entry.get("apiKey"):
        api_key, source = str(file_entry["apiKey"]), "file"
    if use_global_env:
        override_key = os.environ.get("SCIVIZ_AGENT_API_KEY", "").strip()
        if override_key:
            api_key, source = override_key, "env"

    if provider_id == OPENCODE_GO_PROVIDER:
        # 官方 Go endpoint 与当前唯一使用模型由专用 adapter 固定；旧配置中的 Zen URL / 模型不再介入。
        base_url = OPENCODE_GO_BASE_URL
        model = OPENCODE_GO_MODEL
    else:
        base_url = str(file_entry.get("baseUrl") or "") or preset.get("baseUrl")
        if use_global_env:
            base_url = os.environ.get("SCIVIZ_AGENT_BASE_URL", "").strip() or base_url

        model = str(file_entry.get("model") or "") or None
        if use_global_env:
            model = os.environ.get("SCIVIZ_AGENT_MODEL", "").strip() or model

    return {
        "provider": provider_id,
        "label": preset.get("label", provider_id),
        "baseUrl": base_url,
        "apiKey": api_key,
        "model": model,
        "source": source if api_key else ("preset" if base_url else "none"),
        "local": _is_loopback(base_url),
        "preset": provider_id in PROVIDER_PRESETS,
    }


def describe_all() -> list[dict[str, Any]]:
    """给 `/agent/config` 列表用：每个 preset 都在，没配的也回 available=false。"""
    described: list[dict[str, Any]] = []
    file_entries, _ = load()
    for provider_id in PROVIDER_PRESETS:
        resolved = resolve(provider_id, use_global_env=False)
        described.append(
            {
                "id": provider_id,
                "label": resolved["label"],
                "available": bool(resolved["baseUrl"] and (resolved["apiKey"] or resolved["local"])),
                "source": resolved["source"],
                "apiKeyConfigured": bool(resolved["apiKey"]),
                "apiKeyTail": mask(resolved["apiKey"]),
                "local": resolved["local"],
                "model": resolved["model"],
                "defaultModel": default_model(provider_id),
                "baseUrl": _public_url(resolved["baseUrl"], resolved["apiKey"]),
                "hasLocalConfig": provider_id in file_entries,
                "endpointEditable": provider_id != OPENCODE_GO_PROVIDER,
            }
        )
    return described


def _public_url(value: str | None, api_key: str | None) -> str:
    try:
        parsed = urlsplit(value or "")
        host = parsed.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        authority = f"{host}:{parsed.port}" if parsed.port else host
        sanitized = urlunsplit((parsed.scheme, authority, parsed.path, "", ""))
        return sanitized.replace(api_key, "…") if api_key else sanitized
    except ValueError:
        return ""


def _usage() -> str:
    return (
        "用法：\n"
        "  python -m sciviz_host.providers list\n"
        "  python -m sciviz_host.providers select <provider> [--model ID]\n"
        "  python -m sciviz_host.providers set <provider> [--base-url URL] [--model ID]\n"
        "  python -m sciviz_host.providers remove <provider>\n"
        f"provider：{'、'.join(PROVIDER_PRESETS)}\n"
        "set 的密钥从标准输入读（不接命令行参数），回车结束。\n"
        "select 记的是\"界面/命令行现在用哪个 provider 与模型\"——它决定下次不开界面时的默认。"
    )


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    action = args.pop(0) if args else "list"
    if action not in {"list", "select", "set", "remove"}:
        print(_usage(), file=sys.stderr)
        return 2
    if action == "list":
        entries, problem = load()
        if problem:
            print(f"⚠ {problem}")
        print(f"配置文件  {config_path()}")
        # 选中的那个单独标出来：它就是"不开界面时默认用谁"
        selected = load_selection().get("provider")
        for info in describe_all():
            from_env = [key for key in PROVIDER_PRESETS[info["id"]]["envKeys"] if os.environ.get(key, "").strip()]
            where = "环境变量 " + "、".join(from_env) if from_env else ("本地文件 " + mask(entries.get(info["id"], {}).get("apiKey")) if entries.get(info["id"], {}).get("apiKey") else "未配置")
            model_note = f"  模型 {info['model']}" if info["model"] else ""
            print(f"  {info['id']:<9}{info['label']:<14}{where}{model_note}{'  ← 选中' if info['id'] == selected else ''}")
        return 0
    if not args:
        print(_usage(), file=sys.stderr)
        return 2
    provider_id = args.pop(0).strip().lower()
    # 先认 provider 再读密钥：名字错了就不该停在"等待输入"上
    if provider_id not in PROVIDER_PRESETS:
        print(f"未知 provider「{provider_id}」；可选：{'、'.join(PROVIDER_PRESETS)}", file=sys.stderr)
        return 2
    base_url = None
    model = None
    while args:
        flag = args.pop(0)
        value = args.pop(0) if args else ""
        if flag == "--base-url":
            base_url = value
        elif flag == "--model":
            model = value
        else:
            print(f"不认识的参数：{flag}\n{_usage()}", file=sys.stderr)
            return 2
    if action == "remove":
        path = remove_provider(provider_id)
        print(f"已删除 {provider_id} 的本地配置：{path}")
        return 0
    if action == "select":
        # 只改"用谁"，不碰密钥：所以不需要从标准输入读 key
        path = select_provider(provider_id, model=model)
        resolved = resolve(provider_id, use_global_env=False)
        print(f"已选中 {provider_id}（模型 {resolved['model'] or '未指定'}）：{path}")
        return 0
    api_key = getpass.getpass(f"{provider_id} 的 API key（输入不回显）：").strip() if sys.stdin.isatty() else sys.stdin.readline().strip()
    if not api_key:
        print("没有读到密钥，未改动配置。", file=sys.stderr)
        return 1
    path = set_provider(provider_id, api_key=api_key, base_url=base_url, model=model)
    print(f"已写入 {provider_id}（尾部 {mask(api_key)}）：{path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
