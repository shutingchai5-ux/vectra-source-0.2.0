import { Database } from "bun:sqlite";
import { resolve,sep,extname } from "node:path";
import { existsSync,readFileSync,unlinkSync } from "node:fs";
import { randomUUID,randomBytes,timingSafeEqual } from "node:crypto";
import { error,asError,VERSION,PARTICIPANTS,type CarrierId,type EnterprisePortalConfig,type PortalSession } from "@vectra/shared";
import { readDeployment } from "../../server/src/deployment";
import { PortalAuth } from "../../server/src/portal-auth";
import { runtimeLock } from "../../server/src/lock";
import { Diagnostics } from "../../server/src/logging";
import { atomicWrite,canonical } from "../../server/src/security";
import { ROOT } from "../../server/src/config";
import { openCompanyNode } from "./index";

export async function startEnterprise(config:EnterprisePortalConfig){
  const unlock=runtimeLock(config.dataDir),nodes=new Map<CarrierId,Awaited<ReturnType<typeof openCompanyNode>>>();
  let database:Database|undefined,server:ReturnType<typeof Bun.serve>|undefined;
  try{
    const deployments=PARTICIPANTS.map(id=>readDeployment(config.companies[id]));
    if(new Set(deployments.map(item=>item.username)).size!==PARTICIPANTS.length||deployments.some((item,index)=>item.role!=="carrier"||item.identity!==PARTICIPANTS[index]))throw error("invalid_deployment","各公司账号须唯一，且与登记企业固定绑定。",500);
    database=new Database(resolve(config.dataDir,"accounts.sqlite3"),{create:true});
    database.exec("PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS portal_company_bindings(username TEXT PRIMARY KEY,carrier_id TEXT NOT NULL UNIQUE)");
    for(const item of deployments){
      const previous=database.query<{carrier_id:string},[string]>("SELECT carrier_id FROM portal_company_bindings WHERE username=?").get(item.username);
      if(previous&&previous.carrier_id!==item.identity)throw error("account_binding_changed","企业账号不能改绑其他公司，请保持原绑定。",409);
      const assigned=database.query<{username:string},[string]>("SELECT username FROM portal_company_bindings WHERE carrier_id=?").get(item.identity);
      if(assigned&&assigned.username!==item.username)throw error("account_binding_changed","企业已有固定账号，配置与原绑定不一致。",409);
      database.query("INSERT OR IGNORE INTO portal_company_bindings VALUES(?,?)").run(item.username,item.identity);
    }
    const auth=new PortalAuth(database,{...deployments[0],identity:"companies",publicUrl:config.publicUrl},deployments.slice(1));
    for(const item of deployments)nodes.set(item.identity as CarrierId,await openCompanyNode(item));
    const logs=new Diagnostics(config.logDir),instanceId=randomUUID(),controlToken=randomBytes(32).toString("base64url"),controlPath=resolve(config.dataDir,"server-control.json");logs.remember(controlToken);
    const ownerFor=(username:string|undefined):CarrierId|undefined=>username?database!.query<{carrier_id:CarrierId},[string]>("SELECT carrier_id FROM portal_company_bindings WHERE username=?").get(username)?.carrier_id:undefined;
    const portal=(username?:string):PortalSession=>{
      const owner=ownerFor(username),settings=nodes.get(owner??"carrier-a")!.park.catalog().settings;
      return {role:"carrier",identity:owner??"companies",username:username??"",authenticated:!!owner,...(owner?{carrierId:owner}:{}),settings,companyLinks:[{id:"coordinator",name:"园区端",url:config.parkUrl}]};
    };
    async function loginBody(request:Request){
      const bytes=await request.arrayBuffer();if(bytes.byteLength>4096)throw error("body_too_large","登录信息过大。",413);
      try{return JSON.parse(Buffer.from(bytes).toString("utf8"));}catch{throw error("invalid_json","登录信息格式无效。",422);}
    }
    const webDir=resolve(ROOT,"apps/web/dist");let stopping=false;
    async function route(request:Request){
      const url=new URL(request.url),path=url.pathname,method=request.method;
      if(![new URL(config.publicUrl).hostname,"127.0.0.1","localhost","[::1]"].includes(url.hostname))throw error("host_forbidden","访问主机不属于企业端。",403);
      if(path==="/api/control/shutdown"&&method==="POST"){
        const token=request.headers.get("X-Vectra-Control")??"";
        if(!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||Buffer.byteLength(token)!==Buffer.byteLength(controlToken)||!timingSafeEqual(Buffer.from(token),Buffer.from(controlToken)))throw error("control_forbidden","服务控制凭据无效。",403);
        setTimeout(()=>void close(),20);return Response.json({stopping:true});
      }
      if(path==="/api/health")return Response.json({status:"ready",version:VERSION,role:"carrier",identity:"companies",companies:PARTICIPANTS.length});
      if(path==="/api/portal"&&method==="GET")return Response.json(portal(auth.username(request)));
      if(path==="/api/portal/login"&&method==="POST"){
        const input=await loginBody(request),cookie=await auth.login(request,input,server?.requestIP(request)?.address??"local"),value=portal(input.username);
        if(!value.authenticated)throw error("login_failed","账号未绑定有效企业。",401);
        logs.operation("portal.login",{carrierId:value.carrierId});
        return Response.json(value,{headers:{"Set-Cookie":cookie}});
      }
      if(path==="/api/portal/logout"&&method==="POST")return Response.json({},{headers:{"Set-Cookie":auth.logout(request)}});
      if(path.startsWith("/api/")){
        const username=auth.require(request),owner=ownerFor(username);if(!owner)throw error("portal_login_required","请重新登录有效企业账号。",401);
        const response=await nodes.get(owner)!.handle(request,owner);response.headers.set("X-Company-Identity",owner);return response;
      }
      const file=resolve(webDir,"."+decodeURIComponent(path));
      if((file===webDir||file.startsWith(webDir+sep))&&existsSync(file)&&extname(file))return new Response(Bun.file(file));
      return new Response(Bun.file(resolve(webDir,"index.html")),{headers:{"Content-Type":"text/html; charset=utf-8"}});
    }
    server=Bun.serve({hostname:config.host,port:config.port,maxRequestBodySize:4*1024*1024,async fetch(request){
      const requestId=randomUUID();let response:Response;
      try{response=await route(request);}catch(cause){const value=asError(cause);logs.operation("http.failed",{requestId,path:new URL(request.url).pathname,code:value.code,status:value.status},value.status>=500?"error":"warn");response=Response.json({code:value.code,message:value.message},{status:value.status});}
      const owner=ownerFor(auth.username(request));if(owner)response.headers.set("X-Company-Identity",owner);
      response.headers.set("X-Request-Id",requestId);response.headers.set("Cache-Control","no-store");response.headers.set("X-Content-Type-Options","nosniff");response.headers.set("X-Frame-Options","DENY");response.headers.set("Referrer-Policy","same-origin");return response;
    }});
    atomicWrite(controlPath,canonical({instanceId,host:config.host,port:server.port,token:controlToken,pid:process.pid}));
    async function close(){if(stopping)return;stopping=true;server?.stop(true);try{await Promise.allSettled([...nodes.values()].map(node=>node.close()));}finally{database?.close();unlock();try{if(JSON.parse(readFileSync(controlPath,"utf8")).instanceId===instanceId)unlinkSync(controlPath);}catch{}}}
    logs.operation("enterprise_portal.started",{companies:PARTICIPANTS.length,port:server.port});
    return {server,nodes,close};
  }catch(cause){server?.stop(true);await Promise.allSettled([...nodes.values()].map(node=>node.close()));database?.close();unlock();throw cause;}
}
