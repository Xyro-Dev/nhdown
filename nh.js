/* ================= XY ================= */

// This script made by Xyro-Dev
// NHentai downloader + bulk image translator
// NOT FOR SALE!!!

/* ================= XY ================= */

const axios = require('axios');
const cheerio = require('cheerio');
const PDFDocument = require('pdfkit');
const sharp = require('sharp');
const FormData = require('form-data');
const fileType = require('file-type');
const Humanoid = require('humanoid-js');
const fs = require('fs');
const path = require('path');

/* ================= PARAMS ================= */

const SAVE_LOCAL = false;
const SHOW_PROGRESS = true;

// translate
const ENABLE_TRANSLATE = true;
const TRANSLATE_CONCURRENCY = 10; // jangan lebih dari 5
const TRANSLATE_CONFIG = {
  api: 'https://imagetranslate.ai/api/image/translate',
  recordId: '202601031636402jI2',
  target: 'id'
};

/* ================= UTIL ================= */

function getRandomIP() {
  return Array.from({ length: 4 }, () =>
    Math.floor(Math.random() * 256)
  ).join('.');
}

function normalizeUrl(url) {
  if (!url) return null;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('http://')) return url.replace('http://', 'https://');
  if (url.startsWith('https://')) return url;
  return 'https://' + url;
}

function renderProgress(current, total, label = '') {
  if (!SHOW_PROGRESS) return;

  const percent = Math.floor((current / total) * 100);
  const barLength = 25;
  const filled = Math.floor((percent / 100) * barLength);
  const bar = '█'.repeat(filled) + '░'.repeat(barLength - filled);

  process.stdout.clearLine(0);
  process.stdout.cursorTo(0);
  process.stdout.write(`[${bar}] ${percent}% ${label}`);

  if (current === total) process.stdout.write('\n');
}

/* ================= TRANSLATOR ================= */

async function translateImage(imageUrl) {
  const res = await axios.post(
    TRANSLATE_CONFIG.api,
    {
      imageUrl,
      sourceLanguage: 'auto',
      targetLanguage: TRANSLATE_CONFIG.target,
      mode: 'manga',
      translator: 'grok-4-fast'
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-record-id': TRANSLATE_CONFIG.recordId,
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://imagetranslate.ai/manga-translator',
        'X-Forwarded-For': getRandomIP()
      },
      timeout: 60000
    }
  );

  if (!res.data?.success || !res.data.translatedImageUrl) {
    throw new Error('Translate failed');
  }

  const base64 = res.data.translatedImageUrl.split(',')[1];
  return Buffer.from(base64, 'base64');
}

async function bulkTranslateImages(urls, concurrency) {
  const results = new Array(urls.length);
  let pointer = 0;
  let done = 0;

  async function worker() {
    while (true) {
      const index = pointer++;
      if (index >= urls.length) break;

      try {
        results[index] = await translateImage(urls[index]);
      } catch {
        results[index] = null;
      }

      done++;
      renderProgress(done, urls.length, 'bulk translating');
    }
  }

  const workers = Array.from(
    { length: concurrency },
    worker
  );

  await Promise.all(workers);
  return results;
}

/* ================= OUTPUT ================= */

async function uploadToQuax(buffer) {
  const ext = (await fileType.fromBuffer(buffer))?.ext || 'pdf';
  const form = new FormData();
  form.append('files[]', buffer, `${Date.now()}.${ext}`);

  const res = await axios.post('https://qu.ax/upload.php', form, {
    headers: {
      ...form.getHeaders(),
      Origin: 'https://qu.ax',
      Referer: 'https://qu.ax/',
      'User-Agent': 'Mozilla/5.0'
    }
  });

  if (!res.data?.success) {
    return { status: false, msg: 'Upload gagal' };
  }

  return { status: true, url: res.data.files[0].url };
}

function saveLocal(buffer, code) {
  const outDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir);

  const filePath = path.join(outDir, `${code}.pdf`);
  fs.writeFileSync(filePath, buffer);

  return { status: true, path: filePath };
}

/* ================= CORE ================= */

async function nhentaiToPdf(code) {
  if (!code) return { status: false, msg: 'Kode nhentai kosong' };

  const browser = new Humanoid();
  const res = await browser.get(`https://nhentai.net/g/${code}/`);
  const $ = cheerio.load(res.body);

  const pages = $('.thumb-container img').length;
  if (!pages) return { status: false, msg: 'Halaman tidak ditemukan' };

  const images = [];

  for (let i = 1; i <= pages; i++) {
    try {
      const page = await browser.get(
        `https://nhentai.net/g/${code}/${i}/`,
        {
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'X-Forwarded-For': getRandomIP()
          }
        }
      );

      const $$ = cheerio.load(page.body);
      const img = normalizeUrl(
        $$('#image-container img').attr('src')
      );

      if (img) images.push(img);
    } catch {}

    renderProgress(i, pages, 'fetching pages');
  }

  let imageBuffers;

  if (ENABLE_TRANSLATE) {
    imageBuffers = await bulkTranslateImages(
      images,
      TRANSLATE_CONCURRENCY
    );
  } else {
    imageBuffers = await Promise.all(
      images.map(async url => {
        const { data } = await axios.get(url, {
          responseType: 'arraybuffer'
        });
        return Buffer.from(data);
      })
    );
  }

  const doc = new PDFDocument({ autoFirstPage: false });
  const chunks = [];
  doc.on('data', d => chunks.push(d));

  for (let i = 0; i < imageBuffers.length; i++) {
    const raw = imageBuffers[i];
    if (!raw) continue;

    const buffer = await sharp(raw)
      .resize({ width: 1600, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const meta = await sharp(buffer).metadata();

    doc.addPage({ size: [meta.width, meta.height] });
    doc.image(buffer, 0, 0, {
      width: meta.width,
      height: meta.height
    });

    renderProgress(i + 1, imageBuffers.length, 'writing pdf');
  }

  doc.end();

  const pdfBuffer = await new Promise(resolve =>
    doc.on('end', () => resolve(Buffer.concat(chunks)))
  );

  if (SAVE_LOCAL) return saveLocal(pdfBuffer, code);
  return uploadToQuax(pdfBuffer);
}

module.exports = nhentaiToPdf;

/* ================= CLI ================= */

if (require.main === module) {
  const code = process.argv[2];
  if (!code) {
    console.log('Usage: node dl.js <nhentai_code>');
    process.exit(1);
  }

  (async () => {
    const result = await nhentaiToPdf(code);
    console.log(result);
  })();
}