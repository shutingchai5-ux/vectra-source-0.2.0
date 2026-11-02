import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT,config } from "../apps/server/src/config";
import { readEnterpriseDeployment } from "../apps/server/src/deployment";
const requested=process.argv[2]??"park",identity=["companies","carrier-a","carrier-b","carrier-c"].includes(requested)?"companies":requested;
if(!["park","companies"].includes(identity))throw new Error("请选择 park 或 companies；企业由登录账号区分。");
const file=resolve(ROOT,process.env.VECTRA_DEPLOYMENT_FILE??"runtime-deploy/"+identity+"/deployment.json");
if(!existsSync(file))throw new Error("部署尚未初始化，请先运行 bun run deploy:init。");
let live:{close:()=>Promise<void>};
if(identity==="park"){process.env.VECTRA_DEPLOYMENT_FILE=file;live=await(await import("../apps/server/src/index")).startServer(config());}
else{delete process.env.VECTRA_DEPLOYMENT_FILE;live=await(await import("../apps/carrier/src/portal")).startEnterprise(readEnterpriseDeployment(file));}
console.log("VECTRA "+(identity==="park"?"园区端":"企业统一入口")+"已启动。");
let closing=false;
async function close(code=0){if(closing)return;closing=true;try{await live.close();}catch{code=1;}process.exit(code);}
process.on("SIGINT",()=>void close());process.on("SIGTERM",()=>void close());
process.on("uncaughtException",()=>void close(1));process.on("unhandledRejection",()=>void close(1));
