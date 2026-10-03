"""一个工程多个子对话，而且重开还在 —— 这条机制的最低验收面。

压的是"写下来了但找不回来"这一类缺陷：列表元数据、当前会话、归档、索引重建四件事。
"""

import json
import os
import tempfile
import unittest
from unittest import mock

from sciviz_host import chat_store


def event(seq, session_id, kind, payload, at):
    return {
        "schemaVersion": 1,
        "seq": seq,
        "at": at,
        "projectId": "p-retention",
        "sessionId": session_id,
        "turnId": f"t{seq}",
        "type": kind,
        "payload": payload,
    }


class ChatRetentionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_state = os.environ.get("SCIVIZ_STATE_DIR")
        os.environ["SCIVIZ_STATE_DIR"] = self.tmp.name

    def tearDown(self):
        if self.old_state is None:
            os.environ.pop("SCIVIZ_STATE_DIR", None)
        else:
            os.environ["SCIVIZ_STATE_DIR"] = self.old_state
        self.tmp.cleanup()

    def seed(self, session_id, question, answer, at):
        chat_store.create_session("p-retention", session_id)
        chat_store.append("p-retention", session_id, [event(1, session_id, "user", {"text": question}, at)], 0)
        chat_store.append("p-retention", session_id, [event(2, session_id, "assistant", {"text": answer}, at)], 1)

    def test_multiple_conversations_survive_and_carry_titles(self):
        self.seed("s-1", "这张图为什么报错", "因为上游没接。", "2026-09-22T01:00:00Z")
        self.seed("s-2", "帮我加一个傅里叶块", "已给出提案。", "2026-09-22T02:00:00Z")

        snapshot = chat_store.index_snapshot("p-retention")
        self.assertEqual(len(snapshot["sessions"]), 2)
        self.assertEqual(snapshot["activeSessionId"], "s-2")
        titles = {meta["sessionId"]: meta["title"] for meta in snapshot["sessions"].values()}
        self.assertEqual(titles["s-1"], "这张图为什么报错")
        self.assertEqual(titles["s-2"], "帮我加一个傅里叶块")

        listed = chat_store.list_sessions("p-retention")
        self.assertEqual([meta["sessionId"] for meta in listed], ["s-2", "s-1"], "最近更新的排在前面")
        self.assertEqual(listed[1]["events"], 2)
        self.assertFalse(listed[1]["archived"])

    def test_activate_switches_current_conversation(self):
        self.seed("s-1", "第一轮", "答一", "2026-09-22T01:00:00Z")
        self.seed("s-2", "第二轮", "答二", "2026-09-22T02:00:00Z")
        chat_store.activate("p-retention", "s-1")
        self.assertEqual(chat_store.index_snapshot("p-retention")["activeSessionId"], "s-1")
        with self.assertRaises(chat_store.SessionStoreError):
            chat_store.activate("p-retention", "s-missing")

    def test_archive_hides_from_default_view_but_stays_readable_and_appendable(self):
        self.seed("s-1", "归档我", "好", "2026-09-22T01:00:00Z")
        chat_store.archive("p-retention", "s-1")
        archived = chat_store.list_sessions("p-retention")[0]
        self.assertTrue(archived["archived"])
        self.assertEqual(len(chat_store.read("p-retention", "s-1")), 2, "归档不是删除")

        chat_store.append("p-retention", "s-1", [event(3, "s-1", "user", {"text": "我又回来了"}, "2026-09-22T03:00:00Z")], 2)
        resumed = chat_store.list_sessions("p-retention")[0]
        self.assertFalse(resumed["archived"], "继续说话就自动回到列表")
        self.assertEqual(resumed["events"], 3)
        self.assertEqual(resumed["title"], "归档我", "标题仍是第一条用户消息")

    def test_index_is_rebuildable_from_the_journal(self):
        self.seed("s-1", "第一条", "答", "2026-09-22T01:00:00Z")
        self.seed("s-2", "第二条", "答", "2026-09-22T02:00:00Z")
        chat_store.activate("p-retention", "s-1")
        chat_store.archive("p-retention", "s-2")
        index_path = chat_store.project_dir("p-retention") / "index.json"
        self.assertTrue(index_path.exists())
        index_path.unlink()

        snapshot = chat_store.index_snapshot("p-retention")
        self.assertEqual(sorted(snapshot["sessions"]), ["s-1", "s-2"])
        self.assertEqual(snapshot["sessions"]["s-2"]["title"], "第二条")
        self.assertTrue(snapshot["sessions"]["s-2"]["archived"], "归档靠标记文件，索引丢了也还在")
        self.assertIsNone(snapshot["activeSessionId"], "索引丢了就退回默认，下次 activate 重新记")

    def test_corrupt_index_falls_back_to_the_journal(self):
        self.seed("s-1", "别丢我", "好", "2026-09-22T01:00:00Z")
        (chat_store.project_dir("p-retention") / "index.json").write_text("{ 这不是 JSON", encoding="utf-8")
        sessions = chat_store.list_sessions("p-retention")
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["title"], "别丢我")

    def test_list_does_not_reparse_untouched_journals(self):
        self.seed("s-1", "别重读我", "好", "2026-09-22T01:00:00Z")
        chat_store.list_sessions("p-retention")
        with mock.patch.object(chat_store, "_read_lines", side_effect=AssertionError("没动过的正文不该被重读")):
            chat_store.list_sessions("p-retention")
        self.assertEqual(len(chat_store.read("p-retention", "s-1")), 2, "正文按需读取时照常解析")

    def test_index_metadata_matches_journal_bytes(self):
        self.seed("s-1", "第一条", "答", "2026-09-22T01:00:00Z")
        chat_store.list_sessions("p-retention")
        index = json.loads((chat_store.project_dir("p-retention") / "index.json").read_text(encoding="utf-8"))
        entry = index["sessions"]["s-1"]
        journal = chat_store.session_path("p-retention", "s-1")
        self.assertEqual(entry["bytes"], journal.stat().st_size)
        self.assertEqual(entry["events"], 2)

    def test_other_project_identities_are_offered_for_claiming(self):
        """工程身份落盘之前写下的对话，文件还在但没人认领 —— 列出来，让界面问一句。"""
        self.seed("s-1", "旧身份的对话", "答", "2026-09-22T01:00:00Z")
        self.assertEqual(chat_store.list_projects("p-retention"), [], "自己那份不算别人")
        others = chat_store.list_projects("p-brand-new")
        self.assertEqual([item["projectId"] for item in others], ["p-retention"])
        self.assertEqual(others[0]["sessions"], 1)
        self.assertIsNotNone(others[0]["updatedAt"])
        # 候选必须带标题：只报数量的结果是用户在一堆 UUID 里猜哪份是自己的
        self.assertEqual(others[0]["title"], "旧身份的对话")
        # 空工程目录不该出现在候选里
        (chat_store.project_dir("p-brand-new")).mkdir(parents=True, exist_ok=True)
        self.assertEqual(len(chat_store.list_projects("p-brand-new")), 1)

    def test_merge_copies_history_without_touching_the_source_and_is_idempotent(self):
        """认领的正确形式是"复制过来"，不是"把身份换成它" —— 换身份只能拿回其中一份。"""
        self.seed("s-1", "把评估块改成只画对比曲线", "好", "2026-09-22T01:00:00Z")

        first = chat_store.merge_project("p-retention", "p-current")
        self.assertEqual((first["merged"], first["skipped"]), (1, 0))
        merged = chat_store.list_sessions("p-current")
        self.assertEqual(len(merged), 1)
        self.assertEqual(merged[0]["title"], "把评估块改成只画对比曲线")
        self.assertEqual(merged[0]["sessionId"], chat_store.merged_session_id("p-retention", "s-1"))

        # 源一个字没少
        self.assertEqual(len(chat_store.list_sessions("p-retention")), 1)
        self.assertEqual(len(chat_store.read("p-retention", "s-1")), 2)

        # 幂等：再点一次不会攒出第二份
        second = chat_store.merge_project("p-retention", "p-current")
        self.assertEqual((second["merged"], second["skipped"]), (0, 1))
        self.assertEqual(len(chat_store.list_sessions("p-current")), 1)

        # 自己搬自己什么都不做
        self.assertEqual(chat_store.merge_project("p-current", "p-current")["merged"], 0)

    def test_merged_candidates_drop_out_of_the_offer_list(self):
        """搬过来的不再烦人：候选表里那一项标 merged，界面据此隐藏它。"""
        self.seed("s-1", "旧身份的对话", "答", "2026-09-22T01:00:00Z")
        before = chat_store.list_projects("p-current")
        self.assertEqual([item["merged"] for item in before], [False])
        self.assertEqual([item["claimedBy"] for item in before], [[]])

        chat_store.merge_project("p-retention", "p-current")
        after = chat_store.list_projects("p-current")
        self.assertEqual([item["merged"] for item in after], [True])
        # 关键：搬过之后，**别的**工程也知道它已经有主了 —— 否则每开一个新工程都会把它
        # 当成"没人认领的历史"再列一遍，看起来就像历史一直在丢
        for_other = {item["projectId"]: item for item in chat_store.list_projects("p-other")}
        self.assertEqual(for_other["p-retention"]["claimedBy"], ["p-current"])
        self.assertFalse(for_other["p-retention"]["merged"], "对别的工程来说它没被搬进去，只是已经有主")

    def test_merge_carries_the_archive_marker(self):
        """归档是真相（`*.archived`）：搬过来之后不该在列表里"复活"成没归档的。"""
        self.seed("s-1", "归档过的旧对话", "答", "2026-09-22T01:00:00Z")
        chat_store.archive("p-retention", "s-1")
        chat_store.merge_project("p-retention", "p-current")
        self.assertTrue(chat_store.list_sessions("p-current")[0]["archived"])

    def test_merge_tolerates_a_source_directory_with_odd_characters(self):
        """目录名是磁盘上既有的事实：一个不合规的名字不该让整张候选表 500。

        这条是浏览器用例先撞出来的 —— `merged_session_id` 原先用 `_safe` 把关，遇到带中文的
        身份名直接抛异常，界面上只剩一句报错、候选一个都看不见。
        """
        weird = chat_store.state_root() / "chat" / "旧身份"
        weird.mkdir(parents=True, exist_ok=True)
        (weird / "s-1.jsonl").write_text(
            json.dumps({"schemaVersion": 1, "seq": 1, "at": "2026-09-22T01:00:00Z", "projectId": "旧身份",
                        "sessionId": "s-1", "turnId": "t1", "type": "user", "payload": {"text": "旧对话"}},
                       ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        self.assertTrue(chat_store.merged_session_id("旧身份", "s-1").isascii())
        self.assertEqual(chat_store.merge_project("旧身份", "p-current")["merged"], 1)
        self.assertEqual(len(chat_store.list_sessions("p-current")), 1)
        # 候选表照常列得出来，而且认得出自己已经搬过了。
        # 标题读不出来也不要紧（读正文那一侧对 id 是严格校验的，这里只做到"看得见、搬得动"）
        # —— 关键是它**不许**让整张候选表消失。
        candidates = chat_store.list_projects("p-current")
        self.assertEqual([item["merged"] for item in candidates], [True])
        self.assertEqual([item["sessions"] for item in candidates], [1])


if __name__ == "__main__":
    unittest.main()
