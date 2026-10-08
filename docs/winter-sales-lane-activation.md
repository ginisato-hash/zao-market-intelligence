# Kiraku 冬季販売レーン: 本番 activation 手順 (runbook)

冬季販売レーン (ACTIVE / WARM / TRANSITION) は feature gate の背後にあり、既定では **無効 = 旧 planner と同一配分**。
有効条件は次の両方 (AND):

| ZMI_WINTER_SALES_LANE_ENABLED | 実効 ZMI_CRAWL_VOLUME_MULTIPLIER | 冬季レーン | manifest 読込 / transition ledger 書込 |
|---|---|---|---|
| 未設定 / "0" / "1" 以外 | 任意 | 無効 (旧配分) | しない |
| "1" | 1〜3 (未設定=1 を含む) | **無効 (旧配分)**。警告ログのみ | しない |
| "1" | 4 以上 (hard max 5 にクランプ) | 有効 | する |

実効 multiplier は既存の `resolveCrawlVolumeMultiplier` (整数化 + 1..5 クランプ) の値。

## 本番 activation (launchd 側で 3 つを同時に設定)

`com.yuge.zmi.market-refresh-rotating` の環境変数を次のとおり同時に変更する (このリポジトリでは launchd 実体を変更しない)。

- `ZMI_CRAWL_VOLUME_MULTIPLIER=4` (現行 3 から変更。Booking/Jalan の per-run cap が 36 -> 48)
- `ZMI_WINTER_SALES_LANE_ENABLED=1`
- `KIRAKU_WINTER_SALES_SCOPE_PATH=<RMS が出力する kiraku_winter_sales_scope_v1 JSON のパス>`

注意:
- multiplier 3 のまま `ZMI_WINTER_SALES_LANE_ENABLED=1` にしても **無効扱い** (near-term starvation が受入基準を超えるため)。
- manifest 未設定/欠落/stale(6h 超)/不正の場合、有効時でも冬季全日が WARM になる (販売中扱いにしない)。
- 冬季レーン有効時のみ一般リサーチの ski 期間が 3/31 まで拡張される (無効時は従来の 12/19..3/15)。
- 冬季 window 12/20..3/31、share 上限 0.40、選定根拠は `docs/winter-sales-coverage-simulation.md`。
- ロールバック: `ZMI_WINTER_SALES_LANE_ENABLED` を外す (または multiplier を 3 に戻す)。再起動で即旧配分に戻る。
