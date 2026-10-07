# Kiraku 冬季販売窓 coverage simulation (旧 planner vs 新 planner)

`npm run simulate:winter-coverage` が生成 (read-only: ネットワーク/ブラウザ/history 書込みなし)。数値は実走行の出力。

## 前提
- 初期状態: コミット済み .data/history (63,751 行, 最新 collected_at=2026-10-07T22:00:00+09:00) の (source, slug, checkin) 別 最終収集時刻。
- caps: 本番と同じ ZMI_CRAWL_VOLUME_MULTIPLIER=3 => booking 36/run, jalan 36/run, total 72/run, 12 slots/day (2h cadence) => booking 上限 432/day。cooldown 24h・near-term dense 30 日は不変。
- 期間: 14 日 (168 slots)。前半 7 日は warm-up、後半 7 日を各 slot 実行後に評価して時間平均 (steady)。全 selected は成功し collected_at が更新されると仮定。
- 旧 planner = base commit planner file (/Users/ginisato/kiraku-wt/winter/zmi-base/src/services/rotatingCollectionScopePlanner.ts)。新 planner = 本ブランチ (冬季レーン有効)。
- SLA 定義 (両 planner 共通): ACTIVE は lead<=21d 24h / 22-60d 48h / >60d 72h、WARM は 72h。対象 = PRIMARY_COMPARABLE 3 社 (HAMMOND/吉田屋/OAKHILL) x 窓内の残り泊日 (最大 102)。旧 planner にも同じ SLA で採点する。
- near-term starved = 既存 planner の RMS-critical 定義 (competitor lead<=56d, own lead<=90d) の Booking セルのうち、未収集または 84h (DEFAULT_SERVICE_DEADLINE_HOURS) 超のセル数。
- 冬季レーン上限 WINTER_LANE_MAX_BOOKING_SHARE=0.5 => lane 予算 = floor(36 x 0.5) = 18 pages/run。

## 開始日 2026-10-08

### (a) 販売中の日なし (全日 WARM)

| 指標 | 旧 | 新 |
|---|---:|---:|
| 冬季セルの required Booking pages/day (式: Σ 24/target_hours) | (旧は要求を持たない) | 102 |
| 冬季セルへの planned Booking pages/day (primary+own, 窓内) | 7.4 | 110.5 |
| Booking planned pages/day 合計 | 432 | 432 |
| global booking cap 使用率 (上限 432/day) | 100% | 100% |
| Jalan pages/day (参考: 不変のはず) | 432 | 432 |
| primary comparable coverage within SLA (定常 時間平均) | 0% | 100% |
| primary comparable coverage within 1.5x SLA (定常 時間平均) | 0% | 100% |
| primary comparable coverage within SLA (最終 slot) | 0% | 100% |
| Kiraku own ACTIVE coverage within SLA (定常) | - | - |
| max service age (h, 最終 slot, 収集済みセル) | - | 68 |
| 未収集 primary セル数 (最終) | 306 | 0 |
| near-term RMS-critical セル数 / starved (最終) / starved (定常平均) | 1412 / 170 / 175.4 | 1412 / 306 / 313.6 |
| 1 run 内の同一 property 最大 Booking pages | 2 | 5 |

### (b) 1/1-3/31 が販売中

| 指標 | 旧 | 新 |
|---|---:|---:|
| 冬季セルの required Booking pages/day (式: Σ 24/target_hours) | (旧は要求を持たない) | 132 |
| 冬季セルへの planned Booking pages/day (primary+own, 窓内) | 7.4 | 144.4 |
| Booking planned pages/day 合計 | 432 | 432 |
| global booking cap 使用率 (上限 432/day) | 100% | 100% |
| Jalan pages/day (参考: 不変のはず) | 432 | 432 |
| primary comparable coverage within SLA (定常 時間平均) | 0% | 99.4% |
| primary comparable coverage within 1.5x SLA (定常 時間平均) | 0% | 100% |
| primary comparable coverage within SLA (最終 slot) | 0% | 100% |
| Kiraku own ACTIVE coverage within SLA (定常) | 15.4% | 100% |
| max service age (h, 最終 slot, 収集済みセル) | - | 72 |
| 未収集 primary セル数 (最終) | 306 | 0 |
| near-term RMS-critical セル数 / starved (最終) / starved (定常平均) | 1412 / 170 / 175.4 | 1412 / 413 / 421 |
| 1 run 内の同一 property 最大 Booking pages | 2 | 5 |

### (c) 全窓 販売中 + sim 3 日目に一括 open (bulk transition)

| 指標 | 旧 | 新 |
|---|---:|---:|
| 冬季セルの required Booking pages/day (式: Σ 24/target_hours) | (旧は要求を持たない) | 128.8 |
| 冬季セルへの planned Booking pages/day (primary+own, 窓内) | 7.4 | 136.6 |
| Booking planned pages/day 合計 | 432 | 432 |
| global booking cap 使用率 (上限 432/day) | 100% | 100% |
| Jalan pages/day (参考: 不変のはず) | 432 | 432 |
| primary comparable coverage within SLA (定常 時間平均) | 0% | 100% |
| primary comparable coverage within 1.5x SLA (定常 時間平均) | 0% | 100% |
| primary comparable coverage within SLA (最終 slot) | 0% | 100% |
| Kiraku own ACTIVE coverage within SLA (定常) | 23.6% | 100% |
| max service age (h, 最終 slot, 収集済みセル) | - | 70 |
| 未収集 primary セル数 (最終) | 306 | 0 |
| near-term RMS-critical セル数 / starved (最終) / starved (定常平均) | 1412 / 170 / 175.4 | 1412 / 395 / 408.2 |
| 1 run 内の同一 property 最大 Booking pages | 2 | 5 |
| transition cooldown override 回数 | - | 18 |

## 開始日 2026-12-10

### (a) 販売中の日なし (全日 WARM)

| 指標 | 旧 | 新 |
|---|---:|---:|
| 冬季セルの required Booking pages/day (式: Σ 24/target_hours) | (旧は要求を持たない) | 101.3 |
| 冬季セルへの planned Booking pages/day (primary+own, 窓内) | 72.5 | 128.4 |
| Booking planned pages/day 合計 | 432 | 432 |
| global booking cap 使用率 (上限 432/day) | 100% | 100% |
| Jalan pages/day (参考: 不変のはず) | 432 | 432 |
| primary comparable coverage within SLA (定常 時間平均) | 49.1% | 100% |
| primary comparable coverage within 1.5x SLA (定常 時間平均) | 54.6% | 100% |
| primary comparable coverage within SLA (最終 slot) | 53.7% | 100% |
| Kiraku own ACTIVE coverage within SLA (定常) | - | - |
| max service age (h, 最終 slot, 収集済みセル) | 98 | 66 |
| 未収集 primary セル数 (最終) | 127 | 0 |
| near-term RMS-critical セル数 / starved (最終) / starved (定常平均) | 1412 / 30 / 38 | 1412 / 133 / 141.6 |
| 1 run 内の同一 property 最大 Booking pages | 2 | 5 |

### (b) 1/1-3/31 が販売中

| 指標 | 旧 | 新 |
|---|---:|---:|
| 冬季セルの required Booking pages/day (式: Σ 24/target_hours) | (旧は要求を持たない) | 174.6 |
| 冬季セルへの planned Booking pages/day (primary+own, 窓内) | 72.5 | 194.1 |
| Booking planned pages/day 合計 | 432 | 432 |
| global booking cap 使用率 (上限 432/day) | 100% | 100% |
| Jalan pages/day (参考: 不変のはず) | 432 | 432 |
| primary comparable coverage within SLA (定常 時間平均) | 33.3% | 98.7% |
| primary comparable coverage within 1.5x SLA (定常 時間平均) | 45.2% | 100% |
| primary comparable coverage within SLA (最終 slot) | 37.1% | 100% |
| Kiraku own ACTIVE coverage within SLA (定常) | 50% | 100% |
| max service age (h, 最終 slot, 収集済みセル) | 98 | 68 |
| 未収集 primary セル数 (最終) | 127 | 0 |
| near-term RMS-critical セル数 / starved (最終) / starved (定常平均) | 1412 / 30 / 38 | 1412 / 334 / 363.6 |
| 1 run 内の同一 property 最大 Booking pages | 2 | 6 |

### (c) 全窓 販売中 + sim 3 日目に一括 open (bulk transition)

| 指標 | 旧 | 新 |
|---|---:|---:|
| 冬季セルの required Booking pages/day (式: Σ 24/target_hours) | (旧は要求を持たない) | 188.2 |
| 冬季セルへの planned Booking pages/day (primary+own, 窓内) | 72.5 | 197.5 |
| Booking planned pages/day 合計 | 432 | 432 |
| global booking cap 使用率 (上限 432/day) | 100% | 100% |
| Jalan pages/day (参考: 不変のはず) | 432 | 432 |
| primary comparable coverage within SLA (定常 時間平均) | 27% | 95.8% |
| primary comparable coverage within 1.5x SLA (定常 時間平均) | 40.2% | 100% |
| primary comparable coverage within SLA (最終 slot) | 32.7% | 96.9% |
| Kiraku own ACTIVE coverage within SLA (定常) | 47.7% | 90.4% |
| max service age (h, 最終 slot, 収集済みセル) | 98 | 80 |
| 未収集 primary セル数 (最終) | 127 | 0 |
| near-term RMS-critical セル数 / starved (最終) / starved (定常平均) | 1412 / 30 / 38 | 1412 / 404 / 415.2 |
| 1 run 内の同一 property 最大 Booking pages | 2 | 7 |
| transition cooldown override 回数 | - | 50 |

## 読み方 / トレードオフ

- 全体の Booking 上限 (36/run x 12 slots) は不変で、旧 planner は near-term RMS-critical セルだけで既にほぼ使い切っている。冬季レーンは上限の内側で専用枠 (最大 share) を取るため、冬季 coverage の改善は near-term starved セル数の増加と引き換えになる。
- 冬季レーンは required (=必要量) までしか使わず、cooldown 中/鮮度十分のセルは選ばない。未使用の枠は通常レーンに戻る (work-conserving)。
- share は WINTER_LANE_MAX_BOOKING_SHARE の 1 定数で調整できる (下の感度分析)。

## 感度分析: WINTER_LANE_MAX_BOOKING_SHARE (開始日 2026-12-10, シナリオ (b))

| share | lane 予算/run | 冬季 planned pages/day | primary coverage within SLA (定常) | Kiraku own ACTIVE (定常) | near-term starved (定常平均 / 1412) |
|---:|---:|---:|---:|---:|---:|
| 0.25 | 9 | 128.4 | 64.2% | 73.5% | 120.9 |
| 0.33 | 11 | 150.6 | 75.9% | 86.2% | 195.3 |
| 0.5 | 18 | 194.1 | 98.7% | 100% | 363.6 |

