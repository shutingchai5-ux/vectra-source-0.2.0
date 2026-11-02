import { shallowRef } from "vue";
import type { PortalSession } from "@vectra/shared";
export const portalSession=shallowRef<PortalSession>();
export const portalExpired=()=>{if(portalSession.value&&!portalSession.value.legacy)portalSession.value={...portalSession.value,authenticated:false};};

