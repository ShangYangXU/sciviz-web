"""对话栏 C0 网关。

网关只负责配置、provider 转发和会话存储。工具执行仍由前端的注入式执行器负责；
这条边界避免宿主再长出一套图执行器。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import secrets
import time
import urllib.error
import urllib.request
from collections.abc import AsyncIterator
from dataclasses import dataclass
from typing import Any

from . import chat_store, code_gate, opencode_go, providers, session


class AgentGatewayError(RuntimeError):
    def __init__(self, code: str, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


#: Go 官方要求调用方提供自有 User-Agent；使用宿主真实身份，不伪装成浏览器。
USER_AGENT = "SciViz-Host/0.1 (local)"


@dataclass(frozen=True)
class ProviderConfig:
    provider: str | None
    label: str
    model: str | None
    base_url: str | None
    api_key: str | None
    local: bool
    configured: bool
    #: 这份凭据是从哪儿来的：env / file / preset / none。界面要能说清"为什么它可用了"。
    source: str = "none"


#: preset 表只有一处：`providers`。这里留一个别名，避免第二个真相。
PROVIDER_PRESETS = providers.PROVIDER_PRESETS

#: 桌面启动器据此拒绝复用不支持当前 Chat 请求协议的旧宿主。
AGENT_GATEWAY_VERSION = 4


def _provider_session_headers(cfg: ProviderConfig, body: dict[str, Any]) -> dict[str, str]:
    if cfg.provider != "opencode":
        return {}
    session_id = body.get("sessionId")
    if not isinstance(session_id, str):
        raise AgentGatewayError("E_PARAM_INVALID", "OpenCode Go 请求缺少会话 ID", 400)
    try:
        # 与 /agent/session 共用同一条 ID 规则；这是会话身份，不是逐轮 requestId。
        chat_store._safe(session_id)
    except chat_store.SessionStoreError as exc:
        raise AgentGatewayError("E_PARAM_INVALID", "OpenCode Go 会话 ID 无效", 400) from exc
    return {"x-opencode-session": session_id}


def _next_stream_item(iterator):
    """把 StopIteration 转成可跨 asyncio.to_thread 传递的哨兵。"""
    try:
        return True, next(iterator)
    except StopIteration:
        return False, None


def _provider_json(payload: dict[str, Any]) -> bytes:
    """按 UTF-8 原文发送 JSON，避免长中文工具结果被 ASCII 转义膨胀。"""
    return json.dumps(payload, ensure_ascii=False).encode("utf-8")


_SECRET_LIKE = re.compile(r"\b(?:oc_)?sk[-_][A-Za-z0-9_\-]{8,}")


def redact_provider_error(message: str, api_key: str | None) -> str:
    if api_key:
        message = message.replace(api_key, "…")
    return _SECRET_LIKE.sub("…", message)

#: 假 provider 的改图触发词与它要提的那条 op。见 `_mock_patch_tool_call`。
MOCK_EDIT_MARKER = "假 provider 改图验收"
MOCK_EDITED_NODE_ID = "mock-edited"


def _mock_patch_tool_call(body: dict[str, Any]) -> dict[str, Any] | None:
    """假 provider 的一条**夹具**分支：说那句触发词，它就提一条真的图补丁。

    为什么值得留在生产代码里：`patch` 这条路上的每一环（基线、审批、写回、
    审计事件）都只有走真浏览器才压得到，而单元测试压不到"界面把模型提的补丁落进画布
    之后，画布真的多了一个块"。触发词是普通文字，改一次对话就能验一次。

    基线**从上下文里取**，不编：编一个指纹只会换回 `E_PATCH_BASE_MISMATCH`，
    那正好是这条夹具要防住的那种"看着在跑其实什么都没落"。
    同一轮里已经有工具结果时不再提 —— 否则工具循环会一直提同一条，直到撞上上限。
    """
    messages = body.get("messages")
    if not isinstance(messages, list):
        return None
    if any(isinstance(message, dict) and (message.get("role") == "tool" or message.get("tool_calls")) for message in messages):
        return None
    asked = any(
        isinstance(message, dict)
        and message.get("role") == "user"
        and MOCK_EDIT_MARKER in str(message.get("content") or "")
        for message in messages
    )
    if not asked:
        return None
    fingerprint = None
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "system":
            continue
        match = re.search(r'"editFingerprint"\s*:\s*"(sha256:[0-9a-f]+)"', str(message.get("content") or ""))
        if match:
            fingerprint = match.group(1)
            break
    if not fingerprint:
        return None
    return {
        "type": "tool_call",
        "callId": "mock-patch-1",
        "name": "patch",
        "arguments": {
            "patch": {
                "reason": "假 provider 的改图验收",
                "baseFingerprint": fingerprint,
                "ops": [{"op": "addNode", "id": MOCK_EDITED_NODE_ID, "type": "data.preview"}],
            }
        },
    }


def provider_error_detail(exc: urllib.error.HTTPError, api_key: str | None = None) -> str:
    """把 provider 的错误正文里那句人话带出来，并做两件事：截断、抹掉像密钥的串。

    只报 "provider HTTP 503" 太吃亏：503 底下可能是 "Model is unavailable"（换个模型就好）
    也可能是上游真的挂了；401 底下可能是 "Invalid API key"。这三种情况用户要做的事完全不同。
    """
    try:
        raw = exc.read(4096).decode("utf-8", errors="replace")
        decoded = json.loads(raw)
    except Exception:  # noqa: BLE001 —— 正文可能根本不是 JSON（HTML 错误页等）
        return ""
    message = ""
    if isinstance(decoded, dict):
        error = decoded.get("error")
        if isinstance(error, dict):
            message = str(error.get("message") or "")
        elif isinstance(error, str):
            message = error
        message = message or str(decoded.get("message") or decoded.get("detail") or "")
    return redact_provider_error(message.strip(), api_key)[:200]


#: provider 说"这个模型 / 这个上游端点现在不存在"时的措辞。
#:
#: 这些词是**实测**来的，不是猜的：OpenCode Zen 对一部分模型直接回
#: 503 `Upstream request failed: Endpoint is unavailable.`（实测 claude-sonnet-4-5、
#: gpt-5.2-codex），另有 400 `Model is unavailable` 与 403 FreeTierError。
#: 它们的共同点是：**用户要做的事只有一件 —— 换一个模型**，而"provider HTTP 503"
#: 这句话把这件事藏起来了（看着像本机或网络坏了，于是去重启宿主、去查代理）。
_UNAVAILABLE_MARKERS = (
    "endpoint is unavailable",
    "model is unavailable",
    "model is not available",
    "no such model",
    "unknown model",
    "freetiererror",
    "free tier",
)


def is_model_unavailable(message: str) -> bool:
    """这句话说的是不是"换个模型就好"。只认实测过的几种措辞，不做语义猜测。"""
    lowered = (message or "").lower()
    return any(marker in lowered for marker in _UNAVAILABLE_MARKERS)


def provider_failure_hint(message: str) -> str:
    """给 provider 的原话补一句**下一步**。不是错误码，只是把话说完。"""
    if is_model_unavailable(message):
        return "这是 provider 侧的答复（模型或上游端点当前不可用），换一个模型再试即可；模型清单见 /agent/models"
    return ""


class AgentGateway:
    def __init__(self) -> None:
        self.token = secrets.token_urlsafe(32)
        self._models_cache: tuple[float, str, list[str]] | None = None
        #: 这个宿主进程里**实测失败过**的模型：provider → model → 那句原话。
        #: 只活在内存里：它描述的是"刚才那一次"，不是模型的属性，重启就该忘掉。
        self._failed_models: dict[str, dict[str, str]] = {}

    def model_health(self, provider_id: str | None = None) -> list[dict[str, str]]:
        """给 `/agent/models` 用：把"上次回不可用"的模型连同原因报出来。"""
        provider = (provider_id or self._provider_name() or "")
        return [{"model": model, "reason": reason} for model, reason in sorted(self._failed_models.get(provider, {}).items())]

    def _provider_name(self) -> str | None:
        explicit = os.environ.get("SCIVIZ_AGENT_PROVIDER", "").strip().lower()
        if explicit == "opencode-go":
            return providers.OPENCODE_GO_PROVIDER
        if explicit and explicit != "auto":
            return explicit
        # auto：**界面里最后选过的那个优先**（那就是用户上一次的决定），其余按固定顺序取第一个配好的。
        # 顺序仍然固定，免得同一台机器两次启动结论不同。
        remembered = providers.load_selection().get("provider")
        order = list(PROVIDER_PRESETS)
        if remembered in PROVIDER_PRESETS:
            order = [remembered, *[item for item in order if item != remembered]]
        for provider_id in order:
            resolved = providers.resolve(provider_id, use_global_env=True)
            if resolved["baseUrl"] and (resolved["apiKey"] or resolved["local"]):
                return provider_id
        return None

    def _provider_config(self, provider_id: str | None = None) -> ProviderConfig:
        """点名 provider 时按点名解析；没点名时用默认 provider（并允许全局覆盖）。

        `SCIVIZ_AGENT_BASE_URL` / `SCIVIZ_AGENT_API_KEY` / `SCIVIZ_AGENT_MODEL` 描述的是"默认那一份"，
        所以只在没点名时生效 —— 否则用户显式选了 OpenCode Go，请求却可能打到默认 provider 的网关上，
        而日志里只留下"选了 A、走了 B"。
        """
        requested = (provider_id or "").strip().lower()
        provider = requested or self._provider_name()
        if provider == "mock":
            return ProviderConfig("mock", "本地假 provider", "mock-model", None, None, True, True, "preset")
        if not provider:
            return ProviderConfig(None, "", None, None, None, False, False, "none")
        resolved = providers.resolve(provider, use_global_env=not requested)
        base_url = resolved["baseUrl"]
        api_key = resolved["apiKey"]
        local = bool(resolved["local"])
        configured = bool(base_url and (api_key or local))
        return ProviderConfig(provider, resolved["label"], resolved["model"], base_url, api_key, local, configured, resolved["source"])

    def config(self) -> dict[str, Any]:
        cfg = self._provider_config()
        return {
            "configured": cfg.configured,
            "provider": cfg.provider,
            "providerLabel": cfg.label,
            "model": cfg.model,
            "local": cfg.local,
            "apiKeyConfigured": bool(cfg.api_key),
            "providerPreset": cfg.provider in PROVIDER_PRESETS,
            "credentialSource": cfg.source,
            # 没有凭据的 provider 也列出来（available=false）：它从列表里消失的话，
            # 用户会以为这个软件不支持它。
            "providers": [
                # 剥掉掩码尾部：HTTP 面只回答"配没配、从哪儿来"，不回答"key 长什么样"。
                {key: value for key, value in info.items() if key != "apiKeyTail"} | {"default": info["id"] == cfg.provider}
                for info in providers.describe_all()
            ],
            "modelDiscovery": bool(cfg.base_url and (cfg.api_key or cfg.local)),
            "capabilities": {"stream": True, "toolCalling": True, "session": True},
            "payloadVersion": 1,
            "providerManagement": True,
            "token": self.token,
        }

    def select_provider(self, provider_id: str, model: str | None = None) -> dict[str, Any]:
        """记住"现在选的是哪个 provider、哪个模型"，下次宿主起来还认它。

        写在宿主的 provider 配置里（见 `providers.select_provider` 的注释），不进浏览器存储 ——
        `sciviz chat` / MCP 那条路用的就是这份默认，两边不该各记一份。
        """
        try:
            providers.select_provider(provider_id, model)
        except providers.ProviderStoreError as exc:
            raise AgentGatewayError("E_PARAM_INVALID", str(exc), 400) from exc
        except OSError as exc:
            raise AgentGatewayError("E_CHAT_CONFIG_MISSING", f"写不进 provider 配置：{exc}", 503) from exc
        return {"ok": True, "provider": provider_id, "model": self._provider_config(provider_id).model}

    def configure_provider(self, body: object) -> dict[str, Any]:
        """User-only BYOK settings; never exposed as a model tool."""
        if not isinstance(body, dict) or set(body) - {"action", "provider", "apiKey", "baseUrl", "model"}:
            raise AgentGatewayError("E_PARAM_INVALID", "模型服务设置字段无效", 400)
        provider = body.get("provider")
        action = body.get("action")
        if not isinstance(provider, str) or provider not in PROVIDER_PRESETS or action not in ("save", "remove"):
            raise AgentGatewayError("E_PARAM_INVALID", "请选择有效的模型服务和设置动作", 400)
        for field in ("apiKey", "baseUrl", "model"):
            if field in body and not isinstance(body[field], str):
                raise AgentGatewayError("E_PARAM_INVALID", "密钥、地址和模型必须是文本", 400)
        if action == "remove" and set(body) - {"action", "provider"}:
            raise AgentGatewayError("E_PARAM_INVALID", "移除配置不能携带密钥、地址或模型", 400)
        try:
            if action == "remove":
                providers.remove_provider(provider)
            else:
                if provider == "opencode" and (body.get("baseUrl") or body.get("model")):
                    raise providers.ProviderStoreError("OpenCode Go 使用固定 API 地址和模型")
                providers.set_provider(provider, api_key=body.get("apiKey"), base_url=body.get("baseUrl"), model=body.get("model"))
        except providers.ProviderStoreError as exc:
            raise AgentGatewayError("E_PARAM_INVALID", str(exc), 400) from exc
        except OSError as exc:
            raise AgentGatewayError("E_CHAT_CONFIG_MISSING", "模型服务配置无法保存，请检查本机状态目录权限", 503) from exc
        self._models_cache = None
        self._failed_models.pop(provider, None)
        return {"ok": True, "config": self.config()}

    async def discover_models(self, provider_id: str | None = None) -> list[str]:
        cfg = self._provider_config(provider_id)
        if cfg.provider == "mock":
            return ["mock-model"]
        if not cfg.base_url or (not cfg.api_key and not cfg.local):
            return []
        if cfg.provider == providers.OPENCODE_GO_PROVIDER:
            return [providers.OPENCODE_GO_MODEL]
        cache_key = f"{cfg.provider}|{cfg.base_url}|{bool(cfg.api_key)}"
        if self._models_cache and self._models_cache[1] == cache_key and self._models_cache[0] > time.time() - 60:
            return list(self._models_cache[2])
        try:
            models = await asyncio.to_thread(self._fetch_models, cfg)
        except Exception as exc:  # noqa: BLE001
            raise AgentGatewayError("E_CHAT_PROVIDER_FAILED", f"读取模型列表失败：{redact_provider_error(str(exc), cfg.api_key)}", 502) from exc
        self._models_cache = (time.time(), cache_key, models)
        return list(models)

    @staticmethod
    def _fetch_models(cfg: ProviderConfig) -> list[str]:
        url = cfg.base_url.rstrip("/") + "/models"
        headers = {"Accept": "application/json", "User-Agent": USER_AGENT}
        if cfg.api_key:
            headers["Authorization"] = f"Bearer {cfg.api_key}"
        request = urllib.request.Request(url, headers=headers, method="GET")
        with urllib.request.urlopen(request, timeout=10) as response:
            decoded = json.loads(response.read().decode("utf-8"))
        rows = decoded.get("data") if isinstance(decoded, dict) else None
        if not isinstance(rows, list):
            return []
        return sorted({str(row.get("id")) for row in rows if isinstance(row, dict) and row.get("id")})

    async def stream_chat(self, body: dict[str, Any]) -> AsyncIterator[dict[str, Any]]:
        requested = str(body.get("provider") or "")
        cfg = self._provider_config(requested)
        if not cfg.configured:
            hint = (
                f"provider「{cfg.provider or requested}」没有可用凭据；"
                "请在对话栏的「模型服务设置」中填写自己的 API key，"
                "或用 `python -m sciviz_host.providers list` 查看已配置项"
            )
            raise AgentGatewayError("E_CHAT_CONFIG_MISSING", hint, 503)
        request_id = str(body.get("requestId") or secrets.token_hex(12))
        if cfg.provider == "mock":
            tool_call = _mock_patch_tool_call(body)
            if tool_call is not None:
                yield {"version": 1, "requestId": request_id, "type": "text_delta", "text": "好，我提一条补丁。"}
                yield {"version": 1, "requestId": request_id, **tool_call}
                yield {"version": 1, "requestId": request_id, "type": "done", "providerMessageId": "mock"}
                return
            yield {"version": 1, "requestId": request_id, "type": "text_delta", "text": "本地假 provider 已连接。"}
            yield {"version": 1, "requestId": request_id, "type": "done", "providerMessageId": "mock"}
            return
        if not cfg.base_url:
            raise AgentGatewayError("E_CHAT_CONFIG_MISSING", "provider 缺少 base URL", 503)
        if cfg.provider == providers.OPENCODE_GO_PROVIDER:
            model = providers.OPENCODE_GO_MODEL
        else:
            model = str(body.get("model") or cfg.model or providers.default_model(cfg.provider or "") or "")
        if not model:
            models = await self.discover_models(cfg.provider)
            model = models[0] if models else ""
        if not model:
            raise AgentGatewayError("E_CHAT_CONFIG_MISSING", "没有发现可用模型；请设置 SCIVIZ_AGENT_MODEL 或检查 provider /models", 503)
        cfg = ProviderConfig(cfg.provider, cfg.label, model, cfg.base_url, cfg.api_key, cfg.local, cfg.configured, cfg.source)
        try:
            if cfg.provider == providers.OPENCODE_GO_PROVIDER:
                session_headers = _provider_session_headers(cfg, body)
                stream = opencode_go.stream_chat(
                    body,
                    api_key=cfg.api_key or "",
                    session_id=session_headers["x-opencode-session"],
                    user_agent=USER_AGENT,
                )
            else:
                stream = self._stream_openai(cfg, body)
            finish_reason: str | None = None
            while True:
                has_item, item = await asyncio.to_thread(_next_stream_item, stream)
                if not has_item:
                    break
                if item["type"] == "text_delta":
                    yield {"version": 1, "requestId": request_id, "type": "text_delta", "text": item["text"]}
                elif item["type"] == "tool_call":
                    yield {"version": 1, "requestId": request_id, **item}
                elif item["type"] == "completion":
                    finish_reason = item.get("finishReason")
        except AgentGatewayError as exc:
            safe_message = redact_provider_error(str(exc), cfg.api_key)
            # 只记"换模型就好"这一类：它是**这个模型的属性**，界面要据此把它标出来并排到最后。
            # 鉴权/网络/限流不记 —— 那不是模型的错，标错了会让人换掉一个本来能用的模型。
            if cfg.model and is_model_unavailable(str(exc)):
                self._failed_models.setdefault(cfg.provider or "", {})[cfg.model] = safe_message
            raise AgentGatewayError(exc.code, safe_message, exc.status) from exc
        except opencode_go.OpenCodeGoError as exc:
            raise AgentGatewayError("E_CHAT_PROVIDER_FAILED", redact_provider_error(str(exc), cfg.api_key), 502) from exc
        except Exception as exc:  # noqa: BLE001
            raise AgentGatewayError("E_CHAT_PROVIDER_FAILED", f"provider 请求失败：{redact_provider_error(str(exc), cfg.api_key)}", 502) from exc
        yield {"version": 1, "requestId": request_id, "type": "done", "finishReason": finish_reason}

    @staticmethod
    def _stream_openai(cfg: ProviderConfig, body: dict[str, Any]):
        """读取 OpenAI-compatible SSE，并把增量规整成内部事件。

        这个函数故意保持同步：urllib 的响应迭代是阻塞 IO，调用方按行放入线程，
        这样 Starlette 仍能把已收到的 token 立刻写给浏览器，同时不把事件循环卡住。
        """
        if cfg.provider == providers.OPENCODE_GO_PROVIDER:
            raise AgentGatewayError("E_PARAM_INVALID", "OpenCode Go 必须使用专用适配器", 400)
        url = cfg.base_url.rstrip("/") + "/chat/completions"
        tools = body.get("tools", [])
        requested_tool_choice = body.get("toolChoice")
        if requested_tool_choice not in (None, "auto", "required"):
            raise AgentGatewayError("E_PARAM_INVALID", "toolChoice 只能是 auto 或 required", 400)
        if requested_tool_choice == "required" and not tools:
            raise AgentGatewayError("E_PARAM_INVALID", "toolChoice=required 时必须提供至少一个工具", 400)
        # 空的 tools 数组不带：它不表达任何能力，却会被一部分上游当成参数非法而整条拒掉。
        payload: dict[str, Any] = {"model": cfg.model, "messages": body.get("messages", []), "stream": True}
        if tools:
            payload["tools"] = tools
        if requested_tool_choice == "required":
            payload["tool_choice"] = "required"
        headers = {"Content-Type": "application/json", "Accept": "text/event-stream", "User-Agent": USER_AGENT}
        if cfg.api_key:
            headers["Authorization"] = f"Bearer {cfg.api_key}"
        request = urllib.request.Request(url, data=_provider_json(payload), headers=headers, method="POST")
        calls: dict[int, dict[str, str]] = {}
        completed = False
        finish_reason: str | None = None
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                for raw_line in response:
                    line = raw_line.decode("utf-8", errors="replace").strip()
                    if not line or line.startswith(":"):
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if line == "[DONE]":
                        completed = True
                        break
                    try:
                        decoded = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(decoded, dict) and isinstance(decoded.get("error"), (dict, str)):
                        detail = decoded["error"]
                        message = detail.get("message") if isinstance(detail, dict) else str(detail)
                        raise AgentGatewayError("E_CHAT_PROVIDER_FAILED", f"provider 返回错误：{message}", 502)
                    choices = decoded.get("choices") or []
                    choice = choices[0] if choices else {}
                    delta = choice.get("delta") or {}
                    if choice.get("finish_reason") is not None:
                        finish_reason = str(choice["finish_reason"])
                        completed = True
                    text = delta.get("content")
                    if text:
                        yield {"type": "text_delta", "text": str(text)}
                    for tool_delta in delta.get("tool_calls") or []:
                        index = int(tool_delta.get("index", 0))
                        function = tool_delta.get("function") or {}
                        call = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                        if tool_delta.get("id"):
                            call["id"] = str(tool_delta["id"])
                        if function.get("name"):
                            call["name"] += str(function["name"])
                        if function.get("arguments"):
                            call["arguments"] += str(function["arguments"])
        except urllib.error.HTTPError as exc:
            detail = provider_error_detail(exc, cfg.api_key)
            message = f"provider HTTP {exc.code}{f'：{detail}' if detail else ''}"
            hint = provider_failure_hint(detail)
            if hint:
                message = f"{message}（{hint}）"
            raise AgentGatewayError("E_CHAT_PROVIDER_FAILED", message, 502) from exc
        if not completed:
            raise AgentGatewayError("E_CHAT_PROVIDER_FAILED", "provider 流在终止标记前结束", 502)
        for index in sorted(calls):
            call = calls[index]
            raw_arguments = call["arguments"] or "{}"
            try:
                arguments = json.loads(raw_arguments)
            except json.JSONDecodeError:
                raise AgentGatewayError("E_CHAT_PROVIDER_FAILED", "provider 工具调用参数不是有效 JSON；本轮工具尚未执行", 502)
            yield {"type": "tool_call", "callId": call["id"] or secrets.token_hex(8), "name": call["name"], "arguments": arguments}
        yield {"type": "completion", "finishReason": finish_reason}

    @staticmethod
    def _complete_openai(cfg: ProviderConfig, body: dict[str, Any]) -> dict[str, Any]:
        if cfg.provider == providers.OPENCODE_GO_PROVIDER:
            raise AgentGatewayError("E_PARAM_INVALID", "OpenCode Go 必须使用专用适配器", 400)
        url = cfg.base_url.rstrip("/") + "/chat/completions"
        payload: dict[str, Any] = {"model": cfg.model, "messages": body.get("messages", []), "stream": False}
        if body.get("tools"):
            payload["tools"] = body["tools"]
        headers = {"Content-Type": "application/json", "User-Agent": USER_AGENT}
        if cfg.api_key:
            headers["Authorization"] = f"Bearer {cfg.api_key}"
        request = urllib.request.Request(url, data=_provider_json(payload), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                decoded = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = provider_error_detail(exc, cfg.api_key)
            message = f"provider HTTP {exc.code}{f'：{detail}' if detail else ''}"
            hint = provider_failure_hint(detail)
            if hint:
                message = f"{message}（{hint}）"
            raise AgentGatewayError("E_CHAT_PROVIDER_FAILED", message, 502) from exc
        choices = decoded.get("choices") or []
        message = (choices[0] if choices else {}).get("message") or {}
        return {"content": message.get("content") or "", "tool_calls": message.get("tool_calls") or []}

    def execute(self, body: dict[str, Any]) -> dict[str, Any]:
        tool = str(body.get("tool", ""))
        args = body.get("args") or {}
        if tool == "doctor":
            root = chat_store.state_root()
            provider = self.config()
            provider.pop("token", None)
            return {"toolPayloadVersion": 1, "ok": True, "status": "done", "tool": tool, "data": {"stateDir": str(root), "stateWritable": self._writable(root), "provider": provider}, "evidence": []}
        if tool == "verify":
            return {"toolPayloadVersion": 1, "ok": False, "status": "rejected", "tool": tool, "error": {"code": "E_EXECUTION_FAILED", "message": "verify 仍由 CLI/宿主真值入口执行"}, "evidence": []}
        if tool == "sciviz_code":
            # HTTP 面不接受模型传来的 root 或 shell 字符串。根目录只由宿主
            # 启动配置决定，动作本身交给同一个 code_gate 结构化闸门。
            workspace = os.environ.get("SCIVIZ_WORKSPACE_ROOT", "").strip() or os.getcwd()
            action = str(args.get("action", ""))
            try:
                if action == "list":
                    return {"toolPayloadVersion": 1, "ok": True, "status": "done", "tool": tool, "data": {"action": action, "files": code_gate.list_files(workspace, str(args.get("glob", "**/*")))}, "evidence": []}
                if action == "search":
                    result = code_gate.search_files(
                        workspace,
                        str(args.get("query", "")),
                        str(args.get("glob", "**/*")),
                        int(args.get("limit", 50)),
                        bool(args.get("caseSensitive", False)),
                    )
                    return {"toolPayloadVersion": 1, "ok": True, "status": "done", "tool": tool, "data": {"action": action, **result}, "evidence": []}
                if action == "read":
                    return {"toolPayloadVersion": 1, "ok": True, "status": "done", "tool": tool, "data": {"action": action, "result": code_gate.read_file(workspace, str(args.get("path", "")), int(args.get("startLine", 1)), int(args["endLine"]) if args.get("endLine") is not None else None)}, "evidence": []}
                if action == "check":
                    raw_checks = args.get("checks")
                    selected = [str(item) for item in raw_checks] if isinstance(raw_checks, list) else None
                    results = code_gate.run_checks(workspace, selected)
                    ok = all(item["ok"] for item in results)
                    return {"toolPayloadVersion": 1, "ok": ok, "status": "done" if ok else "failed", "tool": tool, "data": {"action": action, "checks": results}, "evidence": []}
                if action == "plan":
                    planned = code_gate.plan(workspace, list(args.get("operations") or []))
                    return {"toolPayloadVersion": 1, "ok": True, "status": "done", "tool": tool, "data": planned, "evidence": [{"kind": "code-plan", "ref": str(planned["planId"])}]}
                if action == "apply":
                    result = code_gate.apply(workspace, dict(args.get("plan") or {}), str(args.get("approvalToken", "")))
                    return {"toolPayloadVersion": 1, "ok": bool(result.get("ok")), "status": result.get("status", "failed"), "tool": tool, "data": result, "error": result.get("error"), "evidence": [{"kind": "code-plan", "ref": str(result.get("plan", {}).get("planId", ""))}]}
                if action == "undo":
                    record = code_gate.load_record(workspace, str(args.get("planId", "")))
                    result = code_gate.undo(workspace, record)
                    return {"toolPayloadVersion": 1, "ok": bool(result.get("ok")), "status": result.get("status", "failed"), "tool": tool, "data": result, "error": result.get("error"), "evidence": [{"kind": "code-plan", "ref": str(record.get("planId", ""))}]}
                raise code_gate.CodeGateError("E_PARAM_INVALID", f"未知源码动作「{action}」")
            except code_gate.CodeGateError as exc:
                status = 409 if exc.code in {"E_CODE_BASE_MISMATCH", "E_CODE_GATE_FAILED"} else 400
                raise AgentGatewayError(exc.code, str(exc), status) from exc
        raise AgentGatewayError("E_PARAM_INVALID", f"宿主不接受工具「{tool}」", 400)

    @staticmethod
    def _writable(root) -> bool:
        try:
            root.mkdir(parents=True, exist_ok=True)
            probe = root / ".write-test"
            probe.write_text("ok", encoding="utf-8")
            probe.unlink(missing_ok=True)
            return True
        except OSError:
            return False
