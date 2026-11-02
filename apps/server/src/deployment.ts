import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { error, PARTICIPANTS, type DeploymentConfig,type EnterprisePortalConfig } from "@vectra/shared";
export function readDeployment(file:string):DeploymentConfig {
  const value=JSON.parse(readFileSync(file,"utf8")) as DeploymentConfig;
  if(!["park","carrier"].includes(value.role)||(value.role==="park"?value.identity!=="coordinator":!PARTICIPANTS.includes(value.identity as typeof PARTICIPANTS[number]))||
    typeof value.username!=="string"||!value.username||typeof value.passwordHash!=="string"||!value.passwordHash.startsWith("$argon2")||
    !Number.isInteger(value.port)||value.port<1024||value.port>65535||!Number.isInteger(value.federation?.port)||value.federation.port<1024||value.federation.port>65535)throw error("invalid_deployment","部署身份、端口或登录配置无效。",500);
  const publicUrl=new URL(value.publicUrl);
  if(!["http:","https:"].includes(publicUrl.protocol)||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash)throw error("invalid_deployment","公开访问地址无效。",500);
  if(publicUrl.protocol==="http:"&&!["127.0.0.1","localhost","[::1]"].includes(publicUrl.hostname))throw error("invalid_deployment","远程登录入口须使用HTTPS，可在反向代理终止TLS。",500);
  for(const id of ["coordinator",...PARTICIPANTS]){
    const peer=new URL(value.federation.peers[id]);
    if(peer.protocol!=="tls:"||!peer.port||peer.username||peer.password||peer.search||peer.hash||!["","/"].includes(peer.pathname))throw error("invalid_deployment","协作端点须为不含凭据的 tls://主机:端口，使用双向认证的TLS 1.3协议。",500);
  }
  return {...value,dataDir:resolve(dirname(file),value.dataDir),logDir:resolve(dirname(file),value.logDir)};
}
export function configuredDeployment(root:string):DeploymentConfig|undefined {
  const explicit=process.env.VECTRA_DEPLOYMENT_FILE;
  if(!explicit)return undefined;
  const file=resolve(root,explicit||"runtime-deploy/park/deployment.json");
  if(explicit&&!existsSync(file))throw error("deployment_missing","指定的部署文件不存在，请先初始化部署。",500);
  return existsSync(file)?readDeployment(file):undefined;
}
export function readEnterpriseDeployment(file:string):EnterprisePortalConfig{
  const value=JSON.parse(readFileSync(file,"utf8")) as EnterprisePortalConfig;
  const url=new URL(value.publicUrl);
  if(value.role!=="companies"||!Number.isInteger(value.port)||value.port<1024||value.port>65535||typeof value.host!=="string"||!value.host||!["http:","https:"].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=="/"||url.protocol==="http:"&&!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||!value.companies||Object.keys(value.companies).sort().join()!==[...PARTICIPANTS].sort().join())throw error("invalid_deployment","企业统一入口的监听地址或公司配置无效。",500);
  return {...value,dataDir:resolve(dirname(file),value.dataDir),logDir:resolve(dirname(file),value.logDir),companies:Object.fromEntries(PARTICIPANTS.map(id=>[id,resolve(dirname(file),value.companies[id])])) as EnterprisePortalConfig["companies"]};
}

