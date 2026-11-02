import { shallowRef } from "vue";
import { defaultParkSettings, REGISTERED_IDENTITIES, type ParkSettings, type PublicNode } from "@vectra/shared";
export const currentParkSettings = shallowRef<ParkSettings>(defaultParkSettings());
export function setParkSettings(settings: ParkSettings) { currentParkSettings.value = settings; }
export const registeredIdentities = shallowRef<readonly PublicNode[]>([]);
export function setRegisteredIdentities(nodes: readonly PublicNode[]) {
  registeredIdentities.value = nodes.filter(node => REGISTERED_IDENTITIES.includes(node.id as typeof REGISTERED_IDENTITIES[number]) && !!node.displayName && typeof node.usesLlm === "boolean" && node.displayName.endsWith("Agent") === node.usesLlm && [1, 2, 3].includes(node.level ?? 0) && !!node.fingerprint && !!node.signingPublicKey);
}
