import { shallowRef } from "vue";
import { isCarrierId, error, type CarrierId, type CarrierRole } from "@vectra/shared";
import { api } from "./api";
import { portalSession } from "./portal";
function restored(): CarrierRole | undefined { try { const value = typeof sessionStorage !== "undefined" ? JSON.parse(sessionStorage.getItem("vectra.carrier-role") ?? "null") : null; return value && isCarrierId(value.carrierId) && typeof value.token === "string" && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now() ? value : undefined; } catch { return undefined; } }
export const currentCarrierRole = shallowRef<CarrierRole | undefined>(restored());
export async function selectCarrierRole(carrierId: CarrierId) {
  if(portalSession.value?.role==="carrier"&&portalSession.value.carrierId!==carrierId)throw error("carrier_scope_forbidden","当前登录账号不能切换到其他公司。",403);
  const previous = currentCarrierRole.value;
  const role = await api<CarrierRole>("/api/carrier-role", { method: "POST", body: JSON.stringify({ carrierId, ...(previous ? { previousToken: previous.token } : {}) }) });
  currentCarrierRole.value = role; if (typeof sessionStorage !== "undefined") sessionStorage.setItem("vectra.carrier-role", JSON.stringify(role)); return role;
}
export async function carrierApi<A>(carrierId: CarrierId, path: string, options: RequestInit = {}) {
  const role = currentCarrierRole.value;
  if (!role || role.carrierId !== carrierId || role.expiresAt <= Date.now()) throw error("carrier_role_required", "本企业操作凭据已失效，请刷新本页后继续。", 403);
  const headers = new Headers(options.headers); headers.set("X-Carrier-Role", role.token);
  return api<A>(path, { ...options, headers });
}
