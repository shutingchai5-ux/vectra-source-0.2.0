import { existsSync,readFileSync,unlinkSync } from "node:fs";
import { resolve,sep,extname } from "node:path";
import { randomUUID,randomBytes,timingSafeEqual } from "node:crypto";
import { error,asError,VERSION,decode,ClientLogsSchema,normalizePlateNumber,plateNumberError,type DeploymentConfig,type CarrierId,type JsonObject,type FederationCatalogs,type StatisticsQuery } from "@vectra/shared";
import { Security,hash,canonical,atomicWrite } from "../../server/src/security";
import { ParkData,readParkCatalog,readParkVisits,projectParkVisits } from "../../server/src/park";
import { FleetData } from "../../server/src/fleet";
import { ReservationData,readReservationCatalog,readReservationSlots,projectReservations } from "../../server/src/reservations";
import { BusinessData,businessDomain,readBusinessSnapshot,projectBusiness } from "../../server/src/business";
import { Store } from "../../server/src/store";
import { Audit } from "../../server/src/audit";
import { Diagnostics } from "../../server/src/logging";
import { CarrierRoles } from "../../server/src/carrier-role";
import { PortalAuth } from "../../server/src/portal-auth";
import { FederationTransport } from "../../server/src/federation-transport";
import { FederatedParty } from "../../server/src/federation-party";
import { readDeployment } from "../../server/src/deployment";
import { runtimeLock } from "../../server/src/lock";
import { ROOT } from "../../server/src/config";
async function createCarrier(config:DeploymentConfig,http:boolean){
  if(config.role!=="carrier")throw error("invalid_deployment","本服务只接受企业端部署配置。",500);
  const owner=config.identity as CarrierId,unlock=runtimeLock(config.dataDir);
  let cleanupStore:Store|undefined,cleanupTransport:FederationTransport|undefined,cleanupServer:ReturnType<typeof Bun.serve>|undefined;
  try{
  const security=await Security.open(resolve(config.dataDir,"pki")),store=new Store(config.dataDir),logs=new Diagnostics(config.logDir);
  cleanupStore=store;
  const park=new ParkData(security,[owner]),fleet=new FleetData(security,park,[owner]),reservations=new ReservationData(security,()=>park.catalog().settings,[owner]);
  const business=new BusinessData(security,owner,park,fleet),auth=new PortalAuth(store.db,config),roles=new CarrierRoles(store.db);
  const audit=new Audit(store,security,event=>logs.operation("audit."+event.kind,{auditEventId:event.id,details:event.details,verifiedIdentity:event.verifiedIdentity}),owner);
  const checked=audit.verify();if(!checked.valid)throw error("audit_invalid",checked.reason,500);
  const party=new FederatedParty(security,owner,(query,version)=>{
    if(query.dataset==="park_visits"){const catalog=readParkCatalog(security,version);return {catalog,records:projectParkVisits(readParkVisits(security,version,owner),query)};}
    if(query.dataset==="reservation_plans"){const catalog=readReservationCatalog(security,version);return {catalog,records:projectReservations(readReservationSlots(security,version,owner))};}
    if(query.dataset==="carrier_business"){const snapshot=readBusinessSnapshot(security,owner,businessDomain(query.domain),version);return {catalog:snapshot.catalog,records:projectBusiness(snapshot.records,query),declaration:snapshot.catalog.declaration};}
    throw error("dataset_forbidden","独立企业服务不提供旧采样计算。",403);
  });
  const transport=new FederationTransport(security,config,async(peer,kind,data)=>{
    if(kind==="catalogs"){
      if(peer!=="coordinator")throw error("federation_forbidden","只有园区可读取批准的协作目录。",403);
      return {park:park.catalog(),reservations:reservations.catalog(),business:Object.fromEntries(["demand","haulage","returns","charging"].map(domain=>[domain,business.catalog(businessDomain(domain))])) as FederationCatalogs["business"]} satisfies FederationCatalogs;
    }
    if(kind==="fleet-public"){
      if(peer!=="coordinator")throw error("federation_forbidden","车辆公开概览只向园区开放。",403);
      return fleet.forCarrier(owner);
    }
    if(kind==="sync-settings"){
      if(peer!=="coordinator")throw error("federation_forbidden","只有园区可更新公共配置。",403);
      if(canonical(park.catalog().settings)!==canonical(data.settings)){park.configure(data.settings,park.catalog().version);security.configureIdentities(park.catalog().settings);reservations.refreshSettings();}business.refreshSettings();return {accepted:true};
    }
    return party.handle(peer,kind,data);
  },cause=>logs.operation("federation.rpc_failed",{error:cause},"error"));
  cleanupTransport=transport;party.transport=transport;await transport.start();
  const instanceId=randomUUID(),controlToken=randomBytes(32).toString("base64url"),controlPath=resolve(config.dataDir,"server-control.json");logs.remember(controlToken);
  const json=(value:unknown,status=200)=>Response.json(value,{status});
  async function body(request:Request,max=4*1024*1024){
    const reader=request.body?.getReader();if(!reader)throw error("invalid_request","请求正文缺失。",422);
    const chunks:Uint8Array[]=[];let length=0;
    for(;;){const chunk=await reader.read();if(chunk.done)break;length+=chunk.value.length;if(length>max){await reader.cancel();throw error("body_too_large","请求过大。",413);}chunks.push(chunk.value);}
    try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw error("invalid_json","请求须为有效JSON。",422);}
  }
  const portal=(request:Request)=>({role:"carrier",identity:owner,carrierId:owner,username:config.username,authenticated:auth.authenticated(request),settings:park.catalog().settings,
    companyLinks:[{id:"coordinator",name:"园区端",url:config.publicPeers?.coordinator??""}]});
  const webDir=resolve(ROOT,"apps/web/dist");
  async function route(request:Request,approvedOwner?:CarrierId):Promise<Response>{
    if(approvedOwner!==undefined&&approvedOwner!==owner)throw error("carrier_scope_forbidden","登录账号与企业数据范围不一致。",403);
    const url=new URL(request.url),path=url.pathname,method=request.method;
    if(![new URL(config.publicUrl).hostname,"127.0.0.1","localhost","[::1]"].includes(url.hostname))throw error("host_forbidden","访问主机不属于本部署。",403);
    if(path==="/api/control/shutdown"&&method==="POST"){const value=request.headers.get("X-Vectra-Control")??"";if(!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||value.length!==controlToken.length||!timingSafeEqual(Buffer.from(value),Buffer.from(controlToken)))throw error("control_forbidden","服务控制凭据无效。",403);setTimeout(()=>void close(),20);return json({stopping:true});}
    if(path==="/api/health")return json({status:"ready",version:VERSION,role:"carrier",identity:owner});
    if(path==="/api/portal"&&method==="GET")return json(portal(request));
    if(path==="/api/portal/login"&&method==="POST"){const cookie=await auth.login(request,await body(request,4096));logs.operation("portal.login",{identity:owner});return new Response(JSON.stringify({...portal(request),authenticated:true}),{headers:{"Content-Type":"application/json","Set-Cookie":cookie}});}
    if(path==="/api/portal/logout"&&method==="POST")return new Response("{}",{headers:{"Content-Type":"application/json","Set-Cookie":auth.logout(request)}});
    if(path.startsWith("/api/")){
      if(approvedOwner===undefined)auth.require(request);
      if(path==="/api/session")return json({ready:true,role:"carrier"});
      if(path==="/api/identities")return json(security.nodes());
      if(path==="/api/client-logs"&&method==="POST"){const data=decode(ClientLogsSchema,await body(request,65536));for(const entry of data.entries)logs.operation("client."+entry.event,{...entry,identity:owner});return json({accepted:data.entries.length});}
      if(path==="/api/carrier-role"){
        if(method==="POST"){const data=await body(request,4096);if(data.carrierId!==owner)throw error("carrier_scope_forbidden","本企业部署不能切换为其他公司。",403);const role=roles.select(data);logs.remember(role.token);return json(role);}
        if(method==="GET")return json(roles.require(request.headers));
      }
      const role=roles.require(request.headers);if(role.carrierId!==owner)throw error("carrier_scope_forbidden","当前企业凭据与部署不一致。",403);
      if(path==="/api/carrier/fleet"&&method==="GET")return json(fleet.forCarrier(owner));
      if(path==="/api/fleet"&&method==="POST"){
        const data=await body(request);if(data.carrierId!==owner||!Array.isArray(data.vehicles))throw error("carrier_scope_forbidden","只能维护本公司车辆。",403);
        const known=new Set(fleet.profiles().map(row=>row.vehicleId)),plates:string[]=[];
        for(const vehicle of data.vehicles){const issue=plateNumberError(vehicle.plateNumber);if(issue)throw error("invalid_vehicle",issue,422);const plate=normalizePlateNumber(vehicle.plateNumber);if(!known.has(plate))plates.push(plate);}
        if(plates.length)await transport.call("coordinator","claim-plates",{plates});
        fleet.save(owner,data.vehicles,data.baseVersion,true);audit.append("carrier_vehicles_saved",{carrierId:owner,vehicleCount:fleet.profiles().length});return json(fleet.forCarrier(owner),201);
      }
      if(path==="/api/park"&&method==="GET")return json(park.catalog());
      if(path==="/api/carrier/visits"&&method==="GET")return json(park.forCarrier(owner));
      if((path==="/api/carrier/visits/queue"||path==="/api/carrier/visits/admissions")&&method==="POST"){
        const data=await body(request);fleet.assertVisitOwners([{...data,carrierId:owner}]);
        // Temporary vehicles also register their public ownership before creating a visit.
        if(!fleet.overview().vehicles.some(row=>row.vehicleId===normalizePlateNumber(data.vehicleId??"")))await transport.call("coordinator","claim-plates",{plates:[normalizePlateNumber(data.vehicleId??"")]});
        const snapshot=path.endsWith("/queue")?park.queueCarrier(owner,data):park.admitCarrier(owner,data);
        audit.append(path.endsWith("/queue")?"park_queue_registered":"park_admission_confirmed",{carrierId:owner,datasetVersion:snapshot.version});return json(snapshot,201);
      }
      if(path==="/api/carrier/visits/import"&&method==="POST"){const data=await body(request);if(!Array.isArray(data.visits)||data.visits.some((row:JsonObject)=>row.carrierId!==owner))throw error("carrier_scope_forbidden","只能导入本方车次。",403);fleet.assertVisitOwners(data.visits);const known=new Set(fleet.overview().vehicles.map(row=>row.vehicleId));const newPlates=data.visits.map((row:JsonObject)=>normalizePlateNumber(row.vehicleId as string)).filter((plate:string)=>!known.has(plate));if(newPlates.length)await transport.call("coordinator","claim-plates",{plates:newPlates});const snapshot=park.appendCarrier(owner,data.visits,data.baseVersion);audit.append("park_visits_appended",{carrierId:owner,datasetVersion:snapshot.version});return json(snapshot,201);}
      const visit=path.match(/^\/api\/carrier\/visits\/([^/]+)(?:\/(lifecycle))?$/);
      if(visit&&(method==="PUT"||method==="POST"&&visit[2]==="lifecycle")){const data=await body(request),id=decodeURIComponent(visit[1]),snapshot=visit[2]?park.advanceCarrier(owner,id,data):park.correctCarrier(owner,id,data);audit.append("park_lifecycle_recorded",{carrierId:owner,datasetVersion:snapshot.version});return json(snapshot);}
      if(path==="/api/carrier/reservations/versions"&&method==="GET")return json(reservations.versions(owner));
      if(path==="/api/carrier/reservations"){
        if(method==="GET")return json(reservations.forCarrier(owner,url.searchParams.get("version")??undefined));
        if(method==="PUT"){const data=await body(request),snapshot=reservations.replaceCarrier(owner,data.slots,data.baseVersion);audit.append("reservation_plans_saved",{carrierId:owner,datasetVersion:snapshot.version,rowCount:snapshot.slots.length});return json(snapshot);}
      }
      const ledger=path.match(/^\/api\/carrier\/business\/(demand|haulage|returns|charging)(?:\/(versions))?$/);
      if(ledger){const domain=businessDomain(ledger[1]);if(method==="GET")return json(ledger[2]?business.versions(domain):business.snapshot(domain,url.searchParams.get("version")??undefined));
        if(method==="PUT"&&!ledger[2]){const data=await body(request);if(Object.keys(data).some(key=>!["records","declaration","baseVersion"].includes(key)))throw error("invalid_request","经营台账字段无效。",422);const snapshot=business.replace(domain,data.records,data.declaration,data.baseVersion);audit.append("business_ledger_saved",{carrierId:owner,domain,datasetVersion:snapshot.version,rowCount:snapshot.records.length});return json(snapshot);}}
      throw error("portal_forbidden","本企业端不提供该园区管理或其他企业接口。",403);
    }
    const file=resolve(webDir,"."+decodeURIComponent(path));
    if((file===webDir||file.startsWith(webDir+sep))&&existsSync(file)&&extname(file))return new Response(Bun.file(file));
    return new Response(Bun.file(resolve(webDir,"index.html")), {headers:{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"}});
  }
  const server=http?Bun.serve({hostname:config.host,port:config.port,idleTimeout:60,async fetch(request){
    const requestId=randomUUID(),started=performance.now();
    try{const response=await route(request);response.headers.set("X-Request-Id",requestId);response.headers.set("X-Content-Type-Options","nosniff");response.headers.set("Referrer-Policy","same-origin");if(new URL(request.url).pathname.startsWith("/api/"))response.headers.set("Cache-Control","no-store");return response;}
    catch(cause){const value=asError(cause);logs.operation("http.failed",{requestId,path:new URL(request.url).pathname,status:value.status,code:value.code,durationMs:Math.round(performance.now()-started)},"error");return json({code:value.code,message:value.message},value.status);}
  }}):undefined;
  cleanupServer=server;if(server)atomicWrite(controlPath,canonical({instanceId,port:server.port,host:config.host,token:controlToken,pid:process.pid}));
  let stopping=false;
  async function close(){if(stopping)return;stopping=true;server?.stop(true);party.close();try{await transport.close();}finally{store.close();unlock();try{if(http&&JSON.parse(readFileSync(controlPath,"utf8")).instanceId===instanceId)unlinkSync(controlPath);}catch{}}}
  audit.append("company_service_started",{carrierId:owner,version:VERSION});
  return {server,security,store,park,fleet,reservations,business,transport,handle:route,close};
  }catch(cause){cleanupServer?.stop(true);try{await cleanupTransport?.close();}finally{cleanupStore?.close();unlock();}throw cause;}
}
export async function startCarrier(config:DeploymentConfig){const live=await createCarrier(config,true);return {...live,server:live.server!};}
export async function openCompanyNode(config:DeploymentConfig){return createCarrier(config,false);}
if(import.meta.main){
  const file=process.env.VECTRA_DEPLOYMENT_FILE;if(!file)throw error("deployment_missing","请指定本企业的VECTRA_DEPLOYMENT_FILE。",500);
  const live=await startCarrier(readDeployment(resolve(file)));
  const close=async()=>{await live.close();process.exit(0);};process.on("SIGINT",close);process.on("SIGTERM",close);
  console.log("VECTRA 企业端已启动。");
}

