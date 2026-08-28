import { CustomForm, ObservableBoolean, ObservableNumber, ObservableString } from "@minecraft/server-ui";

// 個数を指定するスライダーの共通部品。従来は複数のUI(terminalUi.ts/autoTerminalUi.ts/
// inventoryTerminalUi.ts/precisionTerminalUi.ts/ioPadUi.ts)がそれぞれmin=1,max=64,step=1の
// 線形スライダーを個別に実装していたが、「毎回スライダーを細かく操作するのが面倒」「細かく
// 動かすより連打した方が速い」というユーザー指摘を受け、2のべき乗(1,2,4,...,1024)の11段階だけを
// 選べる形に統一した(ユーザー要望)。
//
// DDUIのslider()はmin/max/stepいずれも数値で線形刻みしか表現できず、2のべき乗のような等比数列を
// 直接表現する手段が無い。そのため内部的には0〜(QUANTITY_STEPS.length-1)のインデックスを
// スライダー本体に束縛し(段数が64→11に減るため、位置合わせに必要なドラッグの精度自体も下がる)、
// 呼び出し元へ返す値(実際に増減に使う個数)はそこから計算する。スライダーのラベルは実際の個数を
// 含む形に動的更新する(トグルの「増やす/減らす」ラベルと同じ、Observableのsubscribeでテキスト
// 自体を書き換えるパターン)。
export const QUANTITY_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];
const DEFAULT_STEP_INDEX = QUANTITY_STEPS.indexOf(64);

export function setupQuantitySlider(
  form: CustomForm,
  label: string,
  tabVisible: ObservableBoolean,
  options?: { disabled?: ObservableBoolean }
): ObservableNumber {
  const stepIndex = new ObservableNumber(DEFAULT_STEP_INDEX, { clientWritable: true });
  const amount = new ObservableNumber(QUANTITY_STEPS[DEFAULT_STEP_INDEX]);
  const sliderLabel = new ObservableString(`${label}: ${amount.getData()}`);

  stepIndex.subscribe((index) => {
    const value = QUANTITY_STEPS[Math.round(index)] ?? QUANTITY_STEPS[QUANTITY_STEPS.length - 1];
    amount.setData(value);
    sliderLabel.setData(`${label}: ${value}`);
  });

  form.slider(sliderLabel, stepIndex, 0, QUANTITY_STEPS.length - 1, {
    step: 1,
    visible: tabVisible,
    disabled: options?.disabled,
  });

  return amount;
}
