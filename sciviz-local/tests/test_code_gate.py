from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from sciviz_host import code_gate


class CodeGateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        (self.root / "docs").mkdir()
        (self.root / "docs" / "note.md").write_text("alpha\nbeta\n", encoding="utf-8")

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_plan_apply_and_undo(self) -> None:
        current = code_gate.read_file(self.root, "docs/note.md")
        planned = code_gate.plan(self.root, [{"kind": "replaceText", "path": "docs/note.md", "expectSha256": current["sha256"], "oldText": "beta", "newText": "gamma"}])
        result = code_gate.apply(self.root, planned, planned["approvalToken"], skip_gates=True)
        self.assertTrue(result["ok"])
        self.assertIn("gamma", (self.root / "docs" / "note.md").read_text(encoding="utf-8"))
        undone = code_gate.undo(self.root, result["record"], skip_gates=True)
        self.assertTrue(undone["ok"])
        self.assertIn("beta", (self.root / "docs" / "note.md").read_text(encoding="utf-8"))

    def test_path_escape_and_duplicate_match_are_rejected(self) -> None:
        with self.assertRaises(code_gate.CodeGateError) as escaped:
            code_gate.read_file(self.root, "../outside.txt")
        self.assertEqual(escaped.exception.code, "E_CODE_PATH_OUTSIDE")
        current = code_gate.read_file(self.root, "docs/note.md")
        with self.assertRaises(code_gate.CodeGateError) as mismatch:
            code_gate.plan(self.root, [{"kind": "replaceText", "path": "docs/note.md", "expectSha256": current["sha256"], "oldText": "a", "newText": "x"}])
        self.assertEqual(mismatch.exception.code, "E_CODE_BASE_MISMATCH")

    def test_failed_gate_rolls_back(self) -> None:
        current = code_gate.read_file(self.root, "docs/note.md")
        planned = code_gate.plan(self.root, [{"kind": "replaceText", "path": "docs/note.md", "expectSha256": current["sha256"], "oldText": "beta", "newText": "broken"}])
        result = code_gate.apply(self.root, planned, planned["approvalToken"], gate_runner=lambda _gate, _root: {"ok": False, "output": "no"})
        self.assertFalse(result["ok"])
        self.assertIn("beta", (self.root / "docs" / "note.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
