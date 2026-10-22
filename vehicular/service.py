"""LangGraph coordination with deterministic security, real MPC and signed reports."""
import copy
import hashlib
import json
import logging
import threading
import time
import uuid
from typing import TypedDict

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from langgraph.graph import END, START, StateGraph

from .analysis import analyze_events
from .agents import (AgentError, ToolAgent, COORDINATOR_PROMPT, ANALYST_PROMPT, tool_schema, validate_analysis)
from .mpc import MpcError, MpcRunner, initialize_samples
from .model_settings import ModelSettingsError, ModelSettingsStore, public_settings, updated_settings
from .security import AuditLog, SecurityError, SecurityStore, canonical_bytes, secure_read, secure_write
from .storage import TaskStore
from .transport import RsuGateway, PARTICIPANTS, authorize_task


class FlowState(TypedDict, total=False):
    task_id: str
    summary: str


class CollaborationService:
    def __init__(self, settings, llm_transport=None):
        self.model_store = ModelSettingsStore(settings.data_dir)
        settings = self.model_store.load(settings)
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
        # Covers task admission and settings updates; execution itself holds the
        # execution lock so changing credentials never splits a running task.
        self.submission_lock = threading.RLock()
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

    def trace(self, task_id, event, agent=None):
        """Persist public progress as it happens; protocol sources name themselves."""
        event = dict(event)
        if "agent" not in event:
            event["agent"] = agent or "安全执行层"
        for field in ("sender", "recipient"):
            if event.get(field) == "agent":
                event[field] = agent or "任务协调 Agent"
            elif event.get(field) == "model":
                event[field] = "模型服务"
        if self.settings.llm_api_key and isinstance(event.get("detail"), str):
            event["detail"] = event["detail"].replace(self.settings.llm_api_key, "[凭据已隐藏]")
        return self.tasks.step(task_id, **event)

    def task_trace(self, task_id, agent=None):
        return lambda event: self.trace(task_id, event, agent)

    def traced_report_verification(self, task_id, report):
        step_id = str(uuid.uuid4())
        self.tasks.step(task_id, "报告服务", "报告验签", "正在检查已登记报告签署者、Ed25519签名与任务绑定。", "running",
                        id=step_id, kind="security", sender="报告服务", recipient="安全执行层", protocol="Ed25519")
        outcome = self.verify_report(report)
        self.tasks.update_step(task_id, step_id, status="completed" if outcome["valid"] else "failed", detail=outcome["reason"],
                               metadata={"check": "report_signature_and_task_binding", "outcome": "accepted" if outcome["valid"] else "rejected"})
        return outcome

    def model_settings(self):
        return public_settings(self.settings)

    def update_model_settings(self, body):
        with self.submission_lock:
            if not self.execution_lock.acquire(blocking=False):
                raise ModelSettingsError("任务正在执行，请等待完成后切换模式。", 409)
            try:
                if any(task["status"] in {"queued", "running"} for task in self.tasks.list()):
                    raise ModelSettingsError("任务正在排队或执行，请等待完成后切换模式。", 409)
                settings = updated_settings(self.settings, body)
                self.model_store.save(settings)
                self.settings = settings
                self.agent = ToolAgent(settings, self.agent.transport)
                return public_settings(settings)
            finally:
                self.execution_lock.release()

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
        policy_step = str(uuid.uuid4())
        self.tasks.step(task_id, "安全执行层", "固定范围策略", "检查S101、60秒、固定三方与均值输出约束；拒绝单车原始数据查询。", "running",
                        id=policy_step, kind="security", sender="任务协调器", recipient="安全执行层",
                        metadata={"road": road, "window_seconds": window_seconds, "metric": "mean_speed", "participant_count": 3})
        signed = self.signed_task(task_id, task["request_id"], road=road, window_seconds=window_seconds)
        try:
            authorize_task(signed["payload"])
        except SecurityError as exc:
            event = self.audit.append("request_rejected", {"task_id": task_id, "code": exc.code,
                              "layer": "task_policy"}, "coordinator", "coordinator")
            self.tasks.update_step(task_id, policy_step, status="failed", detail=str(exc), evidence_ids=[event["id"]])
            raise
        self.tasks.update_step(task_id, policy_step, status="completed", detail="任务范围符合固定策略；只允许批准的三方均值输出。")
        self.tasks.reserve_query("local-user", self.settings.query_cooldown)
        self.tasks.step(task_id, "安全执行层", "查询预算", "已通过本机隐私查询冷却与预算检查。", kind="security",
                        metadata={"check": "query_budget", "outcome": "accepted"})
        message = self.message(signed)
        self.tasks.step(task_id, "任务协调器", "任务与消息签名", "任务范围和传输信封分别完成Ed25519签名；只展示绑定摘要与序号。",
                        kind="security", sender="coordinator", recipient="rsu", protocol="Ed25519",
                        metadata={"task_digest": hashlib.sha256(canonical_bytes(signed["payload"])).hexdigest(),
                                  "message_digest": hashlib.sha256(canonical_bytes(message["payload"])).hexdigest(),
                                  "request_digest": hashlib.sha256(task["request"].encode()).hexdigest(),
                                  "sequence": message["payload"]["sequence"], "message_type": "task"})
        accepted = self.gateway.send(message, on_progress=self.task_trace(task_id))
        if not accepted.get("accepted"):
            raise SecurityError(accepted["code"], accepted["message"])
        self.tasks.step(task_id, "安全执行层", "认证与授权", "mTLS 身份、Ed25519 签名、任务范围与新鲜性校验通过",
                        kind="security", evidence_ids=[accepted["event_id"]] if accepted.get("event_id") else [])
        mpc_step = str(uuid.uuid4())
        self.tasks.step(task_id, "隐私计算模块", "三方协议", "正在启动三个独立进程；等待各参与方的真实协议进度与批准聚合输出。", "running",
                        id=mpc_step, kind="mpc", sender="coordinator", recipient="mpc", protocol="MPyC / mTLS",
                        metadata={"participant_count": 3, "threshold": 1})
        started_event = self.audit.append("mpc_started", {"task_id": task_id, "participant_count": 3, "metric": "mean_speed"},
                          "coordinator", "coordinator")
        result = self.mpc.run(signed, timeout=self.settings.mpc_timeout, on_progress=self.task_trace(task_id))
        self.tasks.update_step(task_id, mpc_step, status="completed", detail="三方 mTLS 秘密分享计算完成，已获得批准的均值输出。",
                               evidence_ids=[started_event["id"]])
        result["mean_speed_kmh"] = result["average_speed"]
        result["count"] = result["participant_count"]
        mean = result["average_speed"]
        result["traffic_state"] = "低速" if mean < 30 else "平稳" if mean < 60 else "较快"
        result["rule_version"] = "classroom-v1: <30低速; 30–<60平稳; >=60较快（非真实拥堵判定）"
        self.tasks.update(task_id, result=result)
        event = self.audit.append("statistics_completed", {"task_id": task_id, "mean_speed_kmh": mean, "count": 3,
                                                        "elapsed_ms": result["elapsed_ms"]}, "coordinator", "coordinator")
        self.tasks.step(task_id, "车辆节点 × 3", "联合统计完成", f"仅公开均值 {mean} km/h；证据 {event['id']}",
                        kind="mpc", sender="mpc", recipient="任务协调器", evidence_ids=[event["id"]],
                        metadata={"participant_count": 3, "elapsed_ms": result["elapsed_ms"]})
        return result

    def public_nodes(self):
        return [{"id": n["id"], "role": n["role"], "enabled": n["enabled"],
                 "certificate_fingerprint": n["cert_fingerprint"], "expires_at": n["valid_until"]} for n in self.security.identities()]

    def evidence_analysis(self, task_id=None, event_id=None):
        if not self.audit.verify()["valid"]:
            raise SecurityError("audit_invalid", "审计链或签名检查点校验失败，不能基于这些记录发布调查结论。")
        return analyze_events(self.audit.list(limit=80), task_id=task_id, event_id=event_id)

    def investigate(self, task_id):
        observed = []
        analyst = "信息安全分析 Agent" if self.settings.mode == "llm" else "模板分析器"
        self.tasks.step(task_id, "任务协调器", "调查委托", "将证据调查交给分析角色；仅允许读取公开审计摘要和登记身份状态。",
                        kind="exchange", sender="任务协调器", recipient=analyst, protocol="受控工具委托")
        audit_step = str(uuid.uuid4())
        self.tasks.step(task_id, "安全执行层", "审计链校验", "正在核对事件哈希链和签名检查点，校验通过后才允许发布证据结论。", "running",
                        id=audit_step, kind="security", sender=analyst, recipient="审计服务", protocol="SHA-256 / Ed25519")
        verification = self.audit.verify()
        self.tasks.update_step(task_id, audit_step, status="completed" if verification["valid"] else "failed",
                               detail="审计哈希链与签名检查点验证通过。" if verification["valid"] else "审计验证失败，停止发布证据结论。",
                               metadata={"check": "audit_chain_and_checkpoint", "count": verification["count"],
                                         "outcome": "accepted" if verification["valid"] else "rejected"})
        if not verification["valid"]:
            raise SecurityError("audit_invalid", "审计链或签名检查点校验失败，不能基于这些记录发布调查结论。")

        def query_events():
            # Audit contains public, allowlisted metadata only, never node inputs/shares.
            events = self.audit.list(limit=30)
            observed.extend(events)
            self.tasks.step(task_id, "审计服务", "公开事件摘要", f"返回 {len(events)} 条公开安全事件；不包含节点输入、秘密份额或密钥。",
                            kind="exchange", sender="审计服务", recipient=analyst,
                            evidence_ids=[event["id"] for event in events], metadata={"count": len(events)})
            return {"events": events, "scope": "最近30条公开安全事件摘要"}

        if self.settings.mode == "demo":
            events = self.audit.list(limit=80)
            self.tasks.step(task_id, "审计服务", "公开事件摘要", f"读取 {len(events)} 条公开事件，按任务绑定筛选实际证据。",
                            kind="exchange", sender="审计服务", recipient=analyst,
                            evidence_ids=[event["id"] for event in events], metadata={"count": len(events)})
            analysis = analyze_events(events, task_id=task_id)
        else:
            text = self.agent.run(ANALYST_PROMPT, "查询最近的身份、签名、权限和计算状态事件，说明确认事实、可能原因和不确定性。",
                [tool_schema("query_events", "读取最近30条经过过滤的公开审计事件"), tool_schema("identity_status", "查询已登记节点的公开身份状态")],
                {"query_events": query_events, "identity_status": self.public_nodes},
                lambda action, status, detail: None,
                on_progress=self.task_trace(task_id, "信息安全分析 Agent"))
            if not observed:
                raise AgentError("分析 Agent 未查询事件，不能发布结论。")
            analysis = validate_analysis(text, [e["id"] for e in observed])
        self.tasks.update(task_id, analysis=analysis)
        self.tasks.step(task_id, analyst, "证据调查", f"引用 {len(analysis['evidence_ids'])} 条实际事件；区分事实与推断",
                        kind="analysis", sender=analyst, recipient="任务协调器", evidence_ids=analysis["evidence_ids"])
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
                outcome = self.traced_report_verification(task_id, report)
                self.tasks.update(task_id, verification=outcome)
                return outcome

            summary = self.agent.run(COORDINATOR_PROMPT, request,
                [tool_schema("compute_statistics", "执行批准的三车速度均值统计", {"road": {"type": "string", "enum": ["S101"]}, "window_seconds": {"type": "integer", "enum": [60]}}),
                 tool_schema("investigate", "将安全事件证据调查委托给信息安全分析 Agent"),
                 tool_schema("verify_latest_report", "验证最近签名报告的来源、完整性与任务绑定"),
                 tool_schema("identity_status", "读取已登记身份的公开状态")],
                {"compute_statistics": lambda road, window_seconds: self.compute(task_id, road, window_seconds),
                 "investigate": lambda: self.investigate(task_id), "verify_latest_report": verify_latest_report, "identity_status": self.public_nodes},
                lambda action, status, detail: None,
                on_progress=self.task_trace(task_id, "任务协调 Agent"))
        else:
            self.tasks.step(task_id, "模板协调器", "任务规划", "已按离线任务规则选择统计、证据调查或报告验证流程；密码与 MPC 后端真实执行。",
                            kind="analysis", sender="用户", recipient="模板协调器", metadata={"mode": "demo"})
            if any(token in request.lower() for token in ("单车", "每辆车的速度", "私钥", "private", "raw_speed", "vehicle-a的速度")):
                raise SecurityError("unauthorized", "拒绝读取单车私有速度或密钥；仅允许固定三方均值。")
            if "验证" in request and "报告" in request and not any(x in request for x in ("统计", "平均", "均值")):
                report = self.latest_report()
                if not report:
                    raise SecurityError("report_missing", "尚无可验证报告，请先完成统计任务。")
                outcome = self.traced_report_verification(task_id, report)
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
        sign_step = str(uuid.uuid4())
        self.tasks.step(task["id"], "报告服务", "报告签名", "正在将任务绑定、聚合结果与证据结论封装为签名报告。", "running",
                        id=sign_step, kind="report", sender="任务协调器", recipient="报告服务", protocol="Ed25519")
        report = self.security.sign("report", payload)
        digest = hashlib.sha256(canonical_bytes(payload)).hexdigest()
        self.tasks.update_step(task["id"], sign_step, status="completed", detail="已使用已登记报告身份完成Ed25519签名。",
                               metadata={"report_digest": digest})
        save_step = str(uuid.uuid4())
        self.tasks.step(task["id"], "报告服务", "报告加密保存", "正在使用AES-GCM保存签名报告，并验证保存对象的认证完整性。", "running",
                        id=save_step, kind="report", sender="报告服务", recipient="本机加密存储", protocol="AES-GCM")
        path = self.root / f"reports/{task['id']}.enc"
        secure_write(path, self.report_storage_key, report)
        if secure_read(path, self.report_storage_key) != report:
            raise SecurityError("report_storage", "报告保存后的完整性校验失败，未发布报告。")
        self.tasks.update_step(task["id"], save_step, status="completed", detail="签名报告已完成AES-GCM加密保存，读回认证校验通过。")
        verification = self.traced_report_verification(task["id"], report)
        if not verification["valid"]:
            raise SecurityError("report_self_check", "生成报告的签名或任务绑定校验失败，未发布报告。")
        event = self.audit.append("report_signed", {"task_id": task["id"], "report_digest": digest}, "report", "report")
        self.tasks.step(task["id"], "报告服务", "签名与保存", "报告已完成Ed25519签名、AES-GCM保存和本机验签；可下载独立核验。",
                        kind="report", sender="报告服务", recipient="用户", evidence_ids=[event["id"]], metadata={"report_digest": digest})
        # Terminal snapshots are complete: streaming consumers may close as soon
        # as they observe this final status.
        self.tasks.update(task["id"], status="completed", summary=state["summary"], report=report, report_verification=verification)
        return {}

    def fail_task(self, task_id, code, message):
        if self.settings.llm_api_key:
            message = message.replace(self.settings.llm_api_key, "[凭据已隐藏]")
        current = self.tasks.get(task_id)
        for step in current["steps"]:
            if step["status"] in {"running", "queued"}:
                step.update(status="failed", updated_at=time.time(),
                            detail=step["detail"] + "（任务中止，此步骤未完成。）")
        self.tasks.update(task_id, steps=current["steps"])
        self.tasks.step(task_id, "安全执行层", "任务终止", message + " 本次流程未完成，未发布新的报告。", "failed",
                        kind="security", sender="安全执行层", recipient="用户", metadata={"code": code})
        try:
            self.audit.append("task_failed", {"task_id": task_id, "code": code, "reason": message})
        except Exception:
            # A damaged audit database must not leave the task perpetually
            # running or manufacture a successful audit write.
            self.tasks.step(task_id, "审计服务", "失败记录保存", "审计记录写入失败；本任务已停止，不能声称完成审计记录。", "failed",
                            kind="security", metadata={"check": "audit_failure_record", "outcome": "rejected"})
        self.tasks.update(task_id, status="failed", error={"code": code, "message": message})

    def execute(self, task_id):
        with self.execution_lock:
            context = {"mode": self.settings.mode,
                       "provider": self.settings.llm_provider if self.settings.mode == "llm" else None,
                       "model": self.settings.llm_model if self.settings.mode == "llm" else None}
            self.tasks.update(task_id, status="running", model_context=context, **context)
            try:
                task = self.tasks.get(task_id)
                self.tasks.step(task_id, "任务协调器", "任务受理", "任务已进入执行队列；执行模式已锁定，本次任务期间不会切换提供商或凭据。",
                                kind="analysis", sender="用户", recipient="任务协调器",
                                metadata={**context, "request_digest": hashlib.sha256(task["request"].encode()).hexdigest()})
                self.graph.invoke({"task_id": task_id})
            except (SecurityError, MpcError, AgentError) as exc:
                self.fail_task(task_id, exc.code, str(exc))
            except Exception:
                self.fail_task(task_id, "internal_error", "任务执行失败，未发布统计报告。请检查服务诊断。")
                logging.getLogger(__name__).error("Task execution failed (internal_error); task_id=%s", task_id)

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
        event = self.audit.append("experiment_completed", {"scenario": scenario, "blocked": blocked,
                             "layer": layer, "code": code, "validation_event_id": extra.get("event_id")})
        return {"scenario": scenario, "blocked": blocked, "layer": layer, "code": code, "message": message,
                "event_id": event["id"], "details": extra}

    def state(self):
        return {"mode": self.settings.mode, "nodes": self.public_nodes(), "tasks": self.tasks.list(), "events": self.audit.list(limit=80),
                "audit": self.audit.verify(), "protocol": {"name": "MPyC 三方秘密分享", "threshold": 1, "transport": "mTLS / TLS 1.3",
                "privacy": "固定三方、至多一方被动腐化；中心仅接收均值；同机演示信任宿主机"},
                "llm": {"configured": self.settings.mode == "llm", "model": self.settings.llm_model if self.settings.mode == "llm" else None},
                "auth": {"role": "local-demo-admin"}}
