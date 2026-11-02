import type { CarrierId, ParkSettings } from "./park";
import type { DataCatalog, StatisticsQuery } from "./statistics";
import type { ChargeCapacitySlot } from "./business";
export interface FederationManifest {
  version: string; dataset: Exclude<StatisticsQuery["dataset"], undefined>; domain?: StatisticsQuery["domain"]; updatedAt: number;
  settings: ParkSettings; sources: Record<CarrierId, { version: string; catalogDigest: string }>;
  chargingCapacityVersion?: string;
}
export interface DeploymentConfig {
  role: "park" | "carrier"; identity: "coordinator" | CarrierId; dataDir: string; logDir: string;
  host: string; port: number; publicUrl: string;
  federation: { host: string; port: number; peers: Record<string, string> };
  username: string; passwordHash: string;
  publicPeers?: Record<string, string>;
}
export interface PortalSession {
  role: "park" | "carrier"; identity: string; username: string; authenticated: boolean;
  carrierId?: CarrierId; settings?: ParkSettings; companyLinks?: Array<{ id: string; name: string; url: string }>;
  legacy?: boolean;
}
export interface EnterprisePortalConfig {
  role:"companies";host:string;port:number;publicUrl:string;parkUrl:string;dataDir:string;logDir:string;
  companies:Record<CarrierId,string>;
}
export interface FederationCatalogs {
  park: DataCatalog & { dataset: "park_visits"; settings: ParkSettings; visitCount: number; completedCount: number };
  reservations: import("./operations").ReservationCatalog;
  business: Record<import("./business").BusinessDomain, import("./business").BusinessCatalog>;
}

