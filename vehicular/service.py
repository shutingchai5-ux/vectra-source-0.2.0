"""LangGraph coordination with deterministic security, real MPC and signed reports."""
import copy
import hashlib
import json
import threading
import time
import uuid
from typing import TypedDict

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from langgraph.graph import END, START, StateGraph

from .agents import (AgentError, ToolAgent, COORDINATOR_PROMPT, ANALYST_PROMPT, tool_schema, validate_analysis)
from .mpc import MpcError, MpcRunner, initialize_samples
from .security import AuditLog, SecurityError, SecurityStore, canonical_bytes, secure_write
from .storage import TaskStore
from .transport import RsuGateway, PARTICIPANTS, authorize_task


class FlowState(TypedDict, total=False):
    task_id: str
    summary: str


class CollaborationService:
    def __init__(self, settings, llm_transport=None):
        settings.validate()
        self.settings = settings
        self.root = settings.data_dir
        self.root.mkdir(parents=True, exist_ok=True)
        self.security = SecurityStore(self.root)
        self.security.provision()
        initialize_samples(self.root)
        self.audit = AuditLog(self.root / "audit.sqlite3", self.security)
        self.tasks = TaskStore(self.root / "tasks.sqlite3")
        self.gateway = RsuGateway(self.root, self.security, self.audit)
        self.mpc = MpcRunner(self.root)
        self.agent = ToolAgent(settings, llm_transport)
        self.session = str(uuid.uuid4())
        self.sequence, self.message_lock = 0, threading.Lock()
        self.execution_lock = threading.Lock()
        self.storage_key_path = self.root / "reports/storage.key"
        self.storage_key_path.parent.mkdir(exist_ok=True)
        if not self.storage_key_path.exists():
            self.storage_key_path.write_bytes(AESGCM.generate_key(bit_length=256))
        self.report_storage_key = self.storage_key_path.read_bytes()
        graph = StateGraph(FlowState)
        graph.add_node("coordinate", self.coordinate)
        graph.add_node("publish", self.publish)
        graph.add_edge(START, "coordinate")
        graph.add_edge("coordinate", "publish")
        graph.add_edge("publish", END)
        self.graph = graph.compile()
        self.audit.append("service_started", {"mode": settings.mode, "protocol": "MPyC", "participants": PARTICIPANTS})

    def close(self):
        self.gateway.close()

    def signed_task(self, task_id, request_id, **overrides):
        now = time.time()
        task = {"task_id": task_id, "request_id": request_id, "sender": "coordinator", "recipient": "coordinator",
                "purpose": "traffic_statistics", "metric": "mean_speed", "road": "S101", "window_seconds": 60,
                "participants": PARTICIPANTS, "issued_at": now, "expires_at": now + 100}
        task.update(overrides)
        return self.security.sign("coordinator", task)

    def message(self, signed_task, **overrides):
        with self.message_lock:
            self.sequence += 1
            sequence = self.sequence
        now = time.time()
        payload = {"sender": "coordinator", "recipient": "rsu", "purpose": "traffic_statistics", "message_type": "task",
                   "task_id": signed_task["payload"]["task_id"], "request_id": signed_task["payload"]["request_id"],
                   "session_id": self.session, "sequence": sequence, "timestamp": now, "expires_at": now + 100, "task": signed_task}
        payload.update(overrides)
        return self.security.sign("coordinator", payload)

    def compute(self, task_id, road="S101", window_seconds=60):
        task = self.tasks.get(task_id)
        if task.get("result"):
            return task["result"]
        signed = self.signed_task(task_id, task["request_id"], road=road, window_seconds=window_seconds)
        authorize_task(signed["payload"])
        self.tasks.reserve_query("local-user", self.settings.query_cooldown)
        accepted = self.gateway.send(self.message(signed))
        if not accepted.get("accepted"):
            raise SecurityError(accepted["code"], accepted["message"])
        self.tasks.step(task_id, "安全执行层", "认证与授权", "mTLS 身份、Ed25519 签名、任务范围与新鲜性校验通过")
        self.tasks.step(task_id, "隐私计算模块", "三方协议", "三个独立进程通过 mTLS 交换秘密份额；等待批准的聚合输出", "running")
        result = self.mpc.run(signed, timeout=self.settings.mpc_timeout)
        current = self.tasks.get(task_id)
        for step in current["steps"]:
            if step["agent"] == "隐私计算模块" and step["status"] == "running":
                step["status"] = "completed"
                step["detail"] = "三方 mTLS 秘密分享计算完成，已获得批准的均值输出"
        self.tasks.update(task_id, steps=current["steps"])
        result["mean_speed_kmh"] = result["average_speed"]
        result["count"] = result["participant_count"]
        mean = result["average_speed"]
        result["traffic_state"] = "低速" if mean < 30 else "平稳" if mean < 60 else "较快"
        result["rule_version"] = "classroom-v1: <30低速; 30–<60平稳; >=60较快（非真实拥堵判定）"
        self.tasks.update(task_id, result=result)
        event = self.audit.append("statistics_completed", {"task_id": task_id, "mean_speed_kmh": mean, "count": 3,
                                                        "elapsed_ms": result["elapsed_ms"]}, "coordinator", "coordinator")
        self.tasks.step(task_id, "车辆节点 × 3", "联合统计完成", f"仅公开均值 {mean} km/h；证据 {event['id']}")
        return result

    def public_nodes(self):
        return [{"id": n["id"], "role": n["role"], "enabled": n["enabled"],
                 "certificate_fingerprint": n["cert_fingerprint"], "expires_at": n["valid_until"]} for n in self.security.identities()]

    def investigate(self, task_id):
        observed = []

        def query_events():
            # Audit contains public, allowlisted metadata only, never node inputs/shares.
            events = self.audit.list(limit=30)
            observed.extend(events)
            return {"events": events, "scope": "最近30条公开安全事件摘要"}

        if self.settings.mode == "demo":
            events = query_events()["events"]
            rejects = [e for e in events if e["kind"] == "request_rejected" or e["kind"] == "experiment_completed"]
            analysis = {"facts": [f"检索到 {len(events)} 条事件，其中 {len(rejects)} 条涉及拒绝或验证实验。", "密码验证和任务授权由确定性执行层处理。"],
                        "possible_causes": ["请求重复、签名内容变化或参数超出白名单可能导致拒绝；具体原因应与事件 code 对照。"],
                        "recommendations": ["检查失败层、已验证身份和任务绑定，先保存证据，再决定是否调整配置。"],
                        "uncertainties": ["演示模式采用固定模板；日志不能单独证明恶意来源、传感器真实性或不存在其他泄露。"],
                        "evidence_ids": [e["id"] for e in (rejects or events)[:6]]}
        else:
            text = self.agent.run(ANALYST_PROMPT, "查询最近的身份、签名、权限和计算状态事件，说明确认事实、可能原因和不确定性。",
                [tool_schema("query_events", "读取最近30条经过过滤的公开审计事件"), tool_schema("identity_status", "查询已登记节点的公开身份状态")],
                {"query_events": query_events, "identity_status": self.public_nodes},
                lambda action, status, detail: self.tasks.step(task_id, "信息安全分析 Agent", action, detail, status))
            if not observed:
                raise AgentError("分析 Agent 未查询事件，不能发布结论。")
            analysis = validate_analysis(text, [e["id"] for e in observed])
        self.tasks.update(task_id, analysis=analysis)
        self.tasks.step(task_id, "信息安全分析 Agent" if self.settings.mode == "llm" else "模板分析器", "证据调查", f"引用 {len(analysis['evidence_ids'])} 条实际事件；区分事实与推断")
        return analysis

    def latest_report(self):
        return next((t["report"] for t in self.tasks.list() if t.get("report")), None)

    def verify_report(self, envelope):
        try:
            payload = self.security.verify(envelope, expected_signer="report")
            required = {"task_id", "request_id", "request_digest", "recipient", "generated_at", "report_type"}
            if not required <= payload.keys() or payload["recipient"] != "local-user" or payload["report_type"] != "traffic-collaboration-v1":
                raise SecurityError("report_context", "报告上下文不符合预期。")
            task = self.tasks.get(payload["task_id"])
            if not task or payload["request_id"] != task["request_id"] or payload["request_digest"] != hashlib.sha256(task["request"].encode()).hexdigest():
                raise SecurityError("task_binding", "报告与登记任务不匹配。")
            return {"valid": True, "reason": "已登记签署者、Ed25519 签名与任务绑定均验证通过。", "task_id": payload["task_id"], "signer": "report"}
        except (SecurityError, TypeError, ValueError, KeyError) as exc:
            return {"valid": False, "reason": str(exc) if isinstance(exc, SecurityError) else "报告格式无效。", "code": getattr(exc, "code", "invalid_report")}

    def coordinate(self, state):
        task_id = state["task_id"]
        task = self.tasks.get(task_id)
        request = task["request"]
        if self.settings.mode == "llm":
            def verify_latest_report():
                report = self.latest_report()
                if not report:
                    raise SecurityError("report_missing", "尚无可验证报告。")
                outcome = self.verify_report(report)
                self.tasks.update(task_id, verification=outcome)
                return outcome

            summary = self.agent.run(COORDINATOR_PROMPT, request,
                [tool_schema("compute_statistics", "执行批准的三车速度均值统计", {"road": {"type": "string", "enum": ["S101"]}, "window_seconds": {"type": "integer", "enum": [60]}}),
                 tool_schema("investigate", "将安全事件证据调查委托给信息安全分析 Agent"),
                 tool_schema("verify_latest_report", "验证最近签名报告的来源、完整性与任务绑定"),
                 tool_schema("identity_status", "读取已登记身份的公开状态")],
                {"compute_statistics": lambda road, window_seconds: self.compute(task_id, road, window_seconds),
                 "investigate": lambda: self.investigate(task_id), "verify_latest_report": verify_latest_report, "identity_status": self.public_nodes},
                lambda action, status, detail: self.tasks.step(task_id, "任务协调 Agent", action, detail, status))
        else:
            self.tasks.step(task_id, "模板协调器", "任务规划", "当前为离线模板演示，未调用大模型；密码与 MPC 后端真实执行")
            if any(token in request.lower() for token in ("单车", "每辆车的速度", "私钥", "private", "raw_speed", "vehicle-a的速度")):
                raise SecurityError("unauthorized", "拒绝读取单车私有速度或密钥；仅允许固定三方均值。")
            if "验证" in request and "报告" in request and not any(x in request for x in ("统计", "平均", "均值")):
                report = self.latest_report()
                if not report:
                    raise SecurityError("report_missing", "尚无可验证报告，请先完成统计任务。")
                outcome = self.verify_report(report)
                self.tasks.update(task_id, verification=outcome)
                summary = outcome["reason"]
            elif any(token in request for token in ("统计", "平均", "均值", "交通")):
                result = self.compute(task_id, task["road"], task["window_seconds"])
                self.investigate(task_id)
                summary = f"S101 固定三方均值为 {result['average_speed']} km/h，课堂规则提示为“{result['traffic_state']}”。普通接口与模型只接收聚合结果。"
            elif any(token in request for token in ("调查", "告警", "事件", "异常", "为什么", "证据")):
                self.investigate(task_id)
                summary = "已检索实际审计事件，形成确认事实、可能原因、建议和不确定性。"
            else:
                raise SecurityError("unsupported_request", "离线入口支持均值统计、事件调查与报告验证；其他自然语言任务请配置 LLM 模式。")
        return {"summary": summary}

    def publish(self, state):
        task = self.tasks.get(state["task_id"])
        requested = task["request"].lower()
        if any(word in requested for word in ("统计", "平均", "均值", "average", "mean", "statistics")) and not task.get("result"):
            raise AgentError("任务要求统计，但 Agent 未完成真实联合计算，不能发布统计报告。")
        if any(word in requested for word in ("调查", "事件", "告警", "investigate", "evidence")) and not task.get("analysis"):
            raise AgentError("任务要求事件调查，但 Agent 未查询并引用真实证据，不能发布调查报告。")
        payload = {"report_type": "traffic-collaboration-v1", "task_id": task["id"], "request_id": task["request_id"],
                   "request_digest": hashlib.sha256(task["request"].encode()).hexdigest(), "recipient": "local-user", "generated_at": time.time(),
                   "mode": self.settings.mode, "summary": state["summary"], "explanation_source": "LLM interpretation, not a cryptographic fact" if self.settings.mode == "llm" else "offline template",
                   "result": task.get("result"), "analysis": task.get("analysis"),
                   "verification": task.get("verification"),
                   "security_model": "MPyC三方、阈值1、最多一方被动腐化；信任本地CA/注册表与宿主机；公开均值仍有推断风险"}
        report = self.security.sign("report", payload)
        secure_write(self.root / f"reports/{task['id']}.enc", self.report_storage_key, report)
        self.tasks.update(task["id"], status="completed", summary=state["summary"], report=report)
        self.audit.append("report_signed", {"task_id": task["id"], "report_digest": hashlib.sha256(canonical_bytes(payload)).hexdigest()}, "report", "report")
        self.tasks.step(task["id"], "报告服务", "签名与保存", "报告已使用 Ed25519 签名，并以 AES-GCM 保存对象；可下载独立核验")
        return {}

    def execute(self, task_id):
        with self.execution_lock:
            self.tasks.update(task_id, status="running")
            try:
                self.graph.invoke({"task_id": task_id})
            except (SecurityError, MpcError, AgentError) as exc:
                current = self.tasks.get(task_id)
                for step in current["steps"]:
                    if step["status"] == "running":
                        step["status"] = "failed"
                self.tasks.update(task_id, steps=current["steps"])
                self.tasks.update(task_id, status="failed", error={"code": exc.code, "message": str(exc)})
                self.tasks.step(task_id, "安全执行层", "任务终止", str(exc), "failed")
                self.audit.append("task_failed", {"task_id": task_id, "code": exc.code, "reason": str(exc)})
            except Exception:
                self.tasks.update(task_id, status="failed", error={"code": "internal_error", "message": "任务执行失败，未发布统计报告。请检查服务诊断。"})
                self.audit.append("task_failed", {"task_id": task_id, "code": "internal_error"})
                # The exception is surfaced to the developer terminal, without private node data.
                import traceback
                traceback.print_exc()

    def experiment(self, scenario):
        identifier = "experiment-" + str(uuid.uuid4())
        signed = self.signed_task(identifier, identifier)
        layer, code, message, blocked, extra = "", "", "", False, {}
        if scenario in {"tamper_message", "replay", "impersonation", "unauthorized"}:
            envelope = self.message(signed)
            if scenario == "tamper_message":
                envelope["payload"]["recipient"] = "attacker"
            elif scenario == "impersonation":
                envelope["signer"] = "vehicle-a"
            elif scenario == "unauthorized":
                envelope = self.message(self.signed_task(identifier, identifier, metric="raw_speed"))
            elif scenario == "replay":
                initial = self.gateway.send(envelope)
                extra["first_request_accepted"] = initial["accepted"]
            outcome = self.gateway.send(envelope)
            blocked, code, message, layer = not outcome["accepted"], outcome.get("code", "accepted"), outcome.get("message", "请求被接受"), "mTLS / RSU 应用验证"
            extra.update(outcome)
        elif scenario == "tamper_report":
            report = self.latest_report()
            if not report:
                raise SecurityError("report_missing", "先完成一个正常任务，再运行报告篡改实验。")
            modified = copy.deepcopy(report)
            modified["payload"]["summary"] += "（内容被修改）"
            outcome = self.verify_report(modified)
            blocked, code, message, layer = not outcome["valid"], outcome.get("code", "valid"), outcome["reason"], "报告 Ed25519 验签"
        elif scenario == "dropout":
            try:
                self.mpc.run(signed, timeout=min(self.settings.mpc_timeout, 5), offline_party="vehicle-c")
                code, message, layer = "unexpected_success", "缺席参与方时协议不应完成。", "三方 MPC"
            except MpcError as exc:
                blocked, code, message, layer = True, exc.code, str(exc), "MPC 超时与失败处理"
        elif scenario == "ciphertext":
            from .security import encrypt_object, decrypt_object
            key = AESGCM.generate_key(bit_length=256)
            # An isolated object avoids touching live private inputs.
            encrypted = encrypt_object({"public_demo": "protected-object"}, key)
            try:
                damaged = copy.deepcopy(encrypted)
                # A wrong key is also an authenticated decryption failure, but mutate bytes if supported.
                if isinstance(damaged, dict) and "ciphertext" in damaged:
                    import base64
                    data = bytearray(base64.b64decode(damaged["ciphertext"]))
                    data[0] ^= 1
                    damaged["ciphertext"] = base64.b64encode(data).decode()
                    decrypt_object(damaged, key)
                else:
                    decrypt_object(damaged, AESGCM.generate_key(bit_length=256))
                code, message = "unexpected_success", "认证加密验证应拒绝修改后的对象。"
            except SecurityError as exc:
                blocked, code, message = True, exc.code, str(exc)
            layer = "AES-GCM 认证解密"
        else:
            raise SecurityError("unknown_experiment", "未知实验类型。")
        event = self.audit.append("experiment_completed", {"scenario": scenario, "blocked": blocked, "layer": layer, "code": code})
        return {"scenario": scenario, "blocked": blocked, "layer": layer, "code": code, "message": message,
                "event_id": event["id"], "details": extra}

    def state(self):
        return {"mode": self.settings.mode, "nodes": self.public_nodes(), "tasks": self.tasks.list(), "events": self.audit.list(limit=80),
                "audit": self.audit.verify(), "protocol": {"name": "MPyC 三方秘密分享", "threshold": 1, "transport": "mTLS / TLS 1.3",
                "privacy": "固定三方、至多一方被动腐化；中心仅接收均值；同机演示信任宿主机"},
                "llm": {"configured": self.settings.mode == "llm", "model": self.settings.llm_model if self.settings.mode == "llm" else None},
                "auth": {"role": "local-demo-admin"}}
