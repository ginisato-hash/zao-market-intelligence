SELECT name
FROM sqlite_master
WHERE type = 'table'
  AND name IN (
    'properties',
    'property_ota_links',
    'collector_runs',
    'rate_snapshots',
    'inventory_snapshots',
    'market_daily_signals',
    'pricing_targets',
    'target_inventory_snapshots',
    'pricing_recommendations',
    'target_dates'
  )
ORDER BY name;

SELECT 'properties' AS table_name, COUNT(*) AS row_count FROM properties
UNION ALL
SELECT 'property_ota_links', COUNT(*) FROM property_ota_links
UNION ALL
SELECT 'collector_runs', COUNT(*) FROM collector_runs
UNION ALL
SELECT 'rate_snapshots', COUNT(*) FROM rate_snapshots
UNION ALL
SELECT 'inventory_snapshots', COUNT(*) FROM inventory_snapshots
UNION ALL
SELECT 'market_daily_signals', COUNT(*) FROM market_daily_signals
UNION ALL
SELECT 'pricing_targets', COUNT(*) FROM pricing_targets
UNION ALL
SELECT 'target_inventory_snapshots', COUNT(*) FROM target_inventory_snapshots
UNION ALL
SELECT 'pricing_recommendations', COUNT(*) FROM pricing_recommendations
UNION ALL
SELECT 'target_dates', COUNT(*) FROM target_dates;
