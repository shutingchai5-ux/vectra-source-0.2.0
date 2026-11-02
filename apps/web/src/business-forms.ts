import { BUSINESS_DOMAINS,CHARGE_CONNECTORS,RETURN_REGIONS,type BusinessDomain } from "@vectra/shared";
export interface BusinessFieldForm {key:string;label:string;kind:"number"|"time"|"vehicle"|"visit"|"select";required?:boolean;integer?:boolean;options?:Record<string,string>;help?:string}
const numeric=(key:string,label:string,required=false,integer=false):BusinessFieldForm=>({key,label,kind:"number",required,integer});
const date=(key:string,label:string):BusinessFieldForm=>({key,label,kind:"time",required:true});
export const businessForms:Record<BusinessDomain,BusinessFieldForm[]>={
 demand:[date("earliestAt","最早允许到达"),date("slotStart","计划到达（整点或半点）"),date("latestAt","最晚允许到达"),numeric("expectedTrips","总运输需求（车次）",true,true),numeric("reservedTrips","其中已预约（车次）",true,true),numeric("minimumCommittedTrips","最低保留承诺（车次）",true,true),numeric("expectedWorkMinutes","预计作业量（分钟）",true),numeric("cargoTonnes","预计货量（吨）"),numeric("cargoVolumeM3","预计体积（m³）"),numeric("pallets","预计托盘数",false,true)],
 haulage:[{key:"visitId",label:"本方已离园车次",kind:"visit",required:true},numeric("actualLoadTonnes","实际装载（吨）"),numeric("loadCapacityTonnes","本车次适用载重（吨）"),numeric("actualVolumeM3","实际装载体积（m³）"),numeric("loadCapacityVolumeM3","本车次适用容积（m³）"),numeric("pallets","实际托盘数",false,true),numeric("loadCapacityPallets","本车次托盘容量",false,true),numeric("loadedDistanceKm","载货里程（km）"),numeric("emptyDistanceKm","空驶里程（km）")],
 returns:[date("slotStart","可用开始（整点或半点）"),date("availableUntil","可用结束"),numeric("availableTrips","可承接回程（车次）",true,true),{key:"regionCode",label:"回程粗区域",kind:"select",required:true,options:Object.fromEntries(Object.entries(RETURN_REGIONS).map(([key,label])=>[key,label]))}],
 charging:[{key:"vehicleId",label:"本方车辆",kind:"vehicle",required:true},date("slotStart","预计到达充电区域"),date("deadlineAt","需要完成补能的时间"),{key:"connector",label:"充电接口",kind:"select",required:true,options:CHARGE_CONNECTORS},numeric("batteryCapacityKwh","电池容量（kWh）",true),numeric("socPercent","当前电量（%）",true),numeric("targetSocPercent","目标电量（%）",true),numeric("maxPowerKw","车辆最大充电功率（kW）")],
};
export const businessDescriptions:Record<BusinessDomain,string>={
 demand:"在本方记录尚未预约的运输压力及可调整范围。总需求、已预约和最低保留承诺分别填写；同一条需求只统计一次。",
 haulage:"关联真实已离园车次，补充实际装载与里程拆分。到达、入口及离园时间来自原车次，未知数值留空。",
 returns:"按可用时间和粗区域申报回程车次额度。只汇总可利用规模，当前不自动匹配订单或承诺分配。",
 charging:"电池容量和当前电量保留在本企业；所需补能电量在本地派生后参与联合统计，不把单车电量交给园区。",
};
export const businessRecordEnd=(domain:BusinessDomain,row:Record<string,unknown>)=>Number(domain==="demand"?row.latestAt:domain==="returns"?row.availableUntil:domain==="charging"?row.deadlineAt:row.recordedAt);
export { BUSINESS_DOMAINS };

