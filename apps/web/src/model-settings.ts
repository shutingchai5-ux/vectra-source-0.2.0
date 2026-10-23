import { computed, reactive, ref } from "vue";
import { PROVIDERS, resolveThinkingProtocol, type PublicModelSettings, type ThinkingProtocol } from "@vectra/shared";
import { api } from "./api";

export function createModelSettingsEditor(onSettings: (settings: PublicModelSettings) => void, onError: (cause: unknown) => void) {
  const loading = ref(true), busy = ref(false), editing = ref(false), savedNotice = ref(false);
  const snapshot = ref<PublicModelSettings | null>(null);
  const form = reactive({ provider: "openai", baseUrl: "https://api.openai.com/v1", model: "", apiKey: "", clearApiKey: false,
    deepThinking: false, thinkingProtocol: "auto" as ThinkingProtocol });
  const locked = computed(() => loading.value || busy.value || !editing.value);
  const canCancel = computed(() => Boolean(snapshot.value?.saved || snapshot.value?.ready));
  const protocol = computed(() => resolveThinkingProtocol(form));
  function hydrate(settings: PublicModelSettings) {
    Object.assign(form, { provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, apiKey: "", clearApiKey: false,
      deepThinking: settings.deepThinking ?? false, thinkingProtocol: settings.thinkingProtocol ?? "auto" });
  }
  function accept(settings: PublicModelSettings) { snapshot.value = { ...settings }; hydrate(settings); onSettings(settings); }
  async function load() {
    loading.value = true;
    try { const settings = await api<PublicModelSettings>("/api/model-settings"); accept(settings); editing.value = !settings.saved && !settings.ready; }
    catch (cause) { onError(cause); }
    finally { loading.value = false; }
  }
  function beginEdit() { if (!snapshot.value || busy.value || loading.value) return; hydrate(snapshot.value); editing.value = true; savedNotice.value = false; }
  function cancelEdit() { if (!snapshot.value || busy.value) return; hydrate(snapshot.value); editing.value = !snapshot.value.saved && !snapshot.value.ready; savedNotice.value = false; }
  function providerChange() {
    if (locked.value) return;
    const preset = PROVIDERS.find(item => item.id === form.provider);
    if (preset) Object.assign(form, { baseUrl: preset.baseUrl, model: preset.model, apiKey: "", clearApiKey: false, deepThinking: false, thinkingProtocol: "auto" });
  }
  async function save() {
    if (locked.value) return;
    busy.value = true; savedNotice.value = false;
    try {
      const settings = await api<PublicModelSettings>("/api/model-settings", { method: "PUT", body: JSON.stringify(form) });
      accept(settings); editing.value = false; savedNotice.value = true;
    } catch (cause) { onError(cause); }
    finally { busy.value = false; }
  }
  return { form, snapshot, loading, busy, editing, savedNotice, locked, canCancel, protocol, load, beginEdit, cancelEdit, providerChange, save };
}
