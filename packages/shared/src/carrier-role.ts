import { CARRIER_BINDINGS, type CarrierId } from "./park";
export const isCarrierId = (value: unknown): value is CarrierId => CARRIER_BINDINGS.some(carrier => carrier.id === value);
export interface CarrierRole { carrierId: CarrierId; token: string; expiresAt: number }
