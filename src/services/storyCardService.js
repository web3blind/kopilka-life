const sharp = require('sharp');
const QRCode = require('qrcode');
const config = require('../config');
const { publicProfileByCode } = require('./referralService');

const STORY_WIDTH = 1080;
const STORY_HEIGHT = 1920;
const CODE_PATTERN = /^[A-Z0-9]{4,24}$/;
const PLATFORMS = new Set(['telegram', 'vk']);
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ITEMS = 128;
const cardCache = new Map();

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function normalizeCode(value) {
  const code = String(value || '').trim().toUpperCase();
  return CODE_PATTERN.test(code) ? code : '';
}

function baseUrl() {
  return String(config.webappUrl || config.appBaseUrl || '').replace(/\/+$/, '');
}

function telegramProfileLink(code) {
  const username = String(config.botUsername || '').replace(/^@/, '').trim();
  return username
    ? `https://t.me/${username}?startapp=profile-${code}`
    : `${baseUrl()}/p/${code}`;
}

function vkProfileLink(code) {
  return config.vkAppId ? `https://vk.com/app${config.vkAppId}#profile=${code}` : `${baseUrl()}/p/${code}`;
}

function storyDestination(code, platform) {
  if (!PLATFORMS.has(platform)) throw new Error('invalid story platform');
  return platform === 'telegram' ? telegramProfileLink(code) : vkProfileLink(code);
}

function storyCardUrl(code, platform) {
  if (!PLATFORMS.has(platform)) throw new Error('invalid story platform');
  return `${baseUrl()}/api/story-card/${code}.png?platform=${platform}&v=3`;
}

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(999999, Math.round(number))) : 0;
}

async function renderStoryCard(codeValue, platform) {
  const code = normalizeCode(codeValue);
  if (!code) return { error: 'invalid_code' };
  if (!PLATFORMS.has(platform)) return { error: 'invalid_platform' };
  const cacheKey = `${platform}:${code}`;
  const cached = cardCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) cardCache.delete(cacheKey);
  const profile = publicProfileByCode(code);
  if (!profile) return { error: 'not_found' };

  // Deliberately construct a narrow allow-listed projection. Never pass the full
  // public profile (which may grow later) to the renderer.
  const card = {
    name: String(profile.firstName || 'Life Harbor user').trim().slice(0, 48),
    heart: boundedNumber(profile.activeReferred),
    todayLife: boundedNumber(profile.today?.todayLife),
    weekLife: boundedNumber(profile.week?.weekLife),
    activeDays: Math.min(7, boundedNumber(profile.week?.activeDays))
  };
  const destination = storyDestination(code, platform);
  const qr = await QRCode.toBuffer(destination, {
    type: 'png',
    errorCorrectionLevel: 'H',
    margin: 2,
    width: 420,
    color: { dark: '#25362f', light: '#fffaf0' }
  });
  // In the observed Telegram Android editor, the link sticker is around
  // y=1500 and the caption below y=1690. Reserve that area for native UI.
  // VK retains its existing composition.
  const telegram = platform === 'telegram';
  const svgText = `
    <svg width="${STORY_WIDTH}" height="${STORY_HEIGHT}" viewBox="0 0 ${STORY_WIDTH} ${STORY_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#fff7e8"/><stop offset="0.52" stop-color="#f7dfc1"/><stop offset="1" stop-color="#d9ead8"/>
        </linearGradient>
        <radialGradient id="sun"><stop offset="0" stop-color="#ffd88c" stop-opacity=".9"/><stop offset="1" stop-color="#ffd88c" stop-opacity="0"/></radialGradient>
      </defs>
      <rect width="1080" height="1920" fill="url(#bg)"/>
      <circle cx="930" cy="170" r="340" fill="url(#sun)"/>
      <circle cx="90" cy="1550" r="330" fill="#bdd6bd" opacity=".38"/>
      <g transform="${telegram ? 'translate(54 60) scale(0.9 0.78)' : 'translate(0 0)'}">
      <text x="92" y="150" font-family="Arial, sans-serif" font-size="34" font-weight="700" fill="#87654e" letter-spacing="3">КОПИЛКА ЖИЗНИ</text>
      <text x="92" y="310" font-family="Arial, sans-serif" font-size="76" font-weight="700" fill="#25362f">${escapeXml(card.name)}</text>
      <text x="92" y="410" font-family="Arial, sans-serif" font-size="34" fill="#52645a">Маленькие действия складываются в тепло.</text>
      <rect x="72" y="510" width="936" height="450" rx="58" fill="#fffaf0" opacity=".96"/>
      <text x="130" y="635" font-family="Arial, sans-serif" font-size="34" fill="#7e695b">СЕРДЦЕ ЗАБОТЫ</text>
      <text x="130" y="790" font-family="Arial, sans-serif" font-size="132" font-weight="700" fill="#c56e62">♥ ${card.heart}</text>
      <line x1="560" y1="585" x2="560" y2="875" stroke="#eadac6" stroke-width="3"/>
      <text x="620" y="640" font-family="Arial, sans-serif" font-size="30" fill="#7e695b">СЕГОДНЯ</text>
      <text x="620" y="735" font-family="Arial, sans-serif" font-size="74" font-weight="700" fill="#25362f">${card.todayLife} ЖИЗНЬ</text>
      <text x="620" y="825" font-family="Arial, sans-serif" font-size="28" fill="#7e695b">За последние 7 дней</text>
      <text x="620" y="895" font-family="Arial, sans-serif" font-size="54" font-weight="700" fill="#25362f">${card.weekLife} · ${card.activeDays}/7 дней</text>
      </g>
      <rect x="72" y="${telegram ? 830 : 1040}" width="936" height="720" rx="58" fill="#31463b"/>
      <text x="540" y="${telegram ? 895 : 1160}" text-anchor="middle" font-family="Arial, sans-serif" font-size="38" font-weight="700" fill="#fffaf0">Открыть публичный профиль</text>
      <text x="540" y="${telegram ? 945 : 1215}" text-anchor="middle" font-family="Arial, sans-serif" font-size="28" fill="#dce9dc">Наведите камеру на QR-код</text>
      <rect x="310" y="${telegram ? 975 : 1270}" width="460" height="460" rx="42" fill="#fffaf0"/>
      <text opacity="${telegram ? 0 : 1}" x="540" y="1840" text-anchor="middle" font-family="Arial, sans-serif" font-size="27" fill="#52645a">Без сравнения. Без стыда. Просто видимый след жизни.</text>
    </svg>`;
  const svg = Buffer.from(svgText);
  const png = await sharp(svg, { density: 144 })
    .resize(STORY_WIDTH, STORY_HEIGHT)
    .composite([{ input: qr, left: 330, top: telegram ? 995 : 1290 }])
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer();
  const value = { png, destination, card };
  if (cardCache.size >= CACHE_MAX_ITEMS) cardCache.delete(cardCache.keys().next().value);
  cardCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, value });
  return value;
}

module.exports = {
  STORY_WIDTH,
  STORY_HEIGHT,
  normalizeCode,
  storyDestination,
  storyCardUrl,
  telegramProfileLink,
  vkProfileLink,
  renderStoryCard
};
