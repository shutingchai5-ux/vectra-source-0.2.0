# 系统验证记录

## README 结构与迁移包核验（2026-10-09）

README 按 GitHub 项目文档结构重写，包含开发环境、安装、启动停止、使用步骤、配置、开发测试、迁移分发、常见问题和独立的项目详解章节。源码运行逻辑未修改；演示截图放入 `docs/images/dashboard.jpg`，随源码迁移包分发。

已核对主入口及 setup/start/stop/package 帮助和 check 实际配置输出，命令选项与文档一致。执行迁移相关回归测试：

```powershell
python run.py test -- tests/test_launcher.py tests/test_portable_paths.py tests/test_cli_portability.py --basetemp .pytest-readme --tb=short
```

结果：**47 passed in 3.58s**，无失败、无跳过。另核对 README 目录锚点、本地文档及图片链接、源码包内 README 一致性和资源完整性，并验证迁移包排除虚拟环境、本机配置、运行数据、缓存及凭据。Linux/macOS 的实际执行状态仍按原验证边界说明。

## Ctrl+C 正常关闭修复（2026-10-09）

用户实际按 Ctrl+C 后出现 `asyncio.exceptions.CancelledError`，随后打印 `KeyboardInterrupt` 堆栈。已核对当前 Uvicorn 源码：它先执行正常关闭，再在 `capture_signals()` 中恢复处理器并重放 SIGINT；Python 3.13 的 asyncio.Runner 将其转换为 KeyboardInterrupt。此前 `lifecycle.serve()` 未处理这个正常停止异常。

本次只在 `server.run()` 边界捕获 KeyboardInterrupt，继续执行原有状态文件清理和项目锁释放，正常退出码为 0。其他服务异常仍然传播。统一启动器在收到中断后继续等待子服务，等待提示只打印一次。

回归测试覆盖中断异常链、关闭后可重新启动、意外 asyncio 取消仍然传播、真实服务错误仍然传播，以及启动器等待子服务并保留其退出码。

本次运行生命周期、启动器和迁移 CLI 的相关测试：**41 项通过**；命令为 `python run.py test -- tests/test_lifecycle.py tests/test_launcher.py tests/test_cli_portability.py --basetemp .pytest-shutdown-final --tb=short`。此前的 124 项完整测试记录保留在下一节，本次按关闭流程的修改范围运行回归测试。

在 Windows / Python 3.13.14 上创建隐藏的独立测试控制台，仅向该控制台发送真实 Ctrl+C，实际验证了三种入口：

- `.venv` Python 的 `-m vehicular.cli serve`。
- `python run.py start`；提交真实 MPC 任务后按 Ctrl+C，任务最终完成，均值为 40 km/h。
- Windows PowerShell 5.1 的 `scripts/start.ps1`。

三种入口均没有异常堆栈，退出码均为 **0**，状态文件清理且项目锁释放。随后在相同端口重新启动成功，并通过正常停止接口退出。测试未向用户终端发送信号，测试服务均已停止。

## v0.2 可迁移性验证（2026-10-09）

实际执行环境：Windows 11、Python 3.13.14、Windows PowerShell 5.1.26100.9444。下面的跨目录验证是在同一台 Windows 电脑的独立目录执行，不等同于另一台实体电脑或 Linux/macOS 实测。

统一启动入口为 `run.py`，默认使用项目内新建虚拟环境。安装依赖依据 `pyproject.toml` 选择当前平台适用版本，Windows/Python 3.13 快照只作为记录保存。

### 自动化验证

```powershell
python run.py setup --test --no-init
python run.py test -- --tb=short
```

最终完整测试：**124 passed in 60.24s**，无失败、无跳过。

新增测试覆盖：源目录、安装包目录与数据目录区分；从其他工作目录调用；中文与空格路径；配置及端口校验；源码包排除私钥、环境和缓存；损坏/已搬移的虚拟环境提示；操作系统锁防重复启动和安装；崩溃残留状态恢复；私有正常停止接口；报告密文升级、搬移解密与损坏文件保留；再次初始化保留 CA、身份、车辆数据与旧报告信任。

### 独立目录与安装包验证

1. 从 `dist/vectra-source-0.2.0.zip` 解压到中文、空格目录，未复制 `.venv`、`.env` 或 `runtime`，从无关工作目录执行 `run.py setup`：新建环境、联网安装、初始化均成功。
2. 启动独立源码服务：根页面、JS、CSS 返回成功；三个真实车辆进程计算均值 **40 km/h**；报告验签与审计通过。
3. 错误停止凭据返回 **403**；同一项目重复启动被操作系统锁拒绝；`run.py stop` 等待服务正常退出，清理当前服务状态。
4. 停止并检查迁移格式后，将完整运行数据复制到另一个新源码目录，重新创建虚拟环境：历史任务和报告保持一致，原报告验签及审计通过。
5. 用实际 wheel 替换 editable 安装，并临时移走源码包目录：模块从 `site-packages` 加载，网页、JS、CSS、历史报告和审计仍可用；独立 CLI 演示实际运行三方 MPC，均值和七项负向实验通过。
6. 当前原项目的 **3 份旧路径绑定报告**通过认证升级为可迁移格式，原报告和密钥保留。
7. Windows PowerShell 5.1 从其他工作目录按完整路径调用新 `start.ps1 -Port 8019`：HTTP **200**；新 `stop.ps1` 正常停止，再次停止成功。三个 PowerShell 脚本均具有 UTF-8 BOM 且 AST 解析无错误。
8. `pip check` 无依赖冲突。所有验证服务在完成后已停止。

机器可读的独立目录验证结果保存在 `artifacts/portability-verification.json`；它是本地验证证据，不进入默认源码迁移包。wheel 包含 `vehicular/web/index.html`、`app.js` 和 `app.css`。

### 跨系统验证边界

`.github/workflows/ci.yml` 已配置 Windows、Ubuntu、macOS × Python 3.11/3.13 六组全新安装及测试。**尚未提交或触发 GitHub Actions；当前没有 Linux/macOS 运行环境，因此未实际执行这些组合。**

当前证据支持 Windows 上从源码包重新安装、变更目录和安装 wheel 的运行路径。其他电脑需要相应 Python、可写项目目录，以及首次安装时下载依赖的网络；后续可在 CI 或目标电脑执行同一测试命令核验。

真实外部 LLM API、真实车辆、公网、多用户账户与独立主机隔离仍未验证，业务安全模型见架构文档。

## 历史记录：v0.1 实测验证

验证日期：2026-10-09。执行环境：Windows、Python 3.13.14，项目内 `.venv`；依赖版本见 `docs/dependencies-windows-python313.txt`（原 requirements.lock.txt）。

## 自动化测试

执行命令：

```powershell
.\.venv\Scripts\python.exe -m pytest -q --basetemp .pytest-final --tb=short
```

结果：**61 passed in 55.48s**，没有失败或跳过。

| 测试组 | 数量 | 验证范围 |
|---|---:|---|
| PKI、签名、加密与审计 | 15 | 证书、公钥与身份绑定；过期/禁用身份；AES-GCM认证失败；报告自带公钥不受信；审计局部篡改、截断和重算哈希；并发审计；真实Node JSON往返 |
| 真实MPC与参与端策略 | 27 | 三个独立进程；TLS1.3；参与编号和证书绑定；均值与精度；协调端不读取本地样本/密钥；掉线清理；密文损坏；任务范围与签署者 |
| API与Agent | 19 | 真实API异步执行；幂等及并发预算；持久化重放/合法乱序；未知CA实际TLS握手拒绝；会话、来源与Host；权限；报告验证；两个角色工具路径；模型失败和虚构统计拒绝 |

真实三方计算的数值用例包括默认 60/40/20 → 40、全零 → 0、12.34/45.67/89.01 → 49.01、全300 → 300，以及各车1.005按百分之一km/h半上舍入后 → 1.01。

工具模型测试使用 `httpx.MockTransport`，完整两角色流程实际调用真实MPC与审计查询。该测试验证接口及权限控制，不证明真实模型的质量或服务可用性。

## 最终端到端演示

最终格式使用 RFC8785 JCS，通信要求 TLS1.3。命令行执行记录保存在 `artifacts/e2e-verification.json`。

- 三车均值为 **40.0 km/h**，协议阶段单次耗时 **485 ms**。该值只是本次本地观测，不是性能基准。
- 原报告：登记签署者、Ed25519签名和任务绑定校验通过。
- 消息篡改：`SIGNATURE_INVALID`。
- 重放：首次消息接收，重复消息以 `replay` 拒绝。
- 身份冒用：`IDENTITY_MISMATCH`。
- 单车原始指标请求：`unauthorized`。
- 报告正文篡改：`SIGNATURE_INVALID`。
- 隔离对象密文翻转：`AEAD_INVALID`。
- 车辆C缺席：`mpc_timeout`；参与进程被回收，不发布部分结果。
- 审计链与最新签名检查点：验证通过。

七项实验的成功判定是本次明确负向用例得到预期拒绝/失败，不代表系统已经抵抗所有攻击。

## 浏览器与启动脚本

浏览器实际提交任务后看到公开均值40，原始报告回传验签通过，修改报告公开均值而保留签名后验证失败。检查了事件、重放、AES-GCM实验及掉线反馈。截图在 `artifacts/ui.jpg` 和 `artifacts/verification.jpg`。

Node `--check web/app.js` 通过，`pip check` 无依赖冲突。`scripts/setup.ps1` 在当前已安装环境中实际执行成功，完成依赖核对、editable安装与初始化；首次从空环境联网安装的流程已通过等效安装命令完成，但没有在第二台干净机器复测。

## 验证边界

本次没有配置用户的真实外部模型凭证，没有测试外部模型语义质量、费用或延迟；没有接入真实车辆、公网、多用户账户、独立宿主机或NTFS生产隔离；没有做流量抓包或正式渗透测试。密码协议按文档中声明的被动安全和本机信任假设解释，不能从负向测试推出零泄露或恶意参与方安全结论。

## Windows PowerShell 5.1 脚本兼容修复

原脚本使用不带 BOM 的 UTF-8，Windows PowerShell 5.1 按旧编码读取中文后出现字符串终止符和右括号解析错误。首次交付只实际运行了 PowerShell 7 安装脚本，没有覆盖 README 指定的 `powershell.exe`。

本次将 `setup.ps1`、`start.ps1` 和新增的 `stop.ps1` 保存为 UTF-8 BOM，并在 `.editorconfig` 中固定该编码。脚本为 Python 子进程设置 UTF-8 输出，README 分别列出安装、前台启动、自定义端口、正常停止与另一个终端强制停止的命令。

实测 Windows PowerShell **5.1.26100.9444**：

- 三个脚本 AST 解析没有错误。
- 用户原命令 `powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1` 执行成功，依赖核对、安装和初始化全部完成，中文提示正常。
- 使用 Windows PowerShell 5.1 实际执行 `start.ps1 -Port 8019`，网页响应 HTTP 200。
- `stop.ps1` 精确匹配本项目虚拟环境 Python 路径和 `vehicular.cli serve`，成功停止本项目默认端口及自定义端口的服务与其解释器子进程；同时启动的其他 Python 验证进程保持运行。
- 再次执行停止命令成功返回“本项目服务未运行，无需停止”。测试用后台进程已清理。

本次修改范围为脚本编码、启动/停止操作和说明文档，没有更改密码协议或业务代码；没有重复运行此前61项业务测试。
