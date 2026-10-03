"""本地执行宿主的 HTTP / WebSocket 服务。

只监听回环地址。**这不是一个可以暴露出去的服务**：它会执行任意 Python
（用户的"自定义算子"就是任意代码），且没有任何认证。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import time
import uuid
from pathlib import Path
from typing import Any

# 只有一处用到它：认出"客户端走了"的第三种长相（见 ClientGone）。
# anyio 不是新加的包 —— starlette（fastapi 的依赖）本来就靠它跑传输层。
from anyio import ClosedResourceError
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import __version__, agent_gateway, bridge, chat_store, device, live_canvas, preflight, protocol, session
from .live_canvas import CanvasAction

log = logging.getLogger("sciviz_host")

#: 允许调用 `/agent/*` 的页面来源：开发 5173、e2e 用的 5174、预览 4173、宿主自己伺服的 8765。
#: CORS 与 Origin 检查共用这一份 —— 只有一处真相，改端口时不会漏掉其中一处。
AGENT_ALLOWED_ORIGINS: tuple[str, ...] = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://localhost:8765",
    "http://127.0.0.1:8765",
)


def fixed_dataset_path() -> Path | None:
    """固定数据集的唯一宿主路径；HTTP 请求不能覆盖它。"""
    configured = os.environ.get("SCIVIZ_FIXED_DATASET_PATH", "").strip()
    return Path(configured).expanduser() if configured else None


class ClientGone(Exception):
    """客户端已经断开，消息送不出去了。

    **这不是错误**：没人再接了。它被单独分出来只为一件事 —— 别让它在日志里
    变成一条带 traceback 的 ERROR（"后台指令出错"），那会让人以为宿主出了故障。
    断开时该做的事只有一件：把正在跑的活停下（见 `send` 与 socket 的 finally）。
    """


# "客户端走了"在传输层有三种长相，都在 `send` 那一处收拢：
#   · 真断开 —— starlette 把底层的 OSError（ConnectionResetError 之类）翻成 WebSocketDisconnect；
#   · 已经发过 close 还写 —— RuntimeError；
#   · 测试用的内存传输 —— anyio 的 ClosedResourceError。
# 三种都不是宿主出错，区别只在"这条消息没人接"。
_CLIENT_GONE = (WebSocketDisconnect, RuntimeError, OSError, ClosedResourceError)


def _versions() -> tuple[str, str, str, str | None]:
    """Python / numpy / pandas / scipy 版本号。这些是共享 runtime 一并带进来的。

    scipy 是**可能没有**的：它只被共享算子用到，而共享算子不装也能跑一部分图。
    报不出来就报 None —— 运行清单里"缺"与"有个假版本号"是两件事。
    """
    import numpy
    import pandas

    python = platform.python_version()
    try:
        import scipy

        scipy_version: str | None = str(scipy.__version__)
    except ImportError:
        scipy_version = None
    return python, str(numpy.__version__), str(pandas.__version__), scipy_version


def create_app(dist: Path | None = None, *, port: int = 8765) -> FastAPI:
    app = FastAPI(title="SciViz 本地执行宿主", version=__version__)
    agent = agent_gateway.AgentGateway()
    canvas_broker = live_canvas.LiveCanvasBroker()
    agent_allowed_origins = set(AGENT_ALLOWED_ORIGINS)
    agent_allowed_origins.update((f"http://localhost:{port}", f"http://127.0.0.1:{port}"))

    # 前端开发时是 5173，e2e 按 AGENTS.md 用 5174，预览时是 4173，生产静态页由同一个 8765 宿主提供。
    # agent 面不允许通配 CORS：进程令牌是第二道同机网页隔离。
    # 这份清单与 `check_agent_request` 共用一处（AGENT_ALLOWED_ORIGINS）：两处各写一份的话，
    # 换端口时会出现"浏览器说跨域、宿主的 Origin 检查却放行"这种互相矛盾的现场。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=sorted(agent_allowed_origins),
        allow_methods=["GET", "POST"],
        allow_headers=["*"],
    )

    @app.get("/preflight")
    async def preflight_report() -> dict[str, Any]:
        """跨机器体检（T17）：这台机器能不能跑、跑不了该怎么办。

        与 `/health` 分开是刻意的：`/health` 是**探活**（界面每隔几秒问一次，要快），
        这个要读注册表、试端口、看磁盘 —— 只在"换机器 / 装给别人 / 排查"时按需问一次。

        **放进线程里跑**：这些检查都是阻塞 IO（注册表、socket、磁盘），而其中"端口是不是
        被自己占着"那一条要回头问一次 `/health` —— 如果占着事件循环，这个自问自答会超时，
        于是自己把自己判成"端口被别的程序占着"（实测撞到过）。
        """
        return await asyncio.to_thread(preflight.run_checks)

    @app.get("/fixed-dataset/sheet1.csv")
    async def fixed_sheet1() -> FileResponse:
        """只向桌面前端提供配置好的固定 CSV，不提供任意路径读取接口。"""
        path = fixed_dataset_path()
        if path is None:
            raise HTTPException(status_code=404, detail="未配置固定数据集；请手动导入 CSV 或设置 SCIVIZ_FIXED_DATASET_PATH")
        if not path.is_file():
            raise HTTPException(
                status_code=404,
                detail=f"固定数据集不存在：{path}",
            )
        return FileResponse(path, media_type="text/csv", filename="Sheet1.csv")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        info = device.probe()
        python, numpy_version, pandas_version, scipy_version = _versions()
        body: protocol.HealthBody = {
            "ok": True,
            "backend": "local",
            "agentGatewayVersion": agent_gateway.AGENT_GATEWAY_VERSION,
            "fixedDatasetConfigured": fixed_dataset_path() is not None,
            "engine": info.summary(),
            "python": python,
            "numpy": numpy_version,
            "pandas": pandas_version,
            "scipy": scipy_version,
            "device": info.as_dict(),
            "operators": session.available_operators(),
        }
        return {"protocolVersion": protocol.PROTOCOL_VERSION, **body}

    def check_agent_request(request: Request, token: str | None, require_token: bool = True, require_json: bool = False) -> None:
        origin = request.headers.get("origin")
        if origin and origin not in agent_allowed_origins:
            raise HTTPException(status_code=403, detail="不接受这个 Origin")
        if require_json and "application/json" not in request.headers.get("content-type", "").lower():
            raise HTTPException(status_code=415, detail="agent 请求必须使用 application/json")
        if require_token and token != agent.token:
            raise HTTPException(status_code=403, detail="agent 进程令牌无效")

    @app.get("/agent/config")
    async def agent_config(request: Request) -> dict[str, Any]:
        check_agent_request(request, None, require_token=False)
        return agent.config()

    @app.get("/agent/models")
    async def agent_models(request: Request, provider: str | None = None, x_sciviz_agent_token: str | None = Header(default=None)) -> dict[str, Any]:
        check_agent_request(request, x_sciviz_agent_token)
        try:
            chosen = provider or agent.config()["provider"]
            return {
                "models": await agent.discover_models(provider),
                "provider": chosen,
                # 这个宿主进程里**实测回不可用**的模型（上游 503 / 免费层限制）。
                # 界面据此标注并排后，不静默换模型：写图的是哪个模型必须说得清。
                "unavailable": agent.model_health(chosen),
            }
        except agent_gateway.AgentGatewayError as exc:
            raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)}) from exc

    @app.post("/agent/selection")
    async def agent_selection(request: Request, x_sciviz_agent_token: str | None = Header(default=None)) -> dict[str, Any]:
        """HTTP-10：记住"界面里现在选中的 provider / 模型"，下次宿主起来还认它。

        密钥由独立的 HTTP-13 BYOK 设置、CLI 标准输入或环境变量管理。
        """
        check_agent_request(request, x_sciviz_agent_token, require_json=True)
        try:
            body = await request.json()
            model = body.get("model")
            return agent.select_provider(str(body.get("provider", "")), model if isinstance(model, str) else None)
        except agent_gateway.AgentGatewayError as exc:
            raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)}) from exc

    @app.post("/agent/providers")
    async def agent_providers(request: Request, x_sciviz_agent_token: str | None = Header(default=None)) -> dict[str, Any]:
        check_agent_request(request, x_sciviz_agent_token, require_json=True)
        raw = await request.body()
        if len(raw) > 16 * 1024:
            raise HTTPException(status_code=400, detail={"code": "E_PARAM_INVALID", "message": "模型服务设置超过 16 KiB 上限"})
        try:
            body = json.loads(raw)
            return await asyncio.to_thread(agent.configure_provider, body)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(status_code=400, detail={"code": "E_PARAM_INVALID", "message": "模型服务设置不是有效 JSON"}) from exc
        except agent_gateway.AgentGatewayError as exc:
            raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)}) from exc

    @app.post("/agent/chat")
    async def agent_chat(request: Request, x_sciviz_agent_token: str | None = Header(default=None)) -> StreamingResponse:
        check_agent_request(request, x_sciviz_agent_token, require_json=True)
        try:
            body = await request.json()
            stream = agent.stream_chat(body)
        except agent_gateway.AgentGatewayError as exc:
            raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)}) from exc
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail={"code": "E_PARAM_INVALID", "message": "请求体不是有效 JSON 对象"}) from exc

        async def lines():
            try:
                async for item in stream:
                    yield json.dumps(item, ensure_ascii=False) + "\n"
            except agent_gateway.AgentGatewayError as exc:
                yield json.dumps({"version": 1, "type": "error", "code": exc.code, "message": str(exc)}, ensure_ascii=False) + "\n"

        return StreamingResponse(lines(), media_type="application/x-ndjson")

    @app.post("/agent/exec")
    async def agent_exec(request: Request, x_sciviz_agent_token: str | None = Header(default=None)) -> dict[str, Any]:
        check_agent_request(request, x_sciviz_agent_token, require_json=True)
        try:
            body = await request.json()
            return await asyncio.to_thread(agent.execute, body)
        except agent_gateway.AgentGatewayError as exc:
            raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)}) from exc

    @app.post("/agent/session")
    async def agent_session(request: Request, x_sciviz_agent_token: str | None = Header(default=None)) -> dict[str, Any]:
        check_agent_request(request, x_sciviz_agent_token, require_json=True)
        body = await request.json()
        action = str(body.get("action", ""))
        project_id = str(body.get("projectId", ""))
        session_id = str(body.get("sessionId", ""))
        try:
            if action == "create":
                chosen = chat_store.create_session(project_id, session_id or None)
                return {"ok": True, "sessionId": chosen, "seq": 0}
            if action == "append":
                seq = chat_store.append(project_id, session_id, list(body.get("events") or []), int(body.get("expectedSeq", 0)))
                return {"ok": True, "seq": seq}
            if action == "read":
                return {"ok": True, "events": chat_store.read(project_id, session_id, body.get("untilSeq"))}
            if action == "list":
                snapshot = chat_store.index_snapshot(project_id)
                # 只回界面上要用的字段：bytes / mtime 是索引快路径的判定依据，属于实现细节
                public = ("sessionId", "title", "createdAt", "updatedAt", "seq", "events", "turns", "archived", "preview")
                sessions = [
                    {key: meta[key] for key in public if key in meta}
                    for meta in sorted(
                        snapshot["sessions"].values(),
                        key=lambda meta: (str(meta.get("updatedAt") or ""), str(meta.get("sessionId") or "")),
                        reverse=True,
                    )
                ]
                return {"ok": True, "sessions": sessions, "activeSessionId": snapshot["activeSessionId"]}
            if action == "activate":
                chat_store.activate(project_id, session_id)
                return {"ok": True, "activeSessionId": session_id}
            if action == "projects":
                # 状态目录里还有哪些工程身份存着对话（工程身份落盘之前的历史需要认领）
                return {"ok": True, "projects": chat_store.list_projects(project_id)}
            if action == "merge":
                # 把另一个身份下的对话**复制**进当前工程：身份换来换去只会拿回其中一段
                source = str(body.get("sourceProjectId", ""))
                if not source:
                    raise agent_gateway.AgentGatewayError("E_PARAM_INVALID", "缺 sourceProjectId", 400)
                return {"ok": True, "sourceProjectId": source, **chat_store.merge_project(source, project_id)}
            if action == "archive":
                chat_store.archive(project_id, session_id)
                return {"ok": True}
            if action == "unarchive":
                chat_store.unarchive(project_id, session_id)
                return {"ok": True}
            if action == "delete":
                active = chat_store.delete_session(project_id, session_id)
                return {"ok": True, "activeSessionId": active}
            if action == "lease":
                return {"ok": True, "lease": chat_store.acquire_lease(project_id, session_id, str(body.get("owner", "")))}
            if action == "release":
                chat_store.release_lease(project_id, str(body.get("owner", "")))
                return {"ok": True}
            raise agent_gateway.AgentGatewayError("E_PARAM_INVALID", f"未知会话动作「{action}」", 400)
        except chat_store.SessionStoreError as exc:
            raise HTTPException(status_code=409 if isinstance(exc, (chat_store.SequenceMismatch, chat_store.LeaseError)) else 400, detail={"code": getattr(exc, "code", "E_CHAT_SESSION_IO"), "message": str(exc)}) from exc

    @app.post("/agent/canvas/call")
    async def agent_canvas_call(request: Request, x_sciviz_agent_token: str | None = Header(default=None)) -> dict[str, object]:
        """Relay a finite set of live-canvas actions to the foreground SciViz page."""
        check_agent_request(request, x_sciviz_agent_token, require_json=True)
        raw = await request.body()
        if len(raw) > 1_048_576:
            raise HTTPException(status_code=413, detail="画布请求超过 1 MiB")
        try:
            body = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise HTTPException(status_code=400, detail="画布请求不是有效 JSON") from exc
        if not isinstance(body, dict):
            raise HTTPException(status_code=400, detail="画布请求必须是 JSON 对象")
        raw_action = body.get("action")
        if raw_action == "status":
            return await canvas_broker.status()
        actions: dict[str, CanvasAction] = {
            "new": "new",
            "inspect": "inspect",
            "patch": "patch",
            "undo": "undo",
            "run": "run",
            "screenshot": "screenshot",
        }
        action = actions.get(raw_action) if isinstance(raw_action, str) else None
        if action is None:
            raise HTTPException(status_code=400, detail="未知的实时画布动作")
        payload = body.get("payload", {})
        if not isinstance(payload, dict):
            raise HTTPException(status_code=400, detail="画布动作参数必须是 JSON 对象")
        return await canvas_broker.dispatch(action, payload)

    @app.websocket("/agent/canvas")
    async def agent_canvas_socket(websocket: WebSocket) -> None:
        """Browser-owned connection; Origin and a first-frame process token are both required."""
        origin = websocket.headers.get("origin")
        if not origin or origin not in agent_allowed_origins:
            await websocket.close(code=1008, reason="不接受这个画布页面来源")
            return
        await canvas_broker.serve_page(websocket, token=agent.token)

    @app.websocket("/engine")
    async def engine_socket(websocket: WebSocket) -> None:
        await websocket.accept()
        loop = asyncio.get_running_loop()
        engine = session.EngineSession(uuid.uuid4().hex[:12])
        # 一个会话的计算串行执行：Python 侧的节点输出是共享状态，
        # 两个 eval 并行跑会让"上游先算完"这个前提失效
        lock = asyncio.Lock()

        async def send(message: dict[str, Any]) -> None:
            # "送不出去"只有一种原因：客户端走了（关窗、刷新、宿主被停）。
            # 把它翻成 ClientGone，是为了让下面那条后台任务的 report 能认出
            # "这不是故障" —— 否则关一次窗口，控制台就多一条带 traceback 的
            # ERROR（"后台指令出错"），看起来像宿主坏了。
            try:
                await websocket.send_text(json.dumps(message, ensure_ascii=False))
            except _CLIENT_GONE as err:
                raise ClientGone(f"消息没送出去：{_text(err)}") from err

        async def run(blocking, *args):
            async with lock:
                return await asyncio.to_thread(blocking, *args)

        def spawn(coro) -> None:
            """把一条会等锁的指令丢到后台。

            后台任务里的异常不能悄无声息地消失 —— 那样故障会表现成"界面一直转圈"，
            而不是一条能查的错。
            """
            task = asyncio.create_task(coro)

            def report(task: asyncio.Task) -> None:
                if task.cancelled():
                    return
                err = task.exception()
                if isinstance(err, ClientGone):
                    # 客户端走了，这条回话本来就没人接。该做的只有停下正在跑的活，
                    # 那是 socket 的 finally 在做的事（见下面的 engine.request_cancel）
                    log.debug("会话 %s 已断开，一条回话没送出去", engine.id)
                    return
                if err is not None:
                    log.error("会话 %s 的后台指令出错", engine.id, exc_info=err)

            task.add_done_callback(report)

        async def start() -> None:
            await send({"type": "initProgress", "phase": "装载算子"})
            await run(session.install_gpu_operators)
            info = device.probe()
            python, _, _, _ = _versions()
            await send(
                {
                    "type": "ready",
                    "engineInfo": f"本地 Python {python} · {info.summary()}",
                }
            )

        try:
            while True:
                message = await websocket.receive()
                if message.get("type") == "websocket.disconnect":
                    break

                blob = message.get("bytes")
                if blob is not None:
                    await _on_column(send, run, engine, blob)
                    continue

                text = message.get("text")
                if text is not None:
                    # **求值不能在这里 await。** 中间那把锁在训练期间要握几分钟，
                    # 在这里等它等于把接收循环也一起卡住：连"取消"都收不到 ——
                    # 它会一直躺在缓冲区里，直到训练自己跑完。
                    # 所以会等锁的指令交给后台任务，循环继续转；其余都很短，照旧按顺序处理
                    # （数据集那条路尤其要靠顺序：描述与二进制帧不能被打乱）。
                    if _needs_lock(text):
                        spawn(_on_text(send, run, engine, text, start, loop))
                    else:
                        await _on_text(send, run, engine, text, start, loop)
        except WebSocketDisconnect:
            log.info("会话 %s 断开", engine.id)
        finally:
            # 客户端没了，正在跑的活就停下。
            #
            # 没有这一步，"关掉窗口 / 刷新页面"会留下一个**孤儿训练**：它还在烧 GPU，
            # 而唯一能发 `cancel` 的那条连接已经没了 —— 实测撞过一次（GPU 100% 挂了好几分钟，
            # 后续的端到端用例因为抢卡而超时，看起来像产品慢）。
            # 求值是协作式的取消（见 session.request_cancel），所以这里只是置一面旗子。
            engine.request_cancel()
            log.info("会话 %s 结束", engine.id)

    if dist is not None and dist.is_dir():
        # 挂在最后：/health 与 /engine 先匹配
        app.mount("/", StaticFiles(directory=str(dist), html=True), name="dist")

    return app


def _needs_lock(text: str) -> bool:
    """这条指令会不会等那把求值锁（= 会不会被一个长任务堵住）。

    `evalNode` 与 `head` 都要先拿锁。其余的都是纯状态操作，很短 ——
    它们留在接收循环里按顺序处理，那是协议对顺序的要求（见调用处注释）。
    """
    try:
        kind = json.loads(text).get("type")
    except json.JSONDecodeError:
        # 不是合法 JSON：交给 _on_text 去报错，那一步很快
        return False
    return kind in ("evalNode", "head")


async def _on_column(send, run, engine: session.EngineSession, blob: bytes) -> None:
    try:
        loaded_dataset = await run(engine.feed_column, blob)
    except Exception as err:  # noqa: BLE001 —— 装载失败必须变成界面上的可见原因
        # 装载中断后剩下的二进制帧还会陆续到达。让会话彻底忘掉这份数据，
        # 免得它们被当成下一份数据集的前几列，报出更难查的错
        await run(engine.abort_dataset)
        await send(
            {"type": "datasetError", "datasetId": engine.dataset_id, "message": _text(err)}
        )
        return
    if loaded_dataset is not None:
        await send({"type": "datasetReady", "datasetId": loaded_dataset})


async def _on_text(send, run, engine: session.EngineSession, text: str, start, loop) -> None:
    try:
        message = json.loads(text)
    except json.JSONDecodeError as err:
        await send({"type": "initError", "message": f"宿主收到的不是合法 JSON：{err}"})
        return

    kind = message.get("type")
    if kind == "init":
        await start()
        return
    if kind == "setDataset":
        payload = message.get("payload") or {}
        # 二进制帧紧跟着这条路进来，等最后一列到齐才回 datasetReady
        try:
            await run(engine.begin_dataset, payload)
        except Exception as err:  # noqa: BLE001
            await send(
                {
                    "type": "datasetError",
                    "datasetId": str(payload.get("datasetId") or ""),
                    "message": _text(err),
                }
            )
        return
    if kind == "loadFn":
        try:
            await run(engine.load_fn, message["nodeId"], message["fnName"], message["code"])
            await send({"type": "fnLoaded", "nodeId": message["nodeId"]})
        except Exception as err:  # noqa: BLE001
            await send({"type": "fnError", "nodeId": message["nodeId"], "message": _text(err)})
        return
    if kind == "evalNode":
        await _on_eval(send, run, engine, message, loop)
        return
    if kind == "cancel":
        # 取消**不能排到那把锁后面**：那等于"等训练跑完再取消"，一点用都没有。
        # 它只是一面旗子，置上就返回；真正的中断发生在算子的可中断点上。
        engine.request_cancel()
        return
    if kind == "head":
        try:
            table = await run(engine.head, message["nodeId"], message["portId"], message["n"], message.get("offset", 0))
            await send({"type": "head", "requestId": message["requestId"], "table": table})
        except Exception as err:  # noqa: BLE001
            await send(
                {
                    "type": "headError",
                    "requestId": message["requestId"],
                    "message": _text(err),
                }
            )
        return
    if kind == "dropNode":
        try:
            await run(engine.drop_node, message["nodeId"])
        except Exception:  # noqa: BLE001 —— 丢弃失败无所谓：那个节点已经不在图上了
            log.exception("丢弃节点 %s 失败", message.get("nodeId"))
        return

    await send({"type": "initError", "message": f"宿主不认识的指令「{kind}」"})


async def _on_eval(
    send, run, engine: session.EngineSession, message: dict[str, Any], loop
) -> None:
    node_id = message.get("nodeId", "")
    # **整条请求原样转给运行时，只去掉 `type`。**
    #
    # 手工列字段在这个项目里已经埋过三次同样的坑：`fingerprint`（T8）、`meta`（T11）、
    # `sampleRate`（T5）—— 每加一个字段都要记得改这一处，而忘了改的表现是"字段悄悄变空"，
    # 不报错（浏览器那侧的 worker 有同样一段，也改成了透传）。
    payload = {key: value for key, value in message.items() if key != "type"}
    payload["nodeId"] = node_id
    try:
        result = await run(engine.eval_node, payload, _make_progress_sink(send, loop, node_id))
    except Exception as err:  # noqa: BLE001 —— 求值本身的异常也必须如实回报
        await send({"type": "nodeError", "nodeId": node_id, "message": _text(err), "traceback": ""})
        return


    if result.get("cancelled"):
        # 取消不是错误：单独一条消息，让上层把节点放回"可以重试"
        await send(
            {
                "type": "nodeCancelled",
                "nodeId": node_id,
                "message": result.get("message") or "已取消",
            }
        )
        return
    if result.get("ok"):
        await send(
            {
                "type": "nodeResult",
                "nodeId": node_id,
                "refs": result.get("refs") or {},
                "artifacts": result.get("artifacts") or [],
                # 元信息（设备、版本…）与产物一样随结果回传：指标里放不下它
                "meta": result.get("meta") or {},
                # 这一步是"刚算的"还是"复用了上次那份"—— 不传的话上层会以为它刚跑过
                # （同一类漏转发在这条链路上已经出现四次：fingerprint / meta /
                #  sampleRate / 现在这个 cached）
                **({"cached": True} if result.get("cached") else {}),
                **({"restored": True} if result.get("restored") else {}),
            }
        )
        return
    await send(
        {
            "type": "nodeError",
            "nodeId": node_id,
            "message": result.get("message") or "未知错误",
            "traceback": result.get("traceback") or "",
        }
    )


def _text(err: Exception) -> str:
    """异常 → 界面上一行字。共享 runtime 的异常多是 KeyError/ValueError，
    它们的中文说明本身就是给用户看的，不要换成"内部错误"
    """
    return f"{type(err).__name__}: {err}"


def _make_progress_sink(send, loop, node_id: str):
    """算子报进度 → wire 消息。**节流在这里做**。

    算子按自己最自然的粒度报（训练每个 batch 一次，一轮就是一万多条），
    而界面每秒看几条就够。规则：带消息的必发（那是一句人话），
    其余至少隔 250ms、或进度涨了 0.5% 才发。
    """
    last_at = 0.0
    last_ratio = -1.0

    def swallow(future) -> None:
        """进度消息送不出去，唯一的原因是客户端走了 —— 那不是错误。

        这个 future 没人 await，异常本来会被静默吞掉；取出来是为了把
        "客户端走了"与"真的出了问题"分开说，而不是两种都无声无息。
        """
        try:
            err = future.exception()
        except Exception:  # noqa: BLE001 —— 事件循环已关，连取异常都取不到
            return
        if err is None or isinstance(err, ClientGone):
            return
        log.debug("进度消息没送出去：%s", _text(err))

    def report(ratio: float, message: str = "") -> None:
        nonlocal last_at, last_ratio
        now = time.monotonic()
        if not message and now - last_at < 0.25 and ratio - last_ratio < 0.005:
            return
        last_at = now
        last_ratio = ratio
        # 从工作线程发回事件循环。这个 sink 是在求值线程里被调的，
        # 而 send 是协程 —— 直接 await 不了，只能交回循环去跑
        try:
            future = asyncio.run_coroutine_threadsafe(
                send(
                    {
                        "type": "nodeProgress",
                        "nodeId": node_id,
                        "ratio": ratio,
                        "message": message,
                    }
                ),
                loop,
            )
        except RuntimeError:
            # 循环已经停了（宿主正在退出）。进度是可有可无的东西，
            # 让算子的线程在这里炸掉才是真麻烦
            return
        future.add_done_callback(swallow)

    return report


def resolved_dist(explicit: Path | None = None) -> Path | None:
    """找打包好的前端。默认取仓库里的 sciviz-web/dist"""
    if explicit is not None:
        return explicit if explicit.is_dir() else None
    # shared_dir = <仓库>/sciviz-web/src/engine/python
    candidate = bridge.shared_dir().parents[2] / "dist"
    return candidate if candidate.is_dir() else None
