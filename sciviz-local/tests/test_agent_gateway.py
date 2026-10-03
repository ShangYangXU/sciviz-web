import json
import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from sciviz_host import server, providers
from sciviz_host.agent_gateway import AgentGateway, AgentGatewayError


class AgentGatewayTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.old_state = os.environ.get("SCIVIZ_STATE_DIR")
        self.old_provider = os.environ.get("SCIVIZ_AGENT_PROVIDER")
        self.old_model = os.environ.get("SCIVIZ_AGENT_MODEL")
        self.old_url = os.environ.get("SCIVIZ_AGENT_BASE_URL")
        self.old_deepseek_key = os.environ.get("DEEPSEEK_API_KEY")
        self.old_opencode_key = os.environ.get("OPENCODE_API_KEY")
        self.old_opencode_go_key = os.environ.get("OPENCODE_GO_API_KEY")
        extra_keys = ({key for preset in providers.PROVIDER_PRESETS.values() for key in preset["envKeys"]} - {"DEEPSEEK_API_KEY", "OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"}) | {"SCIVIZ_AGENT_API_KEY"}
        self.saved_extra_keys = {key: os.environ.get(key) for key in extra_keys}
        for key in extra_keys | {"DEEPSEEK_API_KEY", "OPENCODE_API_KEY", "OPENCODE_GO_API_KEY"}:
            os.environ.pop(key, None)
        os.environ["SCIVIZ_STATE_DIR"] = self.tmp.name
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "mock"
        os.environ["SCIVIZ_AGENT_MODEL"] = "mock-model"
        os.environ.pop("SCIVIZ_AGENT_BASE_URL", None)
        self.client = TestClient(server.create_app())
        self.client.__enter__()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        for key, value in (("SCIVIZ_STATE_DIR", self.old_state), ("SCIVIZ_AGENT_PROVIDER", self.old_provider), ("SCIVIZ_AGENT_MODEL", self.old_model), ("SCIVIZ_AGENT_BASE_URL", self.old_url), ("DEEPSEEK_API_KEY", self.old_deepseek_key), ("OPENCODE_API_KEY", self.old_opencode_key), ("OPENCODE_GO_API_KEY", self.old_opencode_go_key)):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        self.tmp.cleanup()
        for key, value in self.saved_extra_keys.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def token(self):
        return self.client.get("/agent/config").json()["token"]

    def test_config_and_mock_stream_are_token_gated(self):
        config = self.client.get("/agent/config")
        self.assertTrue(config.json()["configured"])
        denied = self.client.post("/agent/exec", json={"tool": "doctor", "args": {}})
        self.assertEqual(denied.status_code, 403)
        response = self.client.post("/agent/chat", headers={"X-Sciviz-Agent-Token": self.token()}, json={"messages": [], "tools": []})
        self.assertEqual(response.status_code, 200)
        self.assertIn('"type": "done"', response.text)

    def test_mock_provider_emits_one_real_patch_tool_call(self):
        """假 provider 的一句触发词能换来一条**真的**图补丁（e2e 的"AI 改块"用它）。

        基线必须是从上下文里读出来的那一个 —— 编一个只会换回"基线不符"，
        而那条路径恰恰是这次要防的"看着在跑、其实什么都没落"。
        """
        gateway = AgentGateway()
        fingerprint = "sha256:" + "0" * 64
        asked = [
            {"role": "system", "content": f'<上下文>{{"project":{{"editFingerprint":"{fingerprint}"}}}}</上下文>'},
            {"role": "user", "content": "帮我加一个块（假 provider 改图验收）"},
        ]
        events = asyncio.run(_collect(gateway.stream_chat({"requestId": "r0", "messages": asked, "tools": []})))
        self.assertEqual([event["type"] for event in events], ["text_delta", "tool_call", "done"])
        arguments = events[1]["arguments"]["patch"]
        self.assertEqual(arguments["baseFingerprint"], fingerprint)
        self.assertEqual(arguments["ops"][0]["op"], "addNode")

        # 同一轮里已经有工具结果时不许再提 —— 否则工具循环会一直提同一条直到撞上限
        already = [*asked, {"role": "tool", "content": "{}", "tool_call_id": "mock-patch-1"}]
        again = asyncio.run(_collect(gateway.stream_chat({"requestId": "r1", "messages": already, "tools": []})))
        self.assertEqual([event["type"] for event in again], ["text_delta", "done"])

        # 没有触发词时还是原来那句，别的 e2e 用例不靠猜
        plain = asyncio.run(_collect(gateway.stream_chat({"requestId": "r2", "messages": [{"role": "user", "content": "你好"}], "tools": []})))
        self.assertIn("本地假 provider", plain[0]["text"])

    def test_openai_stream_adapter_preserves_text_and_tool_calls(self):
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "deepseek"
        os.environ["DEEPSEEK_API_KEY"] = "secret"
        os.environ["SCIVIZ_AGENT_MODEL"] = "deepseek-chat"
        gateway = AgentGateway()
        gateway._stream_openai = lambda cfg, body: iter([
            {"type": "text_delta", "text": "先查一下。"},
            {"type": "tool_call", "callId": "call-1", "name": "catalog", "arguments": {}},
        ])
        events = asyncio.run(_collect(gateway.stream_chat({"requestId": "r1", "messages": [], "tools": []})))
        self.assertEqual([event["type"] for event in events], ["text_delta", "tool_call", "done"])
        self.assertEqual(events[1]["callId"], "call-1")

    def test_request_model_overrides_host_default(self):
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "deepseek"
        os.environ["DEEPSEEK_API_KEY"] = "secret"
        os.environ["SCIVIZ_AGENT_MODEL"] = "deepseek-chat"
        gateway = AgentGateway()
        selected = {}

        def fake_stream(cfg, _body):
            selected["model"] = cfg.model
            return iter([{"type": "text_delta", "text": "ok"}])

        gateway._stream_openai = fake_stream
        events = asyncio.run(_collect(gateway.stream_chat({"model": "deepseek-reasoner", "messages": [], "tools": []})))
        self.assertEqual(selected["model"], "deepseek-reasoner")
        self.assertEqual(events[-1]["type"], "done")

    def test_unavailable_model_is_reported_back_to_the_picker(self):
        """模型级失败要能被下一次 `/agent/models` 带回去，界面才标得出"这个别选"。

        只记这一类：鉴权、限流、网络不是模型的属性，记错了会让人换掉一个本来能用的模型。
        """
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "deepseek"
        os.environ["DEEPSEEK_API_KEY"] = "secret"
        os.environ["SCIVIZ_AGENT_MODEL"] = "deepseek-chat"
        gateway = AgentGateway()

        def unavailable(_cfg, _body):
            raise AgentGatewayError(
                "E_CHAT_PROVIDER_FAILED",
                "provider HTTP 503：Upstream request failed: Endpoint is unavailable.（换一个模型再试）",
            )

        def unauthorized(_cfg, _body):
            raise AgentGatewayError("E_CHAT_PROVIDER_FAILED", "provider HTTP 401：Invalid API key.")

        gateway._stream_openai = unavailable
        with self.assertRaises(AgentGatewayError):
            asyncio.run(_collect(gateway.stream_chat({"model": "claude-sonnet-4-5", "messages": [], "tools": []})))
        self.assertEqual([entry["model"] for entry in gateway.model_health("deepseek")], ["claude-sonnet-4-5"])

        gateway._stream_openai = unauthorized
        with self.assertRaises(AgentGatewayError):
            asyncio.run(_collect(gateway.stream_chat({"model": "deepseek-flash", "messages": [], "tools": []})))
        self.assertEqual(
            [entry["model"] for entry in gateway.model_health("deepseek")],
            ["claude-sonnet-4-5"],
            "鉴权失败不是模型的属性，不许被记成'这个模型不能用'",
        )

    def test_models_endpoint_carries_the_unavailable_list(self):
        response = self.client.get("/agent/models", headers={"X-Sciviz-Agent-Token": self.token()})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["models"], ["mock-model"])
        self.assertEqual(body["unavailable"], [])
    def test_openai_sse_parser_reads_incremental_content(self):
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "deepseek"
        os.environ["DEEPSEEK_API_KEY"] = "secret"
        os.environ["SCIVIZ_AGENT_MODEL"] = "deepseek-chat"
        gateway = AgentGateway()

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                return iter([
                    b'data: {"choices":[{"delta":{"content":"hi"}}]}\n',
                    b'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"catalog","arguments":"{}"}}]}}]}\n',
                    b'data: [DONE]\n',
                ])

        with patch("sciviz_host.agent_gateway.urllib.request.urlopen", return_value=Response()):
            events = list(gateway._stream_openai(gateway._provider_config(), {"messages": [], "tools": []}))
        self.assertEqual(events[0], {"type": "text_delta", "text": "hi"})
        self.assertEqual(events[1]["type"], "tool_call")
        self.assertEqual(events[1]["arguments"], {})

    def test_opencode_chat_requests_keep_the_conversation_session_header(self):
        os.environ["OPENCODE_GO_API_KEY"] = "secret"
        gateway = AgentGateway()
        cfg = gateway._provider_config("opencode")
        requests = []

        class Response:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                return iter([b"data: [DONE]\n"])

            def read(self):
                return b'{"choices":[{"message":{"content":"ok"}}]}'

        def fake_urlopen(request, timeout):
            requests.append(request)
            return Response()

        with patch("sciviz_host.opencode_go._open", side_effect=lambda request: fake_urlopen(request, 120)):
            for request_id, session_id in (("r1", "s-one"), ("r2", "s-one"), ("r3", "s-two")):
                asyncio.run(_collect(gateway.stream_chat({"provider": "opencode", "requestId": request_id, "sessionId": session_id, "messages": [{"role": "tool", "content": "中文工具结果"}], "tools": []})))

        self.assertEqual(
            [request.get_header("X-opencode-session") for request in requests],
            ["s-one", "s-one", "s-two"],
        )
        self.assertTrue(all(request.get_header("Authorization") == "Bearer secret" for request in requests))
        self.assertTrue(all("中文工具结果".encode("utf-8") in request.data for request in requests))

        for session_id in (None, "", "bad\nheader"):
            with self.assertRaises(AgentGatewayError) as caught:
                asyncio.run(_collect(gateway.stream_chat({"provider": "opencode", "sessionId": session_id, "messages": [], "tools": []})))
            self.assertEqual(caught.exception.code, "E_PARAM_INVALID")

        os.environ["DEEPSEEK_API_KEY"] = "secret"
        other_cfg = gateway._provider_config("deepseek")
        with patch("sciviz_host.agent_gateway.urllib.request.urlopen", side_effect=fake_urlopen):
            list(gateway._stream_openai(other_cfg, {"messages": [], "tools": []}))
        self.assertIsNone(requests[-1].get_header("X-opencode-session"))

    def test_byok_routes_each_service_with_its_own_credentials_and_model(self):
        for provider in providers.PROVIDER_PRESETS:
            if provider == "opencode":
                continue  # Go's dedicated transport is covered above.
            secret = f"FAKE_{provider.upper()}_CREDENTIAL"
            providers.set_provider(provider, api_key=secret, base_url="https://example.invalid/v1", model=f"fake-{provider}-model")
        captured = []
        gateway = AgentGateway()
        def fake_stream(cfg, _body):
            captured.append((cfg.provider, cfg.api_key, cfg.model, cfg.base_url))
            return iter([{"type": "text_delta", "text": "ok"}])
        gateway._stream_openai = fake_stream
        for provider in providers.PROVIDER_PRESETS:
            if provider != "opencode":
                events = asyncio.run(_collect(gateway.stream_chat({"provider": provider, "messages": []})))
                self.assertEqual(events[-1]["type"], "done")
                self.assertEqual(captured[-1], (provider, f"FAKE_{provider.upper()}_CREDENTIAL", f"fake-{provider}-model", "https://example.invalid/v1"))

    def test_provider_failures_hide_arbitrary_key_before_truncation(self):
        import io
        import urllib.error
        secret = "FAKE_ARBITRARY_CREDENTIAL_WITHOUT_SK_PREFIX_" + "X" * 240
        providers.set_provider("openai", api_key=secret, model="fake-model")
        error = urllib.error.HTTPError("https://example.invalid", 401, "auth", {}, io.BytesIO(json.dumps({"error": {"message": "Invalid credential " + secret}}).encode()))
        with patch("sciviz_host.agent_gateway.urllib.request.urlopen", side_effect=error):
            response = self.client.post("/agent/chat", headers={"X-Sciviz-Agent-Token": self.token()}, json={"provider": "openai", "messages": []})
        self.assertNotIn(secret[:30], response.text)
        self.assertIn("E_CHAT_PROVIDER_FAILED", response.text)
        gateway = AgentGateway()
        gateway._fetch_models = lambda _cfg: (_ for _ in ()).throw(RuntimeError("Invalid credential " + secret))
        with self.assertRaises(AgentGatewayError) as caught:
            asyncio.run(gateway.discover_models("openai"))
        self.assertNotIn(secret[:30], str(caught.exception))

    def test_session_expected_sequence_and_read(self):
        token = self.token()
        headers = {"X-Sciviz-Agent-Token": token}
        created = self.client.post("/agent/session", headers=headers, json={"action": "create", "projectId": "p1", "sessionId": "s1"})
        self.assertEqual(created.status_code, 200)
        event = {"schemaVersion": 1, "seq": 1, "at": "now", "projectId": "p1", "sessionId": "s1", "turnId": "t1", "type": "user", "payload": {"text": "hi"}}
        appended = self.client.post("/agent/session", headers=headers, json={"action": "append", "projectId": "p1", "sessionId": "s1", "expectedSeq": 0, "events": [event]})
        self.assertEqual(appended.json()["seq"], 1)
        conflict = self.client.post("/agent/session", headers=headers, json={"action": "append", "projectId": "p1", "sessionId": "s1", "expectedSeq": 0, "events": [event]})
        self.assertEqual(conflict.status_code, 409)
        read = self.client.post("/agent/session", headers=headers, json={"action": "read", "projectId": "p1", "sessionId": "s1"})
        self.assertEqual(read.json()["events"][0]["payload"]["text"], "hi")

    def test_provider_presets_and_model_discovery(self):
        os.environ.pop("SCIVIZ_AGENT_PROVIDER", None)
        os.environ["DEEPSEEK_API_KEY"] = "secret"
        gateway = AgentGateway()
        config = gateway.config()
        self.assertEqual(config["provider"], "deepseek")
        self.assertTrue(config["apiKeyConfigured"])
        self.assertNotIn("secret", json.dumps(config))
        gateway._fetch_models = lambda cfg: ["deepseek-chat", "deepseek-reasoner"]
        self.assertEqual(asyncio.run(gateway.discover_models()), ["deepseek-chat", "deepseek-reasoner"])
        os.environ.pop("DEEPSEEK_API_KEY", None)
        os.environ["OPENCODE_GO_API_KEY"] = "secret"
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "auto"
        self.assertEqual(AgentGateway().config()["provider"], "opencode")
        os.environ.pop("OPENCODE_GO_API_KEY", None)

    def test_loopback_provider_does_not_require_a_key(self):
        os.environ["SCIVIZ_AGENT_PROVIDER"] = "local"
        os.environ["SCIVIZ_AGENT_BASE_URL"] = "http://127.0.0.1:9001/v1"
        os.environ.pop("SCIVIZ_AGENT_MODEL", None)
        config = AgentGateway().config()
        self.assertTrue(config["configured"])
        self.assertTrue(config["local"])
        self.assertTrue(config["modelDiscovery"])

async def _collect(stream):
    return [item async for item in stream]


if __name__ == "__main__":
    unittest.main()
