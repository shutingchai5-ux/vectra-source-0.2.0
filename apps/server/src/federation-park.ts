import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PARTICIPANTS,PARK_ENTRANCES,BUSINESS_DOMAINS,BUSINESS_DOMAIN_FIELDS,CHARGE_CONNECTORS,statisticsFrames,error,
 type CarrierId,type FederationCatalogs,type FederationManifest,type DataCatalog,type BusinessCatalog,type BusinessDomain,type StatisticsQuery,type Aggregate,type SignedEnvelope,
 type ChargeCapacitySlot,type ChargeCapacityWindow,type BusinessContext,type JsonObject,type FleetOverview } from "@vectra/shared";
import { atomicWrite,canonical,hash,type Security } from "./security";
import { FederationTransport } from "./federation-transport";
import { validateStatisticsOutput } from "./statistics";
import { validateChargeCapacities } from "./business";
import type { ParkData } from "./park";
import type { ReservationData } from "./reservations";
import type { Trace } from "./transport";
import { signingSections } from "./protocol";
export class FederatedPark {
  transport!:FederationTransport;
  catalogs?:FederationCatalogs;
  private directory:Partial<Record<CarrierId,FederationCatalogs>>={};
  private active=new Map<string,Promise<unknown>>();
  constructor(private security:Security,private park:ParkData,private reservations:ReservationData,private timeout:number){
    mkdirSync(join(security.root,"federation-manifests"),{recursive:true});
    mkdirSync(join(security.root,"charging-capacity"),{recursive:true});
    if(!existsSync(join(security.root,"charging-capacity","current.json")))this.saveCharge({slots:[],baseVersion:null});
  }
  async refresh(signal?:AbortSignal){
    await Promise.all(PARTICIPANTS.map(id=>this.transport.call(id,"sync-settings",{settings:this.park.catalog().settings},signal)));
    const entries=await Promise.all(PARTICIPANTS.map(async id=>[id,await this.transport.call(id,"catalogs",{},signal) as FederationCatalogs] as const));
    for(const[id,catalogs]of entries){
      if(!catalogs?.park?.version||!catalogs.reservations?.version||!catalogs.business)throw error("federation_catalog","企业目录不完整。",502);
      this.directory[id]=catalogs;
    }
    const park=this.merge("park_visits") as FederationCatalogs["park"],reservations=this.merge("reservation_plans") as FederationCatalogs["reservations"];
    const business=Object.fromEntries((Object.keys(BUSINESS_DOMAINS) as BusinessDomain[]).map(domain=>[domain,this.merge("carrier_business",domain)])) as FederationCatalogs["business"];
    this.catalogs={park,reservations,business};return this.catalogs;
  }
  private merge(dataset:FederationManifest["dataset"],domain?:BusinessDomain):DataCatalog{
    const source=(id:CarrierId)=>dataset==="park_visits"?this.directory[id]!.park:dataset==="reservation_plans"?this.directory[id]!.reservations:this.directory[id]!.business[domain!];
    const sources=Object.fromEntries(PARTICIPANTS.map(id=>[id,{version:source(id).version,catalogDigest:hash(source(id))}])) as FederationManifest["sources"];
    const settings=this.park.catalog().settings,charge=this.charge(),capacity=this.reservations.catalog();
    const identity={dataset,...(domain?{domain}:{}),settings,sources,...(domain==="charging"?{chargingCapacityVersion:charge.version}:{}),...(dataset==="reservation_plans"?{capacityVersion:capacity.version}:{})};
    const digest=hash(identity),version=[digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join("-");
    const updatedAt=Math.max(...PARTICIPANTS.map(id=>source(id).updatedAt),dataset==="reservation_plans"?capacity.updatedAt:0,domain==="charging"?charge.updatedAt:0);
    const manifest:FederationManifest={...identity,version,updatedAt};
    const file=join(this.security.root,"federation-manifests",version+".json");if(!existsSync(file))atomicWrite(file,canonical(manifest));
    const catalog={dataset,...(domain?{domain}:{}),version,source:"import" as const,updatedAt,settings,
      sampleCount:PARTICIPANTS.reduce((sum,id)=>sum+source(id).sampleCount,0),vehicleCount:PARTICIPANTS.reduce((sum,id)=>sum+source(id).vehicleCount,0),
      nodes:PARTICIPANTS.map(id=>({id,sampleCount:source(id).sampleCount,vehicleCount:source(id).vehicleCount})),
      roads:PARK_ENTRANCES.map(id=>{const rows=PARTICIPANTS.flatMap(owner=>source(owner).roads.filter(road=>road.id===id));
        return {id,sampleCount:rows.reduce((sum,row)=>sum+row.sampleCount,0),vehicleCount:rows.reduce((sum,row)=>sum+row.vehicleCount,0),start:Math.min(...rows.map(row=>row.start).filter(Boolean),Date.now()),end:Math.max(0,...rows.map(row=>row.end)),fields:[...new Set(rows.flatMap(row=>row.fields))]};})};
    if(dataset==="park_visits")return {...catalog,visitCount:catalog.sampleCount,completedCount:PARTICIPANTS.reduce((sum,id)=>sum+this.directory[id]!.park.completedCount,0)} as FederationCatalogs["park"];
    if(dataset==="reservation_plans")return {...catalog,slotMinutes:30,capacitySlots:capacity.capacitySlots,planCount:catalog.sampleCount} as FederationCatalogs["reservations"];
    return catalog as BusinessCatalog;
  }
  manifest(version:string):FederationManifest {
    if(!/^[a-f0-9-]{36}$/.test(version))throw error("invalid_dataset","联合快照版本无效。",403);
    return JSON.parse(readFileSync(join(this.security.root,"federation-manifests",version+".json"),"utf8"));
  }
  businessContext(query:StatisticsQuery,manifest:FederationManifest):BusinessContext{
    const sourceVersions=Object.fromEntries(PARTICIPANTS.map(id=>[id,manifest.sources[id].version]));
    let chargingWindows:ChargeCapacityWindow[]|undefined;
    if(query.domain==="charging"){
      const capacity=this.charge(manifest.chargingCapacityVersion);
      chargingWindows=statisticsFrames(query).flatMap(frame=>(Object.keys(CHARGE_CONNECTORS) as ChargeCapacitySlot["connector"][]).map(connector=>{
        const slots=capacity.slots.filter(slot=>slot.road===frame.road&&slot.connector===connector&&slot.slotStart<frame.end&&slot.slotStart+1800000>frame.start);
        const expectedSlots=Math.max(0,Math.ceil(frame.end/1800000)-Math.floor(frame.start/1800000));
        const aligned=frame.start%1800000===0&&frame.end%1800000===0;
        return {road:frame.road,start:frame.start,end:frame.end,connector,capacityKwh:aligned&&expectedSlots>0&&slots.length===expectedSlots?slots.reduce((sum,slot)=>sum+slot.capacityKwh,0):null,coveredSlots:slots.length,expectedSlots};
      }));
    }
    return {domain:query.domain!,sourceVersions,...(chargingWindows?{chargingWindows}:{}),
      note:query.domain==="haulage"?"本方关联已离园车次后本地派生，同批完整记录参与比值统计。":"未来申报不是实际发生；需求按批准的计划到达或最晚到达选取，每条只计一次，建议不自动改写计划。充电容量比较须使用完整半小时边界；截断时段不按完整电量预算推算缺口。"};
  }
  charge(version?:string):{version:string;updatedAt:number;slots:ChargeCapacitySlot[]} {
    return JSON.parse(readFileSync(join(this.security.root,"charging-capacity",version&&/^[a-f0-9-]{36}$/.test(version)?version+".json":"current.json"),"utf8"));
  }
  saveCharge(input:JsonObject){
    const pointer=join(this.security.root,"charging-capacity","current.json"),current=existsSync(pointer)?this.charge():undefined;
    if(current&&input.baseVersion!==current.version)throw error("capacity_changed","园区充电容量已更新，请刷新核对。",409);
    const slots=validateChargeCapacities(input.slots),now=Date.now(),key=(row:ChargeCapacitySlot)=>row.road+":"+row.slotStart+":"+row.connector;
    if(current){
      const old=new Map(current.slots.map(row=>[key(row),row])),next=new Map(slots.map(row=>[key(row),row]));
      for(const row of [...current.slots,...slots])if(row.slotStart<=now&&canonical(old.get(key(row))??null)!==canonical(next.get(key(row))??null)){
        if(old.has(key(row))&&!next.has(key(row))&&row.slotStart+1800000<=now)continue;
        throw error("invalid_reservation","已经开始的充电容量不可修改；结束后可归档。",422);
      }
    }
    const value={version:randomUUID(),updatedAt:now,slots};
    atomicWrite(join(this.security.root,"charging-capacity",value.version+".json"),canonical(value));atomicWrite(pointer,canonical(value));return value;
  }
  async fleet(signal?:AbortSignal):Promise<FleetOverview>{
    const values=await Promise.all(PARTICIPANTS.map(id=>this.transport.call(id,"fleet-public",{},signal) as Promise<FleetOverview>));
    const vehicles=values.flatMap(value=>value.vehicles),owners=new Map<string,string>();
    for(const vehicle of vehicles){const owner=owners.get(vehicle.vehicleId);if(owner&&owner!==vehicle.carrierId)throw error("fleet_ownership_conflict","跨企业车辆归属冲突，请核对车牌登记。",409);owners.set(vehicle.vehicleId,vehicle.carrierId);}
    const versions=hash(values.map(value=>[value.version,value.parkVersion]));
    return {version:versions,updatedAt:Math.max(...values.map(value=>value.updatedAt)),parkVersion:versions,parkUpdatedAt:Math.max(...values.map(value=>value.parkUpdatedAt)),settings:this.park.catalog().settings,roads:[...PARK_ENTRANCES],vehicles};
  }
  async run(task:SignedEnvelope,trace:Trace,signal:AbortSignal):Promise<Aggregate>{
    const id=String(task.payload.taskId);
    if(this.active.size)throw error("mpc_busy","联合计算通道繁忙。",409);
    const job=this.execute(task,trace,signal);this.active.set(id,job);
    try{return await job;}finally{this.active.delete(id);}
  }
  private async execute(task:SignedEnvelope,trace:Trace,signal:AbortSignal):Promise<Aggregate>{
    const id=String(task.payload.taskId),controller=new AbortController(),timer=setTimeout(()=>controller.abort(),this.timeout);
    const combined=AbortSignal.any([signal,controller.signal]);
    try{
      await Promise.all(PARTICIPANTS.map(async owner=>{
        const result=await this.transport.call(owner,"prepare",{task},combined) as JsonObject;
        if(result.prepared!==true)throw error("mpc_party_failed","企业尚未准备联合计算。",503);
        trace({agent:owner,kind:"mpc",phase:4,action:"生成秘密分享多项式",detail:"企业服务已校验签名任务与本方冻结版本，在本地计算必要统计量，并独立生成秘密份额。私有明细和密钥保留在该企业部署。",protocol:"TLS 1.3 / Ed25519 / Shamir"});
      }));
      await Promise.all(PARTICIPANTS.map(async owner=>{
        const result=await this.transport.call(owner,"start",{taskId:id},combined) as JsonObject;
        trace({agent:owner,kind:"exchange",phase:5,action:"完成跨端份额交换",detail:"本企业已通过双向认证的加密连接交换对应份额，当前已接收"+String(result.receivedShares)+"个来源的输入份额。",protocol:"TLS 1.3 mTLS / Shamir",metadata:{receivedShares:result.receivedShares}});
      }));
      for(;;){
        combined.throwIfAborted();
        const statuses=await Promise.all(PARTICIPANTS.map(owner=>this.transport.call(owner,"status",{taskId:id},combined) as Promise<JsonObject>));
        if(statuses.some(status=>status.errorCode))throw error("mpc_party_failed","某企业未完成联合计算，未发布结果。",503);
        if(statuses.every(status=>status.complete===true)){
          const result=this.security.verify(statuses[0].output,"carrier-a"),query=task.payload.statistics as StatisticsQuery;
          if(result.taskId!==id||result.requestDigest!==task.payload.requestDigest||result.datasetVersion!==task.payload.datasetVersion||canonical(result.query)!==canonical(query)||
            canonical(result.federationManifest)!==canonical(task.payload.federationManifest)||canonical(result.parkContext)!==canonical(task.payload.parkContext)||
            canonical(result.reservationContext??null)!==canonical(task.payload.reservationContext??null)||canonical(result.businessContext??null)!==canonical(task.payload.businessContext??null))throw error("mpc_output_invalid","联合输出与冻结任务不一致。",403);
          const groups=validateStatisticsOutput(result.groups,query);
          trace({agent:"carrier-a",kind:"mpc",phase:6,action:"重构总和并签署批准输出",detail:"已收齐三个企业的聚合份额，完成一致性检查、联合结果重构和结果签名；园区已核对任务与数据版本绑定。",protocol:"Shamir / Ed25519",protocolDetails:{objective:"只发布批准的联合指标，并保留可核验来源。",operations:["收齐三个独立企业的聚合份额，校验线性关系后恢复联合充分统计量。","按冻结指标计算均值、加权比值与有效记录，缺失字段不补零。","使用本企业 Ed25519 签名；园区核验公钥、任务摘要、所有来源版本和结果结构。"],sections:signingSections(this.security,statuses[0].output as SignedEnvelope),checks:[{name:"结果签名与冻结任务绑定",status:"passed"}]}});
          return {road:String(result.road),windowSeconds:Number(result.windowSeconds),participantCount:3,protocol:String(result.protocol),query,groups,datasetVersion:String(result.datasetVersion),
            federationManifest:task.payload.federationManifest as unknown as FederationManifest,...(task.payload.parkContext?{parkContext:task.payload.parkContext as Aggregate["parkContext"]}:{}),
            ...(task.payload.reservationContext?{reservationContext:task.payload.reservationContext as Aggregate["reservationContext"]}:{}),...(task.payload.businessContext?{businessContext:task.payload.businessContext as unknown as BusinessContext}:{})};
        }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }catch(cause){if(combined.aborted)throw error(signal.aborted?"cancelled":"mpc_timeout",signal.aborted?"联合计算已取消。":"等待企业联合计算超时。",signal.aborted?409:504);throw cause;}
    finally{clearTimeout(timer);await Promise.allSettled(PARTICIPANTS.map(owner=>this.transport.call(owner,"abort",{taskId:id})));}
  }
  async waitForTask(id:string){await this.active.get(id)?.catch(()=>{});}
  async close(){await Promise.allSettled([...this.active.values()]);await this.transport.close();}
}

