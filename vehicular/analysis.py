"""Evidence-bound explanations for the offline security investigation."""

from .security import SecurityError


_REASONS = {
    "replay": ("同一会话中的消息序号已被接收。", "检查客户端是否重复发送了同一签名消息。"),
    "stale_sequence": ("消息序号已超出接收窗口。", "检查发送端的会话和序号状态。"),
    "expired": ("消息或任务不在批准的有效期内。", "检查发送端时钟与任务有效期。"),
    "unauthorized": ("任务参数或调用权限不符合批准范围。", "核对路段、窗口、指标和固定参与集合。"),
    "SIGNATURE_INVALID": ("应用签名未通过登记公钥验证。", "检查签名对象与登记的应用公钥。"),
    "IDENTITY_MISMATCH": ("签署者与预期身份不一致。", "核对传输身份和登记的应用签署者。"),
    "IDENTITY_DISABLED": ("已登记身份处于禁用状态。", "检查身份登记状态；不要仅凭自称身份执行处置。"),
    "CERTIFICATE_UNREGISTERED": ("证书与登记身份不匹配。", "检查证书指纹与登记记录。"),
    "CERTIFICATE_EXPIRED": ("证书超出有效期。", "检查证书有效期与本机时钟。"),
    "untrusted_peer": ("传输对端未通过预期身份验证。", "检查证书链、有效期与身份登记状态。"),
    "context_mismatch": ("消息身份、接收者、用途或任务绑定不一致。", "核对签名消息中的上下文字段。"),
}


def _details(event):
    value = event.get("details")
    return value if isinstance(value, dict) else {}


def analyze_events(events, task_id=None, event_id=None):
    """Describe observed stages without treating event text as instructions or proof of intent."""
    events = sorted(events, key=lambda item: item["id"], reverse=True)
    relevant = {"request_rejected", "task_failed", "statistics_completed", "experiment_completed"}
    selectable = relevant | {"task_authorized", "mpc_started"}
    own = [event for event in events if _details(event).get("task_id") == task_id
           and event.get("kind") in selectable]
    if event_id is not None:
        if type(event_id) is not int or event_id < 1:
            raise SecurityError("evidence_missing", "事件编号无效。")
        anchor = next((event for event in events if event.get("id") == event_id
                       and event.get("kind") in selectable), None)
        if anchor is None:
            raise SecurityError("evidence_missing", "事件不在最近可调查的审计记录中。")
    else:
        anchor = next((event for event in own if event.get("kind") in relevant), None)
        if anchor is None:
            anchor = next((event for event in events if event.get("kind") in relevant), None)

    facts = []
    causes = []
    recommendations = []
    uncertainties = ["事件记录不能单独证明传感器真实性、攻击意图或系统绝无其他泄露。"]
    evidence_ids = []

    def cite(event):
        if event["id"] not in evidence_ids:
            evidence_ids.append(event["id"])
        return f"证据 #{event['id']}"

    if anchor is None:
        if events:
            facts.append(f"当前只有启动或任务创建等基础记录（{cite(events[0])}）。运行协作任务或受控实验后，可查看具体的执行阶段。")
        else:
            raise SecurityError("evidence_missing", "没有可供调查的审计事件。")
        uncertainties.append("没有目标事件，无法判断某次请求是否进入计算。")
        recommendations.append("先提交任务或运行受控实验，再按事件编号调查。")
    else:
        details = _details(anchor)
        kind = anchor["kind"]
        code = details.get("code")
        if not isinstance(code, str) or len(code) > 64:
            code = None
        if kind == "request_rejected":
            layer = details.get("layer")
            boundary = "RSU " if layer == "RSU" else "任务策略" if layer == "task_policy" else "接入层"
            facts.append(f"{cite(anchor)}：{boundary}拒绝了该次请求，代码为 {code or '未提供'}；该次请求没有进入 MPC 调度。")
            verified = anchor.get("verified_identity")
            facts.append(f"该事件的已验证身份为 {verified}。" if verified else "该事件没有已验证的发送者身份，不能按自称身份归因。")
            reason, action = _REASONS.get(code, ("请求未通过接入或授权校验。", "核对该事件的失败代码、身份与任务上下文。"))
            causes.append(reason)
            recommendations.append(action)
        elif kind == "task_failed":
            task = details.get("task_id")
            facts.append(f"{cite(anchor)}：任务 {task} 以 {code or '未提供'} 代码失败。")
            related = [event for event in events if _details(event).get("task_id") == task]
            started = next((event for event in related if event.get("kind") == "mpc_started"), None)
            if started:
                facts.append(f"{cite(started)}：已发起三方 MPC 调度；失败任务没有发布完成的统计结果。")
            else:
                rejected = next((event for event in related if event.get("kind") == "request_rejected"), None)
                if rejected:
                    facts.append(f"{cite(rejected)}：该次任务请求在调度前被拒绝，没有进入 MPC。")
                else:
                    facts.append("所查事件中没有该任务进入 MPC 调度的记录；不能仅凭记录缺失证明系统从未计算。")
            causes.append("失败代码指示任务终止阶段，不能据此推断攻击者或输入真实性。")
            recommendations.append("按任务 ID 查看执行步骤与失败代码，并核对关联审计事件。")
        elif kind == "statistics_completed":
            facts.append(f"{cite(anchor)}：任务 {_details(anchor).get('task_id')} 已发布批准的三方统计结果。")
            causes.append("当前选中的事件不是拒绝事件。")
            recommendations.append("如需调查异常，请选择相应的拒绝或失败事件。")
        elif kind == "task_authorized":
            facts.append(f"{cite(anchor)}：任务 {details.get('task_id')} 已通过 RSU 认证与授权。")
            uncertainties.append("授权通过不等于三方计算已开始或完成，需查看后续阶段事件。")
            recommendations.append("沿任务 ID 检查 MPC 调度与统计完成事件。")
        elif kind == "mpc_started":
            facts.append(f"{cite(anchor)}：任务 {details.get('task_id')} 已发起三方 MPC 调度。")
            uncertainties.append("调度事件不证明计算成功，需查看统计完成或失败事件。")
            recommendations.append("沿任务 ID 检查最终状态与报告签名。")
        else:
            blocked = details.get("blocked")
            scenario = details.get("scenario")
            facts.append(f"{cite(anchor)}：受控实验 {scenario} 的实际阻断结果为 {blocked}，失败层为 {details.get('layer', '未提供')}。")
            validation_id = details.get("validation_event_id")
            validation = next((event for event in events if type(validation_id) is int and event.get("id") == validation_id
                               and event.get("kind") == "request_rejected"), None)
            if validation:
                facts.append(f"{cite(validation)}：该次实验请求被 RSU 拒绝，没有进入 MPC 调度。")
                verified = validation.get("verified_identity")
                facts.append(f"该拒绝事件的已验证身份为 {verified}。" if verified else
                             "该拒绝事件没有已验证的发送者身份，不能按自称身份归因。")
            causes.append("受控实验的结果不能直接归因于真实车辆或外部攻击者。")
            recommendations.append("结合实验代码和对应拒绝事件检查保护层。")
        if kind != "request_rejected":
            uncertainties.append("仅凭本次选中的事件，不能判断其他消息是否进入计算阶段。")

    return {"facts": facts, "possible_causes": causes,
            "recommendations": recommendations, "uncertainties": uncertainties,
            "evidence_ids": evidence_ids}
