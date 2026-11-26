# Data

`processed/` is committed and is all the application needs at runtime. `raw/` (BTS downloads, about 105 MB for the three months) is created by `data:download`, is git-ignored and is not needed to run the app.

| File | Content | Source |
|---|---|---|
| `manifest.json` | Periods, row counts, build statistics, file hashes | generated |
| `airports.json` | Airport identities, FAA coordinates, runways, match status | BTS identities + FAA ArcGIS |
| `traffic-monthly.csv.gz` | Monthly passengers, seats, departures, load factor, 36 months | BTS Socrata API |
| `route-segments.csv.gz` | Origin-destination-class-month departures, seats, passengers, distance | BTS T-100 Segment (All Carriers) |
| `ontime-airport-month.json.gz` | Airport-month counts, sums and taxi-out histograms (never pre-computed rates) | BTS Reporting Carrier On-Time Performance |

Rebuild (optional, ~15 minutes, needs network):

```bash
npm run data:download -- segment 2026-06 2026-07 2026-08
npm run data:download -- ontime  2026-06 2026-07 2026-08
npm run data:build   -- --months 2026-06,2026-07,2026-08
npm run data:verify
```

Segment and on-time tables are only published through a BTS TranStats download form (no JSON API); the download script submits that form.
