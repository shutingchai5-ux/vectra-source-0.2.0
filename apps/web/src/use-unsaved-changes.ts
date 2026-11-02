import { onMounted, onUnmounted } from "vue";
import { onBeforeRouteLeave } from "vue-router";
export function useUnsavedChanges(dirty: () => boolean, label: string, handlesNavigation: () => boolean = () => true) {
  const confirmDiscard = () => !dirty() || window.confirm(label + "有尚未保存的修改，离开将丢失这些草稿。是否继续？");
  onBeforeRouteLeave(() => !handlesNavigation() || confirmDiscard());
  const unload = (event: BeforeUnloadEvent) => { if (handlesNavigation() && dirty()) { event.preventDefault(); event.returnValue = ""; } };
  onMounted(() => { if (typeof window !== "undefined") window.addEventListener("beforeunload", unload); });
  onUnmounted(() => { if (typeof window !== "undefined") window.removeEventListener("beforeunload", unload); });
  return confirmDiscard;
}
