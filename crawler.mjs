import { chromium } from 'playwright';

const SEARCH_URL = process.env.QZIH_SEARCH_URL || 'https://www.e-estekhdam.com/search/%D8%A7%D8%B3%D8%AA%D8%AE%D8%AF%D8%A7%D9%85-%D8%AF%D8%B1-%D9%82%D8%B2%D9%88%DB%8C%D9%86';
const ENDPOINT = process.env.QZIH_IMPORT_ENDPOINT || '';
const TOKEN = process.env.QZIH_IMPORT_TOKEN || '';
const MAX_PAGES = clamp(process.env.QZIH_MAX_PAGES, 1, 10, 1);
const MAX_CANDIDATES = clamp(process.env.QZIH_MAX_CANDIDATES, 1, 100, 20);
const MAX_ACCEPT = clamp(process.env.QZIH_MAX_ACCEPT, 1, 10, 1);
const RUN_LIMIT_MINUTES = clamp(process.env.QZIH_RUN_LIMIT_MINUTES, 2, 15, 8);
const RUN_DEADLINE = Date.now() + RUN_LIMIT_MINUTES * 60 * 1000;
const SEED_URLS = (process.env.QZIH_SEED_URLS || '').split(/[\n,]+/).map(v => v.trim()).filter(Boolean);

if (!ENDPOINT || !TOKEN) {
  throw new Error('QZIH_IMPORT_ENDPOINT and QZIH_IMPORT_TOKEN secrets are required.');
}

const cities = [
  'محمودآباد نمونه','بوئین زهرا','بوئین‌زهرا','معلم کلایه','دانسفهان','اسفرورین','ضیاءآباد',
  'محمدیه','اقبالیه','خرمدشت','تاکستان','آبیک','الوند','آوج','آبگرم','رازمیان','کوهین',
  'سیردان','نرجه','ارداق','سگزآباد','خاکعلی','بیدستان','شال','قزوین'
];

console.log('CRAWLER VERSION 0.3.3 - FAST TEST + IMMEDIATE SEND');
console.log(`Run limits: pages=${MAX_PAGES}, candidates=${MAX_CANDIDATES}, accepted=${MAX_ACCEPT}, minutes=${RUN_LIMIT_MINUTES}`);
console.log(`Seed URLs: ${SEED_URLS.length}`);

const browser = await chromium.launch({
  headless: true,
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
});
const context = await browser.newContext({
  locale: 'fa-IR',
  timezoneId: 'Asia/Tehran',
  viewport: { width: 1365, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.5' }
});

await context.route('**/*', async route => {
  const request = route.request();
  const resourceType = request.resourceType();
  const url = request.url();
  if (['image', 'font', 'media'].includes(resourceType) || /google-analytics|googletagmanager|doubleclick|hotjar|clarity\.ms/i.test(url)) {
    await route.abort();
  } else {
    await route.continue();
  }
});

const discovered = new Set(SEED_URLS.filter(isJobUrl).map(cleanUrl));
const searchPage = await context.newPage();
searchPage.setDefaultTimeout(5000);

for (let pageNo = 1; pageNo <= MAX_PAGES && discovered.size < MAX_CANDIDATES; pageNo++) {
  if (Date.now() >= RUN_DEADLINE) break;
  const url = pageNo === 1 ? SEARCH_URL : withQuery(SEARCH_URL, 'page', pageNo);
  console.log(`Discover page ${pageNo}: ${url}`);
  try {
    await searchPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 18000 });
    await searchPage.waitForTimeout(1000);
    for (let i = 0; i < 4; i++) {
      await searchPage.mouse.wheel(0, 1400);
      await searchPage.waitForTimeout(250);
    }
    const links = await searchPage.evaluate(() => Array.from(document.querySelectorAll('a[href]'), a => a.href));
    let added = 0;
    for (const link of links) {
      const cleaned = cleanUrl(link);
      if (isJobUrl(cleaned) && !discovered.has(cleaned)) {
        discovered.add(cleaned);
        added++;
        if (discovered.size >= MAX_CANDIDATES) break;
      }
    }
    console.log(`Discovered on page: ${added}; total: ${discovered.size}`);
  } catch (error) {
    console.warn(`Search page failed: ${error.message}`);
  }
}
await searchPage.close();

if (discovered.size === 0) {
  throw new Error('No job links were discovered after browser rendering.');
}

const accepted = [];
const rejected = { noLocation: 0, noContact: 0, errors: 0 };
const detailPage = await context.newPage();
detailPage.setDefaultTimeout(4000);

const candidateUrls = [...discovered].slice(0, MAX_CANDIDATES);
console.log(`Candidate pages to inspect: ${candidateUrls.length}`);

for (let index = 0; index < candidateUrls.length; index++) {
  if (accepted.length >= MAX_ACCEPT) break;
  if (Date.now() >= RUN_DEADLINE) {
    console.log('Inspection stopped safely: overall run time limit reached.');
    break;
  }

  const url = candidateUrls[index];
  const started = Date.now();
  console.log(`Inspect ${index + 1}/${candidateUrls.length}: ${url}`);

  try {
    await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await detailPage.waitForTimeout(650);
    await revealContactFast(detailPage);
    await detailPage.waitForTimeout(450);

    const data = await extractJobFast(detailPage, url);
    const city = detectCity(`${data.title} ${data.contentText}`);
    if (!city) {
      rejected.noLocation++;
      console.log(`Reject: outside Qazvin (${elapsed(started)})`);
      continue;
    }

    const contacts = extractContacts(data.contactText || data.contentText, data.contactLinks);
    if (!hasContact(contacts)) {
      rejected.noContact++;
      console.log(`Reject: no direct public contact (${elapsed(started)})`);
      continue;
    }

    const acceptedItem = {
      source_id: sourceId(url),
      url,
      title: data.title,
      content_text: data.contentText.slice(0, 30000),
      content_html: data.contentHtml.slice(0, 70000),
      published_at: data.publishedAt,
      city,
      contacts,
      fields: inferFields(`${data.title} ${data.contentText}`, city)
    };

    await sendBatch([acceptedItem]);
    accepted.push(acceptedItem);
    console.log(`Accepted and sent ${accepted.length}/${MAX_ACCEPT}: ${data.title} (${elapsed(started)})`);
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
  process.exit(0);
}
console.log(`Run complete. Sent ${accepted.length} acceptable ad(s) to WordPress.`);

async function revealContactFast(page) {
  const clicked = await page.evaluate(() => {
    const labels = ['نمایش اطلاعات تماس','مشاهده اطلاعات تماس','اطلاعات تماس','نمایش شماره تماس','نمایش شماره','شماره تماس'];
    const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    let count = 0;
    for (const node of nodes) {
      const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
      if (labels.some(label => text.includes(label))) {
        try { node.click(); count++; } catch {}
      }
    }
    return count;
  }).catch(() => 0);
  if (clicked) console.log(`Contact reveal clicks: ${clicked}`);
}

async function extractJobFast(page, url) {
  return await page.evaluate(({ url }) => {
    const clean = value => String(value || '')
      .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const title = clean(
      document.querySelector('h1')?.innerText ||
      document.querySelector('meta[property="og:title"]')?.content ||
      document.title
    ).replace(/\s*[-–|].*ای\s*استخدام.*$/i, '').trim();

    const selectors = ['main article','article','main','[class*="job-detail"]','[class*="jobDetail"]','[class*="advertisement"]','body'];
    let root = document.body;
    for (const selector of selectors) {
      const node = document.querySelector(selector);
      const text = clean(node?.innerText || node?.textContent || '');
      if (node && text.length > 250) { root = node; break; }
    }

    const contentText = clean(root?.innerText || root?.textContent || '');
    const contentHtml = root?.innerHTML || '';

    const markerRegex = /اطلاعات تماس|نحوه ارتباط|راه ارتباطی|شماره تماس/i;
    const markerNodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,strong,b,p,span,div,section,button,a'));
    let contactRoot = null;
    for (const node of markerNodes) {
      const own = clean(node.innerText || node.textContent || '');
      if (!markerRegex.test(own) || own.length > 300) continue;
      let current = node;
      for (let i = 0; i < 4 && current; i++, current = current.parentElement) {
        const text = clean(current.innerText || current.textContent || '');
        if (text.length >= 10 && text.length <= 5000) {
          contactRoot = current;
          break;
        }
      }
      if (contactRoot) break;
    }
    if (!contactRoot) contactRoot = root;

    const contactText = clean(contactRoot?.innerText || contactRoot?.textContent || '');
    const contactLinks = Array.from(contactRoot?.querySelectorAll?.('a[href]') || [], a => a.href);
    const publishedAt = document.querySelector('meta[property="article:published_time"]')?.content || '';

    return { title, contentText, contentHtml, contactText, contactLinks, publishedAt, url };
  }, { url });
}

async function sendBatch(items) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-QZIH-Token': TOKEN,
        'User-Agent': 'QazvinJobsImportCrawler/0.3.3'
      },
      body: JSON.stringify({ source: 'e-estekhdam', crawler_version: '0.3.3', items }),
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
function isJobUrl(url) { try { const u = new URL(url); return /(^|\.)e-estekhdam\.com$/i.test(u.hostname) && /^\/k[a-z0-9]+(?:-|\/|$)/i.test(u.pathname); } catch { return false; } }
function sourceId(url) { const m = new URL(url).pathname.match(/\/(k[a-z0-9]+)(?:-|\/|$)/i); return m ? m[1].toLowerCase() : ''; }
function cleanText(value) { return String(value || '').replace(/[\u200c\u200f\u202a-\u202e]/g, ' ').replace(/\s+/g, ' ').trim(); }
function toEnglishDigits(value) { return String(value || '').replace(/[۰-۹٠-٩]/g, ch => '۰۱۲۳۴۵۶۷۸۹'.includes(ch) ? String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)) : String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch))); }
function detectCity(text) { const normalized = cleanText(text).replace(/ي/g,'ی').replace(/ك/g,'ک'); return cities.find(city => normalized.includes(city.replace('بوئین زهرا','بوئین‌زهرا'))) || cities.find(city => normalized.includes(city)) || ''; }
function normalizePhone(value) {
  let v = toEnglishDigits(value).replace(/\D+/g, '');
  if (v.startsWith('0098')) v = v.slice(4); else if (v.startsWith('98')) v = v.slice(2);
  if (v.length === 10 && v.startsWith('9')) v = `0${v}`;
  if (v.length === 10 && v.startsWith('28')) v = `0${v}`;
  return v;
}
function extractContacts(text, links = []) {
  const flat = toEnglishDigits(`${text} ${links.join(' ')}`);
  const phones = [];
  const emails = [];
  const whatsapp = [];
  const telegram = [];
  for (const m of flat.matchAll(/(?<!\d)(?:(?:\+|00)?98[\s-]?)?0?9\d{9}(?!\d)/g)) phones.push(normalizePhone(m[0]));
  for (const m of flat.matchAll(/(?<!\d)(?:(?:\+|00)?98[\s-]?)?0?28[\s-]?\d{7,8}(?!\d)/g)) phones.push(normalizePhone(m[0]));
  for (const m of flat.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) if (!/@(?:e-estekhdam\.com|estekhdam\.com)$/i.test(m[0])) emails.push(m[0].toLowerCase());
  for (const link of links) {
    if (/^tel:/i.test(link)) phones.push(normalizePhone(link));
    if (/^mailto:/i.test(link)) { const e = link.replace(/^mailto:/i,'').split('?')[0]; if (!/@(?:e-estekhdam\.com|estekhdam\.com)$/i.test(e)) emails.push(e.toLowerCase()); }
    const wa = link.match(/(?:wa\.me\/|phone=)(\+?\d{10,15})/i); if (wa) whatsapp.push(normalizePhone(wa[1]));
    const tg = link.match(/t\.me\/([A-Za-z0-9_]{5,32})/i); if (tg) telegram.push(`@${tg[1]}`);
  }
  if (/واتساپ|واتس.?اپ|whatsapp/i.test(flat)) whatsapp.push(...phones);
  return { phones: uniq(phones), emails: uniq(emails), whatsapp: uniq(whatsapp), telegram: uniq(telegram) };
}
function uniq(values) { return [...new Set(values.filter(Boolean))]; }
function hasContact(c) { return c.phones.length || c.emails.length || c.whatsapp.length || c.telegram.length; }
function inferFields(text, city) {
  const t = cleanText(text).toLowerCase();
  const fields = { city, category: category(t) };
  for (const [needle, value] of [['تمام وقت','تمام وقت'],['تمام‌وقت','تمام وقت'],['پاره وقت','پاره وقت'],['پاره‌وقت','پاره وقت'],['دورکاری','دورکاری'],['پروژه‌ای','پروژه‌ای'],['کارآموزی','کارآموزی']]) if (t.includes(needle)) { fields.cooperation_type = value; break; }
  if (t.includes('دورکاری')) fields.workplace_mode = 'دورکاری'; else if (t.includes('حضوری')) fields.workplace_mode = 'حضوری';
  return fields;
}
function category(t) {
  const groups = [
    ['فروش و بازاریابی',['فروش','بازاریاب','ویزیتور','صندوقدار','فروشنده']], ['مالی و حسابداری',['حسابدار','حسابداری','حسابرسی','مالی']],
    ['اداری و منابع انسانی',['اداری','منابع انسانی','کارگزینی','منشی','مسئول دفتر']], ['فنی و مهندسی',['مهندس','تکنسین','برق','مکانیک','عمران','معماری','تاسیسات']],
    ['تولید و کارگر',['کارگر','تولید','اپراتور','بسته بندی','بسته‌بندی','مونتاژ']], ['خدمات و پشتیبانی',['خدمات','نظافت','نگهبان','سرایدار','آبدارچی']],
    ['رانندگی و حمل‌ونقل',['راننده','پیک','توزیع','حمل و نقل','حمل‌ونقل']], ['فناوری اطلاعات',['برنامه نویس','برنامه‌نویس','نرم افزار','نرم‌افزار','شبکه','it','کامپیوتر']],
    ['درمان و سلامت',['پرستار','پزشک','دندانپزشک','داروخانه','بهیار','درمان']], ['آموزش',['مدرس','معلم','مربی','آموزش']], ['رستوران و صنایع غذایی',['آشپز','رستوران','کافی شاپ','کافی‌شاپ','صنایع غذایی','قناد']]
  ];
  for (const [label, needles] of groups) if (needles.some(n => t.includes(n))) return label;
  return 'سایر مشاغل';
}
