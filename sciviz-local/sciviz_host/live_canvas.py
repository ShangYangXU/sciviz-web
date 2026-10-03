"""Authenticated, narrow RPC broker between MCP and an open SciViz page."""

from __future__ import annotations

import asyncio
import secrets
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal, TypedDict

from fastapi import WebSocket, WebSocketDisconnect

CanvasAction = Literal["new", "inspect", "patch", "undo", "run", "screenshot"]


class PageState(TypedDict, total=False):
    pageId: str
    title: str
    projectId: str
    projectName: str
    nodeCount: int
    edgeCount: int
    visible: bool
    focused: bool


@dataclass(slots=True)
class CanvasPeer:
    page_id: str
    websocket: WebSocket
    state: PageState = field(default_factory=dict)
    last_focused_at: float = 0.0


@dataclass(slots=True)
class PendingCall:
    page_id: str
    websocket: WebSocket
    future: asyncio.Future[dict[str, object]]


class LiveCanvasBroker:
    """Owns connected pages and correlates one-shot MCP calls with browser replies."""

    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._peers: dict[str, CanvasPeer] = {}
        self._pending: dict[str, PendingCall] = {}

    async def serve_page(self, websocket: WebSocket, *, token: str) -> None:
        await websocket.accept()
        page_id = ""
        try:
            hello = await asyncio.wait_for(websocket.receive_json(), timeout=5)
            if not isinstance(hello, dict) or hello.get("type") != "hello":
                await websocket.close(code=1008, reason="缺少画布通道认证")
                return
            supplied = hello.get("token")
            state = hello.get("state")
            if not isinstance(supplied, str) or not secrets.compare_digest(supplied, token):
                await websocket.close(code=1008, reason="画布通道令牌无效")
                return
            if not isinstance(state, dict) or not isinstance(state.get("pageId"), str):
                await websocket.close(code=1008, reason="画布页面身份无效")
                return

            page_id = str(state["pageId"])
            peer = CanvasPeer(page_id=page_id, websocket=websocket, state=self._normalize_state(state))
            if peer.state.get("focused") is True:
                peer.last_focused_at = time.monotonic()
            async with self._lock:
                previous = self._peers.get(page_id)
                self._peers[page_id] = peer
            if previous is not None and previous.websocket is not websocket:
                await previous.websocket.close(code=1000, reason="同一画布页面重新连接")

            await websocket.send_json({"type": "ready", "pageId": page_id})
            while True:
                message = await websocket.receive_json()
                if not isinstance(message, dict):
                    continue
                if message.get("type") == "state":
                    self._update_state(peer, message.get("state"))
                    continue
                if message.get("type") != "result":
                    continue
                request_id = message.get("requestId")
                result = message.get("result")
                if not isinstance(request_id, str) or not isinstance(result, dict):
                    continue
                async with self._lock:
                    pending = self._pending.get(request_id)
                if pending is not None and pending.page_id == page_id and not pending.future.done():
                    pending.future.set_result(result)
        except (WebSocketDisconnect, asyncio.TimeoutError, RuntimeError, OSError, ValueError):
            return
        finally:
            if page_id:
                async with self._lock:
                    peer = self._peers.get(page_id)
                    if peer is not None and peer.websocket is websocket:
                        self._peers.pop(page_id, None)
                    stale = [
                        key
                        for key, pending in self._pending.items()
                        if pending.page_id == page_id and pending.websocket is websocket
                    ]
                    for key in stale:
                        pending = self._pending.pop(key)
                        if not pending.future.done():
                            pending.future.set_result({
                                "ok": False,
                                "error": {"code": "E_EXECUTION_FAILED", "message": "SciViz 画布页面已断开"},
                            })

    async def status(self) -> dict[str, object]:
        async with self._lock:
            peers = list(self._peers.values())
            active = self._choose_peer(peers)
            return {
                "ok": True,
                "connected": bool(peers),
                "visiblePages": sum(peer.state.get("visible") is True for peer in peers),
                "activePage": self._public_state(active) if active else None,
            }

    async def dispatch(self, action: CanvasAction, payload: dict[str, object]) -> dict[str, object]:
        if action == "screenshot":
            payload = {**payload, "includeScreenshot": True}
        async with self._lock:
            peer = self._choose_peer(list(self._peers.values()))
            if peer is None:
                return {
                    "ok": False,
                    "error": {
                        "code": "E_EXECUTION_FAILED",
                        "message": "没有已连接的前台 SciViz 画布；请先在 Edge 中打开并显示 SciViz 画布",
                    },
                }
            request_id = uuid.uuid4().hex
            future: asyncio.Future[dict[str, object]] = asyncio.get_running_loop().create_future()
            self._pending[request_id] = PendingCall(page_id=peer.page_id, websocket=peer.websocket, future=future)
        try:
            await peer.websocket.send_json({
                "type": "request",
                "requestId": request_id,
                "action": action,
                "payload": payload,
            })
            return await asyncio.wait_for(asyncio.shield(future), timeout=65)
        except asyncio.TimeoutError:
            return {
                "ok": False,
                "error": {"code": "E_EXECUTION_FAILED", "message": "SciViz 画布在 65 秒内没有完成请求"},
            }
        except (WebSocketDisconnect, RuntimeError, OSError):
            return {
                "ok": False,
                "error": {"code": "E_EXECUTION_FAILED", "message": "无法把请求送到 SciViz 画布页面"},
            }
        finally:
            async with self._lock:
                pending = self._pending.pop(request_id, None)
            if pending is not None and not pending.future.done():
                pending.future.cancel()

    @staticmethod
    def _normalize_state(value: dict[object, object]) -> PageState:
        state: PageState = {}
        for key in ("pageId", "title", "projectId", "projectName"):
            item = value.get(key)
            if isinstance(item, str):
                state[key] = item
        for key in ("nodeCount", "edgeCount"):
            item = value.get(key)
            if isinstance(item, int) and not isinstance(item, bool):
                state[key] = max(0, item)
        for key in ("visible", "focused"):
            item = value.get(key)
            if isinstance(item, bool):
                state[key] = item
        return state

    def _update_state(self, peer: CanvasPeer, value: object) -> None:
        if not isinstance(value, dict):
            return
        state = self._normalize_state(value)
        was_focused = peer.state.get("focused") is True
        peer.state = state
        if state.get("focused") is True and not was_focused:
            peer.last_focused_at = time.monotonic()

    @staticmethod
    def _choose_peer(peers: list[CanvasPeer]) -> CanvasPeer | None:
        visible = [peer for peer in peers if peer.state.get("visible") is True]
        if not visible:
            return None
        focused = [peer for peer in visible if peer.state.get("focused") is True]
        return max(focused or visible, key=lambda peer: peer.last_focused_at)

    @staticmethod
    def _public_state(peer: CanvasPeer) -> dict[str, object]:
        return dict(peer.state)
