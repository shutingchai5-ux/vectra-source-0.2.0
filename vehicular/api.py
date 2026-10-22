"""Local dashboard API. Browser session and same-origin controls are explicit."""
import asyncio
import hmac
import json
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field

from .config import Settings
from .model_settings import ModelSettingsError
from .security import SecurityError
from .service import CollaborationService

PACKAGE_WEB = Path(__file__).resolve().parent / "web"


class TaskRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request: str = Field(min_length=1, max_length=2000)
    request_id: str = Field(min_length=8, max_length=100, pattern=r"^[a-zA-Z0-9_-]+$")
    road: str = Field(default="S101", max_length=32)
    window_seconds: int = Field(default=60, ge=1, le=3600)


class ExperimentRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    scenario: str = Field(max_length=40)


class ReportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    envelope: dict


def create_app(settings=None, llm_transport=None):
    settings = settings or Settings.from_env()
    session = secrets.token_urlsafe(32)

    @asynccontextmanager
    async def lifespan(app):
        app.state.service = CollaborationService(settings, llm_transport)
        app.state.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vectra-task")
        try:
            yield
        finally:
            app.state.executor.shutdown(wait=True, cancel_futures=False)
            app.state.service.close()

    app = FastAPI(title="车联网多智能体可信数据协作与隐私保护", version="0.2.0", lifespan=lifespan,
                  docs_url=None, redoc_url=None, openapi_url="/api/openapi.json")
    # Set only by the managed CLI lifecycle. The control token is never part of
    # public browser state; a standalone ASGI app has no remote shutdown control.
    app.state.control_token = None
    app.state.shutdown_callback = None

    @app.middleware("http")
    async def local_auth(request: Request, call_next):
        hostname = request.url.hostname
        if hostname not in {"127.0.0.1", "localhost", "::1", "testserver"}:
            return JSONResponse({"detail": "只允许本机访问。"}, status_code=403)
        if request.url.path.startswith("/api/"):
            if request.url.path == "/api/control/shutdown" and request.method == "POST":
                control_token = getattr(request.app.state, "control_token", None)
                credential = request.headers.get("X-Vectra-Control", "")
                if (not control_token or not credential
                        or not hmac.compare_digest(credential.encode("utf-8"), control_token.encode("utf-8"))):
                    return JSONResponse({"detail": "服务控制凭据无效。"}, status_code=403)
            else:
                credential = request.cookies.get("vectra_session", "")
                if not hmac.compare_digest(credential, session):
                    return JSONResponse({"detail": "请先打开本地工作台建立演示会话。"}, status_code=401)
            if request.method not in {"GET", "HEAD", "OPTIONS"}:
                origin = request.headers.get("origin")
                if origin and (urlsplit(origin).netloc != request.url.netloc or urlsplit(origin).scheme != request.url.scheme):
                    return JSONResponse({"detail": "跨来源写入被拒绝。"}, status_code=403)
                length = request.headers.get("content-length", "0")
                if not length.isdigit() or int(length) > 131072:
                    return JSONResponse({"detail": "请求过大。"}, status_code=413)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.exception_handler(SecurityError)
    async def security_error(request, exc):
        return JSONResponse({"code": exc.code, "message": str(exc)}, status_code=403)

    @app.exception_handler(ModelSettingsError)
    async def model_settings_error(request, exc):
        return JSONResponse({"detail": str(exc)}, status_code=exc.status_code)

    @app.get("/")
    def index():
        response = FileResponse(PACKAGE_WEB / "index.html")
        response.set_cookie("vectra_session", session, httponly=True, samesite="strict", max_age=12 * 3600)
        return response

    app.mount("/assets", StaticFiles(directory=PACKAGE_WEB), name="assets")

    @app.post("/api/control/shutdown")
    def shutdown(request: Request):
        callback = getattr(request.app.state, "shutdown_callback", None)
        if callback is None:
            raise HTTPException(503, "当前服务未启用受控停止。")
        callback()
        return {"requested": True}

    @app.get("/api/state")
    def state(request: Request):
        return request.app.state.service.state()

    @app.get("/api/model-settings")
    def model_settings(request: Request):
        return request.app.state.service.model_settings()

    @app.put("/api/model-settings")
    async def update_model_settings(request: Request):
        # Do not use automatic validation here: its error objects may echo the
        # secret-bearing input. Only constant validation messages are returned.
        try:
            body = await request.json()
        except (ValueError, UnicodeError, RecursionError):
            raise ModelSettingsError("模型设置必须是有效的 JSON 对象。") from None
        return request.app.state.service.update_model_settings(body)

    @app.get("/api/evidence/analysis")
    def evidence_analysis(request: Request, event_id: int | None = None):
        return request.app.state.service.evidence_analysis(event_id=event_id)

    @app.post("/api/tasks", status_code=202)
    def create_task(body: TaskRequest, request: Request):
        service = request.app.state.service
        with service.submission_lock:
            if len([t for t in service.tasks.list() if t["status"] in {"queued", "running"}]) >= 8:
                raise HTTPException(429, "任务队列已满。")
            task, created = service.tasks.create(body.model_dump())
            if created:
                service.audit.append("task_created", {"task_id": task["id"], "request_id": task["request_id"]})
                request.app.state.executor.submit(service.execute, task["id"])
        return task

    @app.get("/api/tasks/{task_id}")
    def task(task_id: str, request: Request):
        task = request.app.state.service.tasks.get(task_id)
        if not task:
            raise HTTPException(404, "任务不存在。")
        return task

    @app.get("/api/tasks/{task_id}/stream")
    async def task_stream(task_id: str, request: Request):
        tasks = request.app.state.service.tasks
        if await asyncio.to_thread(tasks.get, task_id) is None:
            raise HTTPException(404, "任务不存在。")

        async def snapshots():
            # Send persisted snapshots so a reconnect recovers the complete
            # execution history, including events emitted between connections.
            # Fast stages may share one snapshot, but none of their steps vanish.
            previous = None
            heartbeat = time.monotonic()
            while not await request.is_disconnected():
                task = await asyncio.to_thread(tasks.get, task_id)
                if task is None:
                    return
                encoded = json.dumps(task, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
                if encoded != previous:
                    yield f"event: task\ndata: {encoded}\n\n"
                    previous = encoded
                    heartbeat = time.monotonic()
                elif time.monotonic() - heartbeat >= 10:
                    yield ": keep-alive\n\n"
                    heartbeat = time.monotonic()
                if task["status"] in {"completed", "failed"}:
                    return
                await asyncio.sleep(0.15)

        return StreamingResponse(snapshots(), media_type="text/event-stream",
                                 headers={"X-Accel-Buffering": "no", "Cache-Control": "no-store"})

    @app.post("/api/experiments")
    def experiment(body: ExperimentRequest, request: Request):
        return request.app.state.service.experiment(body.scenario)

    @app.post("/api/reports/verify")
    def report_verify(body: ReportRequest, request: Request):
        return request.app.state.service.verify_report(body.envelope)

    @app.get("/api/reports/{task_id}/download")
    def report_download(task_id: str, request: Request):
        task = request.app.state.service.tasks.get(task_id)
        if not task or not task.get("report"):
            raise HTTPException(404, "签名报告尚未生成。")
        return Response(json.dumps(task["report"], ensure_ascii=False, indent=2), media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="report-{task["id"]}.json"'})

    @app.post("/api/audit/checkpoint")
    def checkpoint(request: Request):
        return request.app.state.service.audit.checkpoint()

    @app.get("/api/audit/verify")
    def audit_verify(request: Request):
        return request.app.state.service.audit.verify()

    return app
