import { resolve } from "node:path";
import { readDeployment,readEnterpriseDeployment } from "../apps/server/src/deployment";
const root=resolve(import.meta.dir,".."),all=["park","companies"];
const chosen=process.argv[2]??"park";
const targets=process.argv.includes("--all")?all:[["carrier-a","carrier-b","carrier-c"].includes(chosen)?"companies":chosen];
if(targets.some(id=>!all.includes(id)))throw new Error("请选择 park、companies 或 --all。");
const children:Bun.Subprocess[]=[];
for(const identity of targets){
  const file=resolve(root,process.env.VECTRA_DEPLOYMENT_FILE??"runtime-deploy/"+identity+"/deployment.json"),deployment=identity==="park"?readDeployment(file):readEnterpriseDeployment(file);
  const env:Record<string,string|undefined>={...process.env,VECTRA_DEPLOYMENT_FILE:file,VECTRA_DEV:"1",VECTRA_PORT:String(deployment.port),VECTRA_WEB_PORT:String(5173+all.indexOf(identity))};
  delete env.VECTRA_TS_DATA_DIR;delete env.VECTRA_LOG_DIR;
  children.push(Bun.spawn([process.execPath,"--watch","scripts/serve.ts",identity],{cwd:root,env,stdin:"inherit",stdout:"inherit",stderr:"inherit"}));
  children.push(Bun.spawn([process.execPath,"node_modules/vite/bin/vite.js","--config","apps/web/vite.config.ts"],{cwd:root,env,stdin:"inherit",stdout:"inherit",stderr:"inherit"}));
  console.log((deployment.role==="park"?"园区端":"企业统一入口")+" 开发入口：http://127.0.0.1:"+env.VECTRA_WEB_PORT+" · Vue HMR + Bun watch");
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
