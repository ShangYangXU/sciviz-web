"""专用的 OpenCode Go 传输适配器。

OpenCode Go 官方文档把 DeepSeek V4.1 Flash 列为 OpenAI-compatible
Chat Completions endpoint。这个模块只实现该套餐的固定 route / model，
并解析它返回的 SSE；凭据仍由 providers.py 管理。
"""

from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlsplit

from .providers import OPENCODE_GO_BASE_URL, OPENCODE_GO_MODEL

GO_CHAT_COMPLETIONS_URL = f"{OPENCODE_GO_BASE_URL}/chat/completions"
GO_HOST = urlsplit(OPENCODE_GO_BASE_URL).hostname or "opencode.ai"
_SECRET_LIKE = re.compile(r"\b(?:oc_)?sk[-_][A-Za-z0-9_\-]{8,}")
_READ_TIMEOUT_SECONDS = 120


class OpenCodeGoError(RuntimeError):
    """Go endpoint returned an unusable response or local routing is invalid."""


def _normalize_proxy(value: str) -> str:
    candidate = value.strip()
    if "://" not in candidate:
        candidate = f"http://{candidate}"
    parsed = urlsplit(candidate)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise OpenCodeGoError("OpenCode Go 代理地址无效；请使用 HTTP 或 HTTPS 本地代理")
    return candidate


def _windows_system_proxy() -> str | None:
    if sys.platform != "win32":
        return None
    try:
        import winreg

        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ) as key:
            enabled, _ = winreg.QueryValueEx(key, "ProxyEnable")
            if int(enabled) != 1:
                return None
    except (OSError, ValueError, TypeError):
        return None
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Internet Settings",
        ) as key:
            proxy_server, _ = winreg.QueryValueEx(key, "ProxyServer")
    except (OSError, ValueError, TypeError) as exc:
        raise OpenCodeGoError("Windows 已启用系统代理，但没有可用的代理地址") from exc

    raw = str(proxy_server).strip()
    if not raw:
        raise OpenCodeGoError("Windows 已启用系统代理，但代理地址为空")
    if "=" in raw:
        per_scheme: dict[str, str] = {}
        for item in re.split(r"[;\s]+", raw):
            scheme, separator, address = item.partition("=")
            if separator and address.strip():
                per_scheme[scheme.lower()] = address.strip()
        raw = per_scheme.get("https") or per_scheme.get("http") or per_scheme.get("all") or ""
        if not raw:
            raise OpenCodeGoError("Windows 系统代理没有配置 HTTP 或 HTTPS 代理地址")
    return _normalize_proxy(raw)


def _https_proxy() -> str | None:
    """Resolve the caller's HTTPS proxy without printing its address or credentials."""
    for name in ("https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "http_proxy", "HTTP_PROXY"):
        value = os.environ.get(name, "").strip()
        if value:
            return _normalize_proxy(value)

    configured = urllib.request.getproxies()
    for scheme in ("https", "all", "http"):
        value = configured.get(scheme)
        if value:
            return _normalize_proxy(value)

    return _windows_system_proxy()


def _open(request: urllib.request.Request):
    proxy = _https_proxy()
    if not proxy:
        return urllib.request.urlopen(request, timeout=_READ_TIMEOUT_SECONDS)

    if urllib.request.proxy_bypass(GO_HOST):
        raise OpenCodeGoError("系统代理绕过规则排除了 OpenCode Go 域名；已阻止该请求绕过代理")

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({"https": proxy}),
    )
    return opener.open(request, timeout=_READ_TIMEOUT_SECONDS)


def _sanitize_message(message: str, api_key: str) -> str:
    safe = message.replace(api_key, "[已隐藏]") if api_key else message
    return _SECRET_LIKE.sub("…", safe.strip())[:200]


def _http_error_detail(exc: urllib.error.HTTPError, api_key: str) -> str:
    try:
        raw = exc.read(4096).decode("utf-8", errors="replace")
        decoded = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError):
        return ""

    if not isinstance(decoded, dict):
        return ""
    error = decoded.get("error")
    if isinstance(error, dict):
        detail = str(error.get("message") or error.get("code") or "")
    elif isinstance(error, str):
        detail = error
    else:
        detail = str(decoded.get("message") or decoded.get("detail") or "")
    return _sanitize_message(detail, api_key)


def _content_text(content: object) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "".join(
        str(part.get("text", ""))
        for part in content
        if isinstance(part, dict) and part.get("type") in {"text", "output_text"}
    )


def stream_chat(
    body: dict[str, Any],
    *,
    api_key: str,
    session_id: str,
    user_agent: str,
) -> Iterator[dict[str, Any]]:
    """Send one Go Chat Completions request and yield normalized stream events."""
    if not api_key:
        raise OpenCodeGoError("OpenCode Go 凭据未配置")
    if not session_id:
        raise OpenCodeGoError("OpenCode Go 请求缺少会话 ID")

    messages = body.get("messages", [])
    tools = body.get("tools")
    tool_choice = body.get("toolChoice")
    if not isinstance(messages, list):
        raise OpenCodeGoError("OpenCode Go 请求中的 messages 必须是数组")
    if tools is not None and not isinstance(tools, list):
        raise OpenCodeGoError("OpenCode Go 请求中的 tools 必须是数组")
    if tool_choice not in {None, "auto", "required"}:
        raise OpenCodeGoError("toolChoice 只能是 auto 或 required")
    if tool_choice == "required" and not tools:
        raise OpenCodeGoError("toolChoice=required 时必须提供至少一个工具")

    payload: dict[str, Any] = {
        "model": OPENCODE_GO_MODEL,
        "messages": messages,
        "stream": True,
    }
    if tools:
        payload["tools"] = tools
    if tool_choice == "required":
        payload["tool_choice"] = "required"

    request = urllib.request.Request(
        GO_CHAT_COMPLETIONS_URL,
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Accept": "text/event-stream",
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "User-Agent": user_agent,
            "x-opencode-session": session_id,
        },
        method="POST",
    )

    calls: dict[int, dict[str, str]] = {}
    completed = False
    finish_reason: str | None = None

    def consume(data: str) -> list[dict[str, Any]]:
        nonlocal completed, finish_reason
        if data == "[DONE]":
            completed = True
            return []
        try:
            decoded = json.loads(data)
        except json.JSONDecodeError as exc:
            raise OpenCodeGoError("OpenCode Go SSE 中包含无效 JSON") from exc
        if not isinstance(decoded, dict):
            raise OpenCodeGoError("OpenCode Go SSE 事件不是 JSON 对象")

        if isinstance(decoded.get("error"), (dict, str)):
            error = decoded["error"]
            message = error.get("message") if isinstance(error, dict) else error
            raise OpenCodeGoError(_sanitize_message(str(message or "OpenCode Go 返回错误"), api_key))

        events: list[dict[str, Any]] = []
        choices = decoded.get("choices")
        if not isinstance(choices, list):
            return events
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            delta = choice.get("delta") or {}
            if isinstance(delta, dict):
                text = _content_text(delta.get("content"))
                if text:
                    events.append({"type": "text_delta", "text": text})
                tool_deltas = delta.get("tool_calls") or []
                if not isinstance(tool_deltas, list):
                    raise OpenCodeGoError("OpenCode Go 返回的工具调用增量不是数组")
                for tool_delta in tool_deltas:
                    if not isinstance(tool_delta, dict):
                        continue
                    index = tool_delta.get("index", 0)
                    if not isinstance(index, int) or index < 0:
                        raise OpenCodeGoError("OpenCode Go 返回了无效的工具调用序号")
                    call = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    call_id = tool_delta.get("id")
                    if call_id:
                        call["id"] = str(call_id)
                    function = tool_delta.get("function") or {}
                    if isinstance(function, dict):
                        name = function.get("name")
                        arguments = function.get("arguments")
                        if name:
                            call["name"] += str(name)
                        if isinstance(arguments, str):
                            call["arguments"] += arguments
                        elif arguments is not None:
                            call["arguments"] += json.dumps(arguments, ensure_ascii=False)
            if choice.get("finish_reason") is not None:
                finish_reason = str(choice["finish_reason"])
        return events

    data_lines: list[str] = []
    try:
        with _open(request) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="strict").rstrip("\r\n")
                if line.startswith(":"):
                    continue
                if not line:
                    if data_lines:
                        for event in consume("\n".join(data_lines)):
                            yield event
                        data_lines.clear()
                        if completed:
                            break
                    continue
                if line.startswith("data:"):
                    data_lines.append(line[5:].lstrip())
            if data_lines:
                for event in consume("\n".join(data_lines)):
                    yield event
    except urllib.error.HTTPError as exc:
        detail = _http_error_detail(exc, api_key)
        suffix = f": {detail}" if detail else ""
        raise OpenCodeGoError(f"OpenCode Go HTTP {exc.code}{suffix}") from exc
    except UnicodeDecodeError as exc:
        raise OpenCodeGoError("OpenCode Go SSE 不是有效 UTF-8") from exc

    if not completed:
        raise OpenCodeGoError("OpenCode Go 流在终止标记前结束")

    for index in sorted(calls):
        call = calls[index]
        try:
            arguments = json.loads(call["arguments"] or "{}")
        except json.JSONDecodeError as exc:
            raise OpenCodeGoError("OpenCode Go 工具参数不是有效 JSON；本轮工具尚未执行") from exc
        if not isinstance(arguments, dict) or not call["name"]:
            raise OpenCodeGoError("OpenCode Go 返回了不完整的工具调用；本轮工具尚未执行")
        yield {
            "type": "tool_call",
            "callId": call["id"] or f"go-{index}",
            "name": call["name"],
            "arguments": arguments,
        }
    yield {"type": "completion", "finishReason": finish_reason}
