"""本机 provider 凭据：落盘、合并优先级、以及"HTTP 面永远拿不到密钥"。

这一组压的是用户提的那个诉求：不必每次开宿主都去设环境变量，两个 provider 都能在界面上选。
"""

import json
import io
import os
import tempfile
import unittest
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient

from sciviz_host import agent_gateway, providers as provider_store, server

KEYS = tuple({key for preset in provider_store.PROVIDER_PRESETS.values() for key in preset["envKeys"]}) + ("SCIVIZ_AGENT_API_KEY", "SCIVIZ_AGENT_BASE_URL", "SCIVIZ_AGENT_PROVIDER", "SCIVIZ_AGENT_MODEL")


class ProviderStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.saved = {key: os.environ.get(key) for key in KEYS + ("SCIVIZ_STATE_DIR",)}
        os.environ["SCIVIZ_STATE_DIR"] = self.tmp.name
        for key in KEYS:
            os.environ.pop(key, None)

    def tearDown(self):
        for key, value in self.saved.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()

    def test_key_is_stored_locally_and_masked(self):
        path = provider_store.set_provider("opencode", api_key="sk-opencode-secret-1234")
        self.assertEqual(path, provider_store.config_path())
        self.assertEqual(path.parent, Path(self.tmp.name).resolve(), "凭据必须落在状态目录里")
        stored = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(stored["providers"]["opencode"]["apiKey"], "sk-opencode-secret-1234")
        self.assertEqual(provider_store.mask("sk-opencode-secret-1234"), "…1234")
        self.assertNotIn("secret-1", provider_store.mask("sk-opencode-secret-1234"))

        listed = {info["id"]: info for info in provider_store.describe_all()}
        self.assertTrue(listed["opencode"]["available"])
        self.assertEqual(listed["opencode"]["source"], "file")
        self.assertFalse(listed["deepseek"]["available"], "没配的 provider 仍然列出来，只是不可用")

        provider_store.remove_provider("opencode")
        self.assertFalse({info["id"]: info for info in provider_store.describe_all()}["opencode"]["available"])

    def test_selection_survives_restarts_and_key_writes(self):
        """用户要的那句："我切到 opencode 的 ds flash，下次打开应该还是它。" """
        provider_store.set_provider("deepseek", api_key="ds-key")
        provider_store.set_provider("opencode", api_key="oc-key")
        provider_store.select_provider("opencode", "deepseek-v4.1-flash")
        self.assertEqual(provider_store.load_selection(), {"provider": "opencode"})
        self.assertEqual(
            {info["id"]: info["model"] for info in provider_store.describe_all()}["opencode"],
            "deepseek-v4.1-flash",
        )

        # 之后又写别的 provider 的密钥，不该把"选中的是谁"和已选模型顺手抹掉
        provider_store.set_provider("deepseek", api_key="ds-key-2")
        self.assertEqual(provider_store.load_selection(), {"provider": "opencode"})

        # 关掉宿主再起来（新的 gateway 实例）：仍然选中同一个
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "auto"
        self.assertEqual(agent_gateway.AgentGateway().config()["provider"], "opencode")

    def test_selection_falls_back_when_the_remembered_provider_has_no_credentials(self):
        provider_store.set_provider("deepseek", api_key="ds-key")
        provider_store.select_provider("opencode")  # 只选了它，没配密钥
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "auto"
        self.assertEqual(
            agent_gateway.AgentGateway().config()["provider"],
            "deepseek",
            "记住的那个现在用不了，就按固定顺序回落 —— 但不能悄悄用一个没配的",
        )

    def test_explicit_env_provider_still_wins_over_the_selection(self):
        provider_store.set_provider("deepseek", api_key="ds-key")
        provider_store.set_provider("opencode", api_key="oc-key")
        provider_store.select_provider("opencode", "kimi-k3")
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "deepseek"
        self.assertEqual(agent_gateway.AgentGateway().config()["provider"], "deepseek", "显式点名的优先级不变")

    def test_selection_endpoint_round_trip(self):
        provider_store.set_provider("opencode", api_key="sk-opencode-secret-1234")
        client = TestClient(server.create_app())
        with client:
            token = client.get("/agent/config").json()["token"]
            headers = {"X-Sciviz-Agent-Token": token, "Content-Type": "application/json"}
            ok = client.post("/agent/selection", json={"provider": "opencode", "model": "deepseek-v4.1-flash"}, headers=headers)
            self.assertEqual(ok.status_code, 200, ok.text)
            self.assertEqual(ok.json(), {"ok": True, "provider": "opencode", "model": "deepseek-v4.1-flash"})
            self.assertNotIn("secret", json.dumps(ok.json(), ensure_ascii=False))
            bad = client.post("/agent/selection", json={"provider": "不存在的"}, headers=headers)
            self.assertEqual(bad.status_code, 400)
            self.assertEqual(bad.json()["detail"]["code"], "E_PARAM_INVALID")
            # 没有令牌就写不动（它不是"界面里点一下就生效"的本地开关）
            self.assertEqual(client.post("/agent/selection", json={"provider": "opencode"}, headers={"Content-Type": "application/json"}).status_code, 403)
        self.assertEqual(provider_store.load_selection(), {"provider": "opencode"})

    def test_environment_still_wins_over_the_local_file(self):
        provider_store.set_provider("deepseek", api_key="from-file")
        provider_store.set_provider("opencode", api_key="from-file-too")
        os.environ["DEEPSEEK_API_KEY"] = "from-env"
        self.assertEqual(provider_store.resolve("deepseek", use_global_env=True)["apiKey"], "from-env")
        self.assertEqual(provider_store.resolve("deepseek", use_global_env=True)["source"], "env")
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "auto"
        config = agent_gateway.AgentGateway().config()
        self.assertEqual(config["provider"], "deepseek", "auto 仍按 deepseek → opencode 的固定顺序")

    def test_named_provider_ignores_global_overrides(self):
        provider_store.set_provider("opencode", api_key="sk-opencode")
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "deepseek"
        os.environ["SCIVIZ_AGENT_BASE_URL"] = "https://example.invalid/v1"
        os.environ["SCIVIZ_AGENT_API_KEY"] = "global-key"
        named = provider_store.resolve("opencode", use_global_env=False)
        self.assertEqual(named["apiKey"], "sk-opencode")
        self.assertEqual(named["baseUrl"], provider_store.PROVIDER_PRESETS["opencode"]["baseUrl"])
        default = provider_store.resolve("deepseek", use_global_env=True)
        self.assertEqual(default["baseUrl"], "https://example.invalid/v1", "全局覆盖只作用于默认 provider")

    def test_config_lists_all_providers_without_leaking_the_key(self):
        provider_store.set_provider("opencode", api_key="sk-opencode-secret-1234")
        provider_store.set_provider("deepseek", api_key="sk-deepseek-secret-5678")
        client = TestClient(server.create_app())
        with client:
            payload = client.get("/agent/config").json()
        text = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn("secret", text)
        self.assertNotIn("apiKeyTail", text)
        ids = [info["id"] for info in payload["providers"]]
        self.assertEqual(ids, list(provider_store.PROVIDER_PRESETS))
        self.assertEqual([info["id"] for info in payload["providers"] if info["available"]], ["deepseek", "opencode"])
        self.assertTrue(all(info["source"] == "file" for info in payload["providers"][:2]))
        self.assertEqual([info["id"] for info in payload["providers"] if info["default"]], [payload["provider"]])

    def test_broken_config_file_is_reported_not_silently_ignored(self):
        provider_store.config_path().write_text("{ 坏掉的 JSON", encoding="utf-8")
        entries, problem = provider_store.load()
        self.assertEqual(entries, {})
        self.assertIsNotNone(problem)
        self.assertFalse(provider_store.describe_all()[0]["available"])

    def test_cli_reads_the_key_from_stdin(self):
        import io
        import sys

        original = sys.stdin
        sys.stdin = io.StringIO("sk-from-stdin\n")
        try:
            self.assertEqual(provider_store.main(["set", "opencode"]), 0)
        finally:
            sys.stdin = original
        self.assertEqual(provider_store.load()[0]["opencode"]["apiKey"], "sk-from-stdin")
        self.assertEqual(provider_store.main(["remove", "opencode"]), 0)
        self.assertEqual(provider_store.load()[0], {})

    def test_cli_rejects_unknown_provider(self):
        self.assertEqual(provider_store.main(["set", "nope"]), 2)

    def test_provider_error_detail_is_readable_and_sanitized(self):
        """'provider HTTP 503' 太吃亏：换个模型就好、和上游真的挂了，是两件事。"""
        def http_error(body: bytes, code: int = 503):
            return urllib.error.HTTPError("https://example.invalid/v1/chat/completions", code, "err", {}, io.BytesIO(body))

        self.assertEqual(
            agent_gateway.provider_error_detail(http_error(b'{"error":{"message":"Upstream request failed: Model is unavailable."}}')),
            "Upstream request failed: Model is unavailable.",
        )
        self.assertEqual(agent_gateway.provider_error_detail(http_error(b'{"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}')), "Invalid API key.")
        self.assertEqual(agent_gateway.provider_error_detail(http_error(b"<html>not json</html>")), "")
        masked = agent_gateway.provider_error_detail(http_error(b'{"error":{"message":"bad key oc_sk_fake_fixture_123456789"}}'))
        self.assertNotIn("fake_fixture", masked)
        self.assertIn("bad key", masked)

    def test_concurrent_writes_preserve_other_providers(self):
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda name: provider_store.set_provider(name, api_key=f"fake-{name}-credential"), provider_store.PROVIDER_PRESETS))
        entries, problem = provider_store.load()
        self.assertIsNone(problem)
        self.assertEqual(set(entries), set(provider_store.PROVIDER_PRESETS))
        self.assertFalse(list(Path(self.tmp.name).glob(".providers-*.tmp")))

    def test_url_validation_allows_only_tls_or_exact_loopback(self):
        for url in ("https://example.invalid/v1", "http://localhost:1234/v1", "http://127.0.0.2:1234/v1", "http://[::1]:1234/v1"):
            self.assertEqual(provider_store.validate_base_url(url + "/"), url)
        for url in ("http://localhost.evil.invalid/v1", "http://127.0.0.1.evil.invalid", "http://192.168.1.1/v1", "file:///tmp/key", "https://user:password@example.invalid", "https://example.invalid?key=fake", "https://example.invalid/#fake", "https://example.invalid:0", "https://example.invalid:99999", "not-a-url"):
            with self.subTest(url=url), self.assertRaises(provider_store.ProviderStoreError):
                provider_store.validate_base_url(url)

    def test_byok_http_round_trip_retains_blank_key_and_env_priority(self):
        with TestClient(server.create_app()) as client:
            headers = {"X-Sciviz-Agent-Token": client.get("/agent/config").json()["token"]}
            secret = "FAKE_GEMINI_CREDENTIAL_12345678"
            save = client.post("/agent/providers", headers=headers, json={"action": "save", "provider": "gemini", "apiKey": secret, "model": "fake-gemini-model"})
            self.assertEqual(save.status_code, 200, save.text)
            self.assertNotIn(secret, save.text)
            self.assertNotIn("apiKeyTail", save.text)
            self.assertTrue(save.json()["config"]["providerManagement"])
            changed = client.post("/agent/providers", headers=headers, json={"action": "save", "provider": "gemini", "apiKey": "", "model": "fake-other-model"})
            self.assertEqual(changed.status_code, 200)
            self.assertEqual(provider_store.resolve("gemini", use_global_env=False)["apiKey"], secret)
            os.environ["GEMINI_API_KEY"] = "FAKE_ENV_CREDENTIAL"
            removed = client.post("/agent/providers", headers=headers, json={"action": "remove", "provider": "gemini"})
            self.assertEqual(removed.status_code, 200)
            info = next(entry for entry in removed.json()["config"]["providers"] if entry["id"] == "gemini")
            self.assertTrue(info["available"])
            self.assertFalse(info["hasLocalConfig"])
            self.assertEqual(info["source"], "env")

    def test_byok_rejected_inputs_never_modify_credentials(self):
        with TestClient(server.create_app()) as client:
            headers = {"X-Sciviz-Agent-Token": client.get("/agent/config").json()["token"]}
            body = {"action": "save", "provider": "openai", "apiKey": "FAKE_INPUT_CREDENTIAL"}
            self.assertEqual(client.post("/agent/providers", json=body).status_code, 403)
            self.assertEqual(client.post("/agent/providers", headers={**headers, "Origin": "https://evil.invalid"}, json=body).status_code, 403)
            self.assertEqual(client.post("/agent/providers", headers={**headers, "Content-Type": "text/plain"}, content=json.dumps(body)).status_code, 415)
            for invalid in ([], {**body, "provider": "nope"}, {**body, "apiKey": 10}, {**body, "apiKey": "fake\nkey"}, {**body, "apiKey": "x" * 8193}, {**body, "model": "x" * 121}, {**body, "baseUrl": "http://localhost.evil.invalid"}, {**body, "extra": True}, {**body, "action": "remove"}, {**body, "provider": "opencode", "model": "other"}):
                with self.subTest(invalid_type=type(invalid).__name__):
                    response = client.post("/agent/providers", headers=headers, json=invalid)
                    self.assertEqual(response.status_code, 400, response.text)
                    self.assertNotIn("FAKE_INPUT_CREDENTIAL", response.text)
            self.assertEqual(client.post("/agent/providers", headers={**headers, "Content-Type": "application/json"}, content="{").status_code, 400)
            self.assertEqual(client.post("/agent/providers", headers=headers, json={**body, "apiKey": "x" * 17000}).status_code, 400)
            self.assertFalse(provider_store.config_path().exists())

    def test_reconfiguration_invalidates_model_health_and_cache(self):
        gateway = agent_gateway.AgentGateway()
        gateway._models_cache = (100, "openai", ["old"])
        gateway._failed_models = {"openai": {"old": "Model is unavailable"}, "deepseek": {"other": "Model is unavailable"}}
        gateway.configure_provider({"action": "save", "provider": "openai", "apiKey": "fake-key"})
        self.assertIsNone(gateway._models_cache)
        self.assertEqual(gateway.model_health("openai"), [])
        self.assertEqual(len(gateway.model_health("deepseek")), 1)

    def test_model_unavailable_gets_a_next_step(self):
        """只报 "provider HTTP 503" 时，人会去重启宿主、查代理 —— 而实际只需要换个模型。

        判据全部来自实测的 provider 正文（OpenCode Zen）：503 Endpoint is unavailable、
        400 Model is unavailable、403 FreeTierError。这里不认的措辞一律不猜。
        """
        for message in (
            "Upstream request failed: Endpoint is unavailable.",
            "Upstream request failed: Model is unavailable.",
            "OpenCode's free tier can only be used from within OpenCode",
        ):
            self.assertTrue(agent_gateway.is_model_unavailable(message), message)
            self.assertIn("换一个模型", agent_gateway.provider_failure_hint(message))
        for message in ("Invalid API key.", "rate limit exceeded", ""):
            self.assertFalse(agent_gateway.is_model_unavailable(message), message)
            self.assertEqual(agent_gateway.provider_failure_hint(message), "")
    def test_permission_tightening_knows_whether_it_is_inside_a_workspace(self):
        """开发模式的状态目录在仓库里（多账户共用），收紧权限的规则与安装版不同。

        去掉继承只对安装版（`%LOCALAPPDATA%`）做：仓库里那样做的结果是留下一个
        只有写入者能删的文件 —— 实测踩过，别的账户连 takeown 都不够。
        """
        old = os.environ.get("SCIVIZ_WORKSPACE_ROOT")
        try:
            os.environ["SCIVIZ_WORKSPACE_ROOT"] = self.tmp.name
            inside = Path(self.tmp.name) / ".sciviz-state" / "agent-providers.json"
            outside = Path(tempfile.gettempdir()) / "sciviz-elsewhere" / "agent-providers.json"
            self.assertTrue(provider_store._inside_workspace(inside))
            self.assertFalse(provider_store._inside_workspace(outside))
            os.environ.pop("SCIVIZ_WORKSPACE_ROOT", None)
            self.assertFalse(provider_store._inside_workspace(inside), "没配工作区时按安装版处理（收紧）")
        finally:
            if old is None:
                os.environ.pop("SCIVIZ_WORKSPACE_ROOT", None)
            else:
                os.environ["SCIVIZ_WORKSPACE_ROOT"] = old


if __name__ == "__main__":
    unittest.main()
