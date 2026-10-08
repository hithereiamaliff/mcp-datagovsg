# Tool Reference

All tools are read-only. Responses are compact JSON; errors set `isError: true` and include a `hint` where possible. Dates and times are Singapore time (UTC+8).

## Best practices

1. **Start with `datagovsg_search_all`.** Every result includes `next_step` with the exact tool and arguments to call next.
2. **For "right now" questions, go straight to the real-time tools.** `datagovsg_get_current_conditions` answers most "what's the weather in X" questions in one call.
3. **Before querying a dataset, get its columns** with `datagovsg_get_dataset_metadata`. Filters are exact and case-sensitive (e.g. `"town": "BISHAN"`).
4. **Use `filters` rather than `q`** in `datagovsg_query_dataset`; plain-text `q` totals can be approximate.
5. **For SingStat tables**, filter by `series` and `time_filter`. `limit` counts data points, not rows.
6. **Locations**: tools that take `latitude`/`longitude` only accept coordinates inside Singapore. Forecast tools also take area names such as "Bishan" or "Jurong West".

---

## Search and discovery

### `datagovsg_search_all`
Search datasets, collections, real-time APIs and SingStat tables at once.

| Param | Type | Notes |
|-------|------|-------|
| `query` | string | e.g. `"HDB resale prices"`, `"dengue"`, `"GDP"` |
| `limit` | 1–30 | Default 10 |
| `include_singstat` | boolean | Default true (adds ~7s for a new query; cached 1h) |

```json
{ "query": "hawker centres", "limit": 5 }
```

### `datagovsg_search_datasets`
Search or browse the full dataset catalogue.

| Param | Type | Notes |
|-------|------|-------|
| `query` | string? | Omit to browse |
| `format` | `CSV` \| `GEOJSON` \| `XLSX` \| `PDF` \| `API` | CSV = queryable tables, GEOJSON = maps |
| `agency` | string? | Partial match, e.g. `"Housing"`, `"National Environment Agency"` |
| `updated_since` | `YYYY-MM-DD`? | |
| `sort` | `relevance` \| `last_updated` \| `name` | |
| `limit` / `offset` | | Pagination (default 10 / 0) |

```json
{ "agency": "National Environment Agency", "format": "GEOJSON", "sort": "last_updated" }
```

### `datagovsg_list_collections`
| Param | Type | Notes |
|-------|------|-------|
| `query` | string? | |
| `agency` | string? | |
| `limit` / `offset` | | Default 20 / 0 |

---

## Datasets

### `datagovsg_get_collection`
```json
{ "collection_id": "189" }
```
Returns the collection description, agency, frequency and its datasets (with format and `next_step`).

### `datagovsg_get_dataset_metadata`
```json
{ "dataset_id": "d_8b84c4ee58e3cfc0ece0d773c8ca6abc" }
```
Returns description, format, coverage, size, columns (`name`, `title`, `type`, `categorical`) and a `how_to_query` example.

### `datagovsg_query_dataset`
Query rows of a CSV dataset.

| Param | Type | Notes |
|-------|------|-------|
| `dataset_id` | string | Starts with `d_` |
| `filters` | object? | Exact match; array = any of. `{"town": ["BISHAN", "BEDOK"], "flat_type": "4 ROOM"}` |
| `q` | string \| object? | Full-text; object searches specific columns |
| `fields` | string[] \| string? | Columns to return |
| `sort` | string? | `"resale_price desc"`, `"month desc, town asc"` |
| `limit` | 1–1000 | Default 50 |
| `offset` | number | Pagination |
| `format` | `json` \| `csv` | CSV is more compact for many rows |

```json
{
  "dataset_id": "d_8b84c4ee58e3cfc0ece0d773c8ca6abc",
  "filters": { "town": "BISHAN", "flat_type": "4 ROOM" },
  "sort": "month desc",
  "limit": 20
}
```
The response includes `total_matching_rows` and `pagination.next_offset`. Numeric columns are returned as numbers.

### `datagovsg_get_download_url`
Temporary download link (about 1 hour) for the full file. Starts the export and waits for it to finish.

| Param | Type | Notes |
|-------|------|-------|
| `dataset_id` | string | |
| `column_names` | string[]? | CSV only |
| `filters` | `{column_name, type: EQ\|LIKE\|ILIKE, value}[]`? | CSV only; `%` is the wildcard for LIKE/ILIKE |
| `wait_seconds` | 0–40 | Default 20. If not ready, call again with the same arguments |

```json
{
  "dataset_id": "d_8b84c4ee58e3cfc0ece0d773c8ca6abc",
  "column_names": ["month", "town", "resale_price"],
  "filters": [{ "column_name": "town", "type": "EQ", "value": "BISHAN" }]
}
```

---

## Weather and environment

All of these accept `date`: `"YYYY-MM-DD"` for a whole day (paginated; pass `next_page_token` back as `pagination_token`) or `"YYYY-MM-DDTHH:mm:ss"` for that moment. Omit it for the latest data.

### `datagovsg_get_current_conditions`
```json
{ "area": "Tampines" }
```
or `{ "latitude": 1.3521, "longitude": 103.8198 }`, or `{}` for island-wide. Combines the 2h forecast, nearest temperature/humidity/rain/wind, PSI (nearest region), UV, heat stress and flood alerts.

### `datagovsg_get_weather_forecast`
| Param | Notes |
|-------|-------|
| `period` | `2h` (default), `24h`, `4day` |
| `area` | 2h only. One of the 47 forecast areas (loose matching) |
| `latitude` / `longitude` | 2h only. Picks the nearest area |
| `region` | 24h only. `north`/`south`/`east`/`west`/`central` |

### `datagovsg_get_weather_readings`
| Param | Notes |
|-------|-------|
| `metric` | `temperature` (°C), `rainfall` (mm/5min), `humidity` (%), `wind_speed` (knots, also km/h), `wind_direction` (degrees, also compass) |
| `latitude` / `longitude` + `nearest` | Nearest stations (default 3) |
| `station` | Station ID (`S109`) or part of a name |

Without a location filter, returns all stations plus an island-wide min/max/avg. With a whole-day `date`, returns a time series.

### `datagovsg_get_air_quality`
`{ "region": "west" }` or coordinates, or nothing for all regions. Returns 24h PSI with band (Good ≤50, Moderate ≤100, Unhealthy ≤200, Very unhealthy ≤300, Hazardous), 1h PM2.5 band, pollutant concentrations and NEA activity advice.

### `datagovsg_get_uv_index`
Latest UV index with category (Low, Moderate, High, Very High, Extreme) and today's hourly series.

### `datagovsg_get_heat_stress`
WBGT readings with NEA heat stress level (Low < 31°C, Moderate 31–33°C, High ≥ 33°C). Filter with coordinates + `nearest`, or `station`.

### `datagovsg_get_lightning`
`{ "latitude": 1.30, "longitude": 103.85, "radius_km": 5 }`. Strikes in the latest observation(s), optionally within a radius.

### `datagovsg_get_flood_alerts`
Active PUB flash flood alerts plus alerts from recent checks.

### `datagovsg_get_weather_radar`
`{ "range": "240km" }` (`70km`, `240km`, `480km`). PNG overlay URL (valid ~20 minutes) and bounding box. Beta dataset.

---

## Transport

### `datagovsg_get_carpark_availability`
| Param | Notes |
|-------|-------|
| `latitude` / `longitude` + `radius_km` | Default radius 0.5 km, sorted by distance |
| `address` | All words must appear, e.g. `"bishan st 22"`, `"blk 270"` |
| `carpark_numbers` | e.g. `["ACB", "BE3"]` |
| `lot_type` | `car` (default), `motorcycle`, `heavy_vehicle` |
| `min_available` | Only carparks with at least this many free lots |
| `limit` | Default 10 |
| `date_time` | Past snapshot `YYYY-MM-DDTHH:mm:ss` |

HDB carparks only. Each result includes address, coordinates, lots (available/total by type), parking system, free/night parking and gantry height.

### `datagovsg_get_taxi_availability`
`{ "latitude": 1.3016, "longitude": 103.8547, "radius_km": 1, "nearest": 5 }`. Island-wide count, plus count within the radius and the nearest taxis.

### `datagovsg_get_traffic_images`
`{ "camera_ids": ["2701"] }` or coordinates. data.gov.sg currently publishes only about 8 cameras (Woodlands and Tuas checkpoint approaches).

---

## SingStat

### `singstat_search_tables`
`{ "keyword": "consumer price index" }`. Phrases match literally on SingStat, so when a phrase finds nothing the tool searches each word and merges the results (`used_word_fallback: true`).

### `singstat_get_table_metadata`
`{ "resource_id": "M015721" }`. Title, frequency, start/end period, footnotes and the list of series (`series_no`, `name`, `unit`).

### `singstat_get_table_data`
| Param | Notes |
|-------|-------|
| `resource_id` | e.g. `M015721` |
| `series` | Series numbers from metadata, e.g. `["1", "1.1"]` |
| `time_filter` | Must match frequency: `["2024"]`, `["2024 4Q"]`, `["2025 Mar"]`, `["2024 1H"]` |
| `between` | Value range `"min,max"` (filters values, not dates) |
| `search` | Series name contains |
| `sort_by` | e.g. `key desc` (most recent periods first) |
| `limit` / `offset` | **Data points**, not rows (default 1000, max 5000) |

```json
{ "resource_id": "M015721", "series": ["1"], "time_filter": ["2023", "2024", "2025"] }
```

---

## `datagovsg_hello`
Server version, which data.gov.sg key this connection uses (`user`, `server` or `none`, never the key itself) and catalogue index status.
