import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

const SYNTHETIC_DOCUMENT = Buffer.from([
  'WhatsApp Agent E2E Test Document',
  'Generated locally from a fixed, non-personal payload.',
  'No user files were read to create this attachment.',
  'Test date: 2026-07-21',
  '',
].join('\n'), 'utf8');

const SYNTHETIC_VCARD = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:E2E Synthetic Contact',
  'TEL;TYPE=CELL:+12025550123',
  'NOTE:Synthetic test contact; not sourced from the address book.',
  'END:VCARD',
].join('\r\n');

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

export function createSyntheticPng() {
  const width = 256;
  const height = 256;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const checker = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0;
      const diagonal = Math.abs(x - y) < 10 || Math.abs(x + y - width) < 10;
      pixels[offset] = diagonal ? 255 : checker ? 38 : 16;
      pixels[offset + 1] = diagonal ? 255 : checker ? 166 : 88;
      pixels[offset + 2] = diagonal ? 255 : checker ? 154 : 120;
      pixels[offset + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function getSyntheticRichAction(kind, { MessageMedia, Location } = {}) {
  if (typeof MessageMedia !== 'function' || typeof Location !== 'function') {
    throw new Error('getSyntheticRichAction requires MessageMedia and Location constructors.');
  }
  const image = createSyntheticPng();
  const specifications = {
    image: {
      preview: 'Send a locally generated 256×256 PNG test image. No user file is read. Caption: [E2E TEST 2/6 — IMAGE]',
      expectedTypes: ['image'],
      content: () => new MessageMedia('image/png', image.toString('base64'), 'whatsapp-agent-e2e.png', image.length),
      options: { caption: '[E2E TEST 2/6 — IMAGE]' },
      attest: image,
    },
    document: {
      preview: 'Send a locally generated plain-text test document named whatsapp-agent-e2e.txt. No user file is read.',
      expectedTypes: ['document'],
      content: () => new MessageMedia('text/plain', SYNTHETIC_DOCUMENT.toString('base64'), 'whatsapp-agent-e2e.txt', SYNTHETIC_DOCUMENT.length),
      options: { sendMediaAsDocument: true, caption: '[E2E TEST 3/6 — DOCUMENT]' },
      attest: SYNTHETIC_DOCUMENT,
    },
    location: {
      preview: 'Send the public location Monumen Nasional, Gambir, Jakarta Pusat (-6.175392, 106.827153).',
      expectedTypes: ['location'],
      content: () => new Location(-6.175392, 106.827153, {
        name: 'Monumen Nasional — E2E test',
        address: 'Gambir, Jakarta Pusat',
        url: 'https://www.openstreetmap.org/?mlat=-6.175392&mlon=106.827153',
      }),
      options: {},
      attest: Buffer.from('location|-6.175392|106.827153|Monumen Nasional — E2E test|Gambir, Jakarta Pusat', 'utf8'),
    },
    contact: {
      preview: 'Send a synthetic vCard named “E2E Synthetic Contact” using reserved fictional number +1 202-555-0123. The address book is not read.',
      expectedTypes: ['vcard', 'multi_vcard'],
      content: () => SYNTHETIC_VCARD,
      options: { parseVCards: true },
      attest: Buffer.from(SYNTHETIC_VCARD, 'utf8'),
    },
    sticker: {
      preview: 'Send the locally generated test image as a sticker. No user file is read.',
      expectedTypes: ['sticker'],
      content: () => new MessageMedia('image/png', image.toString('base64'), 'whatsapp-agent-e2e-sticker.png', image.length),
      options: {
        sendMediaAsSticker: true,
        stickerName: 'WhatsApp Agent E2E',
        stickerAuthor: 'Local synthetic test',
        stickerCategories: ['✅'],
      },
      attest: image,
    },
  };
  const action = specifications[kind];
  if (!action) throw new Error('Unsupported rich test kind. Use image, document, location, contact, or sticker.');
  return {
    ...action,
    sha256: createHash('sha256').update(action.attest).digest('hex'),
  };
}
