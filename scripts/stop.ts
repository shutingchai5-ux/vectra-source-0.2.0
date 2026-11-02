import { existsSync,readFileSync } from "node:fs";
import { resolve,join } from "node:path";
import { ROOT,config } from "../apps/server/src/config";
import { readDeployment,readEnterpriseDeployment } from "../apps/server/src/deployment";
const args=process.argv.slice(2),shared=existsSync(resolve(ROOT,"runtime-deploy/companies/deployment.json"));
const chosen=args[0]??"park",identities=args.includes("--all")?(shared?["park","companies"]:["park","carrier-a","carrier-b","carrier-c"]):[shared&&["carrier-a","carrier-b","carrier-c"].includes(chosen)?"companies":chosen];
const roots=args.includes("--legacy")?[config().dataDir]:identities.map(id=>{const file=resolve(ROOT,process.env.VECTRA_DEPLOYMENT_FILE??"runtime-deploy/"+id+"/deployment.json");return id==="companies"?readEnterpriseDeployment(file).dataDir:readDeployment(file).dataDir;});
for(const root of roots){const path=join(root,"server-control.json");if(!existsSync(path)){console.log("该端没有运行服务："+root);continue;}
 const metadata=JSON.parse(readFileSync(path,"utf8"));if(!Number.isInteger(metadata.port)||typeof metadata.token!=="string")throw new Error("服务控制元数据无效。");
 const response=await fetch("http://127.0.0.1:"+metadata.port+"/api/control/shutdown",{method:"POST",headers:{"X-Vectra-Control":metadata.token},signal:AbortSignal.timeout(5000)});if(!response.ok)throw new Error("服务控制请求未被接受。");console.log("已请求该端完成清理后退出："+root);
}
console.log("开发监听模式请在对应 bun run dev 终端按 Ctrl+C。");
