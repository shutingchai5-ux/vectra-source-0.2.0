import { test,expect } from "bun:test";
import { existsSync,mkdtempSync,readFileSync,rmSync,readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve,join,sep } from "node:path";
import { randomUUID } from "node:crypto";
import { PARTICIPANTS,businessMetrics,chargeCapacityResult,shanghaiTimestamp,sanitizeLogValue,type BusinessDomain,type StatisticsQuery,type Task,type ParkVisit } from "@vectra/shared";
import { provisionDeployments } from "../src/provision";
import { readDeployment,readEnterpriseDeployment } from "../src/deployment";
import { config } from "../src/config";
import { startServer } from "../src/index";
import { openCompanyNode } from "../../carrier/src/index";
import { startEnterprise } from "../../carrier/src/portal";
import { localVector,finishVector,validateQuery,approveStatisticsQuery } from "../src/statistics";
import { Security } from "../src/security";
import { Collaboration } from "../src/service";
import { configureFixtureModels } from "./fixtures";
const slot=Math.ceil((Date.now()+3600000)/3600000)*3600000;
function query(domain:BusinessDomain):StatisticsQuery{return {dataset:"carrier_business",domain,roads:["东入口"],start:domain==="haulage"?Date.now()-86400000:slot,end:domain==="haulage"?Date.now():slot+3600000,timeZone:"Asia/Shanghai",metrics:businessMetrics(domain),...(domain==="haulage"?{}:{bucketMinutes:60})};}
function cleanup(root:string){const parent=resolve(tmpdir())+sep;if(!resolve(root).startsWith(parent)||!root.includes("vectra-federation-"))throw new Error("Unexpected test path");rmSync(root,{recursive:true,force:true});}

test("business zero, missing optional fields, paired ratios and query constraints remain distinct",()=>{
  const q=query("charging"),empty=localVector([],q),declared=localVector([],q,{start:q.start,end:q.end});
  expect(finishVector(empty.map(value=>value*3n),q)[0].metrics[0].value).toBeNull();
  expect(finishVector(declared.map(value=>value*3n),q)[0].metrics[0].value).toBe(0);
  const incomplete=localVector([{road:"东入口",recordedAt:slot,chargeEnergyKwh:20}],q,{start:q.start,end:q.end});
  const result=finishVector(incomplete.map(value=>value*3n),q)[0];
  expect(result.metrics[0].value).toBe(60);expect(result.metrics.at(-1)!.value).toBeNull();
  expect(()=>validateQuery({...q,domain:"haulage"})).toThrow();
  expect(()=>validateQuery({...q,metrics:[{label:"车辆数",operation:"vehicle_count"}]})).toThrow(/计划额度/);
  expect(()=>validateQuery({...q,metrics:[{label:"越界",operation:"sum",field:"socPercent"}]})).toThrow();
  const relative=approveStatisticsQuery("东入口未来六小时充电需求",{...q,start:0,end:1});
  expect(relative.end-relative.start).toBe(6*3600000);
  expect(JSON.stringify(sanitizeLogValue({socPercent:17.3,batteryCapacityKwh:250,records:[{id:"private-demand"}]}))).not.toContain("17.3");
});

test("shared enterprise port binds accounts to companies and completes all first-batch mTLS Shamir and Agent reports",async()=>{
  const root=mkdtempSync(join(tmpdir(),"vectra-federation-")),base=24000+Math.floor(Math.random()*10000),native=globalThis.fetch;
  const initialized=await provisionDeployments(root,{apiPorts:[base,base+1,base+2,base+3],federationPorts:[base+4,base+5,base+6,base+7]});
  const deployments=initialized.deployments.map(item=>readDeployment(item.config));
  const companies:Awaited<ReturnType<typeof openCompanyNode>>[]=[];
  let enterprise:Awaited<ReturnType<typeof startEnterprise>>|undefined;
  let park:Awaited<ReturnType<typeof startServer>>|undefined;
  try{
    enterprise=await startEnterprise({...readEnterpriseDeployment(initialized.enterprisePortal!.config),port:0});
    companies.push(...PARTICIPANTS.map(id=>enterprise!.nodes.get(id)!));
    const p=deployments[0];park=await startServer({...config(),deployment:p,dataDir:p.dataDir,logDir:p.logDir,host:"127.0.0.1",port:0,cooldown:0,mpcTimeout:30000,taskTimeout:60000});
    const app=park.app,federation=app.federation!;
    expect(existsSync(join(app.security.root,"carrier-a","signing.key"))).toBeFalse();
    expect(existsSync(join(companies[0].security.root,"carrier-b","input.key"))).toBeFalse();
    expect(existsSync(join(companies[0].security.root,"ca.key"))).toBeFalse();
    const login=async(index:number,port:number)=>{const url="http://127.0.0.1:"+port,credentials=JSON.parse(readFileSync(initialized.deployments[index].credentials,"utf8"));const response=await native(url+"/api/portal/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:credentials.username,password:credentials.password})});expect(response.status).toBe(200);return response.headers.get("set-cookie")!.split(";")[0];};
    const parkUrl="http://127.0.0.1:"+park.server.port,parkCookie=await login(0,park.server.port!);
    const ownUrl="http://127.0.0.1:"+enterprise.server.port,ownCookie=await login(1,enterprise.server.port!);
    const send=(url:string,cookie:string,path:string,method="GET",value?:unknown,token?:string)=>native(url+path,{method,headers:{Cookie:cookie,"Content-Type":"application/json",...(token?{"X-Carrier-Role":token}:{})},...(value===undefined?{}:{body:JSON.stringify(value)})});
    expect((await native(parkUrl+"/api/overview")).status).toBe(401);
    expect((await send(ownUrl,parkCookie,"/api/session")).status).toBe(401);
    expect((await send(parkUrl,parkCookie,"/api/carrier-role","POST",{carrierId:"carrier-a"})).status).toBe(403);
    expect((await send(parkUrl,parkCookie,"/api/telemetry/records")).status).toBe(403);
    expect((await send(ownUrl,ownCookie,"/api/carrier-role","POST",{carrierId:"carrier-b"})).status).toBe(403);
    const role=await(await send(ownUrl,ownCookie,"/api/carrier-role","POST",{carrierId:"carrier-a"})).json();
    const cookieB=await login(2,enterprise.server.port!),cookieC=await login(3,enterprise.server.port!);
    expect((await(await send(ownUrl,cookieB,"/api/portal")).json()).carrierId).toBe("carrier-b");
    expect((await(await send(ownUrl,cookieC,"/api/portal")).json()).carrierId).toBe("carrier-c");
    expect((await send(ownUrl,cookieB,"/api/carrier/fleet","GET",undefined,role.token)).status).toBe(403);
    const roleB=await(await send(ownUrl,cookieB,"/api/carrier-role","POST",{carrierId:"carrier-b"})).json();
    expect((await send(ownUrl,ownCookie,"/api/agents","GET",undefined,role.token)).status).toBe(403);
    const outside=await native(ownUrl+"/api/carrier-role",{method:"POST",headers:{Cookie:ownCookie,Origin:"https://unrelated.invalid","Content-Type":"application/json"},body:JSON.stringify({carrierId:"carrier-a"})});expect(outside.status).toBe(403);
    const plates=PARTICIPANTS.map((_,i)=>"沪"+String.fromCharCode(65+i)+"12345");
    for(const [i,company]of companies.entries()){
      const owner=PARTICIPANTS[i];
      company.fleet.save(owner,[{vehicleId:plates[i],plateNumber:plates[i],carrierId:owner,allowedRoads:[],capacityTonnes:[10,20,30][i],energyType:"electric"}],company.fleet.catalog().version,true);
      await company.transport.call("coordinator","claim-plates",{plates:[plates[i]]});
      const at=Date.now()-7200000,visit:ParkVisit={visitId:"private-visit-"+i,carrierId:owner,vehicleId:plates[i],road:"东入口",arrivedAt:at,enteredAt:at+100000,serviceStartedAt:at+200000,serviceEndedAt:at+300000,departedAt:at+400000,distanceKm:100};
      const actual=company.park.import([visit],company.park.catalog().version);
      const declaration={start:slot,end:slot+3600000};
      company.business.replace("demand",[{id:"private-demand-"+i,road:"东入口",slotStart:slot,earliestAt:slot-1800000,latestAt:slot+1800000,expectedTrips:10+i,reservedTrips:4,minimumCommittedTrips:3,expectedWorkMinutes:100}],declaration,company.business.catalog("demand").version);
      company.business.replace("returns",[{id:"private-return-"+i,road:"东入口",slotStart:slot,availableUntil:slot+3600000,availableTrips:2+i,regionCode:i===2?3:2}],declaration,company.business.catalog("returns").version);
      company.business.replace("haulage",[{id:"private-haulage-"+i,visitId:visit.visitId,sourceParkVersion:actual.version,actualLoadTonnes:[2,10,30][i],loadedDistanceKm:80,emptyDistanceKm:20}],{start:at-1000,end:Date.now()},company.business.catalog("haulage").version);
      const battery={id:"private-charge-"+i,road:"东入口",slotStart:slot,deadlineAt:slot+3600000,vehicleId:plates[i],connector:"dc",batteryCapacityKwh:100,socPercent:17.3,targetSocPercent:67.3,maxPowerKw:30};
      const saved=company.business.replace("charging",[battery],declaration,company.business.catalog("charging").version);
      expect(()=>company.business.replace("charging",[battery,{...battery,id:"overlap"}],declaration,saved.version)).toThrow(/重叠/);
      expect(()=>company.business.replace("charging",[{...battery,carrierId:PARTICIPANTS[(i+1)%3]}],declaration,saved.version)).toThrow(/当前贸易公司/);
      expect(readFileSync(join(company.security.root,"business","charging",saved.version,"records.enc.json"),"utf8")).not.toContain("socPercent");
    }
    const ownLedger=await(await send(ownUrl,cookieB,"/api/carrier/business/demand?carrierId=carrier-a","GET",undefined,roleB.token)).json();
    expect(ownLedger.catalog.carrierId).toBe("carrier-b");expect(ownLedger.records[0].id).toBe("private-demand-1");
    expect((await send(ownUrl,ownCookie,"/api/carrier/business/demand","PUT",{baseVersion:companies[0].business.catalog("demand").version,records:[{...companies[1].business.snapshot("demand").records[0],carrierId:"carrier-b"}]},role.token)).status).toBe(403);
    expect((await send(ownUrl,cookieB,"/api/carrier/business/demand?version="+companies[0].business.catalog("demand").version,"GET",undefined,roleB.token)).status).toBe(404);
    await expect(companies[1].transport.call("coordinator","claim-plates",{plates:[plates[0]]})).rejects.toThrow(/另一家公司/);
    await expect(companies[0].transport.call("carrier-b","catalogs",{})).rejects.toThrow(/只有园区/);
    const capacities=[0,1800000].map(offset=>({road:"东入口",slotStart:slot+offset,connector:"dc",ports:4,maxPowerKw:100,capacityKwh:60}));
    const initialCharge=federation.charge();federation.saveCharge({slots:capacities,baseVersion:initialCharge.version});
    await federation.refresh();
    const run=async(q:StatisticsQuery)=>{
      const catalog=federation.catalogs!.business[q.domain!],manifest=federation.manifest(catalog.version);
      const task={id:randomUUID(),requestId:randomUUID(),request:"隔离校验",plan:{statistics:q,datasetVersion:catalog.version,participants:[...PARTICIPANTS],parkContext:{settings:catalog.settings,dataUpdatedAt:catalog.updatedAt},businessContext:federation.businessContext(q,manifest),federationManifest:manifest}} as unknown as Task;
      return federation.run(app.signedTask(task),()=>{},new AbortController().signal);
    };
    const demand=await run(query("demand"));expect(demand.groups![0].metrics.map(item=>item.value)).toEqual([33,21,24,24,24,33,300]);
    const returns=query("returns");returns.metrics=returns.metrics.map(metric=>({...metric,filter:{field:"returnRegionCode",op:"eq",value:2}}));
    const back=await run(returns);expect(back.groups![0].metrics[0].value).toBe(5);
    const actual=await run(query("haulage"));expect(actual.groups![0].metrics.find(item=>item.label==="按载重加权的装载利用率")?.value).toBe(70);expect(actual.groups![0].metrics.find(item=>item.label==="联合空驶率")?.value).toBe(20);
    expect(actual.groups![0].metrics.find(item=>item.label==="载重利用率低于50%的记录比例")?.value).toBeCloseTo(100/3,5);
    expect(actual.groups![0].metrics.find(item=>item.label==="实际载货体积")?.value).toBeNull();
    const charging=await run(query("charging"));expect(charging.groups![0].metrics[0].value).toBe(150);expect(charging.groups![0].metrics.at(-1)?.value).toBe(3);
    expect(chargeCapacityResult(charging.groups!,charging.businessContext!.chargingWindows!,charging.query!.metrics)[0].connectors[0].gapKwh).toBe(30);
    const freeze=charging.businessContext!.chargingWindows![0].capacityKwh;
    federation.saveCharge({slots:capacities.map(row=>({...row,capacityKwh:0})),baseVersion:federation.charge().version});expect(charging.businessContext!.chargingWindows![0].capacityKwh).toBe(freeze);
    configureFixtureModels(app,"federation-fixture-key");let modelInput="";
    globalThis.fetch=Object.assign(async(input:Parameters<typeof fetch>[0],init?:RequestInit)=>{
      if(!String(input).startsWith("https://example.invalid/"))return native(input,init);
      modelInput+=String(init?.body);const payload=JSON.parse(String(init?.body)),names=payload.tools.map((tool:any)=>tool.function.name),last=payload.messages.at(-1);
      const call=(name:string,args:unknown={})=>Response.json({choices:[{message:{role:"assistant",content:null,tool_calls:[{id:randomUUID(),type:"function",function:{name,arguments:JSON.stringify(args)}}]}}]});
      if(names.includes("submit_statistics_plan"))return call("submit_statistics_plan",query("charging"));
      if(names.includes("submit_analysis"))return last.role==="user"?call("query_events"):call("submit_analysis",{facts:["已核对批准结果"],possibleCauses:[],recommendations:["园区人工复核补能资源"],uncertainties:["申报计划不等于已充电"],evidenceIds:[JSON.parse(last.content).events[0].id]});
      return last.role==="user"?call("compute_statistics"):Response.json({choices:[{message:{role:"assistant",content:"已完成联合补能统计，建议仍待人工确认。"}}]});
    },{preconnect:native.preconnect}) as typeof fetch;
    const task=app.submit({request:"统计东入口从"+shanghaiTimestamp(slot)+"至"+shanghaiTimestamp(slot+3600000)+"的充电需求并生成签名报告",requestId:randomUUID(),intent:"statistics"});
    let completed=app.store.task(task.id)!;const deadline=Date.now()+45000;
    while(["queued","running"].includes(completed.status)&&Date.now()<deadline){await Bun.sleep(30);completed=app.store.task(task.id)!;}
    expect(completed.error).toBeUndefined();expect(completed.status).toBe("completed");expect(completed.analysis).toBeDefined();
    expect(app.verifyReport(app.report(task.id)).valid).toBeTrue();expect(completed.plan.federationManifest?.sources["carrier-a"].version).toBe(companies[0].business.catalog("charging").version);
    expect(completed.steps.some(step=>step.phase===5&&step.agent==="carrier-b")).toBeTrue();expect(completed.steps.every(step=>!step.hasPrivateDetails)).toBeTrue();
    expect(()=>app.protocolMaterials(task.id,completed.steps[0].id)).toThrow(/不提供/);
    expect(modelInput).not.toContain("private-charge-");expect(modelInput).not.toContain(plates[0]);expect(modelInput).not.toContain('"socPercent":17.3');
    expect((await send(ownUrl,ownCookie,"/api/portal/logout","POST")).status).toBe(200);
    expect((await send(ownUrl,ownCookie,"/api/carrier/fleet","GET",undefined,role.token)).status).toBe(401);
    expect((await send(ownUrl,cookieB,"/api/carrier/fleet","GET",undefined,roleB.token)).status).toBe(200);
    const tampered=structuredClone(app.report(task.id));tampered.payload.summary="篡改";expect(app.verifyReport(tampered).valid).toBeFalse();
  }catch(cause){for(const d of deployments){const folder=join(d.logDir,"operations");if(existsSync(folder))for(const name of readdirSync(folder)){const errors=readFileSync(join(folder,name),"utf8").split("\n").filter(line=>line.includes("federation.rpc_failed"));if(errors.length)console.warn(errors.join("\n"));}}throw cause;}finally{globalThis.fetch=native;await park?.close();await enterprise?.close();cleanup(root);}
},120000);

test("offline split preserves business data and master memory while rotating company keys and keeping report identity",async()=>{
  const root=mkdtempSync(join(tmpdir(),"vectra-federation-")),legacy=join(root,"legacy"),target=join(root,"split");
  const app=await Collaboration.open({...config(),dataDir:legacy,logDir:join(legacy,"logs"),port:0});
  const oldCertificate=app.security.validateNode("carrier-a").fingerprint,report=app.security.sign("report",{note:"retained signed material"});
  app.agents.memory.save({category:"business",title:"保留的园区说明",content:"东入口需要人工核对",tags:[],enabled:true,pinned:false});
  configureFixtureModels(app,"preserved-model-key");
  app.park.import([{visitId:"legacy-visit",carrierId:"carrier-a",vehicleId:"沪A54321",road:"东入口",arrivedAt:Date.now()-10000}],app.park.catalog().version);
  await app.close();
  try{
    const result=await provisionDeployments(target,{legacyRoot:legacy});
    const p=readDeployment(result.deployments[0].config),park=await Collaboration.open({...config(),deployment:{...p,federation:{...p.federation,port:0}},dataDir:p.dataDir,logDir:p.logDir,port:0});
    try{expect(park.agents.memory.list().items[0].title).toBe("保留的园区说明");expect(park.settings.snapshot().apiKey).toBe("preserved-model-key");expect(park.security.verify(report,"report").note).toBe("retained signed material");expect(park.security.validateNode("carrier-a").fingerprint).not.toBe(oldCertificate);}finally{await park.close();}
    const own=readDeployment(result.deployments[1].config),security=await Security.open(join(own.dataDir,"pki"));
    const {ParkData}=await import("../src/park");expect(new ParkData(security,["carrier-a"]).snapshot().visits[0].visitId).toBe("legacy-visit");
    expect(existsSync(join(legacy,"pki","carrier-a","input.key"))).toBeTrue();
    const repeated=await provisionDeployments(target,{legacyRoot:legacy});expect(repeated).toEqual(result);
  }finally{cleanup(root);}
},60000);
