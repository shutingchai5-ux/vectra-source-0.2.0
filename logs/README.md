# 应用诊断日志

本目录是 VECTRA 的应用功能数据，按项目要求纳入 Git 管理。园区与企业入口分别写入 park/、companies/，公司业务分区写入 carrier-a/、carrier-b/、carrier-c/ 子目录，每个子目录包含下述 conversations/ 与 operations/。Codex 的计划、临时检查脚本和工作记录仍存放于项目外的同级 `codex_files/`。

- `conversations/YYYY-MM-DD.jsonl`：用户提问、助手回复、独立执行步骤、任务状态和失败信息。
- `operations/YYYY-MM-DD.jsonl`：服务启动与停止、API 操作结果与耗时、模型调用状态、安全审计事件、前端操作和运行异常。

每行是独立 JSON。文件按中国上海时间（`Asia/Shanghai`）分日，新增记录的 `timestamp` 使用带时区偏移的 ISO 时间，例如 `2026-10-23T00:00:00.000+08:00`，并记录 `timeZone: Asia/Shanghai`。历史 UTC 格式行保留，可用标准 ISO 解析器统一解析。可通过 `runId`、`sourceId`、`eventId`、`conversationId`、`taskId` 和 `requestId` 关联记录。HTTP 响应的 `X-Request-Id` 与请求及客户端错误日志对应。

服务启动时补写 SQLite 中尚未导出的公开任务事件。导出游标保存在运行数据目录的 `diagnostic-log-cursor.json`；崩溃恢复可能重复少量记录，用 `sourceId + eventId` 去重。日志是诊断副本，不能替代数据库、签名报告或安全审计链。

日志会记录脱敏后的对话正文。写入前过滤已知模型密钥、认证头、Cookie、私钥、加密内容与秘密份额字段；不记录请求头、设置表单、模型原始响应或内部推理。对话中主动提供的其他业务内容仍会进入 Git 历史。

前端日志先经过脱敏，断连期间最多暂存最近 50 条操作记录，服务恢复并建立会话后批量上报。只有经过本机会话认证与同源检查的请求可写日志，服务端限制上报频率。日志写入失败会在服务终端提示，不改变任务的安全判定。

旧本机协议展示中的私钥、AES 密钥、车辆原始输入、随机多项式与真实份额只存入旧运行数据库的加密材料表，公开事件仅包含 `hasPrivateDetails` 标记；本目录不接收材料接口响应。任务失败在对话日志中使用 `error` 级别，步骤日志补齐同一任务的 requestId、mode、model 和 intent。分析结构校验失败记录具体字段或证据原因；正常取消的前端请求不再误报连接失败。已有失败日志保留原始事实，不改写成成功。

2.0.0 的园区车次也遵循这一边界：结构化 `visits/records`、车次与车辆ID、原始到达/核验/作业/离园及预约时间字段经过脱敏，不将材料接口中的原始业务明细写入Git日志。园区快照发布记录只保留版本、道路数、车次/车辆/完成数量等目录信息；批准的联合结果与覆盖可用于诊断。用户主动写入提问中的其他业务文本仍属于对话正文，请按团队的数据管理规则审核提交。

车辆档案新增的 `vehicles`、`vehicleId` 和 `plateNumber` 字段同样脱敏。承运商车辆保存事件仅记录承运商编号、档案数量与版本，不导出车辆明细；车辆档案保存在运行目录的加密快照中。

共享错误转换器会解开 Effect.runPromise 的 FiberFailure 包装，保留原始业务错误代码与说明，避免嵌套工具失败退化成笼统的 internal_error。模型请求步骤更新状态时保留原始协议正文，便于事后排查。

实际日志不自动删除，也不自动提交或推送。日常查看修改后，使用 `git add logs` 将新增记录纳入下一次提交。`VECTRA_LOG_DIR` 可更改目录；需要由本仓库管理时应保持默认的 `logs`。

显式执行 `bun run migrate:identities` 是一次升级清理：它会清空旧身份的对话、报告、协议材料、审计及本目录两类历史JSONL，随后记录 `identities.reissued` 和新审计代次。园区、车辆、车次与模型配置迁移保留；重复执行不会清理新身份的记录。该操作只处理当前工作目录，不改写既有Git提交。

删除对话会移除应用中的关联数据，追加 `conversation.deleted` 记录。已有诊断日志、安全审计和数据库追加事件继续留存；删除功能不清除 Git 历史。已删除会话的原始公开事件不再由页面回放接口返回，切换日志目录后也不会重新导出这些旧对话事件。

## Agent 操作

排查模型请求时，按 taskId 查找 `model.request`、`model.http_response` 和 `model.request_failed`。`baseUrl` 是规范化的基础地址，`endpoint` 是实际请求目标；HTTP 状态码会保留在失败提示中。地址输入支持完整接口路径，避免 `/chat/completions/chat/completions` 等重复拼接。日志不记录 API Key 或模型服务原始错误正文。

明确的临时服务端错误可产生 `model.retry_scheduled`，记录当前 `attempt`、`nextAttempt`、`delayMs`；`model.http_response` 逐次记录状态，最终失败记录总 `attempts`。每轮最多三次HTTP尝试，共用原响应等待时限，不重放已完成工具。错误响应最多读取16KiB，仅提取校验后的 `providerCode`、`providerType`、`providerParam`、`providerRequestId`；不保存原始错误消息、HTML、回显请求或其他任意字段。持续5xx使用 `model_service_error`，不能仅据此判断凭据配置错误。历史错误记录保留原值，页面对旧的通用5xx提示提供对应的服务商故障说明。

单次模型响应超时单独使用 `model_timeout`（HTTP 504），不再统一归入 `model_unavailable`。`model.request` 记录 `requestTimeoutMs`；`model.request_failed` 同时记录 `failureKind`、`responseStage`、已取得的 `httpStatus` 及实际 `durationMs`，可区分等待响应头、读取正文、取消和其他错误。HTTP 200 仅表示取得响应头，仍需完整读完及解析正文。模型请求默认等待 120 秒，整轮协作默认 600 秒，分别通过 `VECTRA_MODEL_TIMEOUT`、`VECTRA_TASK_TIMEOUT` 按秒设置。历史错误行保留原值。

HTTP 200 后发生工具参数 JSON 格式错误时，操作日志记录 `model.tool_arguments_invalid`，包括 Agent、请求轮次、工具、调用编号、参数长度及是否安排更正；不新增原始参数正文或可能带出正文片段的解析器异常。系统最多向同一 Agent 请求一次格式更正，计入调用预算；合法重提记录 `model.tool_arguments_corrected`，它只说明 JSON 格式通过，实际执行结果继续单独记录。对话保留原始公开模型响应、格式失败和更正记录，后续若仍失败则保留原错误，不改写历史为成功。

模型请求按实际 agent 与 model 记录，任务关联 taskId 和 conversationId。主子智能体的委派和产物回执保留在执行步骤中；记忆新增、修改、删除及自动经验保存记录 memoryId 和来源任务，不新增记忆正文日志字段。引用的长期记忆上下文与记忆工具参数在诊断中移除；原始用户消息沿用既有脱敏策略。Agent 记忆与执行记录正文保存在运行数据库的加密字段中，不把数据库纳入 Git。

独立部署的新步骤不保存集中私有材料。federation.rpc_failed 记录已脱敏的实际错误，不记录 RPC 原始报文、输入份额或台账。经营记录、SOC、电池、装载与原始里程字段进一步脱敏；仅记录本方台账发布版本与数量。迁移后的首次日志可能补写已存在的公开事件，可按 sourceId + eventId 去重。
