import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BUSINESS_DOMAINS, BUSINESS_DOMAIN_FIELDS, CHARGE_CONNECTORS, RETURN_REGIONS, MAX_WINDOW_MS, PARK_ENTRANCES, parseParkTimestamp, normalizePlateNumber, isParkEntrance, error,
  type BusinessDomain, type BusinessRecord, type BusinessCatalog, type BusinessSnapshot, type BusinessDeclaration, type DemandRecord, type HaulageRecord,
  type ReturnRecord, type ChargingRecord, type ChargeCapacitySlot, type CarrierId, type StatisticsQuery, type StatisticsRecord } from "@vectra/shared";
import { atomicWrite, canonical, seal, unseal, type Security } from "./security";
import { readParkVisits, type ParkData } from "./park";
import type { FleetData } from "./fleet";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const bad = (message: string): never => { throw error("invalid_business_data", message, 422); };
const versionValid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
export const businessDomain = (value: unknown): BusinessDomain => typeof value === "string" && Object.hasOwn(BUSINESS_DOMAINS,value) ? value as BusinessDomain : bad("请选择受支持的经营台账。");
function number(raw: Record<string,unknown>, field: string, maximum = 1_000_000, integer = false, required = true): number | undefined {
  const value = raw[field];
  if (value === undefined && !required) return;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum || integer && !Number.isSafeInteger(value)) return bad(field + "须为有效非负数，不能把空值当作零。");
  return value;
}
function time(value: unknown, label: string): number {
  const at = parseParkTimestamp(value);
  if (!Number.isSafeInteger(at) || at < 0) return bad(label + "须为有效上海时间。");
  return at;
}
function period(start: number,end: number,now: number,future: boolean) {
  if (start > end || end-start > MAX_WINDOW_MS || end > now+(future?MAX_WINDOW_MS:0)) bad("时间顺序或范围无效，跨度最多31天；实际事实不能在未来。");
}
function strict(raw: Record<string,unknown>, fields: string[]) {
  if (Object.keys(raw).some(field=>!fields.includes(field))) bad("记录包含不支持的字段，未保存。");
}
const rowStart = (domain: BusinessDomain, row: BusinessRecord) => domain === "haulage" ? (row as HaulageRecord).recordedAt : (row as DemandRecord).slotStart;
const rowEnd = (domain: BusinessDomain,row: BusinessRecord) => domain==="demand" ? (row as DemandRecord).latestAt : domain==="returns" ? (row as ReturnRecord).availableUntil : domain==="charging" ? (row as ChargingRecord).deadlineAt : (row as HaulageRecord).recordedAt;

export class BusinessData {
  readonly folder: string;
  constructor(private security: Security, readonly owner: CarrierId, private park: ParkData, private fleet: FleetData) {
    this.folder=join(security.root,"business"); mkdirSync(this.folder,{recursive:true});
    for(const domain of Object.keys(BUSINESS_DOMAINS) as BusinessDomain[]) if(!existsSync(join(this.folder,domain,"catalog.json"))) this.publish(domain,[]);
  }
  catalog(domain:BusinessDomain):BusinessCatalog { return JSON.parse(readFileSync(join(this.folder,domain,"catalog.json"),"utf8")); }
  refreshSettings(){
    for(const domain of Object.keys(BUSINESS_DOMAINS) as BusinessDomain[]){
      const current=this.snapshot(domain);
      if(canonical(current.catalog.settings)!==canonical(this.park.catalog().settings))this.publish(domain,current.records,current.catalog.declaration);
    }
  }
  snapshot(domain:BusinessDomain,version?:string):BusinessSnapshot {
    return readBusinessSnapshot(this.security,this.owner,domain,version??this.catalog(domain).version);
  }
  versions(domain:BusinessDomain) {
    return readdirSync(join(this.folder,domain)).filter(versionValid).map(version=> {
      const catalog=JSON.parse(readFileSync(join(this.folder,domain,version,"catalog.json"),"utf8")) as BusinessCatalog;
      return {version,updatedAt:catalog.updatedAt,rowCount:catalog.sampleCount};
    }).sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,50);
  }
  // The optional reference clock is for offline maintenance, never taken from an HTTP body.
  replace(domain:BusinessDomain,value:unknown,declaration:unknown,baseVersion:unknown,validationTime=Date.now()) {
    const current=this.snapshot(domain);
    if(current.version!==baseVersion) throw error("business_changed","本方经营台账已更新，请刷新核对；草稿仍保留。",409);
    if(!Array.isArray(value)||value.length>6000) return bad("每类台账最多6000条记录。");
    const now=validationTime,ids=new Set<string>(),links=new Set<string>();
    const rows=value.map(raw=>this.validate(domain,raw,now));
    for(const row of rows){
      if(ids.has(row.id)) bad("记录编号重复。"); ids.add(row.id);
      if(domain==="haulage") { const id=(row as HaulageRecord).visitId; if(links.has(id)) bad("同一车次只能有一条装载与空驶事实。"); links.add(id); }
    }
    let coverage:BusinessDeclaration|undefined;
    if(declaration!==undefined&&declaration!==null){
      if(!object(declaration)) return bad("请填写本方资料完整的时间范围。");
      strict(declaration,["start","end"]);
      coverage={start:time(declaration.start,"资料起点"),end:time(declaration.end,"资料终点")};
      period(coverage.start,coverage.end,now,domain!=="haulage");
      if(coverage.end<=coverage.start) bad("资料完整范围的结束须晚于开始。");
    }
    if(domain!=="haulage"){
      const old=new Map(current.records.map(row=>[row.id,row])),next=new Map(rows.map(row=>[row.id,row]));
      for(const row of [...current.records,...rows]) if(rowStart(domain,row)<=now&&canonical(old.get(row.id)??null)!==canonical(next.get(row.id)??null)){
        if(old.has(row.id)&&!next.has(row.id)&&rowEnd(domain,row)<=now)continue;
        bad("已经开始的计划只读，结束后可归档；历史快照继续保留。");
      }
      // One vehicle cannot promise overlapping charging sessions in the same company.
      if(domain==="charging"){
        const ordered=[...rows as ChargingRecord[]].sort((a,b)=>a.slotStart-b.slotStart);
        for(let i=0;i<ordered.length;i++)for(let j=i+1;j<ordered.length&&ordered[j].slotStart<ordered[i].deadlineAt;j++)
          if(ordered[j].vehicleId===ordered[i].vehicleId)bad("同一车辆的充电申报时段重叠，请合并或调整，避免重复承诺。");
      }
    }
    this.publish(domain,rows,coverage);
    return this.snapshot(domain);
  }
  private validate(domain:BusinessDomain,input:unknown,now:number):BusinessRecord {
    if(!object(input))return bad("每条记录须为一个对象。");
    const raw={...input};
    if(raw.carrierId!==undefined&&raw.carrierId!==this.owner)throw error("carrier_scope_forbidden","只能维护当前贸易公司的资料。",403);
    delete raw.carrierId;
    if(typeof raw.id!=="string"||!raw.id.trim()||raw.id.length>100||/[\p{Cc}\p{Cf}]/u.test(raw.id))return bad("记录编号无效。");
    if(domain==="haulage"){
      strict(raw,["id","visitId","road","vehicleId","recordedAt","sourceParkVersion",...BUSINESS_DOMAIN_FIELDS.haulage.filter(field=>!["haulageDistanceKm","tonneKm"].includes(field)&&!field.endsWith("Percent"))]);
      if(typeof raw.visitId!=="string")return bad("请选择本方已离园车次。");
      const version=raw.sourceParkVersion??this.park.catalog().version;
      if(!versionValid(version))return bad("车次来源版本无效。");
      const visit=readParkVisits(this.security,version,this.owner).find(visit=>visit.visitId===raw.visitId);
      if(!visit||visit.departedAt===undefined)return bad("装载与空驶事实须关联本方已离园车次。");
      for(const [field,expected] of [["road",visit.road],["vehicleId",visit.vehicleId],["recordedAt",visit.departedAt]] as const)
        if(raw[field]!==undefined&&raw[field]!==expected)bad("车次、入口或离园时间与来源快照不一致。");
      const result:HaulageRecord={id:raw.id,visitId:visit.visitId,vehicleId:visit.vehicleId,road:visit.road,recordedAt:visit.departedAt,sourceParkVersion:version};
      for(const field of ["actualLoadTonnes","loadCapacityTonnes","actualVolumeM3","loadCapacityVolumeM3","pallets","loadCapacityPallets","loadedDistanceKm","emptyDistanceKm"] as const){
        const value=number(raw,field,field.endsWith("Tonnes")?1000:1_000_000,/pallets/i.test(field),false);
        if(value!==undefined)result[field]=value;
      }
      if(result.loadCapacityTonnes===undefined)result.loadCapacityTonnes=this.fleet.profiles().find(row=>row.vehicleId===visit.vehicleId)?.capacityTonnes;
      for(const [load,capacity] of [["actualLoadTonnes","loadCapacityTonnes"],["actualVolumeM3","loadCapacityVolumeM3"],["pallets","loadCapacityPallets"]] as const)
        if(result[load]!==undefined&&result[capacity]!==undefined&&result[load]!>result[capacity]!)bad("实际装载不能超过本次声明的适用运载能力。");
      if((result.loadedDistanceKm===undefined)!==(result.emptyDistanceKm===undefined))bad("载货与空驶里程须成对填写，未知时两项均留空。");
      if(visit.distanceKm!==undefined&&result.loadedDistanceKm!==undefined&&Math.abs(result.loadedDistanceKm+result.emptyDistanceKm!-visit.distanceKm)>0.01)bad("载货与空驶里程之和须与来源车次完整里程一致。");
      return Object.fromEntries(Object.entries(result).filter(([,value])=>value!==undefined)) as unknown as HaulageRecord;
    }
    if(!isParkEntrance(raw.road))return bad("请选择东、南、西、北四个固定入口之一。");
    const slotStart=time(raw.slotStart,"计划时段");
    if(slotStart%1800000)bad("计划到达或回程开始须为上海整点或半点。");
    const base={id:raw.id,road:raw.road,slotStart};
    if(domain==="demand"){
      strict(raw,["id","road","slotStart","earliestAt","latestAt","expectedTrips","reservedTrips","minimumCommittedTrips","expectedWorkMinutes","cargoTonnes","cargoVolumeM3","pallets"]);
      const earliestAt=time(raw.earliestAt,"最早到达"),latestAt=time(raw.latestAt,"最晚到达");
      period(earliestAt,latestAt,now,true);
      if(earliestAt>slotStart||slotStart>latestAt)bad("计划到达须在允许到达范围内。");
      const expectedTrips=number(raw,"expectedTrips",1_000_000,true)!,reservedTrips=number(raw,"reservedTrips",1_000_000,true)!;
      const minimumCommittedTrips=number(raw,"minimumCommittedTrips",1_000_000,true)!,expectedWorkMinutes=number(raw,"expectedWorkMinutes")!;
      if(reservedTrips>expectedTrips||minimumCommittedTrips>expectedTrips||(expectedTrips===0?expectedWorkMinutes!==0:expectedWorkMinutes<=0))bad("预约及最低保留车次不能超过总需求；有需求须提供作业量。");
      const result:DemandRecord={...base,earliestAt,latestAt,expectedTrips,reservedTrips,minimumCommittedTrips,expectedWorkMinutes};
      for(const field of ["cargoTonnes","cargoVolumeM3","pallets"] as const){ const value=number(raw,field,1_000_000,field==="pallets",false);if(value!==undefined){if(expectedTrips===0&&value!==0)bad("零需求不能同时申报正货量。");result[field]=value;} }
      return result;
    }
    if(domain==="returns"){
      strict(raw,["id","road","slotStart","availableUntil","availableTrips","regionCode"]);
      const availableUntil=time(raw.availableUntil,"回程有效期");
      period(slotStart,availableUntil,now,true);
      if(availableUntil<=slotStart||!Object.hasOwn(RETURN_REGIONS,String(raw.regionCode)))bad("请填写有效回程时间范围及粗区域。");
      return {...base,availableUntil,availableTrips:number(raw,"availableTrips",1_000_000,true)!,regionCode:Number(raw.regionCode) as ReturnRecord["regionCode"]};
    }
    strict(raw,["id","road","slotStart","vehicleId","deadlineAt","connector","batteryCapacityKwh","socPercent","targetSocPercent","maxPowerKw"]);
    const vehicleId=typeof raw.vehicleId==="string"?normalizePlateNumber(raw.vehicleId):"";
    if(!this.fleet.profiles().some(vehicle=>vehicle.vehicleId===vehicleId&&vehicle.carrierId===this.owner))bad("请选择本贸易公司已建档车辆。");
    const deadlineAt=time(raw.deadlineAt,"补能截止");
    period(slotStart,deadlineAt,now,true);
    const batteryCapacityKwh=number(raw,"batteryCapacityKwh")!,socPercent=number(raw,"socPercent",100)!,targetSocPercent=number(raw,"targetSocPercent",100)!;
    if(deadlineAt<=slotStart||!Object.hasOwn(CHARGE_CONNECTORS,String(raw.connector))||batteryCapacityKwh<=0||targetSocPercent<=socPercent)bad("请核对补能时间、接口和电池容量，目标电量须高于当前电量。");
    const maxPowerKw=number(raw,"maxPowerKw",1_000_000,false,false);
    if(maxPowerKw===0)bad("已知车辆最大充电功率须大于零；未知时留空。");
    return {...base,vehicleId,deadlineAt,connector:raw.connector as ChargingRecord["connector"],batteryCapacityKwh,socPercent,targetSocPercent,...(maxPowerKw===undefined?{}:{maxPowerKw})};
  }
  private publish(domain:BusinessDomain,records:BusinessRecord[],declaration?:BusinessDeclaration) {
    const version=randomUUID(),updatedAt=Date.now(),folder=join(this.folder,domain,version);mkdirSync(folder,{recursive:true});
    atomicWrite(join(folder,"records.enc.json"),canonical(seal(records,readFileSync(join(this.security.root,this.owner,"input.key")),"business:"+this.owner+":"+domain+":"+version)));
    const catalog:BusinessCatalog={dataset:"carrier_business",domain,carrierId:this.owner,version,source:"import",updatedAt,settings:this.park.catalog().settings,...(declaration?{declaration}:{}),
      vehicleCount:0,sampleCount:records.length,nodes:[{id:this.owner,vehicleCount:0,sampleCount:records.length}],
      roads:PARK_ENTRANCES.map(id=>{const selected=records.filter(row=>row.road===id);return {id,vehicleCount:0,sampleCount:selected.length,start:selected.length?Math.min(...selected.map(row=>rowStart(domain,row))):0,end:selected.length?Math.max(...selected.map(row=>rowEnd(domain,row))):0,fields:[...BUSINESS_DOMAIN_FIELDS[domain]]};})};
    atomicWrite(join(folder,"catalog.json"),canonical(catalog));atomicWrite(join(this.folder,domain,"catalog.json"),canonical(catalog));
  }
}
export function readBusinessSnapshot(security:Security,owner:CarrierId,domain:BusinessDomain,version:string):BusinessSnapshot {
  if(!versionValid(version))throw error("invalid_dataset","经营台账版本无效。",403);
  const folder=join(security.root,"business",businessDomain(domain),version);
  if(!existsSync(join(folder,"catalog.json"))||!existsSync(join(folder,"records.enc.json")))throw error("dataset_missing","本公司没有该经营台账版本。",404);
  const catalog=JSON.parse(readFileSync(join(folder,"catalog.json"),"utf8")) as BusinessCatalog;
  if(catalog.carrierId!==owner||catalog.domain!==domain||catalog.version!==version)throw error("carrier_scope_forbidden","经营台账不属于本企业或指定版本。",403);
  const records=unseal(JSON.parse(readFileSync(join(folder,"records.enc.json"),"utf8")),readFileSync(join(security.root,owner,"input.key")),"business:"+owner+":"+domain+":"+version) as BusinessRecord[];
  return {version,catalog,records};
}
export function projectBusiness(records:BusinessRecord[],query:StatisticsQuery):StatisticsRecord[] {
  return records.map(input=>{
    const base={road:input.road,recordedAt:rowStart(query.domain!,input)};
    if(query.domain==="demand"){
      const row=input as DemandRecord,flexible=row.earliestAt<row.slotStart||row.latestAt>row.slotStart?row.expectedTrips-row.minimumCommittedTrips:0;
      return {...base,recordedAt:query.businessSelection==="deadline"?row.latestAt:row.slotStart,expectedDemandTrips:row.expectedTrips,unreservedTrips:row.expectedTrips-row.reservedTrips,reservedDemandTrips:row.reservedTrips,committedTrips:row.minimumCommittedTrips,
        flexibleTrips:flexible,advanceableTrips:row.earliestAt<row.slotStart?flexible:0,delayableTrips:row.latestAt>row.slotStart?flexible:0,dueSoonTrips:row.latestAt<=query.start+7200000?row.expectedTrips:0,demandWorkMinutes:row.expectedWorkMinutes,
        ...(row.cargoTonnes===undefined?{}:{demandCargoTonnes:row.cargoTonnes}),...(row.cargoVolumeM3===undefined?{}:{demandCargoVolumeM3:row.cargoVolumeM3}),...(row.pallets===undefined?{}:{demandPallets:row.pallets})};
    }
    if(query.domain==="haulage"){
      const row=input as HaulageRecord,total=row.loadedDistanceKm===undefined?undefined:row.loadedDistanceKm+row.emptyDistanceKm!;
      return {...base,...row,...(total===undefined?{}:{haulageDistanceKm:total}),...(row.actualLoadTonnes===undefined||row.loadedDistanceKm===undefined?{}:{tonneKm:row.actualLoadTonnes*row.loadedDistanceKm}),
        ...(row.actualLoadTonnes===undefined||!row.loadCapacityTonnes?{}:{loadUtilizationPercent:100*row.actualLoadTonnes/row.loadCapacityTonnes}),
        ...(row.actualVolumeM3===undefined||!row.loadCapacityVolumeM3?{}:{volumeUtilizationPercent:100*row.actualVolumeM3/row.loadCapacityVolumeM3}),
        ...(row.pallets===undefined||!row.loadCapacityPallets?{}:{palletUtilizationPercent:100*row.pallets/row.loadCapacityPallets})};
    }
    if(query.domain==="returns"){const row=input as ReturnRecord;return {...base,availableReturnTrips:row.availableTrips,returnRegionCode:row.regionCode};}
    const row=input as ChargingRecord,kwh=row.batteryCapacityKwh*(row.targetSocPercent-row.socPercent)/100,windowMinutes=(row.deadlineAt-row.slotStart)/60000;
    return {...base,chargeEnergyKwh:kwh,dcChargeKwh:row.connector==="dc"?kwh:0,acChargeKwh:row.connector==="ac"?kwh:0,otherChargeKwh:row.connector==="other"?kwh:0,
      urgentChargeRequests:row.deadlineAt<=query.start+7200000?1:0,...(row.maxPowerKw===undefined?{}:{infeasibleChargeRequests:kwh>row.maxPowerKw*windowMinutes/60?1:0}),chargeWindowMinutes:windowMinutes};
  });
}
export function validateChargeCapacities(input:unknown,now=Date.now()):ChargeCapacitySlot[] {
  if(!Array.isArray(input)||input.length>6000)return bad("充电容量最多6000条。");
  const ids=new Set<string>();
  return input.map(raw=>{
    if(!object(raw))return bad("容量须为对象。");strict(raw,["road","slotStart","connector","ports","maxPowerKw","capacityKwh"]);
    const slotStart=time(raw.slotStart,"容量时段");if(!isParkEntrance(raw.road)||slotStart%1800000||slotStart>now+MAX_WINDOW_MS||!Object.hasOwn(CHARGE_CONNECTORS,String(raw.connector)))return bad("请核对入口、半小时时段与接口。");
    const ports=number(raw,"ports",10000,true)!,maxPowerKw=number(raw,"maxPowerKw")!,capacityKwh=number(raw,"capacityKwh")!;
    if(capacityKwh>ports*maxPowerKw*0.5+0.01)bad("半小时电量额度不能超过接口数量与单接口功率上限。");
    const id=raw.road+":"+slotStart+":"+raw.connector;if(ids.has(id))bad("同一入口时段和接口的容量重复。");ids.add(id);
    return {road:raw.road,slotStart,connector:raw.connector as ChargeCapacitySlot["connector"],ports,maxPowerKw,capacityKwh};
  });
}

