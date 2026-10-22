"""Real three-process protocol checks; no plaintext arithmetic fallback."""
import copy
import asyncio
import hashlib
import json
import os
from pathlib import Path
import ssl
import subprocess
import time
from types import SimpleNamespace
import uuid

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from vehicular.mpc import MpcError, MpcRunner, PARTICIPANTS, initialize_samples, task_digest
from vehicular.mpc_party import install_peer_pinning, verify_task
from vehicular.security import SecurityStore


@pytest.fixture
def mpc_root(tmp_path):
    store = SecurityStore(tmp_path)
    store.provision()
    initialize_samples(tmp_path)
    return tmp_path, store


def signed_task(store, **changes):
    clock = time.time()
    payload = {"task_id": str(uuid.uuid4()), "request_id": str(uuid.uuid4()),
               "sender": "coordinator", "recipient": "coordinator",
               "purpose": "traffic_statistics", "metric": "mean_speed", "road": "S101",
               "window_seconds": 60, "participants": list(PARTICIPANTS),
               "issued_at": clock, "expires_at": clock + 120}
    payload.update(changes)
    return store.sign("coordinator", payload)


@pytest.mark.integration
def test_real_three_party_mean_without_parent_reading_private_files(mpc_root, monkeypatch):
    root, store = mpc_root
    task = signed_task(store)
    original_read = Path.read_bytes

    def public_only(path):
        if path.name in {"sample.enc", "storage.key"}:
            raise AssertionError("Coordinator attempted to open a private vehicle input")
        return original_read(path)

    monkeypatch.setattr(Path, "read_bytes", public_only)
    result = MpcRunner(root).run(task)
    assert result["average_speed"] == 40
    assert result["participant_count"] == 3
    assert result["participants"] == list(PARTICIPANTS)
    assert result["threshold"] == 1 and result["transport"] == "mTLS"
    assert "MPyC" in result["protocol"] and result["task_id"] == task["payload"]["task_id"]
    assert not any(name in json.dumps(result) for name in ("speed_kmh", "storage.key", "share", "ciphertext"))
    assert list((root / "mpc-runs").iterdir()) == []


@pytest.mark.integration
@pytest.mark.parametrize("speeds,expected", [
    ([0, 0, 0], 0), ([12.34, 45.67, 89.01], 49.01),
    ([300, 300, 300], 300), ([1.005, 1.005, 1.005], 1.01),
])
def test_real_mpc_fractional_boundary_and_sensor_rounding(mpc_root, speeds, expected):
    root, store = mpc_root
    for vehicle_id, speed in zip(PARTICIPANTS, speeds):
        node = root / "vehicles" / vehicle_id
        key = (node / "storage.key").read_bytes()
        record = {"vehicle_id": vehicle_id, "road": "S101", "speed_kmh": speed,
                  "source": "simulation"}
        nonce = os.urandom(12)
        blob = nonce + AESGCM(key).encrypt(nonce, json.dumps(record).encode(), vehicle_id.encode())
        (node / "sample.enc").write_bytes(blob)
    result = MpcRunner(root).run(signed_task(store))
    assert result["average_speed"] == expected
    assert "TLS 1.3" in result["protocol"]


@pytest.mark.integration
def test_offline_party_fails_and_subprocesses_are_reaped(mpc_root, monkeypatch):
    root, store = mpc_root
    launched = []
    original_popen = subprocess.Popen

    def tracked(*args, **kwargs):
        process = original_popen(*args, **kwargs)
        launched.append(process)
        return process

    monkeypatch.setattr(subprocess, "Popen", tracked)
    started = time.monotonic()
    with pytest.raises(MpcError) as caught:
        MpcRunner(root).run(signed_task(store), timeout=1.5, offline_party="vehicle-c")
    assert caught.value.code == "mpc_timeout"
    assert time.monotonic() - started < 8
    assert len(launched) == 2 and all(process.poll() is not None for process in launched)
    assert list((root / "mpc-runs").iterdir()) == []


@pytest.mark.integration
def test_corrupt_private_input_never_falls_back_to_partial_mean(mpc_root):
    root, store = mpc_root
    sample = root / "vehicles" / "vehicle-b" / "sample.enc"
    ciphertext = bytearray(sample.read_bytes())
    ciphertext[-1] ^= 1
    sample.write_bytes(ciphertext)
    with pytest.raises(MpcError) as caught:
        MpcRunner(root).run(signed_task(store))
    assert caught.value.code == "sample_invalid"
    assert list((root / "mpc-runs").iterdir()) == []


@pytest.mark.integration
def test_workers_reject_signed_single_vehicle_query(mpc_root):
    root, store = mpc_root
    with pytest.raises(MpcError) as caught:
        MpcRunner(root).run(signed_task(store, participants=["vehicle-a"]))
    assert caught.value.code == "task_unauthorized"


@pytest.mark.parametrize("change", [
    {"recipient": "analyst"}, {"metric": "individual_speed"}, {"purpose": "debug"},
    {"road": "S102"}, {"window_seconds": 30}, {"window_seconds": True},
    {"participants": ["vehicle-a", "vehicle-b"]},
    {"participants": ["vehicle-c", "vehicle-b", "vehicle-a"]},
    {"additional_output": "private_speed"}, {"issued_at": 0, "expires_at": 60},
])
def test_every_worker_independently_enforces_complete_policy(mpc_root, change):
    root, store = mpc_root
    task = signed_task(store, **change)
    for vehicle in PARTICIPANTS:
        with pytest.raises(MpcError) as caught:
            verify_task(root, task, vehicle)
        assert caught.value.code == "task_unauthorized"


def test_worker_rejects_tampered_task_and_wrong_signer(mpc_root):
    root, store = mpc_root
    task = signed_task(store)
    tampered = copy.deepcopy(task)
    tampered["payload"]["task_id"] = "replaced-id"
    analyst = store.sign("analyst", task["payload"])
    for envelope in (tampered, analyst):
        with pytest.raises(MpcError) as caught:
            verify_task(root, envelope, "vehicle-a")
        assert caught.value.code == "task_unauthorized"


def test_worker_rejects_disabled_participant(mpc_root):
    root, store = mpc_root
    task = signed_task(store)
    store.set_enabled("vehicle-c", False)
    with pytest.raises(MpcError) as caught:
        verify_task(root, task, "vehicle-a")
    assert caught.value.code == "task_unauthorized"


def test_fixture_provision_does_not_overwrite_private_data(mpc_root):
    root, _ = mpc_root
    sample = root / "vehicles" / "vehicle-a" / "sample.enc"
    ciphertext = sample.read_bytes()
    key = (sample.parent / "storage.key").read_bytes()
    initialize_samples(root)
    assert sample.read_bytes() == ciphertext
    assert (sample.parent / "storage.key").read_bytes() == key


def pinned_runtime(tmp_path, monkeypatch):
    from mpyc import asyncoro
    monkeypatch.chdir(tmp_path)
    config = tmp_path / ".config"
    config.mkdir()
    peers = {str(pid): hashlib.sha256(f"certificate-{pid}".encode()).hexdigest() for pid in range(3)}
    (config / "peers.json").write_text(json.dumps(peers))
    calls, registered = [], []

    async def create_server(factory, host, *args, **kwargs):
        calls.append(("server", host, kwargs["ssl"].minimum_version))

    async def create_connection(factory, *args, **kwargs):
        calls.append(("client", args, kwargs["ssl"].minimum_version))

    runtime = SimpleNamespace(pid=2, options=SimpleNamespace(no_prss=True),
                              set_protocol=lambda pid, proto: registered.append(pid),
                              _loop=SimpleNamespace(create_server=create_server,
                                                    create_connection=create_connection))
    # Restore the process-global MPyC class after each test.
    monkeypatch.setattr(asyncoro, "MessageExchanger", asyncoro.MessageExchanger)
    install_peer_pinning(runtime)
    return runtime, asyncoro.MessageExchanger, calls, registered


def test_both_mpc_socket_directions_require_tls13(tmp_path, monkeypatch):
    runtime, _, calls, _ = pinned_runtime(tmp_path, monkeypatch)
    server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    client = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)

    async def exercise():
        await runtime._loop.create_server(lambda: None, "0.0.0.0", port=1234, ssl=server)
        await runtime._loop.create_connection(lambda: None, "127.0.0.1", 1234, ssl=client)
        with pytest.raises(MpcError) as caught:
            await runtime._loop.create_connection(lambda: None, "127.0.0.1", 1234, ssl=None)
        assert caught.value.code == "identity_invalid"

    asyncio.run(exercise())
    assert calls == [("server", "127.0.0.1", ssl.TLSVersion.TLSv1_3),
                     ("client", ("127.0.0.1", 1234), ssl.TLSVersion.TLSv1_3)]


@pytest.mark.parametrize("version,certificate_pid,claimed_pid,accepted", [
    ("TLSv1.3", 0, 0, True), ("TLSv1.2", 0, 0, False),
    ("TLSv1.3", 0, 1, False), ("TLSv1.3", 0, 2, False),
])
def test_negotiated_tls_version_and_authenticated_pid_before_shares(
        tmp_path, monkeypatch, version, certificate_pid, claimed_pid, accepted):
    runtime, protocol_class, _, registered = pinned_runtime(tmp_path, monkeypatch)

    class Transport:
        aborted = False

        def get_extra_info(self, name, default=None):
            if name == "peercert":
                return {"subject": "registered-vehicle"}
            if name == "ssl_object":
                return SimpleNamespace(version=lambda: version,
                                       getpeercert=lambda binary_form: f"certificate-{certificate_pid}".encode())
            return default

        def abort(self):
            self.aborted = True

    transport = Transport()
    protocol = protocol_class(runtime)
    protocol.connection_made(transport)
    protocol.data_received(claimed_pid.to_bytes(2, "little"))
    assert registered == ([claimed_pid] if accepted else [])
    assert transport.aborted is not accepted


def test_task_digest_uses_jcs_number_semantics():
    assert task_digest({"payload": {"speed": 1}}) == task_digest({"payload": {"speed": 1.0}})
