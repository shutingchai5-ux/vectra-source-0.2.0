import { existsSync,mkdirSync,readFileSync,copyFileSync,writeFileSync,mkdtempSync,renameSync,rmSync } from "node:fs";
import { resolve,join,relative,sep,dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { Database } from "bun:sqlite";
import { createServer as createNetServer } from "node:net";
import { PARTICIPANTS,REGISTERED_IDENTITIES,defaultParkSettings,error,type DeploymentConfig,type CarrierId,type ParkSettings,type ParkVisit,type ParkVehicle } from "@vectra/shared";
import { Security,atomicWrite,canonical,unseal,hash } from "./security";
import { ParkData,readParkVisits } from "./park";
import { FleetData } from "./fleet";
import { ReservationData,readReservationSlots } from "./reservations";
import { BusinessData } from "./business";
interface DeploymentSummary{root:string;deployments:Array<{identity:string;config:string;url:string;credentials:string}>;enterprisePortal?:{config:string;url:string}}
function companyPortal(root:string,summary:DeploymentSummary,logsRoot?:string):DeploymentSummary{
  const park=summary.deployments.find(item=>item.identity==="coordinator")!,first=summary.deployments.find(item=>item.identity==="carrier-a")!;
  const firstConfig=JSON.parse(readFileSync(first.config,"utf8")) as DeploymentConfig,folder=join(root,"companies"),file=join(folder,"deployment.json");
  const configured=existsSync(file)?JSON.parse(readFileSync(file,"utf8")):undefined,portalUrl=configured?.publicUrl??firstConfig.publicUrl,portalPort=configured?.port??firstConfig.port;
  const publicPeers={coordinator:park.url,...Object.fromEntries(PARTICIPANTS.map(id=>[id,portalUrl]))};
  for(const item of summary.deployments){const raw=JSON.parse(readFileSync(item.config,"utf8"));raw.publicPeers=publicPeers;if(item.identity!=="coordinator"){raw.publicUrl=portalUrl;raw.port=portalPort;item.url=portalUrl;if(existsSync(item.credentials)){const credentials=JSON.parse(readFileSync(item.credentials,"utf8"));credentials.portal=portalUrl;atomicWrite(item.credentials,canonical(credentials));}}atomicWrite(item.config,canonical(raw));}
  mkdirSync(folder,{recursive:true});
  const logDir=logsRoot?join(resolve(logsRoot),"companies"):resolve(dirname(first.config),firstConfig.logDir,"..","companies");
  if(!existsSync(file))atomicWrite(file,canonical({role:"companies",host:firstConfig.host,port:portalPort,publicUrl:portalUrl,parkUrl:park.url,dataDir:".",logDir:relative(folder,logDir),companies:Object.fromEntries(PARTICIPANTS.map(id=>[id,"../"+id+"/deployment.json"]))}));
  summary.enterprisePortal={config:file,url:portalUrl};atomicWrite(join(root,"deployments.json"),canonical(summary));return summary;
}
export async function provisionDeployments(root:string,options:{legacyRoot?:string;logsRoot?:string;apiPorts?:number[];federationPorts?:number[];publicHosts?:string[];federationHosts?:string[]}={}){
  root=resolve(root);mkdirSync(root,{recursive:true});
  const marker=join(root,"deployments.json");
  if(existsSync(marker))return companyPortal(root,JSON.parse(readFileSync(marker,"utf8")) as DeploymentSummary,options.logsRoot);
  if(["park",...PARTICIPANTS].some(id=>existsSync(join(root,id))))throw error("deployment_exists","目标含未确认的部署目录，请核对后使用空目录，已有数据未改写。",409);
  const legacy=options.legacyRoot?resolve(options.legacyRoot):undefined;
  if(legacy===root)throw error("invalid_deployment","迁移来源和部署目标不能相同。",422);
  if(legacy&&existsSync(join(legacy,"server.lock.json"))){
    const lock=JSON.parse(readFileSync(join(legacy,"server.lock.json"),"utf8"));let alive=false;
    try{process.kill(lock.pid,0);alive=true;}catch{}
    if(alive){
      // Embedded development hosts may outlive their stopped HTTP service. Do not
      // confuse a reused/live host PID with a service that is still listening.
      let stopped=false;
      const controlFile=join(legacy,"server-control.json");
      if(existsSync(controlFile)){
        const control=JSON.parse(readFileSync(controlFile,"utf8"));
        if(control.pid===lock.pid&&["127.0.0.1","localhost","::1"].includes(control.host)&&Number.isInteger(control.port)&&control.port>=1024&&control.port<=65535){
          try{await fetch("http://"+(control.host==="::1"?"[::1]":control.host)+":"+control.port+"/api/health",{signal:AbortSignal.timeout(2000)});}
          catch(cause){if((cause as NodeJS.ErrnoException).code==="ECONNREFUSED"){
            const probe=createNetServer();
            stopped=await new Promise<boolean>(resolve=>{probe.once("error",()=>resolve(false));probe.listen(control.port,control.host,()=>probe.close(()=>resolve(true)));});
          }}
        }
      }
      if(!stopped)throw error("migration_running","迁移前请先停止旧服务，确保对话和审计快照一致。",409);
    }
  }
  const stage=mkdtempSync(join(root,".provision-")),seed=join(stage,"seed"),oldPki=legacy?join(legacy,"pki"):undefined;
  let old:Security|undefined;
  try{
    if(oldPki&&existsSync(join(oldPki,"registry.json"))){
      mkdirSync(seed,{recursive:true});
      for(const name of ["ca.crt","ca.key","registry.json","storage.key"])copyFileSync(join(oldPki,name),join(seed,name));
      for(const id of REGISTERED_IDENTITIES){mkdirSync(join(seed,id),{recursive:true});for(const name of ["tls.crt","tls.key","signing.key","input.key"])copyFileSync(join(oldPki,id,name),join(seed,id,name));}
      old=await Security.open(oldPki);
    }
    const source=await Security.open(seed);
    if(old)await source.reissueParticipants();
    let settings:ParkSettings=defaultParkSettings(),oldVisits:ParkVisit[]=[],oldProfiles:ParkVehicle[]=[],oldReservationVersion:string|undefined;
    let oldCapacity:import("@vectra/shared").CapacitySlot[]=[];
    if(old){
      const catalog=JSON.parse(readFileSync(join(old.root,"park","catalog.json"),"utf8"));settings=catalog.settings;
      oldVisits=PARTICIPANTS.flatMap(id=>readParkVisits(old!,catalog.version,id));
      const fleet=JSON.parse(readFileSync(join(old.root,"fleet","catalog.json"),"utf8"));
      oldProfiles=PARTICIPANTS.flatMap(id=>unseal(JSON.parse(readFileSync(join(old!.root,"fleet",fleet.version,id+".enc.json"),"utf8")),readFileSync(join(old!.root,id,"input.key")),"fleet:"+fleet.version+":"+id) as ParkVehicle[]);
      const reservations=join(old.root,"reservations","catalog.json");
      if(existsSync(reservations)){const value=JSON.parse(readFileSync(reservations,"utf8"));oldReservationVersion=value.version;oldCapacity=value.capacitySlots;}
    }else settings={...settings,carriers:settings.carriers.map((carrier,index)=>({...carrier,name:"贸易公司 "+String.fromCharCode(65+index)}))};
    source.configureIdentities(settings);
    const identities=["coordinator",...PARTICIPANTS],apiPorts=options.apiPorts??[8000,8101,8102,8103],fedPorts=options.federationPorts??[8500,8501,8502,8503];
    const publicPeers=Object.fromEntries(identities.map((id,index)=>[id,"http://"+(options.publicHosts?.[index]??"127.0.0.1")+":"+apiPorts[index]]));
    const peers=Object.fromEntries(identities.map((id,index)=>[id,"tls://"+(options.federationHosts?.[index]??"127.0.0.1")+":"+fedPorts[index]]));
    const deployments:Array<{identity:string;config:string;url:string;credentials:string}>=[];
    for(const [index,identity]of identities.entries()){
      const id=index===0?"park":identity,target=join(stage,id),pki=join(target,"pki");mkdirSync(pki,{recursive:true});
      for(const name of ["ca.crt","registry.json"])copyFileSync(join(seed,name),join(pki,name));
      for(const node of REGISTERED_IDENTITIES){mkdirSync(join(pki,node),{recursive:true});copyFileSync(join(seed,node,"tls.crt"),join(pki,node,"tls.crt"));}
      const owned=index===0?REGISTERED_IDENTITIES.filter(node=>!PARTICIPANTS.includes(node as CarrierId)):[identity];
      for(const node of owned)for(const name of ["tls.key","signing.key","input.key"])copyFileSync(join(seed,node,name),join(pki,node,name));
      if(index===0){copyFileSync(join(seed,"ca.key"),join(pki,"ca.key"));copyFileSync(join(seed,"storage.key"),join(pki,"storage.key"));}
      else atomicWrite(join(pki,"storage.key"),randomBytes(32));
      const security=await Security.open(pki),owners=index===0?[]:[identity as CarrierId],park=new ParkData(security,owners);
      park.configure(settings,park.catalog().version);
      const fleet=new FleetData(security,park,owners),reservations=new ReservationData(security,()=>park.catalog().settings,owners);
      if(index>0){
        park.import(oldVisits.filter(row=>row.carrierId===identity),park.catalog().version);
        const profiles=oldProfiles.filter(row=>row.carrierId===identity).map(({updatedAt:_updated,...row})=>row);
        if(profiles.length)fleet.save(identity,profiles,fleet.catalog().version,true);
        if(old&&oldReservationVersion)reservations.importSnapshot(readReservationSlots(old,oldReservationVersion,identity),[]);
        new BusinessData(security,identity as CarrierId,park,fleet);
      }else{
        if(oldCapacity.length)reservations.importSnapshot([],oldCapacity);
        if(legacy&&existsSync(join(legacy,"vectra.sqlite3"))){
          const database=new Database(join(legacy,"vectra.sqlite3"),{readonly:true});writeFileSync(join(target,"vectra.sqlite3"),database.serialize());database.close();
          for(const file of ["audit.checkpoint.json","model-settings.enc.json","identity-generation.json"])if(existsSync(join(legacy,file)))copyFileSync(join(legacy,file),join(target,file));
          for(const agent of ["planner","analyst"]){const file=join(legacy,"agents",agent,"model-settings.enc.json");if(existsSync(file)){mkdirSync(join(target,"agents",agent),{recursive:true});copyFileSync(file,join(target,"agents",agent,"model-settings.enc.json"));}}
        }
        const db=new Database(join(target,"vectra.sqlite3"),{create:true});
        db.exec("CREATE TABLE IF NOT EXISTS federation_vehicle_owners(plate_hash TEXT PRIMARY KEY,owner TEXT NOT NULL)");
        for(const row of [...oldProfiles,...oldVisits]){const current=db.query<{owner:string},[string]>("SELECT owner FROM federation_vehicle_owners WHERE plate_hash=?").get(hash(row.vehicleId));if(current&&current.owner!==row.carrierId)throw error("migration_ownership","旧数据中存在跨企业车牌归属冲突。",409);db.query("INSERT OR IGNORE INTO federation_vehicle_owners VALUES(?,?)").run(hash(row.vehicleId),row.carrierId);}
        db.close();
      }
      const password=randomBytes(24).toString("base64url"),username=index===0?"park-admin":identity;
      const final=join(root,id),deployment:DeploymentConfig={role:index===0?"park":"carrier",identity:identity as DeploymentConfig["identity"],dataDir:".",
        logDir:options.logsRoot?relative(final,join(resolve(options.logsRoot),id)):"logs",host:"127.0.0.1",port:apiPorts[index],publicUrl:publicPeers[identity],
        federation:{host:"127.0.0.1",port:fedPorts[index],peers},publicPeers,username,passwordHash:await Bun.password.hash(password,{algorithm:"argon2id"})};
      atomicWrite(join(target,"deployment.json"),canonical(deployment));
      atomicWrite(join(target,"first-login.json"),canonical({username,password,portal:deployment.publicUrl,note:"初始凭据仅保存在本部署目录，不应提交Git或分发给其他企业。"}));
      deployments.push({identity,config:join(final,"deployment.json"),url:deployment.publicUrl,credentials:join(final,"first-login.json")});
    }
    // Every bundle is fully validated before any deployment becomes available.
    for(const id of ["park",...PARTICIPANTS])renameSync(join(stage,id),join(root,id));
    const result={root,deployments};atomicWrite(marker,canonical(result));return companyPortal(root,result,options.logsRoot);
  }finally{
    const resolved=resolve(stage),prefix=root+sep;if(!resolved.startsWith(prefix))throw new Error("Unexpected provisioning cleanup path");
    rmSync(resolved,{recursive:true,force:true});
  }
}

