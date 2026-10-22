"""Console entry points for setup, dashboard and repeatable demo validation."""
import argparse
import json
import sys
import uuid
from dataclasses import replace
from pathlib import Path

from .config import Settings, resolve_project_dir


def main():
    parser = argparse.ArgumentParser(description="VECTRA 可信车联网协作系统")
    parser.add_argument("command", choices=["init", "serve", "demo", "verify-report", "check", "migrate-data"], nargs="?", default="serve")
    parser.add_argument("--port", type=int)
    parser.add_argument("--project-dir", type=Path, help="Configuration and data root; defaults to this checkout or current directory for a wheel")
    parser.add_argument("--file", help="verify-report 的 JSON 文件")
    args = parser.parse_args()
    root = resolve_project_dir(args.project_dir)
    settings = Settings.from_env(root)
    if args.port is not None:
        settings = replace(settings, port=args.port)
    if args.command == "serve":
        from .lifecycle import serve
        serve(settings, root)
        return
    if args.command == "check":
        settings.validate()
        print(json.dumps({"project_dir": str(root), "data_dir": str(settings.data_dir),
                          "mode": settings.mode, "host": settings.host, "port": settings.port,
                          "web_assets": (Path(__file__).parent / "web/index.html").is_file()},
                         ensure_ascii=False, indent=2))
        return
    if args.command == "migrate-data":
        from .lifecycle import ProjectLease
        from .security import migrate_encrypted_file
        with ProjectLease(root):
            files = sorted((settings.data_dir / "reports").glob("*.enc"))
            key_path = settings.data_dir / "reports/storage.key"
            if files and not key_path.is_file():
                raise RuntimeError("Report storage.key is missing; preserve the complete original runtime directory")
            key = key_path.read_bytes() if files else None
            changed = sum(migrate_encrypted_file(path, key) for path in files)
        print(f"Migration complete: {changed} legacy reports converted; {len(files) - changed} portable reports verified. Existing keys and reports preserved.")
        return
    if args.command == "init":
        from .security import SecurityStore
        from .mpc import initialize_samples
        from .lifecycle import ProjectLease
        settings.validate()
        with ProjectLease(root):
            settings.data_dir.mkdir(parents=True, exist_ok=True)
            SecurityStore(settings.data_dir).provision()
            initialize_samples(settings.data_dir)
        print(f"初始化完成：{settings.data_dir}。车辆数据为本地加密模拟输入。")
        return
    from .service import CollaborationService
    service = CollaborationService(settings)
    try:
        if args.command == "verify-report":
            if not args.file:
                parser.error("verify-report requires --file")
            result = service.verify_report(json.loads(Path(args.file).read_text("utf-8")))
            print(json.dumps(result, ensure_ascii=False, indent=2))
            sys.exit(0 if result["valid"] else 1)
        task, _ = service.tasks.create({"request": "统计 S101 的平均速度并生成签名报告", "request_id": "demo-" + str(uuid.uuid4()), "road": "S101", "window_seconds": 60})
        service.execute(task["id"])
        task = service.tasks.get(task["id"])
        if task["status"] != "completed":
            print(json.dumps(task["error"], ensure_ascii=False))
            sys.exit(1)
        checks = [service.experiment(name) for name in ("tamper_message", "replay", "impersonation", "unauthorized", "tamper_report", "ciphertext", "dropout")]
        print(json.dumps({"task_id": task["id"], "result": task["result"], "report_verification": service.verify_report(task["report"]),
                          "experiments": checks, "audit": service.audit.verify()}, ensure_ascii=False, indent=2))
        if not all(c["blocked"] for c in checks):
            sys.exit(1)
    finally:
        service.close()


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError) as failure:
        print(f"ERROR: {failure}", file=sys.stderr)
        sys.exit(1)
