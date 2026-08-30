# ADR 0001: Provider契約とフォールバック判断の境界

- 状態: 採用
- 日付: 2026-08-30

## 背景

本プロジェクトの目的は「利用制限・障害・サービス終了で開発が止まらないこと」であり、
その実体は **フォールバックの判断** に集約される。判断材料が各SDKの例外や
HTTPステータスのままだと、Provider が増えるたびに Application 層へ分岐が漏れ出す。

## 決定

1. `ChatProvider` (`packages/providers/contract`) を唯一の Provider 境界とする。
2. SDK 固有の例外・HTTP ステータスは、必ずアダプタ内で `ProviderError` の
   9 種の `kind` へ正規化する。Application 層は `kind` しか見ない。
3. 再試行回数・フォールバック可否・Provider 冷却時間は
   `FallbackPolicy.FALLBACK_RULES` の表に集約する (ARCHITECTURE §4.2 と 1:1)。
4. `invalid_request` / `content_filtered` はフォールバックしない。
   前者は自分のバグ、後者は別モデルでの回避を方針として採らない。
5. 全 Provider は `tests/contract/chatProviderContract.ts` の適合テストを通す。

## 帰結

- Provider の追加が「調査」ではなく「作業」になる。
- 契約変更には ADR を必須とする (R3)。
- 部分出力を返した後の再試行は行わない。重複出力より失敗の可視化を優先する。
