/**
 * The real-time APIs hosted by data.gov.sg, mapped to the tool that serves
 * each one. Used by search to point the model straight at the right tool.
 *
 * (The catalogue also lists 4 National Library Board APIs with format "API";
 * those need NLB's own credentials and are not supported by this server.)
 */

export interface RealtimeApiInfo {
  datasetId: string;
  name: string;
  description: string;
  keywords: string;
  updateFrequency: string;
  tool: string;
  args?: Record<string, unknown>;
}

export const REALTIME_APIS: RealtimeApiInfo[] = [
  {
    datasetId: 'd_66b77726bbae1b33f218db60ff5861f0',
    name: 'Air Temperature across Singapore',
    description: 'Per-minute air temperature readings from NEA weather stations',
    keywords: 'temperature hot heat weather degrees celsius',
    updateFrequency: '1 minute',
    tool: 'datagovsg_get_weather_readings',
    args: { metric: 'temperature' },
  },
  {
    datasetId: 'd_6580738cdd7db79374ed3152159fbd69',
    name: 'Rainfall across Singapore',
    description: '5-minute rainfall totals (mm) from about 90 NEA rain gauges',
    keywords: 'rain rainfall raining wet weather precipitation',
    updateFrequency: '5 minutes',
    tool: 'datagovsg_get_weather_readings',
    args: { metric: 'rainfall' },
  },
  {
    datasetId: 'd_2d3b0c4da128a9a59efca806441e1429',
    name: 'Relative Humidity across Singapore',
    description: 'Per-minute relative humidity readings (%) from NEA weather stations',
    keywords: 'humidity humid weather',
    updateFrequency: '1 minute',
    tool: 'datagovsg_get_weather_readings',
    args: { metric: 'humidity' },
  },
  {
    datasetId: 'd_7677738484067741bf3b56ab5d69c7e9',
    name: 'Wind Speed across Singapore',
    description: 'Per-minute wind speed readings (knots) from NEA weather stations',
    keywords: 'wind speed windy weather',
    updateFrequency: '1 minute',
    tool: 'datagovsg_get_weather_readings',
    args: { metric: 'wind_speed' },
  },
  {
    datasetId: 'd_534cf203023b51f51f879145ccc56ff9',
    name: 'Wind Direction across Singapore',
    description: 'Per-minute wind direction readings (degrees) from NEA weather stations',
    keywords: 'wind direction weather',
    updateFrequency: '1 minute',
    tool: 'datagovsg_get_weather_readings',
    args: { metric: 'wind_direction' },
  },
  {
    datasetId: 'd_3f9e064e25005b0e42969944ccaf2e7a',
    name: '2-hour Weather Forecast',
    description: 'Nowcast for 47 areas across Singapore, updated every 30 minutes',
    keywords: 'weather forecast nowcast rain thundery showers cloudy area town today now',
    updateFrequency: '30 minutes',
    tool: 'datagovsg_get_weather_forecast',
    args: { period: '2h' },
  },
  {
    datasetId: 'd_ce2eb1e307bda31993c533285834ef2b',
    name: '24-hour Weather Forecast',
    description: 'Island-wide and regional forecast for the next 24 hours',
    keywords: 'weather forecast tomorrow today temperature region',
    updateFrequency: 'several times a day',
    tool: 'datagovsg_get_weather_forecast',
    args: { period: '24h' },
  },
  {
    datasetId: 'd_f131f6e343bf8168e4057a04c4326a0a',
    name: '4-day Weather Outlook',
    description: 'Weather outlook for the next 4 days',
    keywords: 'weather forecast outlook week weekend days',
    updateFrequency: 'twice a day',
    tool: 'datagovsg_get_weather_forecast',
    args: { period: '4day' },
  },
  {
    datasetId: 'd_fe37906a0182569d891506e815e819b7',
    name: 'Pollutant Standards Index (PSI)',
    description: '24-hour PSI and pollutant sub-indices for 5 regions, hourly',
    keywords: 'psi haze air quality pollution pollutant smog',
    updateFrequency: '1 hour',
    tool: 'datagovsg_get_air_quality',
  },
  {
    datasetId: 'd_e1058d6974c877257e32048ab128ad83',
    name: 'PM2.5',
    description: '1-hour PM2.5 concentration for 5 regions',
    keywords: 'pm2.5 haze air quality particulate pollution',
    updateFrequency: '1 hour',
    tool: 'datagovsg_get_air_quality',
  },
  {
    datasetId: 'd_1b676cd174a9af4704fdb3f9aa58ff5e',
    name: 'Ultra-violet Index (UVI)',
    description: 'Hourly UV index readings',
    keywords: 'uv ultraviolet index sun sunburn',
    updateFrequency: '1 hour',
    tool: 'datagovsg_get_uv_index',
  },
  {
    datasetId: 'd_87884af1f85d702d4f74c6af13b4853d',
    name: 'Wet Bulb Globe Temperature (WBGT)',
    description: 'Heat stress readings (WBGT) from ~30 stations with Low/Moderate/High levels',
    keywords: 'wbgt heat stress hot exercise outdoor wet bulb',
    updateFrequency: '15 minutes',
    tool: 'datagovsg_get_heat_stress',
  },
  {
    datasetId: 'd_08238953fe0f6dd13f10714ebfbcb9f9',
    name: 'Lightning Observations',
    description: 'Lightning strikes detected across Singapore',
    keywords: 'lightning thunderstorm storm strike',
    updateFrequency: '5 minutes',
    tool: 'datagovsg_get_lightning',
  },
  {
    datasetId: 'd_f1404e08587ce555b9ea3f565e2eb9a3',
    name: 'PUB Flood Alerts',
    description: 'Flash flood alerts issued by PUB',
    keywords: 'flood flooding flash flood pub water level drain',
    updateFrequency: '2 minutes',
    tool: 'datagovsg_get_flood_alerts',
  },
  {
    datasetId: 'd_418e9ac3414fd927b7405631e0a7bc82',
    name: 'Weather Radar Images (beta)',
    description: 'Rain radar images for 70km / 240km / 480km ranges, every 5 minutes',
    keywords: 'radar rain map image weather storm',
    updateFrequency: '5 minutes',
    tool: 'datagovsg_get_weather_radar',
  },
  {
    datasetId: 'd_ca933a644e55d34fe21f28b8052fac63',
    name: 'HDB Carpark Availability',
    description: 'Available lots at ~2,000 HDB carparks, updated every minute',
    keywords: 'carpark car park parking lots available hdb',
    updateFrequency: '1 minute',
    tool: 'datagovsg_get_carpark_availability',
  },
  {
    datasetId: 'd_e25662f1a062dd046453926aa284ba64',
    name: 'Taxi Availability',
    description: 'Locations of all available taxis, every 30 seconds',
    keywords: 'taxi cab available location',
    updateFrequency: '30 seconds',
    tool: 'datagovsg_get_taxi_availability',
  },
  {
    datasetId: 'd_6cdb6b405b25aaaacbaf7689bcc6fae0',
    name: 'Traffic Images',
    description: 'Traffic camera snapshots (currently only checkpoint cameras are published)',
    keywords: 'traffic camera images jam road checkpoint causeway woodlands tuas',
    updateFrequency: '1-5 minutes',
    tool: 'datagovsg_get_traffic_images',
  },
];

export const REALTIME_BY_DATASET_ID = new Map(REALTIME_APIS.map((api) => [api.datasetId, api]));
