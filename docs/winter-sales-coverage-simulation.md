# Kiraku 冬季販売窓 coverage simulation / multiplier x share 感度分析

`npm run simulate:winter-coverage` が生成 (read-only: ネットワーク/ブラウザ/history 書込みなし)。数値は実走行の出力。

## 前提
- 初期状態: コミット済み .data/history (63,751 行, 最新 collected_at=2026-10-07T22:00:00+09:00) の (source, slug, checkin) 別 最終収集時刻。
- 期間 14 日 (168 slots, 2h cadence)。後半 7 日を各 slot 実行後に評価し時間平均 (steady)。全 selected は成功と仮定。cooldown 24h・near-term dense 30 日・per-run cap の基数 (booking 12) は不変。multiplier のみ {3,4,5} で変化 (hard max 5)。
- 旧 planner = base commit planner file (/Users/ginisato/kiraku-wt/winter/zmi-base/src/services/rotatingCollectionScopePlanner.ts)。新 planner = 本ブランチ。SLA 定義は両者共通 (ACTIVE: lead<=21d 24h / 22-60d 48h / >60d 72h、WARM 72h)。
- near-term starved = RMS-critical Booking セル (competitor lead<=56d / own lead<=90d, 総数 1412) のうち未収集または 84h 超。base = 旧 planner @ multiplier 3 (現行本番)。
- 採用基準 (自動): ACTIVE: primary SLA steady>=95% かつ final-slot>=95% かつ own ACTIVE>=95%。WARM: primary 1.5x SLA steady>=95% かつ steady 未収集 0。既存レーン: near-term starved steady 平均 <= base + 5% x 総数 (約+70)、96h 超セル数も同許容。multiplier 最小 -> share 最小を採用。
- 配分は固定予約でなく緊急度順 (1.TRANSITION 2.ACTIVE 3.RMS-critical never/overdue 4.WARM 5.research)。share は冬季の上限 (ceiling)、未使用 capacity は他 lane へ返る。near-term starved が (12%+5%) x 総数 を超えると WARM と lead>60d の ACTIVE を抑制 (backpressure)。

## 結果

**採用: multiplier=4, winter max share=0.4** (全シナリオが基準を満たす最小構成)。

### 10/08 全日 WARM (WARM 基準)

| mult | share | 判定 | 未達 | winter pages/day | effective winter share | total Booking/day (cap 利用) | primary SLA steady / final | primary 1.5x | own ACTIVE | 未収集 steady max | near starved steady (base) | >96h steady (base) | backpressure runs |
|---:|---:|:--|:--|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3 | 旧 | - | - | 7.4 | - | 432 (100%) | 0% / 0% | 0% | -% | 306 | 175.4 | 154.8 | - |
| 3 | 0.25 | fail | near_term_starved_over_base+5%, near_term_over_96h_chronic | 101.3 | 23.4% | 432 (100%) | 98.4% / 100% | 100% | -% | 0 | 294.6 (175.4) | 244.9 (154.8) | 15 |
| 3 | 0.33 | fail | near_term_starved_over_base+5%, near_term_over_96h_chronic | 101.3 | 23.4% | 432 (100%) | 98.4% / 100% | 100% | -% | 0 | 294.6 (175.4) | 244.9 (154.8) | 15 |
| 3 | 0.4 | fail | near_term_starved_over_base+5%, near_term_over_96h_chronic | 101.3 | 23.4% | 432 (100%) | 98.4% / 100% | 100% | -% | 0 | 294.6 (175.4) | 244.9 (154.8) | 15 |
| 3 | 0.5 | fail | near_term_starved_over_base+5%, near_term_over_96h_chronic | 101.3 | 23.4% | 432 (100%) | 98.4% / 100% | 100% | -% | 0 | 294.6 (175.4) | 244.9 (154.8) | 15 |
| 4 | 旧 | - | - | 8.4 | - | 576 (100%) | 1.4% / 1.6% | 1.4% | -% | 306 | 172 | 150.5 | - |
| 4 | 0.25 | PASS | - | 112.9 | 19.6% | 576 (100%) | 100% / 100% | 100% | -% | 0 | 175.9 (175.4) | 155.5 (154.8) | 4 |
| 4 | 0.33 | PASS | - | 112.9 | 19.6% | 576 (100%) | 100% / 100% | 100% | -% | 0 | 175.9 (175.4) | 155.5 (154.8) | 4 |
| 4 | 0.4 | PASS | - | 112.9 | 19.6% | 576 (100%) | 100% / 100% | 100% | -% | 0 | 175.9 (175.4) | 155.5 (154.8) | 4 |
| 4 | 0.5 | PASS | - | 112.9 | 19.6% | 576 (100%) | 100% / 100% | 100% | -% | 0 | 175.9 (175.4) | 155.5 (154.8) | 4 |
| 5 | 旧 | - | - | 11 | - | 720 (100%) | 2.2% / 2.9% | 2.9% | -% | 303 | 26.1 | 26.1 | - |
| 5 | 0.25 | PASS | - | 113.8 | 15.8% | 720 (100%) | 100% / 100% | 100% | -% | 0 | 88.3 (175.4) | 72.5 (154.8) | 3 |
| 5 | 0.33 | PASS | - | 113.8 | 15.8% | 720 (100%) | 100% / 100% | 100% | -% | 0 | 88.3 (175.4) | 72.5 (154.8) | 3 |
| 5 | 0.4 | PASS | - | 113.8 | 15.8% | 720 (100%) | 100% / 100% | 100% | -% | 0 | 88.3 (175.4) | 72.5 (154.8) | 3 |
| 5 | 0.5 | PASS | - | 113.8 | 15.8% | 720 (100%) | 100% / 100% | 100% | -% | 0 | 88.3 (175.4) | 72.5 (154.8) | 3 |

### 10/08 1/1-3/31 ACTIVE (ACTIVE 基準)

| mult | share | 判定 | 未達 | winter pages/day | effective winter share | total Booking/day (cap 利用) | primary SLA steady / final | primary 1.5x | own ACTIVE | 未収集 steady max | near starved steady (base) | >96h steady (base) | backpressure runs |
|---:|---:|:--|:--|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3 | 旧 | - | - | 7.4 | - | 432 (100%) | 0% / 0% | 0% | 15.4% | 306 | 175.4 | 154.8 | - |
| 3 | 0.25 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5%, near_term_over_96h_chronic | 101.4 | 23.5% | 432 (100%) | 75.6% / 79.7% | 93.8% | 78.1% | 0 | 289.4 (175.4) | 239.1 (154.8) | 13 |
| 3 | 0.33 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5%, near_term_over_96h_chronic | 108.4 | 25.1% | 432 (100%) | 86.4% / 87.3% | 100% | 68.7% | 0 | 316.3 (175.4) | 261.5 (154.8) | 32 |
| 3 | 0.4 | fail | primary_sla_steady<95, primary_sla_final<95, near_term_starved_over_base+5%, near_term_over_96h_chronic | 112.5 | 26% | 432 (100%) | 81.1% / 87.3% | 100% | 95.4% | 0 | 326.5 (175.4) | 269.9 (154.8) | 38 |
| 3 | 0.5 | fail | primary_sla_steady<95, primary_sla_final<95, near_term_starved_over_base+5%, near_term_over_96h_chronic | 112.5 | 26% | 432 (100%) | 81.1% / 87.3% | 100% | 95.4% | 0 | 326.5 (175.4) | 269.9 (154.8) | 38 |
| 4 | 旧 | - | - | 8.4 | - | 576 (100%) | 1.4% / 1.6% | 1.4% | 15.3% | 306 | 172 | 150.5 | - |
| 4 | 0.25 | PASS | - | 144.4 | 25.1% | 576 (100%) | 99.4% / 100% | 100% | 100% | 0 | 174.8 (175.4) | 153.9 (154.8) | 4 |
| 4 | 0.33 | PASS | - | 144.4 | 25.1% | 576 (100%) | 99.4% / 100% | 100% | 100% | 0 | 174.8 (175.4) | 153.9 (154.8) | 4 |
| 4 | 0.4 | PASS | - | 144.4 | 25.1% | 576 (100%) | 99.4% / 100% | 100% | 100% | 0 | 174.8 (175.4) | 153.9 (154.8) | 4 |
| 4 | 0.5 | PASS | - | 144.4 | 25.1% | 576 (100%) | 99.4% / 100% | 100% | 100% | 0 | 174.8 (175.4) | 153.9 (154.8) | 4 |
| 5 | 旧 | - | - | 11 | - | 720 (100%) | 2.2% / 2.9% | 2.9% | 17.7% | 303 | 26.1 | 26.1 | - |
| 5 | 0.25 | PASS | - | 145.9 | 20.3% | 720 (100%) | 99.4% / 100% | 100% | 100% | 0 | 170.4 (175.4) | 149.1 (154.8) | 3 |
| 5 | 0.33 | PASS | - | 145.9 | 20.3% | 720 (100%) | 99.4% / 100% | 100% | 100% | 0 | 170.4 (175.4) | 149.1 (154.8) | 3 |
| 5 | 0.4 | PASS | - | 145.9 | 20.3% | 720 (100%) | 99.4% / 100% | 100% | 100% | 0 | 170.4 (175.4) | 149.1 (154.8) | 3 |
| 5 | 0.5 | PASS | - | 145.9 | 20.3% | 720 (100%) | 99.4% / 100% | 100% | 100% | 0 | 170.4 (175.4) | 149.1 (154.8) | 3 |

### 12/10 全日 WARM (WARM 基準)

| mult | share | 判定 | 未達 | winter pages/day | effective winter share | total Booking/day (cap 利用) | primary SLA steady / final | primary 1.5x | own ACTIVE | 未収集 steady max | near starved steady (base) | >96h steady (base) | backpressure runs |
|---:|---:|:--|:--|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3 | 旧 | - | - | 72.5 | - | 432 (100%) | 49.1% / 53.7% | 54.6% | -% | 147 | 38 | 29 | - |
| 3 | 0.25 | fail | near_term_starved_over_base+5% | 116.2 | 26.9% | 432 (100%) | 100% / 100% | 100% | -% | 0 | 146.6 (38) | 90.3 (29) | 35 |
| 3 | 0.33 | fail | near_term_starved_over_base+5% | 116.2 | 26.9% | 432 (100%) | 100% / 100% | 100% | -% | 0 | 146.6 (38) | 90.3 (29) | 35 |
| 3 | 0.4 | fail | near_term_starved_over_base+5% | 116.2 | 26.9% | 432 (100%) | 100% / 100% | 100% | -% | 0 | 146.6 (38) | 90.3 (29) | 35 |
| 3 | 0.5 | fail | near_term_starved_over_base+5% | 116.2 | 26.9% | 432 (100%) | 100% / 100% | 100% | -% | 0 | 146.6 (38) | 90.3 (29) | 35 |
| 4 | 旧 | - | - | 89.7 | - | 576 (100%) | 54.7% / 56.8% | 54.7% | -% | 147 | 34.5 | 29.3 | - |
| 4 | 0.25 | PASS | - | 139.2 | 24.2% | 576 (100%) | 100% / 100% | 100% | -% | 0 | 29.4 (38) | 24.6 (29) | 27 |
| 4 | 0.33 | PASS | - | 139.2 | 24.2% | 576 (100%) | 100% / 100% | 100% | -% | 0 | 29.4 (38) | 24.6 (29) | 27 |
| 4 | 0.4 | PASS | - | 139.2 | 24.2% | 576 (100%) | 100% / 100% | 100% | -% | 0 | 29.4 (38) | 24.6 (29) | 27 |
| 4 | 0.5 | PASS | - | 139.2 | 24.2% | 576 (100%) | 100% / 100% | 100% | -% | 0 | 29.4 (38) | 24.6 (29) | 27 |
| 5 | 旧 | - | - | 113.9 | - | 720 (100%) | 55.3% / 57.1% | 55.4% | -% | 142 | 0.8 | 0.8 | - |
| 5 | 0.25 | PASS | - | 181 | 25.1% | 720 (100%) | 100% / 100% | 100% | -% | 0 | 2.1 (38) | 2.1 (29) | 21 |
| 5 | 0.33 | PASS | - | 181 | 25.1% | 720 (100%) | 100% / 100% | 100% | -% | 0 | 2.1 (38) | 2.1 (29) | 21 |
| 5 | 0.4 | PASS | - | 181 | 25.1% | 720 (100%) | 100% / 100% | 100% | -% | 0 | 2.1 (38) | 2.1 (29) | 21 |
| 5 | 0.5 | PASS | - | 181 | 25.1% | 720 (100%) | 100% / 100% | 100% | -% | 0 | 2.1 (38) | 2.1 (29) | 21 |

### 12/10 1/1-3/31 ACTIVE (ACTIVE 基準)

| mult | share | 判定 | 未達 | winter pages/day | effective winter share | total Booking/day (cap 利用) | primary SLA steady / final | primary 1.5x | own ACTIVE | 未収集 steady max | near starved steady (base) | >96h steady (base) | backpressure runs |
|---:|---:|:--|:--|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3 | 旧 | - | - | 72.5 | - | 432 (100%) | 33.3% / 37.1% | 45.2% | 50% | 147 | 38 | 29 | - |
| 3 | 0.25 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5% | 122.3 | 28.3% | 432 (100%) | 64.2% / 67% | 90.2% | 72.7% | 0 | 129.4 (38) | 72.2 (29) | 37 |
| 3 | 0.33 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5% | 131.1 | 30.3% | 432 (100%) | 70.5% / 77.9% | 98.4% | 73% | 0 | 163.8 (38) | 97.2 (29) | 44 |
| 3 | 0.4 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5%, near_term_over_96h_chronic | 140.4 | 32.5% | 432 (100%) | 77% / 76.9% | 97.6% | 84.4% | 0 | 201 (38) | 129.4 (29) | 70 |
| 3 | 0.5 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5%, near_term_over_96h_chronic | 142.7 | 33% | 432 (100%) | 79.6% / 84% | 100% | 85.9% | 0 | 212 (38) | 132.3 (29) | 84 |
| 4 | 旧 | - | - | 89.7 | - | 576 (100%) | 41% / 43.2% | 51.1% | 49.9% | 147 | 34.5 | 29.3 | - |
| 4 | 0.25 | fail | primary_sla_steady<95, primary_sla_final<95 | 160.7 | 27.9% | 576 (100%) | 79.8% / 77.2% | 100% | 98.7% | 0 | 21.8 (38) | 19.8 (29) | 28 |
| 4 | 0.33 | PASS | - | 181.2 | 31.5% | 576 (100%) | 98.2% / 98% | 100% | 99.3% | 0 | 22 (38) | 20.1 (29) | 28 |
| 4 | 0.4 | PASS | - | 184.9 | 32.1% | 576 (100%) | 98% / 96.6% | 100% | 100% | 0 | 22.3 (38) | 19.9 (29) | 28 |
| 4 | 0.5 | PASS | - | 184.9 | 32.1% | 576 (100%) | 98% / 96.6% | 100% | 100% | 0 | 22.3 (38) | 19.9 (29) | 28 |
| 5 | 旧 | - | - | 113.9 | - | 720 (100%) | 44.2% / 45.2% | 52.8% | 71.4% | 142 | 0.8 | 0.8 | - |
| 5 | 0.25 | PASS | - | 230.1 | 32% | 720 (100%) | 100% / 100% | 100% | 100% | 0 | 18.7 (38) | 15.3 (29) | 22 |
| 5 | 0.33 | PASS | - | 232.6 | 32.3% | 720 (100%) | 100% / 100% | 100% | 100% | 0 | 20.1 (38) | 16.4 (29) | 22 |
| 5 | 0.4 | PASS | - | 232.6 | 32.3% | 720 (100%) | 100% / 100% | 100% | 100% | 0 | 20.1 (38) | 16.4 (29) | 22 |
| 5 | 0.5 | PASS | - | 232.6 | 32.3% | 720 (100%) | 100% / 100% | 100% | 100% | 0 | 20.1 (38) | 16.4 (29) | 22 |

### 12/10 全窓 ACTIVE + bulk transition (ACTIVE 基準)

| mult | share | 判定 | 未達 | winter pages/day | effective winter share | total Booking/day (cap 利用) | primary SLA steady / final | primary 1.5x | own ACTIVE | 未収集 steady max | near starved steady (base) | >96h steady (base) | backpressure runs |
|---:|---:|:--|:--|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3 | 旧 | - | - | 72.5 | - | 432 (100%) | 27% / 32.7% | 40.2% | 47.7% | 147 | 38 | 29 | - |
| 3 | 0.25 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5% | 117.3 | 27.1% | 432 (100%) | 59.2% / 61.2% | 86.6% | 65.4% | 0 | 128.9 (38) | 70.7 (29) | 35 |
| 3 | 0.33 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5%, near_term_over_96h_chronic | 129.2 | 29.9% | 432 (100%) | 68% / 61.2% | 97% | 62.6% | 0 | 178.7 (38) | 117.2 (29) | 44 |
| 3 | 0.4 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5%, near_term_over_96h_chronic | 142.6 | 33% | 432 (100%) | 68.1% / 74.8% | 94.8% | 77.1% | 0 | 218.2 (38) | 160.6 (29) | 82 |
| 3 | 0.5 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95, near_term_starved_over_base+5%, near_term_over_96h_chronic | 145.5 | 33.7% | 432 (100%) | 67.3% / 82.3% | 93.1% | 82.9% | 9 | 229.9 (38) | 154.9 (29) | 107 |
| 4 | 旧 | - | - | 89.7 | - | 576 (100%) | 35.9% / 38.1% | 48.3% | 47.7% | 147 | 34.5 | 29.3 | - |
| 4 | 0.25 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95 | 154.2 | 26.8% | 576 (100%) | 72.4% / 77.6% | 99.4% | 87.3% | 0 | 21.8 (38) | 19.8 (29) | 27 |
| 4 | 0.33 | fail | primary_sla_steady<95, primary_sla_final<95, own_active_sla<95 | 173.5 | 30.1% | 576 (100%) | 88.6% / 90.5% | 100% | 87.3% | 0 | 21.6 (38) | 19.5 (29) | 27 |
| 4 | 0.4 | PASS | - | 201.9 | 35.1% | 576 (100%) | 99.4% / 100% | 100% | 97% | 0 | 25 (38) | 19.7 (29) | 27 |
| 4 | 0.5 | PASS | - | 207 | 35.9% | 576 (100%) | 99.4% / 100% | 100% | 99.5% | 0 | 25.8 (38) | 19.5 (29) | 27 |
| 5 | 旧 | - | - | 113.9 | - | 720 (100%) | 41.2% / 43.5% | 51.4% | 69.4% | 142 | 0.8 | 0.8 | - |
| 5 | 0.25 | PASS | - | 225.6 | 31.3% | 720 (100%) | 100% / 100% | 100% | 96.7% | 0 | 21.8 (38) | 18.6 (29) | 21 |
| 5 | 0.33 | PASS | - | 232.3 | 32.3% | 720 (100%) | 100% / 100% | 100% | 100% | 0 | 19.9 (38) | 17.8 (29) | 21 |
| 5 | 0.4 | PASS | - | 234.6 | 32.6% | 720 (100%) | 100% / 100% | 100% | 100% | 0 | 19.9 (38) | 17.1 (29) | 21 |
| 5 | 0.5 | PASS | - | 234.6 | 32.6% | 720 (100%) | 100% / 100% | 100% | 100% | 0 | 19.9 (38) | 17.1 (29) | 21 |

## 採用構成の before/after (multiplier 4, share 0.4; before = 現行 multiplier 3 の旧 planner)

| シナリオ | total Booking/day before→after | winter pages/day before→after | effective winter share | primary SLA steady (before→after) | final-slot | WARM 1.5x | own ACTIVE | near starved steady before→after | max service age h (final, 収集済み) before→after |
|---|---|---|---:|---|---:|---:|---:|---|---|
| 10/08 全日 WARM | 432→576 | 7.4→112.9 | 19.6% | 0%→100% | 100% | 100% | -% | 175.4→175.9 | -→68 |
| 10/08 1/1-3/31 ACTIVE | 432→576 | 7.4→144.4 | 25.1% | 0%→99.4% | 100% | 100% | 100% | 175.4→174.8 | -→70 |
| 12/10 全日 WARM | 432→576 | 72.5→139.2 | 24.2% | 49.1%→100% | 100% | 100% | -% | 38→29.4 | 98→62 |
| 12/10 1/1-3/31 ACTIVE | 432→576 | 72.5→184.9 | 32.1% | 33.3%→98% | 96.6% | 100% | 100% | 38→22.3 | 98→74 |
| 12/10 全窓 ACTIVE + bulk transition | 432→576 | 72.5→201.9 | 35.1% | 27%→99.4% | 100% | 100% | 97% | 38→25 | 98→64 |

- 推奨 production 値: ZMI_CRAWL_VOLUME_MULTIPLIER=4 (launchd 側設定。コード既定は変更しない)。冬季 lane の share 上限既定は WINTER_LANE_MAX_BOOKING_SHARE=0.4。
- 不変条件 (anti-block): 2h cadence (12 slots/day)、24h cooldown、sequential/jitter/backoff/captcha・block early-stop、multiplier<=5 (hard max)。
