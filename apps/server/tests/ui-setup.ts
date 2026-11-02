import { createRenderer, h, nextTick } from "vue";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
/** Exercise real Vue lifecycle and navigation guards without a browser or DOM. */
export async function mountPageSetup(component: any, props: any, emit: (...args: any[]) => void = () => {}, path = "/carriers", render?: (state: any) => any) {
  let state: any;
  const empty = { render: () => null }, page = { setup() { state = component.setup(props, { expose() {}, emit }); return () => render?.(state) ?? null; } }, activePath = path.split("?")[0];
  const router = createRouter({ history: createMemoryHistory(), routes: ["/", "/carriers", "/data", "/carrier-vehicles", "/vehicles"].map(route => ({ path: route, component: route === activePath ? page : empty })) });
  const renderer = createRenderer<object, object>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null });
  const app = renderer.createApp({ render: () => h(RouterView) }); app.use(router); await router.push(path); await router.isReady(); app.mount({}); await nextTick();
  for (let i = 0; i < 100 && state?.busy?.value; i++) await new Promise(resolve => setTimeout(resolve, 1));
  return { get state() { return state; }, router, stop: () => app.unmount() };
}
