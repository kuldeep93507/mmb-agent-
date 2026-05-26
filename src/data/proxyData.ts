export const PROXY_SERVER = 'us.smartproxy.net';
export const PROXY_PORT = 3120;
export const PROXY_PASSWORD = '';
export const PROXY_PREFIX = 'smart-pwgbkxcy3lyi';

export const US_STATE_CITIES: Record<string, string[]> = {
  TX: ['AUSTIN', 'DALLAS', 'HOUSTON', 'SANANTONIO', 'FORTWORTH'],
  CA: ['LA', 'SF', 'SANDIEGO', 'FRESNO', 'SACRAMENTO'],
  NY: ['NEWYORK', 'BUFFALO', 'ROCHESTER', 'YONKERS', 'SYRACUSE'],
  FL: ['MIAMI', 'ORLANDO', 'TAMPA', 'JACKSONVILLE', 'STPETERSBURG'],
  WA: ['SEATTLE', 'SPOKANE', 'TACOMA', 'BELLEVUE', 'KENT'],
  IL: ['CHICAGO', 'AURORA', 'JOLIET', 'ROCKFORD', 'NAPERVILLE'],
  AZ: ['PHOENIX', 'TUCSON', 'MESA', 'CHANDLER', 'SCOTTSDALE'],
  GA: ['ATLANTA', 'AUGUSTA', 'COLUMBUS', 'SAVANNAH', 'MACON'],
  NC: ['CHARLOTTE', 'RALEIGH', 'GREENSBORO', 'DURHAM', 'WINSTON'],
  OH: ['COLUMBUS', 'CLEVELAND', 'CINCINNATI', 'TOLEDO', 'AKRON'],
};

export const STATE_TIMEZONES: Record<string, string> = {
  TX: 'America/Chicago',
  CA: 'America/Los_Angeles',
  NY: 'America/New_York',
  FL: 'America/New_York',
  WA: 'America/Los_Angeles',
  IL: 'America/Chicago',
  AZ: 'America/Phoenix',
  GA: 'America/New_York',
  NC: 'America/New_York',
  OH: 'America/New_York',
};

export const PROXY_LIVES = ['1hr', '2hr', '4hr', '8hr', '24hr'] as const;

export const LIFE_MS: Record<string, number> = {
  '1hr': 3600000,
  '2hr': 7200000,
  '4hr': 14400000,
  '8hr': 28800000,
  '24hr': 86400000,
};

export const ANDROID_DEVICES = [
  { model: 'Samsung Galaxy S23', gpu: 'Adreno 740', resolution: '1080x2340', android: '13' },
  { model: 'Google Pixel 7', gpu: 'Mali-G710', resolution: '1080x2400', android: '13' },
  { model: 'OnePlus 11', gpu: 'Adreno 740', resolution: '1080x2412', android: '13' },
  { model: 'Samsung Galaxy A54', gpu: 'Mali-G68', resolution: '1080x2340', android: '13' },
  { model: 'Google Pixel 6a', gpu: 'Mali-G78', resolution: '1080x2400', android: '12' },
  { model: 'Xiaomi 13', gpu: 'Adreno 740', resolution: '1080x2400', android: '13' },
  { model: 'Samsung Galaxy S22', gpu: 'Adreno 730', resolution: '1080x2340', android: '12' },
  { model: 'Motorola Edge 40', gpu: 'Adreno 732', resolution: '1080x2400', android: '13' },
  { model: 'Nothing Phone 2', gpu: 'Adreno 740', resolution: '1080x2412', android: '13' },
  { model: 'Samsung Galaxy A34', gpu: 'Mali-G68', resolution: '1080x2408', android: '13' },
];

// BUG FIX: Expanded Windows user agent list with 100+ realistic variants
// Har profile ko unique user agent milega (Chrome, Firefox, Edge, Safari)
export const WINDOWS_UA_LIST = [
  // Chrome 124.x (Latest)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.178 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.60 Safari/537.36',
  // Chrome 123.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.58 Safari/537.36',
  // Chrome 122.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.128 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.95 Safari/537.36',
  // Chrome 121.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.184 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.139 Safari/537.36',
  // Chrome 120.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.129 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.71 Safari/537.36',
  // Chrome 119.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.159 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.105 Safari/537.36',
  // Firefox 124.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0.1',
  // Firefox 123.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0.1',
  // Firefox 122.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0.1',
  // Firefox 121.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0.1',
  // Firefox 120.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0.1',
  // Edge 124.x (Chromium-based)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.178 Safari/537.36 Edg/124.0.2478.97',
  // Edge 123.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36 Edg/123.0.2420.97',
  // Edge 122.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.128 Safari/537.36 Edg/122.0.2365.92',
  // Edge 121.x
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.184 Safari/537.36 Edg/121.0.2277.98',
  // Chrome with different build numbers
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.202 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.205 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.69 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.160 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.199 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.199 Safari/537.36',
  // Opera (Chromium-based)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.178 Safari/537.36 OPR/110.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36 OPR/109.0.0.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.128 Safari/537.36 OPR/108.0.0.0',
  // Brave (Chromium-based)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.178 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.128 Safari/537.36',
  // Vivaldi
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.178 Safari/537.36 Vivaldi/6.7.2922.27',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.122 Safari/537.36 Vivaldi/6.6.2877.48',
  // More Chrome variants with different patch versions
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.60 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.6312.87 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.33 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.6167.85 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.129 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.159 Safari/537.36',
  // More Firefox variants
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0.2',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0.2',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0.2',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0.2',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0.2',
  // Older Chrome versions (some users don't auto-update)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/118.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
  // Edge with older versions
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.129 Safari/537.36 Edg/120.0.2210.121',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.6045.159 Safari/537.36 Edg/119.0.2151.97',
  // Safari on Windows (rare but exists via parallels)
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Version/18.0.1 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Version/17.0.1 Safari/537.36',
];

export const MACOS_VERSIONS = ['12.6', '13.2', '13.4', '14.0', '14.1'];

export const WINDOWS_WEBGL = [
  'NVIDIA GeForce RTX 3060',
  'AMD Radeon RX 6600',
  'Intel UHD Graphics 770',
  'NVIDIA GeForce GTX 1660',
  'AMD Radeon RX 6500 XT',
  'Intel Arc A380',
];

export const CPU_CORES = [4, 6, 8, 12, 16];
export const RAM_SIZES = [8, 16, 32];
