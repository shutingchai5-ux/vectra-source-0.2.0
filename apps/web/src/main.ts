import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import Workspace from "./views/Workspace.vue";
import "./style.css";
import "katex/dist/katex.min.css";
import { installClientDiagnostics, recordClient } from "./diagnostics";

const router = createRouter({ history: createWebHashHistory(), scrollBehavior(to, _from, savedPosition) {
  // The conversation owns its follow-to-latest behavior; other pages use document scrolling.
  return to.path === "/" ? false : savedPosition || { top: 0, left: 0 };
}, routes: [
  { path: "/", component: Workspace, meta: { title: "AI 对话" } },
  { path: "/evidence", component: () => import("./views/Evidence.vue"), meta: { title: "证据与审计" } },
  { path: "/reports", component: () => import("./views/Reports.vue"), meta: { title: "结果验证" } },
  { path: "/data", component: () => import("./views/Data.vue"), meta: { title: "车辆数据" } },
  { path: "/settings", component: () => import("./views/Settings.vue"), meta: { title: "模型设置" } },
  { path: "/:pathMatch(.*)*", redirect: "/" },
] });
router.afterEach((to, _from, failure) => { if (!failure) recordClient("navigation", { message: to.path }); });
const app = createApp(App);
installClientDiagnostics(app);
app.use(createPinia()).use(router).mount("#app");
