import { chromium } from 'playwright';

const ENDPOINT = process.env.QZIH_IMPORT_ENDPOINT || '';
const TOKEN = process.env.QZIH_IMPORT_TOKEN || '';
const SOURCE_MODE = String(process.env.QZIH_SOURCES || 'both').toLowerCase();
const MAX_PAGES = clamp(process.env.QZIH_MAX_PAGES, 1, 5, 1);
const MAX_PER_SOURCE = clamp(process.env.QZIH_MAX_CANDIDATES, 1, 80, 20);
const MAX_ACCEPT = clamp(process.env.QZIH_MAX_ACCEPT, 1, 20, 4);
const RUN_LIMIT_MINUTES = clamp(process.env.QZIH_RUN_LIMIT_MINUTES, 4, 25, 14);
const RUN_DEADLINE = Date.now() + RUN_LIMIT_MINUTES * 60 * 1000;
const SEED_URLS = String(process.env.QZIH_SEED_URLS || '').split(/[\n,]+/).map(v => v.trim()).filter(Boolean);

if (!ENDPOINT || !TOKEN) {
  throw new Error('QZIH_IMPORT_ENDPOINT and QZIH_IMPORT_TOKEN secrets are required.');
}

const SOURCES = {
  'e-estekhdam': {
    name: 'ای‌استخدام',
    searchUrl: process.env.QZIH_EESTEKHDAM_SEARCH_URL || 'https://www.e-estekhdam.com/search/%D8%A7%D8%B3%D8%AA%D8%AE%D8%AF%D8%A7%D9%85-%D8%AF%D8%B1-%D9%82%D8%B2%D9%88%DB%8C%D9%86'
  },
  divar: {
    name: 'دیوار',
    searchUrl: process.env.QZIH_DIVAR_SEARCH_URL || 'https://divar.ir/s/qazvin/jobs'
  }
};

const activeSources = SOURCE_MODE === 'both'
  ? ['e-estekhdam', 'divar']
  : SOURCE_MODE.split(',').map(v => v.trim()).filter(v => SOURCES[v]);

const cities = [
  'محمودآباد نمونه','بوئین زهرا','بوئین‌زهرا','معلم کلایه','دانسفهان','اسفرورین','ضیاءآباد',
  'محمدیه','اقبالیه','خرمدشت','تاکستان','آبیک','الوند','آوج','آبگرم','رازمیان','کوهین',
  'سیردان','نرجه','ارداق','سگزآباد','خاکعلی','بیدستان','شال','قزوین'
];

console.log('CRAWLER VERSION 0.3.4 - E-ESTEKHDAM + DIVAR');
console.log(`Sources: ${activeSources.join(', ')}`);
console.log(`Run limits: pages/source=${MAX_PAGES}, candidates/source=${MAX_PER_SOURCE}, accepted=${MAX_ACCEPT}, minutes=${RUN_LIMIT_MINUTES}`);

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
});
const context = await browser.newContext({
  locale: 'fa-IR',
  timezoneId: 'Asia/Tehran',
  viewport: { width: 1365, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.5' }
});

await context.route('**/*', async route => {
  const request = route.request();
  const resourceType = request.resourceType();
  const url = request.url();
  if (['image', 'font', 'media'].includes(resourceType) || /google-analytics|googletagmanager|doubleclick|hotjar|clarity\.ms|yektanet/i.test(url)) {
    await route.abort();
  } else {
    await route.continue();
  }
});

const discovered = new Map();
for (const seed of SEED_URLS) {
  const source = detectSource(seed);
  if (source && isJobUrl(seed, source)) discovered.set(cleanUrl(seed), source);
}

for (const source of activeSources) {
  if (Date.now() >= RUN_DEADLINE) break;
  const config = SOURCES[source];
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  let sourceCount = [...discovered.values()].filter(v => v === source).length;

  for (let pageNo = 1; pageNo <= MAX_PAGES && sourceCount < MAX_PER_SOURCE; pageNo++) {
    if (Date.now() >= RUN_DEADLINE) break;
    const url = pageNo === 1 ? config.searchUrl : withQuery(config.searchUrl, 'page', pageNo);
    console.log(`[${config.name}] Discover page ${pageNo}: ${url}`);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(1000);
      for (let i = 0; i < 5; i++) {
        await page.mouse.wheel(0, 1500);
        await page.waitForTimeout(250);
      }
      const links = await page.evaluate(() => Array.from(document.querySelectorAll('a[href]'), a => a.href));
      let added = 0;
      for (const link of links) {
        const cleaned = cleanUrl(link);
        if (isJobUrl(cleaned, source) && !discovered.has(cleaned)) {
          discovered.set(cleaned, source);
          sourceCount++;
          added++;
          if (sourceCount >= MAX_PER_SOURCE) break;
        }
      }
      console.log(`[${config.name}] Added ${added}; source total ${sourceCount}`);
    } catch (error) {
      console.warn(`[${config.name}] Search page failed: ${error.message}`);
    }
  }
  await page.close();
}

if (discovered.size === 0) {
  throw new Error('No job links were discovered after browser rendering.');
}

const accepted = [];
const rejected = { noLocation: 0, noContact: 0, errors: 0 };
const detailPage = await context.newPage();
detailPage.setDefaultTimeout(5000);
const candidates = [...discovered.entries()];
console.log(`Candidate pages to inspect: ${candidates.length}`);

for (let index = 0; index < candidates.length; index++) {
  if (accepted.length >= MAX_ACCEPT) break;
  if (Date.now() >= RUN_DEADLINE) {
    console.log('Inspection stopped safely: overall run time limit reached.');
    break;
  }

  const [url, source] = candidates[index];
  const config = SOURCES[source];
  const started = Date.now();
  console.log(`Inspect ${index + 1}/${candidates.length} [${config.name}]: ${url}`);

  try {
    await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await detailPage.waitForTimeout(800);
    await revealDirectContact(detailPage);
    await detailPage.waitForTimeout(600);

    const data = await extractJob(detailPage, source);
    const city = detectCity(`${data.title} ${data.contentText}`) || 'قزوین';
    const contacts = extractContacts(data.contactText || data.contentText, data.contactLinks, source);

    if (!city) {
      rejected.noLocation++;
      console.log(`Reject: outside Qazvin (${elapsed(started)})`);
      continue;
    }
    if (!hasContact(contacts)) {
      rejected.noContact++;
      console.log(`Reject: no direct public contact (${elapsed(started)})`);
      continue;
    }

    const role = detectRole(`${data.title} ${data.contentText}`);
    const item = {
      source,
      source_name: config.name,
      source_id: sourceId(url, source),
      url,
      title: data.title,
      role,
      content_text: data.contentText.slice(0, 50000),
      content_html: data.contentHtml.slice(0, 100000),
      published_at: data.publishedAt,
      city,
      contacts,
      fields: inferFields(`${data.title} ${data.contentText}`, city, role)
    };

    await sendBatch([item]);
    accepted.push(item);
    console.log(`Accepted and sent ${accepted.length}/${MAX_ACCEPT} [${config.name}/${role}]: ${data.title} (${elapsed(started)})`);
  } catch (error) {
    rejected.errors++;
    console.warn(`Detail failed (${elapsed(started)}): ${error.message}`);
  }
}

await detailPage.close();
await browser.close();

console.log(JSON.stringify({ discovered: discovered.size, accepted: accepted.length, rejected }, null, 2));
if (accepted.length === 0) {
  console.log('No acceptable ads found in this run; nothing will be sent.');
} else {
  console.log(`Run complete. Sent ${accepted.length} acceptable ad(s) to WordPress.`);
}

async function revealDirectContact(page) {
  const clicked = await page.evaluate(() => {
    const labels = [
      'نمایش اطلاعات تماس','مشاهده اطلاعات تماس','اطلاعات تماس',
      'نمایش شماره تماس','نمایش شماره','شماره تماس','تماس با آگهی‌دهنده'
    ];
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    let count = 0;
    for (const node of nodes) {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (labels.some(label => text.includes(label)) && !/چت|ورود|ثبت نام/.test(text)) {
        try { node.click(); count++; } catch {}
      }
    }
    return count;
  }).catch(() => 0);
  if (clicked) console.log(`Contact reveal clicks: ${clicked}`);
}

async function extractJob(page, source) {
  return await page.evaluate(({ source }) => {
    const clean = value => String(value || '')
      .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    let title = clean(
      document.querySelector('h1')?.innerText ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title
    );
    title = title
      .replace(/\s*[-–|].*ای\s*استخدام.*$/i, '')
      .replace(/\s*[-–|].*دیوار.*$/i, '')
      .trim();

    const selectors = source === 'divar'
      ? ['main article','main','article','[class*="post-page"]','[class*="kt-page"]','body']
      : ['main article','article','main','[class*="job-detail"]','[class*="jobDetail"]','[class*="advertisement"]','body'];

    let root = document.body;
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = clean(node?.innerText || node?.textContent || '');
      if (node && text.length > 180) { root = node; break; }
    }

    const contentText = clean(root?.innerText || root?.textContent || '');
    const contentHtml = root?.innerHTML || '';
    const markerRegex = /اطلاعات تماس|نحوه ارتباط|راه ارتباطی|شماره تماس|موبایل|تلفن/i;
    const markerNodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,strong,b,p,span,div,section,button,a'));
    let contactRoot = null;
    for (const node of markerNodes) {
      const own = clean(node.innerText || node.textContent || '');
      if (!markerRegex.test(own) || own.length > 350) continue;
      let current = node;
      for (let i = 0; i < 4 && current; i++, current = current.parentElement) {
        const text = clean(current.innerText || current.textContent || '');
        if (text.length >= 8 && text.length <= 5000) { contactRoot = current; break; }
      }
      if (contactRoot) break;
    }
    if (!contactRoot) contactRoot = root;

    const contactText = clean(contactRoot?.innerText || contactRoot?.textContent || '');
    const contactLinks = Array.from(contactRoot?.querySelectorAll?.('a[href]') || [], a => a.href);
    const publishedAt = document.querySelector('meta[property="article:published_time"]')?.content || '';

    return { title, contentText, contentHtml, contactText, contactLinks, publishedAt };
  }, { source });
}

async function sendBatch(items) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-QZIH-Token': TOKEN,
        'User-Agent': 'QazvinJobsImportCrawler/0.3.4'
      },
      body: JSON.stringify({ source: 'multi', crawler_version: '0.3.4', items }),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`WordPress receiver HTTP ${response.status}: ${body.slice(0, 1000)}`);
    console.log(`WordPress receiver accepted batch: ${body}`);
  } finally {
    clearTimeout(timer);
  }
}

function clamp(value, min, max, fallback) {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function elapsed(started) { return `${((Date.now() - started) / 1000).toFixed(1)}s`; }
function cleanUrl(url) { try { const u = new URL(url); u.hash = ''; return u.toString(); } catch { return url; } }
function withQuery(base, key, value) { const u = new URL(base); u.searchParams.set(key, String(value)); return u.toString(); }
function detectSource(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host === 'e-estekhdam.com') return 'e-estekhdam';
    if (host === 'divar.ir') return 'divar';
  } catch {}
  return '';
}
function isJobUrl(url, source = detectSource(url)) {
  try {
    const u = new URL(url);
    if (source === 'e-estekhdam') return /(^|\.)e-estekhdam\.com$/i.test(u.hostname) && /^\/k[a-z0-9]+(?:-|\/|$)/i.test(u.pathname);
    if (source === 'divar') return /(^|\.)divar\.ir$/i.test(u.hostname) && /^\/v\/[^/]+\/[^/?#]+\/?$/i.test(u.pathname);
  } catch {}
  return false;
}
function sourceId(url, source = detectSource(url)) {
  const u = new URL(url);
  if (source === 'e-estekhdam') {
    const m = u.pathname.match(/\/(k[a-z0-9]+)(?:-|\/|$)/i);
    return m ? m[1].toLowerCase() : '';
  }
  if (source === 'divar') {
    const parts = u.pathname.split('/').filter(Boolean);
    return `divar-${parts.at(-1) || ''}`.toLowerCase();
  }
  return '';
}
function cleanText(value) { return String(value || '').replace(/[\u200c\u200f\u202a-\u202e]/g, ' ').replace(/\s+/g, ' ').trim(); }
function toEnglishDigits(value) { return String(value || '').replace(/[۰-۹٠-٩]/g, ch => '۰۱۲۳۴۵۶۷۸۹'.includes(ch) ? String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)) : String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch))); }
function detectCity(text) {
  const normalized = cleanText(text).replace(/ي/g,'ی').replace(/ك/g,'ک');
  return cities.find(city => normalized.includes(city.replace('بوئین زهرا','بوئین‌زهرا'))) || cities.find(city => normalized.includes(city)) || '';
}
function normalizePhone(value) {
  let v = toEnglishDigits(value).replace(/\D+/g, '');
  if (v.startsWith('0098')) v = v.slice(4); else if (v.startsWith('98')) v = v.slice(2);
  if (v.length === 10 && v.startsWith('9')) v = `0${v}`;
  if (v.length === 10 && v.startsWith('28')) v = `0${v}`;
  return v;
}
function extractContacts(text, links = [], source = '') {
  const flat = toEnglishDigits(`${text} ${links.join(' ')}`);
  const phones = [];
  const emails = [];
  const whatsapp = [];
  const telegram = [];
  for (const m of flat.matchAll(/(?<!\d)(?:(?:\+|00)?98[\s-]?)?0?9\d{9}(?!\d)/g)) phones.push(normalizePhone(m[0]));
  for (const m of flat.matchAll(/(?<!\d)(?:(?:\+|00)?98[\s-]?)?0?28[\s-]?\d{7,8}(?!\d)/g)) phones.push(normalizePhone(m[0]));
  for (const m of flat.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
    if (!/@(?:e-estekhdam\.com|estekhdam\.com|divar\.ir)$/i.test(m[0])) emails.push(m[0].toLowerCase());
  }
  for (const link of links) {
    if (/^tel:/i.test(link)) phones.push(normalizePhone(link));
    if (/^mailto:/i.test(link)) {
      const e = link.replace(/^mailto:/i,'').split('?')[0];
      if (!/@(?:e-estekhdam\.com|estekhdam\.com|divar\.ir)$/i.test(e)) emails.push(e.toLowerCase());
    }
    const wa = link.match(/(?:wa\.me\/|phone=)(\+?\d{10,15})/i); if (wa) whatsapp.push(normalizePhone(wa[1]));
    const tg = link.match(/t\.me\/([A-Za-z0-9_]{5,32})/i); if (tg) telegram.push(`@${tg[1]}`);
  }
  if (/واتساپ|واتس.?اپ|whatsapp/i.test(flat)) whatsapp.push(...phones);
  return { phones: uniq(phones), emails: uniq(emails), whatsapp: uniq(whatsapp), telegram: uniq(telegram) };
}
function uniq(values) { return [...new Set(values.filter(Boolean))]; }
function hasContact(c) { return c.phones.length || c.emails.length || c.whatsapp.length || c.telegram.length; }
function detectRole(text) {
  const t = cleanText(text);
  const seeker = ['جویای کار','آماده همکاری','آماده به کار','دنبال کار','به دنبال کار','درخواست کار','کار می‌خواهم','هستم. جویای','هستم و جویای'];
  return seeker.some(marker => t.includes(marker)) ? 'job_seeker' : 'employer';
}
function inferFields(text, city, role) {
  const t = cleanText(text).toLowerCase();
  const fields = { city, role, category: category(t) };
  for (const [needle, value] of [['تمام وقت','تمام‌وقت'],['تمام‌وقت','تمام‌وقت'],['پاره وقت','پاره‌وقت'],['پاره‌وقت','پاره‌وقت'],['دورکاری','دورکاری'],['پروژه‌ای','پروژه‌ای / پیمانکاری'],['کارآموزی','کارآموزی']]) {
    if (t.includes(needle)) { fields.cooperation_type = value; break; }
  }
  if (t.includes('دورکاری')) fields.workplace_mode = 'دورکاری';
  else if (t.includes('حضوری')) fields.workplace_mode = 'حضوری';
  return fields;
}
function category(t) {
  const groups = [
    ['فروش و بازاریابی',['فروش','بازاریاب','ویزیتور','صندوقدار','فروشنده']],
    ['مالی و حسابداری',['حسابدار','حسابداری','حسابرسی','مالی']],
    ['اداری و منابع انسانی',['اداری','منابع انسانی','کارگزینی','منشی','مسئول دفتر']],
    ['فنی و مهندسی',['مهندس','تکنسین','برق','مکانیک','عمران','معماری','تاسیسات']],
    ['تولید و کارگر',['کارگر','تولید','اپراتور','بسته بندی','بسته‌بندی','مونتاژ']],
    ['خدمات و پشتیبانی',['خدمات','نظافت','نگهبان','سرایدار','آبدارچی']],
    ['رانندگی و حمل‌ونقل',['راننده','پیک','توزیع','حمل و نقل','حمل‌ونقل']],
    ['فناوری اطلاعات',['برنامه نویس','برنامه‌نویس','نرم افزار','نرم‌افزار','شبکه','it','کامپیوتر']],
    ['درمان و سلامت',['پرستار','پزشک','دندانپزشک','داروخانه','بهیار','درمان']],
    ['آموزش',['مدرس','معلم','مربی','آموزش']],
    ['رستوران و صنایع غذایی',['آشپز','رستوران','کافی شاپ','کافی‌شاپ','صنایع غذایی','قناد']]
  ];
  for (const [label, needles] of groups) if (needles.some(n => t.includes(n))) return label;
  return 'سایر مشاغل';
}
