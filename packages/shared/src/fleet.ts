import type { CarrierId, ParkSettings } from "./park";
export const VEHICLE_TYPES = { heavy_truck: "重型货车", light_truck: "轻型货车", tractor: "牵引车", van: "厢式货车", other: "其他车型" } as const;
export const ENERGY_TYPES = { electric: "纯电", diesel: "柴油", hybrid: "混合动力", other: "其他动力" } as const;
export const VEHICLE_STATUSES = { queued: "排队待入园", in_park: "已入园", working: "作业中", work_completed: "作业已结束", departed: "已离园", no_visit: "暂无车次" } as const;
export interface ParkVehicle {
  /** vehicleId is the normalized plate for current records; legacy IDs are read only until corrected. */
  vehicleId: string; carrierId: CarrierId; plateNumber?: string; vehicleType?: keyof typeof VEHICLE_TYPES;
  energyType?: keyof typeof ENERGY_TYPES; capacityTonnes?: number;
  /** Historical profile metadata only; new profiles use [], actual entrances belong to visits. */
  allowedRoads: string[]; updatedAt?: number;
}
export interface VehicleState extends ParkVehicle {
  profiled: boolean; status: keyof typeof VEHICLE_STATUSES;
  lastVisit?: { visitId: string; road: string; arrivedAt: number; lastEventAt: number; stage: string };
}
export interface FleetOverview {
  version: string; updatedAt: number; parkVersion: string; parkUpdatedAt: number; settings: ParkSettings; roads: string[];
  vehicles: VehicleState[];
  carrierId?: CarrierId; scopeVersion?: string;
}
export const MAX_FLEET_VEHICLES = 6000;
