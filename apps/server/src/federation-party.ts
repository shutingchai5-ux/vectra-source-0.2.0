import { PARTICIPANTS, error, asError, type CarrierId, type SignedEnvelope, type JsonObject, type StatisticsQuery, type StatisticsRecord, type DataCatalog, type BusinessDeclaration, type FederationManifest } from "@vectra/shared";
import { authorizeTask, canonical, hash, type Security } from "./security";
import { localVector, finishVector, validateQuery } from "./statistics";
import { polynomialShares, randomField, parseField, mod, reconstruct } from "./mpc/field";
import type { FederationTransport } from "./federation-transport";
interface LocalSource {catalog:DataCatalog;records:StatisticsRecord[];declaration?:BusinessDeclaration}
interface Session {
  task:JsonObject;digest:string;query:StatisticsQuery;values:bigint[][];inputs:Map<string,bigint[]>;aggregates:Map<string,bigint[]>;
  started:boolean;aggregating:boolean;complete:boolean;errorCode?:string;output?:SignedEnvelope;expiresAt:number;
}
export class FederatedParty {
  private sessions=new Map<string,Session>();
  private timer:ReturnType<typeof setInterval>;
  transport!:FederationTransport;
  constructor(private security:Security,private owner:CarrierId,private source:(query:StatisticsQuery,version:string)=>LocalSource){
    this.timer=setInterval(()=>{for(const[id,session]of this.sessions)if(session.expiresAt<Date.now())this.sessions.delete(id);},5000);this.timer.unref();
  }
  private session(id:unknown) {
    if(typeof id!=="string"||!this.sessions.has(id))throw error("mpc_session_missing","本企业未准备该计算会话。",409);
    const session=this.sessions.get(id)!;
    if(session.expiresAt<Date.now())throw error("mpc_session_expired","企业计算会话已过期。",409);
    return session;
  }
  async handle(peer:string,kind:string,data:JsonObject):Promise<unknown>{
    if(kind==="prepare"){
      if(peer!=="coordinator")throw error("federation_forbidden","只有园区可委派联合计算。",403);
      const envelope=data.task as SignedEnvelope,task=authorizeTask(this.security,envelope),query=validateQuery(task.statistics),manifest=task.federationManifest as FederationManifest;
      if(!manifest||manifest.version!==task.datasetVersion||manifest.dataset!==query.dataset||manifest.domain!==query.domain||!manifest.sources?.[this.owner])throw error("federation_binding","任务未绑定本企业的数据版本。",403);
      const id=String(task.taskId),digest=hash(envelope),existing=this.sessions.get(id);
      if(existing){if(existing.digest!==digest)throw error("federation_binding","同一任务内容发生变化。",409);return this.status(existing);}
      if(this.sessions.size>=8)throw error("mpc_busy","企业计算会话繁忙。",429);
      const local=this.source(query,manifest.sources[this.owner].version);
      validateQuery(query,local.catalog);
      if(hash(local.catalog)!==manifest.sources[this.owner].catalogDigest)throw error("federation_binding","本企业快照目录摘要不匹配。",403);
      const context=task.parkContext as JsonObject|undefined;
      if(!context||canonical(context.settings)!==canonical(manifest.settings)||"settings" in local.catalog&&canonical(local.catalog.settings)!==canonical(manifest.settings))throw error("federation_binding","任务公共设置与本企业冻结目录不一致。",403);
      if(query.dataset==="carrier_business"){
        const business=task.businessContext as JsonObject|undefined;
        if(!business||business.domain!==query.domain||canonical(business.sourceVersions)!==canonical(Object.fromEntries(PARTICIPANTS.map(id=>[id,manifest.sources[id].version]))))throw error("federation_binding","经营统计上下文与来源版本不一致。",403);
      }
      const encoded=localVector(local.records,query,local.declaration),values=encoded.map(value=>polynomialShares(value,randomField()));
      const index=PARTICIPANTS.indexOf(this.owner),session:Session={task,digest,query,values,inputs:new Map([[this.owner,values.map(row=>row[index])]]),aggregates:new Map(),started:false,aggregating:false,complete:false,expiresAt:Math.min(Number(task.expiresAt)+30000,Date.now()+120000)};
      this.sessions.set(id,session);return this.status(session);
    }
    const session=this.session(data.taskId);
    if(kind==="share"||kind==="aggregate"){
      if(!PARTICIPANTS.includes(peer as CarrierId)||peer===this.owner||data.digest!==session.digest||!Array.isArray(data.values)||data.values.length!==session.values.length)throw error("federation_binding","份额身份、任务或维数不匹配。",403);
      const values=data.values.map(parseField),target=kind==="share"?session.inputs:session.aggregates;
      if(kind==="aggregate"&&this.owner!=="carrier-a")throw error("federation_forbidden","本企业不是批准的结果重构方。",403);
      const previous=target.get(peer);
      if(previous&&previous.some((value,index)=>value!==values[index]))throw error("mpc_duplicate","同一来源提交了不同份额。",409);
      target.set(peer,values);
      if(kind==="share")await this.aggregate(String(data.taskId),session);else this.finish(session);
      return {accepted:true,taskId:data.taskId};
    }
    if(peer!=="coordinator")throw error("federation_forbidden","该协作操作仅向园区开放。",403);
    if(kind==="status")return this.status(session);
    if(kind==="abort"){this.sessions.delete(String(data.taskId));return {cancelled:true};}
    if(kind==="start"){
      if(!session.started){
        session.started=true;
        try{
          await Promise.all(PARTICIPANTS.filter(id=>id!==this.owner).map(async peer=>{
            const index=PARTICIPANTS.indexOf(peer);
            const receipt=await this.transport.call(peer,"share",{taskId:data.taskId,digest:session.digest,values:session.values.map(row=>row[index].toString())}) as JsonObject;
            if(receipt.accepted!==true||receipt.taskId!==data.taskId)throw error("mpc_receipt","输入份额回执不匹配。",403);
          }));
          await this.aggregate(String(data.taskId),session);
        }catch(cause){session.errorCode=asError(cause).code;throw cause;}
      }
      return this.status(session);
    }
    throw error("federation_route","不支持的协作操作。",404);
  }
  private async aggregate(taskId:string,session:Session){
    if(session.inputs.size!==3||session.aggregating)return;
    session.aggregating=true;
    const aggregate=session.values.map((_,index)=>mod([...session.inputs.values()].reduce((sum,row)=>sum+row[index],0n)));
    if(this.owner==="carrier-a"){session.aggregates.set(this.owner,aggregate);this.finish(session);}
    else{
      try{
        const receipt=await this.transport.call("carrier-a","aggregate",{taskId,digest:session.digest,values:aggregate.map(String)}) as JsonObject;
        if(receipt.accepted!==true||receipt.taskId!==taskId)throw error("mpc_receipt","聚合份额回执不匹配。",403);
        session.complete=true;
      }catch(cause){session.errorCode=asError(cause).code;throw cause;}
    }
  }
  private finish(session:Session){
    if(session.aggregates.size!==3||session.output)return;
    const totals=session.values.map((_,index)=>{
      const points=PARTICIPANTS.map(id=>session.aggregates.get(id)![index]);
      if(mod(points[2]-2n*points[1]+points[0])!==0n)throw error("mpc_consistency","聚合份额不符合批准的一次多项式约定。",403);
      return reconstruct(points);
    });
    const groups=finishVector(totals,session.query),task=session.task;
    session.output=this.security.sign(this.owner,{taskId:task.taskId,requestDigest:task.requestDigest,road:task.road,windowSeconds:task.windowSeconds,datasetVersion:task.datasetVersion,
      query:session.query,groups,participantCount:3,protocol:"Federated Shamir m=3 t=1 / TLS 1.3",federationManifest:task.federationManifest,
      ...(task.parkContext?{parkContext:task.parkContext}:{}),...(task.reservationContext?{reservationContext:task.reservationContext}:{}),...(task.businessContext?{businessContext:task.businessContext}:{})});
    session.complete=true;
  }
  private status(session:Session){
    return {prepared:true,started:session.started,receivedShares:session.inputs.size,receivedAggregates:session.aggregates.size,complete:session.complete,
      ...(session.errorCode?{errorCode:session.errorCode}:{}),...(session.output?{output:session.output}:{})};
  }
  close(){clearInterval(this.timer);this.sessions.clear();}
}

