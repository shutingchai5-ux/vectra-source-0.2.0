import { createApp } from "vue";
import { createPinia } from "pinia";
import { createRouter, createWebHashHistory } from "vue-router";
import App from "./App.vue";
import { SYSTEM_TERMS } from "@vectra/shared";
import Workspace from "./views/Workspace.vue";
import "./style.css";
import "katex/dist/katex.min.css";
import "./ui.css";
import "./layout.css";
import { installUi } from "./components/ui";
import { installClientDiagnostics, recordClient } from "./diagnostics";
import { portalSession } from "./portal";

const router = createRouter({ history: createWebHashHistory(), scrollBehavior(to, _from, savedPosition) {
  // The conversation owns its follow-to-latest behavior; other pages use document scrolling.
  return to.path === "/" ? false : savedPosition || { top: 0, left: 0 };
}, routes: [
  { path: "/", component: Workspace, meta: { title: "AI 对话" } },
  { path: "/agents", component: () => import("./views/Agents.vue"), meta: { title: "Agent 工作组" } },
  { path: "/agents/:id", component: () => import("./views/AgentDetail.vue"), meta: { title: "Agent 详情" } },
  { path: "/evidence", component: () => import("./views/Evidence.vue"), meta: { title: "证据与审计" } },
  { path: "/reports", component: () => import("./views/Reports.vue"), meta: { title: SYSTEM_TERMS.reportsPage } },
  { path: "/vehicles", component: () => import("./views/Vehicles.vue"), meta: { title: "园区车辆" } },
  { path: "/operations", component: () => import("./views/Operations.vue"), meta: { title: "联合运营分析" } },
  { path: "/carriers", component: () => import("./views/CarrierWorkspace.vue"), meta: { title: "承运商工作台" } },
  { path: "/business", component: () => import("./views/BusinessWorkspace.vue"), meta: { title: "企业私有经营台账" } },
  { path: "/sign-out", component: () => import("./views/SignOut.vue"), meta: { title: "退出登录" } },
  { path: "/carrier-vehicles", redirect: to => ({ path: "/carriers", query: { ...to.query, tab: "vehicles" } }) },
  { path: "/data", redirect: to => ({ path: "/carriers", query: { ...to.query, tab: "visits" } }) },
  { path: "/settings", redirect: { path: "/agents/coordinator", query: { section: "model" } } },
  { path: "/:pathMatch(.*)*", redirect: "/" },
] });
router.beforeEach(to=>{
  const session=portalSession.value;if(!session?.authenticated||session.legacy||to.path==="/sign-out")return;
  if(session.role==="carrier"&&!["/carriers","/business"].includes(to.path))return "/carriers";
  if(session.role==="park"&&["/carriers","/business"].includes(to.path))return "/";
});
router.afterEach((to, _from, failure) => { if (!failure) recordClient("navigation", { message: to.path }); });
const app = createApp(App);
installUi(app);
installClientDiagnostics(app);
app.use(createPinia()).use(router).mount("#app");
