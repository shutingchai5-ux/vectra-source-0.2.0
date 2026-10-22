"""Offline explanations must stay tied to actual public evidence and stages."""

import pytest

from vehicular.analysis import analyze_events
from vehicular.security import SecurityError


def event(identifier, kind, details, verified=None):
    return {"id": identifier, "kind": kind, "details": details,
            "claimed_identity": "vehicle-a", "verified_identity": verified}


def test_rejected_message_has_no_false_identity_attribution_or_mpc_stage():
    analysis = analyze_events([event(7, "request_rejected", {"code": "SIGNATURE_INVALID", "layer": "RSU"})])
    assert analysis["evidence_ids"] == [7]
    assert any("没有进入 MPC" in fact for fact in analysis["facts"])
    assert any("不能按自称身份归因" in fact for fact in analysis["facts"])
    assert not any("vehicle-a" in fact for fact in analysis["facts"])


def test_task_failure_uses_matching_started_event_not_another_tasks_completion():
    events = [event(8, "statistics_completed", {"task_id": "other"}),
              event(7, "task_failed", {"task_id": "target", "code": "mpc_timeout"}),
              event(6, "mpc_started", {"task_id": "target"}),
              event(5, "task_authorized", {"task_id": "target"})]
    analysis = analyze_events(events, "target")
    assert analysis["evidence_ids"] == [7, 6]
    assert any("已发起三方 MPC 调度" in fact for fact in analysis["facts"])
    assert all("other" not in fact for fact in analysis["facts"])


def test_policy_rejection_explains_why_failed_task_never_started_mpc():
    events = [event(4, "task_failed", {"task_id": "target", "code": "unauthorized"}),
              event(3, "request_rejected", {"task_id": "target", "code": "unauthorized",
                                             "layer": "task_policy"}, "coordinator")]
    analysis = analyze_events(events, "target")
    assert analysis["evidence_ids"] == [4, 3]
    assert any("调度前被拒绝" in fact for fact in analysis["facts"])


def test_selected_stage_requires_an_actual_recent_event():
    events = [event(3, "mpc_started", {"task_id": "target"}),
              event(2, "task_authorized", {"task_id": "target"})]
    analysis = analyze_events(events, event_id=3)
    assert analysis["evidence_ids"] == [3]
    assert any("已发起三方 MPC" in fact for fact in analysis["facts"])
    with pytest.raises(SecurityError) as failure:
        analyze_events(events, event_id=5)
    assert failure.value.code == "evidence_missing"
