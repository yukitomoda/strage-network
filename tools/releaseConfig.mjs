// prod(リリース)パックの識別情報。dev用のBP/manifest.json・RP/manifest.jsonとは別の、
// 固定のUUID一式を持つ。一度リリースしたら値を変更しない(変えるとMinecraft側で「別パック」
// 扱いになり、既存のprodワールドとの紐付けが切れるため)。
export const PROD_UUIDS = {
  bpHeader: "96b4ab1f-596d-4bc6-a272-e905fbdf7bee",
  bpDataModule: "22c7c9c7-04f7-4719-992b-57110a70a612",
  bpScriptModule: "457c5602-3007-4ecd-a248-f6516d89cf2f",
  rpHeader: "b1a8e4d0-863f-4fdc-a2b9-bc9e5f3ef0b6",
  rpResourcesModule: "7a5fa52d-06b2-4b5b-a762-9cf5c72d12f7",
};

export const PROD_BP_NAME = "Storage Network - Behavior Pack";
export const PROD_RP_NAME = "Storage Network - Resource Pack";

export const OUTPUT_DIR = "dist";
export const BP_MCPACK_NAME = "StorageNetworkBP.mcpack";
export const RP_MCPACK_NAME = "StorageNetworkRP.mcpack";
export const MCADDON_NAME = "StorageNetwork.mcaddon";
