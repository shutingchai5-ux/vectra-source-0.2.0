import { config } from "../apps/server/src/config";
import { migrateCarrierIdentities } from "../apps/server/src/identity-migration";
import { Diagnostics } from "../apps/server/src/logging";
const settings = config(), receipt = await migrateCarrierIdentities(settings);
if (receipt) {
  new Diagnostics(settings.logDir).operation("identities.reissued", { ...receipt });
  console.log("已重新签发 carrier-a/b/c 登记身份，旧对话、报告、协议材料、审计与对应日志已清理。业务数据和模型配置已迁移。", JSON.stringify(receipt));
} else console.log("当前目录无需迁移，未清理任何记录。");
