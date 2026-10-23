import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "../apps/server/src/config";
const path = join(config().dataDir, 'server-control.json');
if (!existsSync(path)) { console.log('没有当前数据目录的运行服务。'); process.exit(0); }
const metadata = JSON.parse(readFileSync(path, 'utf8'));
if (!['127.0.0.1','localhost','::1'].includes(metadata.host) || !Number.isInteger(metadata.port) || typeof metadata.token !== 'string') throw new Error('服务控制元数据无效。');
const host = metadata.host === '::1' ? '[::1]' : metadata.host;
const response = await fetch(`http://${host}:${metadata.port}/api/control/shutdown`, { method: 'POST', headers: { 'X-Vectra-Control': metadata.token }, signal: AbortSignal.timeout(5000) });
if (!response.ok) throw new Error('服务控制请求未被接受。');
console.log('已请求服务取消未完成任务并清理退出。开发监听模式请在 bun run dev 的终端按 Ctrl+C。');
