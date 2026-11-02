import { ROOT } from "../apps/server/src/config";
import { developmentPorts, runtimeDeployment, runtimeIdentity } from "./runtime";
const targets=process.argv.includes("--all")?["park","companies"]:[runtimeIdentity(process.argv[2])];
const runtimes=targets.map(identity=>{
  const runtime=runtimeDeployment(identity);
  return {...runtime,...developmentPorts(runtime.deployment.port,process.env.VECTRA_DEV_API_PORT)};
});
const ports=runtimes.flatMap(runtime=>[runtime.publicPort,runtime.apiPort]);
if(new Set(ports).size!==ports.length)throw new Error("开发入口或后端端口冲突，请检查部署端口与 VECTRA_DEV_API_PORT。");
const children:Bun.Subprocess[]=[];
for(const {identity,file,publicPort,apiPort} of runtimes){
  const env:Record<string,string|undefined>={...process.env,VECTRA_DEPLOYMENT_FILE:file,VECTRA_RUNTIME_IDENTITY:identity,VECTRA_DEV:"1",VECTRA_DEV_API_PORT:String(apiPort)};
  delete env.VECTRA_TS_DATA_DIR;delete env.VECTRA_LOG_DIR;
  children.push(Bun.spawn([process.execPath,"--watch","scripts/serve.ts",identity],{cwd:ROOT,env,stdin:"inherit",stdout:"inherit",stderr:"inherit"}));
  children.push(Bun.spawn([process.execPath,"node_modules/vite/bin/vite.js","--config","apps/web/vite.config.ts"],{cwd:ROOT,env,stdin:"inherit",stdout:"inherit",stderr:"inherit"}));
  console.log((identity==="park"?"园区端":"企业统一入口")+" 开发入口：http://127.0.0.1:"+publicPort+" · Vue HMR + Bun watch");
}
let closing = false;
async function close(code = 0) {
  if (closing) return; closing = true;
  for (const child of children) child.kill("SIGTERM");
  await Promise.allSettled(children.map(child => child.exited)); process.exit(code);
}
process.on("SIGINT", () => close()); process.on("SIGTERM", () => close());
const exits = await Promise.race(children.map(async child => ({ child, code: await child.exited })));
await close(exits.code);
