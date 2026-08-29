import { CustomForm, ObservableBoolean, ObservableNumber, ObservableString } from "@minecraft/server-ui";

// 個数を指定するスライダーの共通部品。従来は複数のUI(terminalUi.ts/autoTerminalUi.ts/
// inventoryTerminalUi.ts/precisionTerminalUi.ts/ioPadUi.ts)がそれぞれmin=1,max=64,step=1の
// 線形スライダーを個別に実装していたが、「毎回スライダーを細かく操作するのが面倒」「細かく
// 動かすより連打した方が速い」というユーザー指摘を受け、2のべき乗(1,2,4,...,1024)の11段階だけを
// 選べる形に統一した。
//
// DDUIのslider()はmin/max/stepいずれも数値で線形刻みしか表現できず、2のべき乗のような等比数列を
// 直接表現する手段が無い。そのため内部的にはインデックスをスライダー本体に束縛し(段数が64→11
// 段階に減るため、位置合わせに必要なドラッグの精度自体も下がる)、呼び出し元へ返す値(実際に
// 増減に使う個数)はそこから計算する。QUANTITY_STEPS[n] === 2^n となるようインデックスnをそのまま
// 指数として使えるようにしており(emptyOption併用時もこの対応関係はズレない、後述)、スライダーの
// ラベルは実際の個数を含む形に動的更新する(トグルの「増やす/減らす」ラベルと同じ、Observableの
// subscribeでテキスト自体を書き換えるパターン)。
export const QUANTITY_STEPS = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024];

// 在庫管理ターミナル/搬入出パッドが持っていた「空に設定」トグル(検索結果のタップの意味を
// 増減ではなく目標を0への直接上書きに切り替える)を、スライダーの一番左のステップに統合した
// (ユーザー要望)。0は通常のステップに絶対現れない値(QUANTITY_STEPSの最小は1)なので、
// amountが0であること自体を「空に設定が選ばれている」の判定に使える。
//
// 配列の先頭に追加する(インデックス0にする)実装も考えられるが、それだと以降の全ステップが
// 1つずつインデックスとズレる(QUANTITY_STEPS[n]が2^nではなく2^(n-1)になる)。「表示される数字が
// 2^nとズレるのが気持ち悪い」という指摘を受け、代わりに空に設定を**インデックス-1**として扱う
// (スライダーのminを-1にする)ことで、通常ステップのインデックスと指数の対応(QUANTITY_STEPS[n]
// === 2^n)を保ったままにした。
const EMPTY_STEP_VALUE = 0;
const EMPTY_STEP_INDEX = -1;

export type QuantitySliderResult = {
  // 空に設定が選ばれている間は0になる(emptyOption未指定なら常に通常の個数のみ)。
  amount: ObservableNumber;
  // 空に設定が選ばれているか。emptyOption未指定なら常にfalseのまま変化しない。
  isEmptySelected: ObservableBoolean;
};

function valueAtIndex(index: number): number {
  if (index < 0) return EMPTY_STEP_VALUE;
  return QUANTITY_STEPS[index] ?? QUANTITY_STEPS[QUANTITY_STEPS.length - 1];
}

// isIncreaseは「増やす/減らす」トグルと連動する符号表示(ユーザー要望)。呼び出し元がそのトグルを
// 持たない(precisionTerminalUi.ts等、目標を直接上書きするだけで増減の概念が無い)場合は
// undefinedのままにし、符号無しの従来通りの表示にする。空に設定は増減ではなく絶対値への上書きの
// ため、符号は付けない。
function labelText(label: string, value: number, isEmpty: boolean, isIncrease: boolean | undefined): string {
  if (isEmpty) return `${label}: 空に設定`;
  const sign = isIncrease === undefined ? "" : isIncrease ? "+" : "-";
  return `${label}: ${sign}${value}`;
}

export function setupQuantitySlider(
  form: CustomForm,
  label: string,
  tabVisible: ObservableBoolean,
  options?: { emptyOption?: boolean; signSource?: ObservableBoolean }
): QuantitySliderResult {
  const minIndex = options?.emptyOption ? EMPTY_STEP_INDEX : 0;
  const maxIndex = QUANTITY_STEPS.length - 1;
  const defaultIndex = QUANTITY_STEPS.indexOf(64);
  const signSource = options?.signSource;

  const stepIndex = new ObservableNumber(defaultIndex, { clientWritable: true });
  const initialValue = valueAtIndex(defaultIndex);
  const amount = new ObservableNumber(initialValue);
  const isEmptySelected = new ObservableBoolean(initialValue === EMPTY_STEP_VALUE);
  const sliderLabel = new ObservableString(
    labelText(label, initialValue, isEmptySelected.getData(), signSource?.getData())
  );

  const refreshLabel = (value: number, isEmpty: boolean) => {
    sliderLabel.setData(labelText(label, value, isEmpty, signSource?.getData()));
  };

  stepIndex.subscribe((index) => {
    const value = valueAtIndex(Math.round(index));
    const isEmpty = value === EMPTY_STEP_VALUE;
    amount.setData(value);
    isEmptySelected.setData(isEmpty);
    refreshLabel(value, isEmpty);
  });

  // 「増やす/減らす」トグル側が切り替わった時も符号表示を更新する。
  signSource?.subscribe(() => refreshLabel(amount.getData(), isEmptySelected.getData()));

  form.slider(sliderLabel, stepIndex, minIndex, maxIndex, {
    step: 1,
    visible: tabVisible,
  });

  return { amount, isEmptySelected };
}
