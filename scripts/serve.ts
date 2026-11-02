import { config } from "../apps/server/src/config";
import { readEnterpriseDeployment } from "../apps/server/src/deployment";
import { developmentPorts, runtimeDeployment } from "./runtime";
if(process.argv.includes("--dev"))process.env.VECTRA_DEV="1";
const {identity,file,deployment}=runtimeDeployment(process.argv[2]);
const binding=process.env.VECTRA_DEV==="1"?{host:"127.0.0.1",port:developmentPorts(deployment.port,process.env.VECTRA_DEV_API_PORT).apiPort}:{host:deployment.host,port:deployment.port};
let live:{close:()=>Promise<void>};
if(deployment.role==="park"){process.env.VECTRA_DEPLOYMENT_FILE=file;live=await(await import("../apps/server/src/index")).startServer({...config(),...binding});}
else{delete process.env.VECTRA_DEPLOYMENT_FILE;live=await(await import("../apps/carrier/src/portal")).startEnterprise({...readEnterpriseDeployment(file),...binding});}
console.log("VECTRA "+(identity==="park"?"园区端":"企业统一入口")+"已启动。");
let closing=false;
async function close(code=0){if(closing)return;closing=true;try{await live.close();}catch{code=1;}process.exit(code);}
process.on("SIGINT",()=>void close());process.on("SIGTERM",()=>void close());
process.on("uncaughtException",()=>void close(1));process.on("unhandledRejection",()=>void close(1));
