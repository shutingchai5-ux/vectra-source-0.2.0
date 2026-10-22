"""Role-specific function calling uses mocked provider responses, never a live key."""
import json
import httpx
import pytest

from vehicular.agents import AgentError, ToolAgent, ANALYST_PROMPT, COORDINATOR_PROMPT, tool_schema, validate_analysis
from vehicular.config import Settings
from vehicular.security import SecurityError


def agent(tmp_path, replies):
    observed = []
    def provider(request):
        observed.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": replies.pop(0)}]})
    settings = Settings(data_dir=tmp_path, mode="llm", llm_api_key="mock-only-key", llm_model="mock-model",
                        llm_base_url="https://mock.invalid/v1")
    return ToolAgent(settings, httpx.MockTransport(provider)), observed


def tool_call(name, arguments=None):
    return {"role": "assistant", "content": None, "tool_calls": [{"id": "call-" + name, "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments or {})}}]}


@pytest.mark.parametrize("prompt,name", [(COORDINATOR_PROMPT, "identity_status"), (ANALYST_PROMPT, "query_events")])
def test_both_agent_roles_use_only_supplied_tools_and_observations(tmp_path, prompt, name):
    runner, requests = agent(tmp_path, [tool_call(name), {"role": "assistant", "content": "观察完成"}])
    actions = []
    result = runner.run(prompt, "查询公开信息", [tool_schema(name, "公开摘要")],
                        {name: lambda: {"events": [{"id": 12, "kind": "approved"}]}},
                        lambda *values: actions.append(values))
    assert result == "观察完成"
    assert len(actions) == 1 and actions[0][0] == name and actions[0][1] == "completed"
    assert requests[0]["parallel_tool_calls"] is False
    observation = requests[1]["messages"][-1]
    assert observation["role"] == "tool" and json.loads(observation["content"])["events"][0]["id"] == 12


def test_unknown_tool_terminates_before_any_handler_executes(tmp_path):
    runner, requests = agent(tmp_path, [tool_call("read_private_speed"), {"role": "assistant", "content": "should not execute"}])
    calls = []
    with pytest.raises(SecurityError) as failure:
        runner.run(COORDINATOR_PROMPT, "查询", [tool_schema("identity_status", "公开身份")],
                   {"identity_status": lambda: calls.append(True)}, lambda *args: None)
    assert failure.value.code == "unknown_tool" and not calls and len(requests) == 1


def test_model_cannot_complete_without_any_tool_observation(tmp_path):
    runner, _ = agent(tmp_path, [{"role": "assistant", "content": "均值为40，但没有证据"}])
    with pytest.raises(AgentError):
        runner.run(COORDINATOR_PROMPT, "统计", [], {}, lambda *args: None)


def test_tool_argument_shape_and_call_budget_fail_closed(tmp_path):
    runner, _ = agent(tmp_path, [tool_call("identity_status", {"private": True})])
    with pytest.raises(AgentError):
        runner.run(COORDINATOR_PROMPT, "查询", [tool_schema("identity_status", "公开身份")],
                   {"identity_status": lambda: []}, lambda *args: None)
    replies = [tool_call("identity_status") for _ in range(3)]
    runner, requests = agent(tmp_path, replies)
    executed = []
    with pytest.raises(AgentError):
        runner.run(COORDINATOR_PROMPT, "查询", [tool_schema("identity_status", "公开身份")],
                   {"identity_status": lambda: executed.append(True)}, lambda *args: None, max_calls=2)
    assert len(executed) == 2 and len(requests) == 3


def test_provider_errors_are_generic_and_never_echo_secret_body(tmp_path):
    settings = Settings(data_dir=tmp_path, mode="llm", llm_api_key="mock-only-key", llm_model="mock-model")
    runner = ToolAgent(settings, httpx.MockTransport(lambda request: httpx.Response(401, json={"error": "secret-value"})))
    with pytest.raises(AgentError) as failure:
        runner.complete([], [])
    assert "secret-value" not in str(failure.value) and "mock-only-key" not in str(failure.value)


@pytest.mark.parametrize("base_url,option", [
    ("https://api.deepseek.com", "thinking"),
    ("https://dashscope.aliyuncs.com/compatible-mode/v1", "enable_thinking"),
    ("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "enable_thinking"),
    ("https://compatible.invalid/v1", None),
    ("https://api.openai.com/v1", "strict"),
])
def test_provider_tool_options_match_supported_protocol_without_mutating_schemas(tmp_path, base_url, option):
    observed = []
    def provider(request):
        observed.append(json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"role": "assistant", "content": "ok"}}]})
    settings = Settings(data_dir=tmp_path, llm_base_url=base_url, llm_model="mock-model", llm_api_key="mock-key")
    runner = ToolAgent(settings, httpx.MockTransport(provider))
    schema = tool_schema("identity_status", "公开身份")
    runner.complete([], [schema])
    payload = observed[0]
    assert schema["function"]["strict"] is True
    if option == "strict":
        assert payload["tools"][0]["function"]["strict"] is True
    else:
        assert "strict" not in payload["tools"][0]["function"]
    if option == "thinking":
        assert payload["thinking"] == {"type": "disabled"}
    elif option == "enable_thinking":
        assert payload["enable_thinking"] is False
    else:
        assert "thinking" not in payload and "enable_thinking" not in payload


def test_analysis_references_must_resolve_to_observed_evidence():
    data = {"facts": ["验签失败"], "possible_causes": ["内容变化"], "recommendations": ["检查请求"],
            "uncertainties": ["不能确认攻击来源"], "evidence_ids": [12]}
    assert validate_analysis(json.dumps(data), [12, 13]) == data
    for change in ({"evidence_ids": [999]}, {"evidence_ids": ["12"]}, {"evidence_ids": []},
                   {"evidence_ids": [True]}, {"facts": "无列表结构"}, {"extra": "unapproved"}):
        with pytest.raises(AgentError):
            validate_analysis(json.dumps({**data, **change}), [12, 13])
