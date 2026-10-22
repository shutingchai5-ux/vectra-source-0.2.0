"""Actual protocol progress is streamed using fixed, non-private stage codes."""
import copy
import json
import subprocess
import time
import uuid

import pytest

from vehicular.mpc import (MpcError, MpcRunner, PARTICIPANTS, TRACE_MARKER,
                           _trace_event, initialize_samples)
from vehicular.security import AuditLog, SecurityStore
from vehicular.transport import RsuGateway


@pytest.fixture
def protocol_root(tmp_path):
    security = SecurityStore(tmp_path)
    security.provision()
    initialize_samples(tmp_path)
    return tmp_path, security


def signed_task(security):
    now = time.time()
    return security.sign("coordinator", {
        "task_id": str(uuid.uuid4()), "request_id": str(uuid.uuid4()),
        "sender": "coordinator", "recipient": "coordinator", "purpose": "traffic_statistics",
        "metric": "mean_speed", "road": "S101", "window_seconds": 60,
        "participants": list(PARTICIPANTS), "issued_at": now, "expires_at": now + 100})


def message(security, task, sequence=1):
    now = time.time()
    return security.sign("coordinator", {
        "sender": "coordinator", "recipient": "rsu", "purpose": "traffic_statistics",
        "message_type": "task", "task_id": task["payload"]["task_id"],
        "request_id": task["payload"]["request_id"], "session_id": "protocol-trace-session",
        "sequence": sequence, "timestamp": now, "expires_at": now + 100, "task": task})


@pytest.mark.parametrize("data", [
    {"stage": "input_verified", "raw_speed": 99}, {"stage": "unknown", "api_key": "secret"},
    {"stage": "tls_peer_verified", "peer": "unregistered"}, {"stage": ["input_verified"]},
    {"stage": "input_verified", "peer": "vehicle-b"}, {"stage": "tls_peer_verified"},
    {"stage": "output_ready"}, ["input_verified"],
    {"stage": "input_verified", "private": "x" * 1000},
])
def test_trace_parser_never_accepts_worker_text_or_extra_fields(data):
    assert _trace_event("vehicle-b", TRACE_MARKER + json.dumps(data)) is None


@pytest.mark.integration
def test_real_mpc_progress_arrives_while_workers_run_without_private_data(protocol_root, monkeypatch):
    root, security = protocol_root
    launched, events, live_stages = [], [], []
    popen = subprocess.Popen

    def tracked(*args, **kwargs):
        process = popen(*args, **kwargs)
        launched.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", tracked)

    def progress(event):
        events.append(event)
        if any(process.poll() is None for process in launched):
            live_stages.append(event["metadata"]["stage"])

    result = MpcRunner(root).run(signed_task(security), on_progress=progress)
    assert result["average_speed"] == 40
    assert "task_verified" in live_stages and "shares_started" in live_stages
    for vehicle in PARTICIPANTS:
        stages = [event["metadata"]["stage"] for event in events if event["agent"] == vehicle]
        assert stages.index("task_verified") < stages.index("input_verified") < stages.index("network_ready")
        assert stages.index("shares_started") < stages.index("shares_ready") < stages.index("output_started")
        assert stages[-1] == "protocol_closed"
        assert stages.count("tls_peer_verified") == 2
        peers = [event for event in events if event["agent"] == vehicle and event["metadata"]["stage"] == "tls_peer_verified"]
        assert len({event["id"] for event in peers}) == 2
    assert [event["agent"] for event in events if event["metadata"]["stage"] == "output_ready"] == ["vehicle-a"]
    encoded = json.dumps(events)
    assert all(private not in encoded for private in ("speed_kmh", "sample.enc", "storage.key", "ciphertext", "private_speed"))
    for vehicle in PARTICIPANTS:
        assert (root / "vehicles" / vehicle / "storage.key").read_bytes().hex() not in encoded
    assert all(process.poll() is not None for process in launched)
    assert list((root / "mpc-runs").iterdir()) == []


@pytest.mark.integration
def test_invalid_input_does_not_publish_later_success_stages(protocol_root):
    root, security = protocol_root
    path = root / "vehicles" / "vehicle-b" / "sample.enc"
    blob = bytearray(path.read_bytes())
    blob[-1] ^= 1
    path.write_bytes(blob)
    events = []
    with pytest.raises(MpcError) as caught:
        MpcRunner(root).run(signed_task(security), on_progress=events.append)
    assert caught.value.code == "sample_invalid"
    b_stages = [event["metadata"]["stage"] for event in events if event["agent"] == "vehicle-b"]
    assert "task_verified" in b_stages and "input_verified" not in b_stages
    assert all(event["metadata"]["stage"] != "output_ready" for event in events)
    assert list((root / "mpc-runs").iterdir()) == []


@pytest.mark.integration
def test_offline_peer_never_reports_network_or_share_completion(protocol_root):
    root, security = protocol_root
    events = []
    with pytest.raises(MpcError) as caught:
        MpcRunner(root).run(signed_task(security), timeout=2, offline_party="vehicle-c", on_progress=events.append)
    assert caught.value.code == "mpc_timeout"
    assert events and all(event["agent"] != "vehicle-c" for event in events)
    assert not {"network_ready", "shares_ready", "output_ready"} & {event["metadata"]["stage"] for event in events}
    assert list((root / "mpc-runs").iterdir()) == []


@pytest.mark.integration
def test_rsu_trace_contains_actual_tls_and_only_completed_checks(protocol_root):
    root, security = protocol_root
    audit = AuditLog(root / "audit.sqlite3", security)
    gateway = RsuGateway(root, security, audit)
    try:
        task = signed_task(security)
        events = []
        outcome = gateway.send(message(security, task), on_progress=events.append)
        assert outcome["accepted"]
        tls = next(event for event in events if event["metadata"].get("stage") == "rsu_peer_verified")
        assert tls["metadata"]["tls_version"] == "TLSv1.3"
        assert len(tls["metadata"]["peer_fingerprint"]) == 64 and tls["metadata"]["cipher"]
        assert events[-1]["evidence_ids"] == [outcome["event_id"]]
        assert {event["metadata"].get("check") for event in events} >= {"task_signature", "task_policy", "replay_guard"}
        tampered = copy.deepcopy(message(security, task, sequence=2))
        tampered["payload"]["purpose"] = "tampered"
        events = []
        rejected = gateway.send(tampered, on_progress=events.append)
        assert not rejected["accepted"] and events[-1]["status"] == "rejected"
        assert [event["metadata"]["check"] for event in events if "check" in event["metadata"]] == ["transport_identity"]
        assert events[-1]["evidence_ids"] == [rejected["event_id"]]
    finally:
        gateway.close()
