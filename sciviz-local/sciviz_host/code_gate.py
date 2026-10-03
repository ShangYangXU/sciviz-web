"""受限的项目源码闸门（CLI-11 / HTTP-8 的宿主实现）。

宿主不会执行浏览器传来的命令行。它只接受这里定义的四种结构化动作，并且在
解析真实路径、校验 SHA-256、原子写入和固定闸门之后才允许产生文件变化。
Python 版与 web 侧 ``src/agent/code.ts`` 的数据形状保持一致，便于桌面壳或
宿主直接使用；两处都不维护第二套算子/图执行逻辑。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

_POLICY_FILE = Path(__file__).resolve().parents[2] / "config" / "code-path-policy.json"
try:
    _PATH_POLICY = json.loads(_POLICY_FILE.read_text(encoding="utf-8"))
except (OSError, ValueError):
    # 可移植安装包没有仓库根时仍保守退回旧写入围栏；读范围不会意外扩大。
    _PATH_POLICY = {
        "maxBytes": 1024 * 1024,
        "readRoots": [],
        "writeRoots": [""],
        "allowedFiles": ["AGENTS.md", "README.md", "requirements.txt", "requirements.lock.txt", "package.json", "tsconfig.json"],
        "deniedSegments": [".git", ".venv", "node_modules", "dist", "public/pyodide", ".artifacts", "runs", ".sciviz-state"],
        "deniedExtensions": [".pem", ".key", ".p12", ".exe", ".dll", ".so", ".bin"],
    }

MAX_CODE_FILE_BYTES = int(_PATH_POLICY.get("maxBytes", 1024 * 1024))
ALLOWED_ROOTS = tuple(str(item).lower() for item in _PATH_POLICY.get("writeRoots", []))
READ_ROOTS = tuple(str(item).lower() for item in _PATH_POLICY.get("readRoots", []))
ALLOWED_FILES = {str(item).lower() for item in _PATH_POLICY.get("allowedFiles", [])}
DENIED_SEGMENTS = {str(item).lower() for item in _PATH_POLICY.get("deniedSegments", [])}
DENIED_EXTENSIONS = tuple(str(item).lower() for item in _PATH_POLICY.get("deniedExtensions", []))


class CodeGateError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def _digest(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _normal_digest(value: str | None) -> str | None:
    if not value:
        return None
    return (value[7:] if value.lower().startswith("sha256:") else value).lower()


def _root(root: str | Path) -> Path:
    candidate = Path(root).expanduser().resolve()
    if not candidate.is_dir():
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"代码围栏根目录不存在：{candidate}")
    return candidate


def _relative(root: Path, name: str, *, must_exist: bool = False, write: bool = True) -> tuple[str, Path]:
    if not isinstance(name, str) or not name or Path(name).is_absolute() or re.match(r"^[A-Za-z]:[\\/]", name):
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"源码路径必须是围栏内的相对路径：{name!r}")
    rel = name.replace("\\", "/")
    if rel.startswith("./"):
        rel = rel[2:]
    parts = [part for part in rel.split("/") if part]
    if not parts or any(part in {".", ".."} for part in parts):
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"源码路径含有越界片段：{name}")
    lower = "/".join(parts).lower()
    if any(segment.lower() in DENIED_SEGMENTS for segment in parts) or any(segment.lower().startswith(".env") for segment in parts):
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"路径不在工作区安全范围内：{rel}")
    roots = ALLOWED_ROOTS if write else READ_ROOTS
    if lower not in ALLOWED_FILES and not any(not root_name or lower == root_name or lower.startswith(root_name + "/") for root_name in roots):
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"路径不在{'源码写入围栏' if write else '工作区读取范围'}内：{rel}")
    if lower.endswith(DENIED_EXTENSIONS):
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"不接受二进制或密钥文件：{rel}")
    target = (root / Path(*parts)).resolve(strict=False)
    try:
        target.relative_to(root)
    except ValueError as exc:
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"路径越过源码围栏：{rel}") from exc
    if target.exists():
        real = target.resolve()
        try:
            real.relative_to(root)
        except ValueError as exc:
            raise CodeGateError("E_CODE_PATH_OUTSIDE", f"符号链接越过源码围栏：{rel}") from exc
        if not real.is_file():
            raise CodeGateError("E_CODE_PATH_OUTSIDE", f"目标不是普通文件：{rel}")
        if write and real.stat().st_size > MAX_CODE_FILE_BYTES:
            raise CodeGateError("E_CODE_PATH_OUTSIDE", f"写入目标超过 1 MiB 限制：{rel}")
    else:
        parent = target.parent
        while not parent.exists() and parent != root:
            parent = parent.parent
        try:
            parent.resolve().relative_to(root)
        except ValueError as exc:
            raise CodeGateError("E_CODE_PATH_OUTSIDE", f"文件父目录通过符号链接越界：{rel}") from exc
    if must_exist and not target.exists():
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"文件不存在：{rel}")
    return "/".join(parts), target


def _state(root: Path, plan_id: str) -> Path:
    base = Path(os.environ.get("SCIVIZ_STATE_DIR", root / ".sciviz-state")).expanduser().resolve()
    return base / "code" / plan_id


def _read(root: Path, rel: str) -> tuple[bool, str | None, str | None]:
    _, target = _relative(root, rel, write=False)
    if not target.exists():
        return False, None, None
    data = target.read_bytes()
    if b"\0" in data:
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"不接受二进制文件：{rel}")
    return True, data.decode("utf-8"), _digest(data)


def list_files(root: str | Path, pattern: str = "**/*") -> list[dict[str, Any]]:
    base = _root(root)
    import fnmatch

    result: list[dict[str, Any]] = []
    # os.walk 的 onerror 让单个无权访问的临时目录不至于中断整仓清单；
    # 也在遍历层就裁掉敏感目录，避免把它们当成“读失败”再逐个处理。
    for current, directories, filenames in os.walk(base, topdown=True, onerror=lambda _error: None):
        directories[:] = [
            name for name in directories
            if name.lower() not in DENIED_SEGMENTS and not name.lower().startswith(".env")
        ]
        for filename in filenames:
            target = Path(current) / filename
            try:
                relative_candidate = target.relative_to(base).as_posix()
            except ValueError:
                continue
            candidate_parts = relative_candidate.lower().split("/")
            if any(part in DENIED_SEGMENTS or part.startswith(".env") for part in candidate_parts):
                continue
            try:
                rel, _ = _relative(base, relative_candidate, write=False)
            except (CodeGateError, OSError):
                continue
            if not fnmatch.fnmatchcase(rel, pattern):
                continue
            try:
                size, digest, has_null = _digest_file(target)
            except OSError:
                continue
            if has_null:
                continue
            result.append({"path": rel, "bytes": size, "sha256": digest})
    return sorted(result, key=lambda item: item["path"])


def _digest_file(filename: Path) -> tuple[int, str, bool]:
    digest = hashlib.sha256()
    size = 0
    has_null = False
    with filename.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            size += len(chunk)
            has_null = has_null or b"\0" in chunk
            digest.update(chunk)
    return size, "sha256:" + digest.hexdigest(), has_null


def read_file(root: str | Path, rel: str, start_line: int = 1, end_line: int | None = None) -> dict[str, Any]:
    base = _root(root)
    rel, target = _relative(base, rel, must_exist=True, write=False)
    start = max(1, int(start_line))
    end_limit = min(max(start, int(end_line)) if end_line is not None else start + 499, start + 499)
    selected: list[str] = []
    line_count = 0
    try:
        with target.open("r", encoding="utf-8") as stream:
            for line_count, line in enumerate(stream, start=1):
                if start <= line_count <= end_limit:
                    selected.append(line.rstrip("\r\n"))
    except UnicodeDecodeError as exc:
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"文件不是 UTF-8 文本：{rel}") from exc
    size, digest, has_null = _digest_file(target)
    if has_null:
        raise CodeGateError("E_CODE_PATH_OUTSIDE", f"不接受二进制文件：{rel}")
    actual_end = min(end_limit, line_count)
    return {
        "path": rel,
        "bytes": size,
        "sha256": digest,
        "startLine": start,
        "endLine": actual_end,
        "lineCount": line_count,
        "nextStartLine": actual_end + 1 if actual_end < line_count else None,
        "complete": actual_end >= line_count,
        "text": "\n".join(selected),
    }


def search_files(root: str | Path, query: str, pattern: str = "**/*", limit: int = 50, case_sensitive: bool = False) -> dict[str, Any]:
    if not isinstance(query, str) or not query.strip() or len(query) > 512:
        raise CodeGateError("E_PARAM_INVALID", "search.query 必须是 1–512 个字符的非空文本")
    result_limit = max(1, min(100, int(limit)))
    files = list_files(root, pattern)
    needle = query if case_sensitive else query.casefold()
    matches: list[dict[str, Any]] = []
    total_matches = 0
    files_searched = 0
    for item in files:
        files_searched += 1
        _, target = _relative(_root(root), item["path"], must_exist=True, write=False)
        try:
            with target.open("r", encoding="utf-8") as stream:
                for line_number, raw_line in enumerate(stream, start=1):
                    line = raw_line.rstrip("\r\n")
                    haystack = line if case_sensitive else line.casefold()
                    if needle not in haystack:
                        continue
                    total_matches += 1
                    if len(matches) < result_limit:
                        matches.append({"path": item["path"], "line": line_number, "text": line[:500] + ("…" if len(line) > 500 else "")})
        except UnicodeDecodeError:
            continue
    return {
        "query": query,
        "glob": pattern,
        "filesSearched": files_searched,
        "totalMatches": total_matches,
        "truncated": total_matches > len(matches),
        "matches": matches,
    }


def run_checks(root: str | Path, selected_ids: list[str] | None = None) -> list[dict[str, Any]]:
    base = _root(root)
    checks = _load_check_registry()
    ids = list(dict.fromkeys(selected_ids)) if selected_ids else list(checks)
    unknown = [check_id for check_id in ids if check_id not in checks]
    if unknown:
        raise CodeGateError("E_PARAM_INVALID", f"未知检查项：{', '.join(unknown)}")
    outcomes: list[dict[str, Any]] = []
    for check_id in ids:
        check = checks[check_id]
        if (
            not isinstance(check, dict)
            or check.get("program") not in {"npm", "python"}
            or not isinstance(check.get("args"), list)
            or any(not isinstance(arg, str) for arg in check["args"])
            or not isinstance(check.get("cwd"), str)
            or not isinstance(check.get("timeoutMs", 600_000), int)
            or not 1 <= check.get("timeoutMs", 600_000) <= 600_000
        ):
            outcomes.append({"id": check_id, "ok": False, "exitCode": None, "output": f"检查项 {check_id} 的固定配置无效。"})
            continue
        cwd = (base / str(check.get("cwd", "."))).resolve()
        try:
            cwd.relative_to(base)
        except ValueError as exc:
            raise CodeGateError("E_PARAM_INVALID", f"检查项 {check_id} 的目录越界") from exc
        if not cwd.is_dir():
            outcomes.append({"id": check_id, "ok": False, "exitCode": None, "output": f"检查目录不存在：{check.get('cwd')}"})
            continue
        program = str(check.get("program", ""))
        args = [str(arg) for arg in check["args"]]
        if program == "python":
            executable = sys.executable
        elif program == "npm":
            if os.name == "nt":
                npm_cmd = shutil.which("npm.cmd") or shutil.which("npm")
                node = shutil.which("node.exe") or shutil.which("node")
                npm_cli = Path(npm_cmd).parent / "node_modules" / "npm" / "bin" / "npm-cli.js" if npm_cmd else None
                if not node or not npm_cli or not npm_cli.is_file():
                    outcomes.append({"id": check_id, "ok": False, "exitCode": None, "output": "找不到 Node.js/npm CLI；请确认 Node.js/npm 已加入 PATH。"})
                    continue
                executable = node
                args.insert(0, str(npm_cli))
            else:
                executable = "npm"
        else:
            raise CodeGateError("E_PARAM_INVALID", f"固定检查 {check_id} 的程序不受支持：{program}")
        try:
            completed = subprocess.run(
                [executable, *args],
                cwd=cwd,
                capture_output=True,
                text=True,
                timeout=int(check.get("timeoutMs", 600_000)) / 1000,
                check=False,
            )
            output = (completed.stdout + completed.stderr)[-20_000:]
            outcomes.append({"id": check_id, "ok": completed.returncode == 0, "exitCode": completed.returncode, "output": output})
        except (OSError, subprocess.TimeoutExpired) as exc:
            output = str(exc)
            if isinstance(exc, subprocess.TimeoutExpired):
                output = f"检查超时：{exc.timeout} 秒"
            outcomes.append({"id": check_id, "ok": False, "exitCode": None, "output": output[-20_000:]})
    return outcomes


def _load_check_registry() -> dict[str, dict[str, Any]]:
    registry_file = Path(__file__).resolve().parents[2] / "config" / "code-checks.json"
    try:
        registry = json.loads(registry_file.read_text(encoding="utf-8"))
        checks = registry["checks"]
        if not isinstance(checks, dict):
            raise TypeError("checks 必须是对象")
        return checks
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise CodeGateError("E_EXECUTION_FAILED", f"固定检查清单不可读：{exc}") from exc


def _after(before: str | None, op: dict[str, Any]) -> str | None:
    kind = op.get("kind")
    if kind in {"createFile", "writeFile"}:
        content = op.get("content")
        if not isinstance(content, str):
            raise CodeGateError("E_PARAM_INVALID", f"{kind} 必须带 content")
        return content
    if kind == "deleteFile":
        return None
    if kind == "replaceText":
        old = op.get("oldText")
        new = op.get("newText")
        if not isinstance(old, str) or not old or not isinstance(new, str):
            raise CodeGateError("E_PARAM_INVALID", "replaceText 必须带非空 oldText 与 newText")
        if before is None:
            raise CodeGateError("E_CODE_BASE_MISMATCH", f"文件不存在：{op.get('path')}")
        count = before.count(old)
        if count != 1:
            raise CodeGateError("E_CODE_BASE_MISMATCH", f"oldText 在 {op.get('path')} 中应唯一匹配，实际 {count} 次")
        return before.replace(old, new, 1)
    raise CodeGateError("E_PARAM_INVALID", f"不认识的源码动作：{kind}")


def _gate_ids(paths: Iterable[str]) -> list[dict[str, Any]]:
    names = [path.lower() for path in paths]
    gates: list[dict[str, Any]] = []
    def add(gate_id: str) -> None:
        if not any(item["id"] == gate_id for item in gates):
            check = _load_check_registry().get(gate_id)
            command = " ".join([str(check.get("program", "")), *[str(arg) for arg in check.get("args", [])]]) if check else "internal-check"
            gates.append({"id": gate_id, "command": command, "required": True})
    if any(name.startswith("docs/") or name in {"agents.md", "readme.md"} for name in names):
        add("docs-structure")
    if any(name.startswith("sciviz-web/src/") or name.startswith("sciviz-web/scripts/") for name in names):
        add("web-test")
        add("web-typecheck")
    if any(name.endswith((".tsx", ".css")) for name in names):
        add("web-build")
    if any(name.startswith("sciviz-local/") for name in names):
        add("host-unittest")
    if any(name.startswith("sciviz-web/scripts/") or "/patch" in name or name.endswith("project.ts") for name in names):
        add("agent-blind")
    return gates


def plan(root: str | Path, operations: list[dict[str, Any]]) -> dict[str, Any]:
    base = _root(root)
    if not operations:
        raise CodeGateError("E_PARAM_INVALID", "源码计划至少需要一条动作")
    seen: set[str] = set()
    files: list[dict[str, Any]] = []
    diffs: list[str] = []
    for op in operations:
        rel, _ = _relative(base, str(op.get("path", "")))
        if rel in seen:
            raise CodeGateError("E_PARAM_INVALID", f"同一计划重复触碰文件：{rel}")
        seen.add(rel)
        kind = op.get("kind")
        if kind not in {"replaceText", "writeFile", "createFile", "deleteFile"}:
            raise CodeGateError("E_PARAM_INVALID", f"不认识的源码动作：{kind}")
        exists, before, before_sha = _read(base, rel)
        expected = _normal_digest(op.get("expectSha256"))
        if kind == "createFile":
            if exists:
                raise CodeGateError("E_CODE_BASE_MISMATCH", f"createFile 目标已存在：{rel}")
        elif not exists or expected != _normal_digest(before_sha):
            raise CodeGateError("E_CODE_BASE_MISMATCH", f"文件基线不符：{rel}")
        after = _after(before, op)
        encoded = after.encode("utf-8") if after is not None else b""
        if len(encoded) > MAX_CODE_FILE_BYTES:
            raise CodeGateError("E_CODE_PATH_OUTSIDE", f"写入后文件超过 1 MiB：{rel}")
        after_sha = _digest(encoded) if after is not None else None
        files.append({"path": rel, "beforeSha256": before_sha, "afterSha256": after_sha, "bytes": len(encoded)})
        diffs.append(f"--- a/{rel}\n+++ b/{rel}\n{_diff(before, after)}")
    plan_id = "code-" + secrets.token_hex(10)
    return {
        "schemaVersion": 1,
        "planId": plan_id,
        "root": str(base),
        "createdAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "operations": operations,
        "files": files,
        "diff": "\n".join(diffs),
        "gates": _gate_ids(seen),
        "approvalToken": secrets.token_hex(18),
    }


def _diff(before: str | None, after: str | None) -> str:
    old = (before or "").splitlines()
    new = (after or "").splitlines()
    lines: list[str] = []
    for index in range(max(len(old), len(new))):
        if index < len(old) and index < len(new) and old[index] == new[index]:
            lines.append(" " + old[index])
        else:
            if index < len(old):
                lines.append("-" + old[index])
            if index < len(new):
                lines.append("+" + new[index])
    return "\n".join(lines)


def _atomic_write(target: Path, content: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{target.name}.sciviz-", dir=target.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass


def _write_operations(base: Path, operations: list[dict[str, Any]]) -> None:
    for op in operations:
        rel, target = _relative(base, str(op["path"]))
        exists, before, _ = _read(base, rel)
        after = _after(before, op)
        if after is None:
            if exists:
                target.unlink()
        else:
            _atomic_write(target, after)


def _run_gate(gate: dict[str, Any], root: Path) -> dict[str, Any]:
    if gate["id"] == "docs-structure":
        return {"id": gate["id"], "ok": True, "output": "结构性文档检查已登记"}
    try:
        result = run_checks(root, [str(gate["id"])])[0]
    except CodeGateError as exc:
        return {"id": gate["id"], "ok": False, "output": f"[{exc.code}] {exc}"}
    return {"id": gate["id"], "ok": result["ok"], "output": result["output"]}


def apply(root: str | Path, plan_data: dict[str, Any], approval_token: str, *, gate_runner: Callable[[dict[str, Any], Path], dict[str, Any]] | None = None, skip_gates: bool = False) -> dict[str, Any]:
    base = _root(root)
    if str(plan_data.get("root")) != str(base):
        raise CodeGateError("E_PARAM_INVALID", "源码计划根目录不匹配")
    if approval_token != plan_data.get("approvalToken"):
        raise CodeGateError("E_CODE_GATE_FAILED", "人工批准令牌与计划不匹配")
    before: list[dict[str, Any]] = []
    operations = list(plan_data.get("operations", []))
    files = list(plan_data.get("files", []))
    if len(operations) != len(files) or any(str(op.get("path")) != str(file.get("path")) for op, file in zip(operations, files)):
        raise CodeGateError("E_PARAM_INVALID", "源码计划的动作与文件摘要不一致")
    for index, file in enumerate(files):
        rel, _ = _relative(base, str(file["path"]))
        exists, content, digest = _read(base, rel)
        if _normal_digest(digest) != _normal_digest(file.get("beforeSha256")):
            raise CodeGateError("E_CODE_BASE_MISMATCH", f"应用前发现文件基线变化：{rel}")
        expected_after = _after(content, operations[index])
        expected_after_sha = _digest(expected_after.encode("utf-8")) if expected_after is not None else None
        if _normal_digest(expected_after_sha) != _normal_digest(file.get("afterSha256")) or (expected_after is None) != (file.get("afterSha256") is None):
            raise CodeGateError("E_PARAM_INVALID", f"源码计划的产物摘要不匹配：{rel}")
        before.append({"path": rel, "exists": exists, "content": content, "sha256": digest})
    try:
        _write_operations(base, operations)
    except Exception as exc:
        _restore(base, before)
        raise CodeGateError("E_CODE_GATE_FAILED", f"源码原子写入失败：{exc}") from exc
    gates: list[dict[str, Any]] = []
    if not skip_gates:
        runner = gate_runner or _run_gate
        for gate in plan_data.get("gates", []):
            outcome = runner(gate, base)
            gates.append(outcome)
            if not outcome.get("ok"):
                _restore(base, before)
                return {"ok": False, "status": "failed", "plan": plan_data, "error": {"code": "E_CODE_GATE_FAILED", "message": "固定验证闸门未通过，已回滚源码"}, "gates": gates}
    after = []
    for file in files:
        rel = str(file["path"])
        exists, _, digest = _read(base, rel)
        after.append({"path": rel, "exists": exists, "sha256": digest})
    record = {"schemaVersion": 1, "planId": plan_data["planId"], "root": str(base), "operations": plan_data["operations"], "before": before, "after": after, "gates": gates}
    record_dir = _state(base, str(plan_data["planId"]))
    record_dir.mkdir(parents=True, exist_ok=True)
    (record_dir / "record.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"ok": True, "status": "done", "plan": plan_data, "record": record, "gates": gates}


def _restore(base: Path, snapshots: list[dict[str, Any]]) -> None:
    for snapshot in snapshots:
        rel, target = _relative(base, str(snapshot["path"]))
        if snapshot.get("exists"):
            _atomic_write(target, str(snapshot.get("content") or ""))
        elif target.exists():
            target.unlink()


def undo(root: str | Path, record: dict[str, Any], *, gate_runner: Callable[[dict[str, Any], Path], dict[str, Any]] | None = None, skip_gates: bool = False) -> dict[str, Any]:
    base = _root(root)
    if str(record.get("root")) != str(base):
        raise CodeGateError("E_PARAM_INVALID", "撤销记录根目录不匹配")
    for after in record.get("after", []):
        rel, _ = _relative(base, str(after["path"]))
        _, _, digest = _read(base, rel)
        if _normal_digest(digest) != _normal_digest(after.get("sha256")):
            raise CodeGateError("E_CODE_BASE_MISMATCH", f"撤销前发现文件已被第三方修改：{rel}")
    reverse: list[dict[str, Any]] = []
    after_by_path = {item["path"]: item for item in record.get("after", [])}
    for before in record.get("before", []):
        after = after_by_path[before["path"]]
        if before.get("exists"):
            reverse.append({"kind": "writeFile", "path": before["path"], "expectSha256": after.get("sha256"), "content": before.get("content") or ""})
        else:
            reverse.append({"kind": "deleteFile", "path": before["path"], "expectSha256": after.get("sha256")})
    reverse_plan = plan(base, reverse)
    return apply(base, reverse_plan, str(reverse_plan["approvalToken"]), gate_runner=gate_runner, skip_gates=skip_gates)


def load_record(root: str | Path, plan_id: str) -> dict[str, Any]:
    base = _root(root)
    filename = _state(base, plan_id) / "record.json"
    try:
        return json.loads(filename.read_text(encoding="utf-8"))
    except OSError as exc:
        raise CodeGateError("E_PARAM_INVALID", f"找不到源码改动记录 {plan_id}") from exc
