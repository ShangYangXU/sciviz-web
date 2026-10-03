"""对话栏的本地 JSONL 会话存储、可重建索引与写租约。

一个工程可以有多个子对话，每个子对话是 `<projectId>/<sessionId>.jsonl` 一份只追加正文，
长期保留、刷新和重开都不丢。三份数据的真伪关系是定死的：

| 东西 | 角色 |
|---|---|
| `*.jsonl` | **正文是真相**：会话里说过什么、跑过什么工具，只有它说了算 |
| `*.archived` | **归档是真相**：一个会话有没有被收起，靠这个标记文件，不靠索引 |
| `index.json` | **纯缓存**：列表元数据与"上次开着哪个子对话"。丢了就重扫正文重建 |

这样切开，是因为"首屏要快"和"记录不能丢"互相拉扯：列表若每次解析全部正文，100 个会话
就是几百毫秒；而若把索引当成真相，一次写坏就永久丢标题与归档状态。索引可以随便丢，
正文一行都不能少。

这里不保存 provider 密钥，也不执行任何工具；它只是把对话状态从浏览器临时状态移到宿主状态目录，
并用 expectedSeq 拦住静默覆盖。
"""

from __future__ import annotations

import json
import os
import secrets
import shutil
import threading
import time
from pathlib import Path
from typing import Any

from .state_dir import state_root

INDEX_VERSION = 1
TITLE_LIMIT = 40
PREVIEW_LIMIT = 80


class SessionStoreError(RuntimeError):
    code = "E_CHAT_SESSION_IO"


class SequenceMismatch(SessionStoreError):
    code = "E_PROJECT_FILE_CHANGED"


class LeaseError(SessionStoreError):
    code = "E_PROJECT_FILE_CHANGED"


_LOCKS: dict[str, threading.Lock] = {}
_LOCKS_GUARD = threading.Lock()


def _lock_for(project_id: str) -> threading.Lock:
    with _LOCKS_GUARD:
        return _LOCKS.setdefault(project_id, threading.Lock())


def _safe(value: str) -> str:
    if not value or len(value) > 128 or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for char in value):
        raise SessionStoreError("projectId/sessionId 只能包含字母、数字、短横线与下划线")
    return value


def project_dir(project_id: str) -> Path:
    return state_root() / "chat" / _safe(project_id)


def session_path(project_id: str, session_id: str) -> Path:
    return project_dir(project_id) / f"{_safe(session_id)}.jsonl"


def _archive_marker(project_id: str, session_id: str) -> Path:
    return session_path(project_id, session_id).with_suffix(".archived")


def merged_session_id(source_project_id: str, session_id: str) -> str:
    """合并进来的会话用**确定性** id：同一份来源重复合并不产生第二份（幂等）。

    带来源前缀还有第二个用处：一眼看得出这段话是从哪个身份搬过来的，
    而它原来那一份仍然躺在原处、一个字没动。

    这里**不能**用 `_safe`（那个是给"新写入的 id"把关、不合法就拒绝）。目录名是磁盘上已有的
    事实，一个不合规的名字不该让整张候选表报错 —— 实测就是这么被浏览器用例抓到的：
    一个带中文的身份名让 `projects` 整个 500，界面上只剩一句报错。所以这里改成把它**转写**成
    安全的字符。
    """
    return f"m-{_slug(source_project_id)[:8]}-{_slug(session_id)[:80]}"


def _slug(value: str) -> str:
    return "".join(char if char.isascii() and (char.isalnum() or char in "-_") else "_" for char in value)


def _existing_dir(project_id: str) -> Path | None:
    """磁盘上**已经存在**的工程目录。

    与 `project_dir` 的区别只有一条，但很要紧：名字不合规的目录也算数 —— 它是磁盘上的事实
    （老版本或人手建的），而拒绝它等于"看不见自己的历史"。安全性靠路径围栏保证：
    解析后必须真的落在 `chat/` 里面，多跨一层就返回 `None`。
    """
    root = (state_root() / "chat").resolve()
    candidate = (root / project_id).resolve()
    if candidate == root or root not in candidate.parents:
        return None
    return candidate if candidate.is_dir() else None


def _one_line(value: Any, limit: int) -> str:
    text = " ".join(str(value or "").split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _read_lines(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    except (OSError, json.JSONDecodeError) as exc:
        raise SessionStoreError(f"会话文件无法读取：{exc}") from exc


def summarize_events(events: list[dict[str, Any]], session_id: str, archived: bool) -> dict[str, Any]:
    """从正文算出列表要的那几行。列表页不该为此解析第二遍正文，所以只跑一次。"""
    first_user = next((event for event in events if event.get("type") == "user"), None)
    last_text = next((event for event in reversed(events) if event.get("type") in {"assistant", "user"}), None)
    payload = (last_text or {}).get("payload") or {}
    return {
        "sessionId": session_id,
        "title": _one_line((first_user or {}).get("payload", {}).get("text"), TITLE_LIMIT) or "未命名对话",
        "createdAt": (events[0] if events else {}).get("at"),
        "updatedAt": (events[-1] if events else {}).get("at"),
        "seq": len(events),
        "events": len(events),
        "turns": sum(1 for event in events if event.get("type") == "user"),
        "archived": archived,
        "preview": _one_line(payload.get("text"), PREVIEW_LIMIT),
    }


def _collect(project_id: str, cached: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """按"文件有没有被动过"取元数据：尺寸与 mtime 都没变就沿用索引那一份，否则重读正文。

    快路径靠的是 stat 而不是"信索引"：只要正文多了一个字节，尺寸或 mtime 必变，
    于是那条会被重读 —— 索引里留着的永远是能在正文里重新算出来的东西。
    """
    root = project_dir(project_id)
    if not root.exists():
        return {}
    collected: dict[str, dict[str, Any]] = {}
    for path in sorted(root.glob("*.jsonl")):
        session_id = path.stem
        try:
            stat = path.stat()
        except OSError:
            continue
        archived = path.with_suffix(".archived").exists()
        previous = cached.get(session_id) if isinstance(cached, dict) else None
        if (
            isinstance(previous, dict)
            and previous.get("bytes") == stat.st_size
            and previous.get("mtime") == stat.st_mtime
            and bool(previous.get("archived")) == archived
        ):
            collected[session_id] = previous
            continue
        meta = summarize_events(_read_lines(path), session_id, archived)
        meta["bytes"] = stat.st_size
        meta["mtime"] = stat.st_mtime
        collected[session_id] = meta
    return collected


def _index_path(project_id: str) -> Path:
    return project_dir(project_id) / "index.json"


def _read_index(project_id: str) -> dict[str, Any] | None:
    path = _index_path(project_id)
    if not path.exists():
        return None
    try:
        decoded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(decoded, dict) or decoded.get("version") != INDEX_VERSION or not isinstance(decoded.get("sessions"), dict):
        return None
    return decoded


def _write_index(project_id: str, sessions: dict[str, dict[str, Any]], active: str | None) -> None:
    path = _index_path(project_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": INDEX_VERSION,
        "projectId": project_id,
        "activeSessionId": active,
        "updatedAt": time.time(),
        "sessions": sessions,
    }
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _reconcile(project_id: str) -> dict[str, Any]:
    """索引与正文对齐：正文里有而索引没有的补上，索引里有而正文没有的删掉。

    被改过的文件（尺寸/mtime 变了）以正文为准重算那一条。全程以正文为依据，索引只被覆盖。
    """
    index = _read_index(project_id) or {}
    cached = index.get("sessions") if isinstance(index.get("sessions"), dict) else {}
    merged = _collect(project_id, cached)
    active = index.get("activeSessionId")
    if not isinstance(active, str) or active not in merged:
        active = None
    if merged != cached or active != index.get("activeSessionId"):
        _write_index(project_id, merged, active)
    return {"sessions": merged, "activeSessionId": active}


def index_snapshot(project_id: str) -> dict[str, Any]:
    with _lock_for(project_id):
        return _reconcile(project_id)


def list_sessions(project_id: str) -> list[dict[str, Any]]:
    """按最近更新排序；归档的照常返回（界面自己决定怎么显示），不在这里隐藏。"""
    sessions = index_snapshot(project_id)["sessions"]
    return sorted(
        sessions.values(),
        key=lambda meta: (str(meta.get("updatedAt") or ""), str(meta.get("sessionId") or "")),
        reverse=True,
    )


def list_projects(exclude: str | None = None) -> list[dict[str, Any]]:
    """状态目录里还有哪些**工程身份**存着对话。

    存在的理由只有一个，而且很具体：在工程身份落盘之前（2026-09-21 及更早），浏览器每次刷新
    都会重新随机一个 projectId，于是那些对话写在了一个再也不会被用到的身份下面 ——
    文件一个字都没少，只是没人认领。而 2026-09-22 又撞上同一条的另一半：工程文件里没有
    `projectId` 时每次打开都会新随机一个身份（已修），于是同一份工程攒下四五个身份。

    所以每一项都要带上**最近一条对话的标题**：候选往往不止一个，只报数量等于让用户猜；
    他认得出的是"把评估块改成只画对比曲线"这句话，不是 UUID。
    """
    root = state_root() / "chat"
    if not root.exists():
        return []
    found: list[dict[str, Any]] = []
    for path in sorted(root.iterdir()):
        if not path.is_dir() or path.name == exclude or path.name.startswith("."):
            continue
        journals = list(path.glob("*.jsonl"))
        if not journals:
            continue
        latest = max((journal.stat().st_mtime for journal in journals), default=0.0)
        try:
            sessions = list_sessions(path.name)
        except Exception:  # noqa: BLE001 - 一份坏目录不该让整张候选表消失
            sessions = []
        newest = sessions[0] if sessions else None
        holders = _claimed_by(path.name, journals)
        found.append({
            "projectId": path.name,
            "sessions": len(journals),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(latest)) if latest else None,
            "title": (newest or {}).get("title"),
            "merged": bool(exclude and exclude in holders),
            "claimedBy": holders,
        })
    return sorted(found, key=lambda item: str(item.get("updatedAt") or ""), reverse=True)


def _claimed_by(source_project_id: str, journals: list[Path], limit: int = 40) -> list[str]:
    """这份历史已经被**哪些**工程接过去了。

    合并是复制、源目录一个字不改，所以"搬过的源"会永远留在磁盘上；如果不告诉界面它已经
    有主，那么此后**每一个**新工程都会把它当成"没人认领的历史"列一遍 —— 修好一个"看不见
    自己历史"的缺陷，看起来又像"它还是一直在丢"。这里按确定性导出的 id 反查一遍。

    目录数超过 `limit` 时干脆不判断：这只是提示，不是真相，宁可少提示也不要每次列表都扫全盘。
    """
    root = state_root() / "chat"
    wanted = {merged_session_id(source_project_id, journal.stem) for journal in journals}
    directories = [path for path in sorted(root.iterdir()) if path.is_dir() and not path.name.startswith(".")]
    if len(directories) > limit:
        return []
    holders: list[str] = []
    for other in directories:
        if other.name == source_project_id:
            continue
        if wanted & {journal.stem for journal in other.glob("*.jsonl")}:
            holders.append(other.name)
    return holders


def merge_project(source_project_id: str, target_project_id: str) -> dict[str, int]:
    """把另一个工程身份下的会话**复制**进当前工程，身份本身不动。

    存在的理由是一条实测：工程文件里没有 `projectId` 时，每次打开都会新随机一个身份
    （2026-09-22 已修成按文件名派生），于是同一份工程攒下了五个身份、每个一段对话。
    把身份换成其中一个只能拿回一段 —— 所以认领的正确形式是"复制过来"，而不是"改成它"。

    三条口径：
    - **只复制，不动源**：源目录一个字不改，接错了也没有损失；
    - **幂等**：目标 id 由 `merged_session_id` 确定性导出，重复点不会攒出第二份；
    - **正文原样**：事件里那行 `projectId` 是"这段话当时发生在哪个身份下"的审计事实，
      搬过来也不改写；目录归属才是新的。
    """
    _safe(target_project_id)
    source_dir = _existing_dir(source_project_id)
    target_dir = project_dir(target_project_id)
    result = {"merged": 0, "skipped": 0, "sessions": 0}
    if source_project_id == target_project_id or source_dir is None:
        return result
    journals = sorted(source_dir.glob("*.jsonl"))
    result["sessions"] = len(journals)
    target_dir.mkdir(parents=True, exist_ok=True)
    for journal in journals:
        copied_id = merged_session_id(source_project_id, journal.stem)
        with _lock_for(target_project_id):
            destination = session_path(target_project_id, copied_id)
            if destination.exists():
                result["skipped"] += 1
                continue
            shutil.copyfile(journal, destination)
            marker = journal.with_suffix(".archived")
            if marker.exists():
                _archive_marker(target_project_id, copied_id).write_text("", encoding="utf-8")
            result["merged"] += 1
    with _lock_for(target_project_id):
        _reconcile(target_project_id)
    return result


def activate(project_id: str, session_id: str) -> None:
    with _lock_for(project_id):
        snapshot = _reconcile(project_id)
        if session_id not in snapshot["sessions"]:
            raise SessionStoreError("会话不存在")
        _write_index(project_id, snapshot["sessions"], session_id)


def append(project_id: str, session_id: str, events: list[dict[str, Any]], expected_seq: int) -> int:
    path = session_path(project_id, session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock_for(project_id):
        if not path.exists():
            raise SessionStoreError("会话不存在")
        current = _read_lines(path)
        actual = len(current)
        if actual != expected_seq:
            raise SequenceMismatch(f"会话序号不匹配：期望 {expected_seq}，当前 {actual}")
        for offset, event in enumerate(events, start=1):
            if int(event.get("seq", actual + offset)) != actual + offset:
                raise SessionStoreError("会话事件 seq 必须连续")
        try:
            with path.open("a", encoding="utf-8", newline="\n") as handle:
                for event in events:
                    handle.write(json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as exc:
            raise SessionStoreError(f"会话文件无法追加：{exc}") from exc
        # 归档只是"从列表收起"：一开口说话就该回到列表里，否则会留下一个能读不能用的状态。
        if any(event.get("type") == "user" for event in events):
            _archive_marker(project_id, session_id).unlink(missing_ok=True)
        snapshot = _reconcile(project_id)
        _write_index(project_id, snapshot["sessions"], snapshot["activeSessionId"] or session_id)
        return actual + len(events)


def read(project_id: str, session_id: str, until_seq: int | None = None) -> list[dict[str, Any]]:
    events = _read_lines(session_path(project_id, session_id))
    return [event for event in events if until_seq is None or int(event.get("seq", 0)) <= until_seq]


def create_session(project_id: str, session_id: str | None = None) -> str:
    chosen = _safe(session_id or f"s-{secrets.token_hex(8)}")
    path = session_path(project_id, chosen)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise SessionStoreError("会话已经存在")
    path.touch()
    with _lock_for(project_id):
        snapshot = _reconcile(project_id)
        snapshot["sessions"][chosen] = summarize_events([], chosen, False)
        _write_index(project_id, snapshot["sessions"], chosen)
    return chosen


def archive(project_id: str, session_id: str) -> None:
    path = session_path(project_id, session_id)
    with _lock_for(project_id):
        if not path.exists():
            raise SessionStoreError("会话不存在")
        _archive_marker(project_id, session_id).write_text(str(time.time()), encoding="utf-8")
        snapshot = _reconcile(project_id)
        active = snapshot["activeSessionId"]
        if active == session_id:
            active = next((
                meta["sessionId"] for meta in sorted(
                    snapshot["sessions"].values(),
                    key=lambda item: (str(item.get("updatedAt") or ""), str(item.get("sessionId") or "")),
                    reverse=True,
                ) if not meta.get("archived")
            ), None)
        _write_index(project_id, snapshot["sessions"], active)


def unarchive(project_id: str, session_id: str) -> None:
    path = session_path(project_id, session_id)
    with _lock_for(project_id):
        if not path.exists():
            raise SessionStoreError("会话不存在")
        _archive_marker(project_id, session_id).unlink(missing_ok=True)
        snapshot = _reconcile(project_id)
        _write_index(project_id, snapshot["sessions"], snapshot["activeSessionId"])


def delete_session(project_id: str, session_id: str) -> str | None:
    path = session_path(project_id, session_id)
    lease_path = project_dir(project_id) / ".lease.json"
    with _lock_for(project_id):
        if not path.exists():
            raise SessionStoreError("会话不存在")
        if lease_path.exists():
            try:
                lease = json.loads(lease_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                lease = None
            try:
                expires_at = float(lease.get("expiresAt", 0) or 0) if isinstance(lease, dict) else 0
            except (TypeError, ValueError):
                expires_at = 0
            if (
                isinstance(lease, dict)
                and lease.get("sessionId") == session_id
                and expires_at > time.time()
            ):
                raise LeaseError("会话正在执行写入，暂时不能删除")
        try:
            path.unlink()
            _archive_marker(project_id, session_id).unlink(missing_ok=True)
        except OSError as exc:
            raise SessionStoreError(f"会话无法删除：{exc}") from exc
        snapshot = _reconcile(project_id)
        active = snapshot["activeSessionId"]
        if active is None and snapshot["sessions"]:
            active = next(iter(sorted(
                snapshot["sessions"].values(),
                key=lambda item: (str(item.get("updatedAt") or ""), str(item.get("sessionId") or "")),
                reverse=True,
            )))["sessionId"]
        _write_index(project_id, snapshot["sessions"], active)
        return active


def acquire_lease(project_id: str, session_id: str, owner: str, ttl_seconds: int = 30) -> dict[str, Any]:
    path = session_path(project_id, session_id)
    lease_path = project_dir(project_id) / ".lease.json"
    with _lock_for(project_id):
        if not path.exists():
            raise SessionStoreError("会话不存在")
        current: dict[str, Any] | None = None
        if lease_path.exists():
            try:
                current = json.loads(lease_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                current = None
        now = time.time()
        if current and float(current.get("expiresAt", 0)) > now and current.get("owner") != owner:
            raise LeaseError("当前工程已有另一个写租约")
        lease = {"projectId": project_id, "sessionId": session_id, "owner": owner, "expiresAt": now + ttl_seconds}
        lease_path.write_text(json.dumps(lease, ensure_ascii=False), encoding="utf-8")
        return lease


def release_lease(project_id: str, owner: str) -> None:
    lease_path = project_dir(project_id) / ".lease.json"
    if not lease_path.exists():
        return
    with _lock_for(project_id):
        try:
            current = json.loads(lease_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return
        if current.get("owner") == owner:
            lease_path.unlink(missing_ok=True)
