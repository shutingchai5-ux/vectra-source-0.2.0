import type { CarrierId, ParkSettings, ParkVisit } from "./park";
import type { DataCatalog, MetricSpec, StatisticsQuery } from "./statistics";

export const BUSINESS_DOMAINS = { demand: "运输需求与到达弹性", haulage: "实际装载与空驶", returns: "回程运力", charging: "分时充电需求" } as const;
export type BusinessDomain = keyof typeof BUSINESS_DOMAINS;
export const CHARGE_CONNECTORS = { dc: "直流充电", ac: "交流充电", other: "其他接口" } as const;
export type ChargeConnector = keyof typeof CHARGE_CONNECTORS;
export const RETURN_REGIONS = { 1: "园区周边", 2: "华东", 3: "华北", 4: "华南", 5: "华中", 6: "西南", 7: "西北", 8: "东北", 9: "其他区域" } as const;
export interface BusinessDeclaration { start: number; end: number }
interface BusinessBase { id: string; road: string }
export interface DemandRecord extends BusinessBase {
  slotStart: number; earliestAt: number; latestAt: number; expectedTrips: number; reservedTrips: number; minimumCommittedTrips: number;
  expectedWorkMinutes: number; cargoTonnes?: number; cargoVolumeM3?: number; pallets?: number;
}
export interface HaulageRecord extends BusinessBase {
  visitId: string; vehicleId: string; recordedAt: number; sourceParkVersion: string;
  actualLoadTonnes?: number; loadCapacityTonnes?: number; actualVolumeM3?: number; loadCapacityVolumeM3?: number; pallets?: number; loadCapacityPallets?: number;
  loadedDistanceKm?: number; emptyDistanceKm?: number;
}
export interface ReturnRecord extends BusinessBase { slotStart: number; availableUntil: number; availableTrips: number; regionCode: keyof typeof RETURN_REGIONS }
export interface ChargingRecord extends BusinessBase {
  vehicleId: string; slotStart: number; deadlineAt: number; connector: ChargeConnector;
  batteryCapacityKwh: number; socPercent: number; targetSocPercent: number; maxPowerKw?: number;
}
export interface BusinessRecordMap { demand: DemandRecord; haulage: HaulageRecord; returns: ReturnRecord; charging: ChargingRecord }
export type BusinessRecord = BusinessRecordMap[BusinessDomain];
export interface BusinessCatalog extends DataCatalog { dataset: "carrier_business"; domain: BusinessDomain; settings: ParkSettings; declaration?: BusinessDeclaration; carrierId?: CarrierId }
export interface BusinessSnapshot { version: string; catalog: BusinessCatalog; records: BusinessRecord[] }
export interface ChargeCapacitySlot { road: string; slotStart: number; connector: ChargeConnector; ports: number; maxPowerKw: number; capacityKwh: number }
export interface ChargeCapacityWindow { road: string; start: number; end: number; connector: ChargeConnector; capacityKwh: number | null; coveredSlots: number; expectedSlots: number }
export interface BusinessContext { domain: BusinessDomain; sourceVersions: Record<string, string>; chargingWindows?: ChargeCapacityWindow[]; note: string }

export const BUSINESS_FIELD_LABELS = {
  expectedDemandTrips: "运输需求车次", unreservedTrips: "未预约车次", reservedDemandTrips: "已预约需求车次", committedTrips: "最低保留车次", flexibleTrips: "可调整车次", advanceableTrips: "可提前车次", delayableTrips: "可延后车次", dueSoonTrips: "查询起点后两小时内到期车次", demandWorkMinutes: "预计需求作业量", demandCargoTonnes: "预计货物吨数", demandCargoVolumeM3: "预计货物体积", demandPallets: "预计托盘数",
  actualLoadTonnes: "实际载货吨数", loadCapacityTonnes: "同车次适用载重", actualVolumeM3: "实际载货体积", loadCapacityVolumeM3: "同车次适用容积", pallets: "实际托盘数", loadCapacityPallets: "同车次托盘容量", loadedDistanceKm: "载货里程", emptyDistanceKm: "空驶里程", haulageDistanceKm: "载货与空驶总里程", tonneKm: "吨公里参考值",
  loadUtilizationPercent: "本车次载重利用率", volumeUtilizationPercent: "本车次容积利用率", palletUtilizationPercent: "本车次托盘利用率",
  availableReturnTrips: "可利用回程车次", returnRegionCode: "回程粗区域编号",
  chargeEnergyKwh: "所需充电电量", dcChargeKwh: "直流接口需求电量", acChargeKwh: "交流接口需求电量", otherChargeKwh: "其他接口需求电量", urgentChargeRequests: "查询起点后两小时内截止的充电请求", infeasibleChargeRequests: "按车辆功率上限仍无法完成的请求", chargeWindowMinutes: "允许补能时长",
} as const;
export type BusinessField = keyof typeof BUSINESS_FIELD_LABELS;
export const BUSINESS_FIELDS = Object.keys(BUSINESS_FIELD_LABELS) as BusinessField[];
export const BUSINESS_DOMAIN_FIELDS: Record<BusinessDomain, readonly BusinessField[]> = {
  demand: ["expectedDemandTrips","unreservedTrips","reservedDemandTrips","committedTrips","flexibleTrips","advanceableTrips","delayableTrips","dueSoonTrips","demandWorkMinutes","demandCargoTonnes","demandCargoVolumeM3","demandPallets"],
  haulage: ["actualLoadTonnes","loadCapacityTonnes","actualVolumeM3","loadCapacityVolumeM3","pallets","loadCapacityPallets","loadedDistanceKm","emptyDistanceKm","haulageDistanceKm","tonneKm","loadUtilizationPercent","volumeUtilizationPercent","palletUtilizationPercent"],
  returns: ["availableReturnTrips","returnRegionCode"],
  charging: ["chargeEnergyKwh","dcChargeKwh","acChargeKwh","otherChargeKwh","urgentChargeRequests","infeasibleChargeRequests","chargeWindowMinutes"],
};
export function businessUnit(field: string): string {
  if(field.endsWith("Percent"))return "%";
  if (field.endsWith("Minutes")) return "分钟";
  if (field.endsWith("Kwh")) return "kWh";
  if (field === "tonneKm") return "吨公里";
  if (field.endsWith("Km")) return "km";
  if (field.endsWith("Tonnes")) return "吨";
  if (field.endsWith("M3")) return "m³";
  if (/pallets/i.test(field)) return "托盘";
  return /Trips$/.test(field) ? "车次" : "条";
}
export function businessMetrics(domain: BusinessDomain): MetricSpec[] {
  const sum = (field: BusinessField): MetricSpec => ({ label: BUSINESS_FIELD_LABELS[field], operation: "sum", field });
  if (domain === "demand") return ["expectedDemandTrips","unreservedTrips","flexibleTrips","advanceableTrips","delayableTrips","dueSoonTrips","demandWorkMinutes"].map(field => sum(field as BusinessField));
  if (domain === "returns") return [sum("availableReturnTrips"), { label: "回程申报条数", operation: "count" }];
  if (domain === "charging") return ["chargeEnergyKwh","dcChargeKwh","acChargeKwh","otherChargeKwh","urgentChargeRequests","infeasibleChargeRequests"].map(field => sum(field as BusinessField));
  return [sum("actualLoadTonnes"),sum("actualVolumeM3"),sum("pallets"),sum("loadedDistanceKm"),sum("emptyDistanceKm"),
    { label: "按载重加权的装载利用率", operation: "ratio_of_sums", field: "actualLoadTonnes", denominatorField: "loadCapacityTonnes", multiplier: 100 },
    { label: "按容积加权的装载利用率", operation: "ratio_of_sums", field: "actualVolumeM3", denominatorField: "loadCapacityVolumeM3", multiplier: 100 },
    { label: "按托盘加权的装载利用率", operation: "ratio_of_sums", field: "pallets", denominatorField: "loadCapacityPallets", multiplier: 100 },
    { label: "联合空驶率", operation: "ratio_of_sums", field: "emptyDistanceKm", denominatorField: "haulageDistanceKm", multiplier: 100 },
    { label: "载重利用率低于50%的记录比例", operation: "ratio", filter: { field: "loadUtilizationPercent", op: "lt", value: 50 } },
    { label: "容积利用率低于50%的记录比例", operation: "ratio", filter: { field: "volumeUtilizationPercent", op: "lt", value: 50 } },
    { label: "托盘利用率低于50%的记录比例", operation: "ratio", filter: { field: "palletUtilizationPercent", op: "lt", value: 50 } }];
}

export const BUSINESS_GUIDE = "carrier_business为承运商私有经营台账。domain=demand/returns/charging为未来申报，最多未来31天，bucketMinutes取30/60/120/240/720/1440；domain=haulage为已离园车次事实，不设置bucketMinutes，不能查询未来。demand按计划到达slotStart选样本，businessSelection=deadline可按最晚到达时间选样本；每条需求只计一次，flexibleTrips=expectedTrips-minimumCommittedTrips且存在调整窗口，可提前与可延后可能同属一个需求，不能相加当作更多可调整车次。returns按申报开始时间选样本，availableReturnTrips是车次额度，returnRegionCode为1园区周边/2华东/3华北/4华南/5华中/6西南/7西北/8东北/9其他，可用filter筛选。charging按预计到达选样本；所需电量由电池容量×(目标SOC-当前SOC)/100本地派生；urgent按deadline<=查询起点+两小时判定；容量比较只说明电量压力，不是逐车排程。haulage按实际离园时间选样本，所有比值使用同批完整记录，不平均企业比例；吨公里仅在所选车次同一载货量适用于该载货里程时作为参考。声明覆盖不足三家时只能展示已收到资料，不能当作完整联合结果。不得请求单家明细、SOC、订单或精细轨迹。";

export function chargeCapacityResult(groups: import("./statistics").RoadStatistics[], windows: ChargeCapacityWindow[], metrics?:MetricSpec[]) {
  return groups.map(group => ({ road: group.road, start: group.slotStart!, end: group.slotEnd!, completeDeclarations: group.businessCoverage?.declaredCarriers === 3,
    connectors: (Object.keys(CHARGE_CONNECTORS) as ChargeConnector[]).map(connector => {
      const field = connector === "dc" ? "dcChargeKwh" : connector === "ac" ? "acChargeKwh" : "otherChargeKwh";
      const label=metrics?.find(item=>item.operation==="sum"&&item.field===field&&!item.filter)?.label??BUSINESS_FIELD_LABELS[field];
      const metric = group.metrics.find(item => item.label === label);
      const capacityKwh = windows.find(window=>window.road===group.road&&window.connector===connector&&window.start===group.slotStart&&window.end===group.slotEnd)?.capacityKwh ?? null;
      return { connector, demandKwh: metric?.value ?? null, capacityKwh, gapKwh: capacityKwh === null || metric?.value == null || group.businessCoverage?.declaredCarriers !== 3 ? null : Math.max(0,metric.value-capacityKwh) };
    }),
  }));
}

