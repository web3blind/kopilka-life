const crypto = require('node:crypto');
const sharp = require('sharp');

const WIDTH = 1080;
const HEIGHT = 1920;
const MAX_BYTES = 4 * 1024 * 1024;
const TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 128;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const images = new Map();

function purge(now) {
  for (const [id, item] of images) if (item.expiresAt <= now) images.delete(id);
}

async function create(userId, input, now = Date.now()) {
  if (!Buffer.isBuffer(input) || input.length < 8 || input.length > MAX_BYTES ||
      !input.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    throw new Error('invalid_image');
  }
  let sanitized;
  try {
    const source = sharp(input, { limitInputPixels: WIDTH * HEIGHT, failOn: 'error' });
    const metadata = await source.metadata();
    if (metadata.format !== 'png' || metadata.width !== WIDTH || metadata.height !== HEIGHT || metadata.pages > 1) {
      throw new Error('invalid_image');
    }
    sanitized = await source.png().toBuffer(); // Strip arbitrary PNG metadata/chunks.
  } catch (_) { throw new Error('invalid_image'); }
  if (sanitized.length > MAX_BYTES) throw new Error('invalid_image');
  purge(now);
  const otherItems = [...images.values()].filter((item) => item.userId !== userId);
  if (otherItems.length >= MAX_ITEMS ||
      otherItems.reduce((bytes, item) => bytes + item.png.length, sanitized.length) > MAX_TOTAL_BYTES) {
    throw new Error('story_capacity'); // Refuse a new picture, never invalidate another user's live URL.
  }
  for (const [id, item] of images) if (item.userId === userId) images.delete(id);
  const id = crypto.randomBytes(32).toString('base64url');
  images.set(id, { userId, png: sanitized, expiresAt: now + TTL_MS });
  return id;
}

function get(id, now = Date.now()) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(id)) return null;
  purge(now);
  return images.get(id)?.png || null;
}

module.exports = { create, get, TTL_MS };
