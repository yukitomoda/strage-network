import { Player } from "@minecraft/server";
import { CustomForm } from "@minecraft/server-ui";
import { endEditingSession, getEditingNetworkId } from "./editingSession";
import { getToolMode, setToolMode, ToolMode } from "./toolMode";

const MODE_LABELS: Record<ToolMode, string> = {
  build: "ネットワーク構築",
  drain: "Drain指定",
};

const MODE_DESCRIPTIONS: Record<ToolMode, string> = {
  build: "コントローラを右クリックして構築モードに入り、ストレージ/ターミナルをShift+右クリックで接続/切断します。",
  drain: "ストレージをShift+右クリックすると、そのストレージへの新規預け入れを止め、倉庫の整理でできるだけ空にします。",
};

// 素手(何も持たない状態)/空中で倉庫レンチを右クリックした時のモード選択メニュー。
export function showToolModeUi(player: Player): void {
  const current = getToolMode(player);

  const form = new CustomForm(player, "倉庫レンチ: モード選択");
  form.label(`現在のモード: ${MODE_LABELS[current]}`);
  form.divider();

  for (const mode of Object.keys(MODE_LABELS) as ToolMode[]) {
    form.button(MODE_LABELS[mode], () => {
      setToolMode(player, mode);
      player.sendMessage(`§bレンチのモードを「${MODE_LABELS[mode]}」に切り替えました。`);
      form.close();
    }, { disabled: mode === current, tooltip: MODE_DESCRIPTIONS[mode] });
  }

  // ネットワーク編集中(構築/Drainいずれか)は、コントローラまで戻らなくても終了できるように
  // 同じ操作(handleControllerUseのトグルOFF相当)をここからも行えるようにする。
  if (getEditingNetworkId(player) !== undefined) {
    form.divider();
    form.button("編集モードを終了する", () => {
      endEditingSession(player);
      player.sendMessage("§eネットワーク編集を終了しました。");
      form.close();
    });
  }

  form.show().catch((e) => console.error(e));
}
