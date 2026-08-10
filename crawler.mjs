import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';


const ENDPOINT = process.env.QZIH_IMPORT_ENDPOINT || '';
const TOKEN = process.env.QZIH_IMPORT_TOKEN || '';
const SOURCE_MODE = String(process.env.QZIH_SOURCES || 'both').toLowerCase();
const MAX_PAGES = clamp(process.env.QZIH_MAX_PAGES, 1, 5, 5);
const MAX_PER_SOURCE = clamp(process.env.QZIH_MAX_CANDIDATES, 1, 80, 80);
const MAX_ACCEPT = clamp(process.env.QZIH_MAX_ACCEPT, 1, 20, 5);
const MAX_REVIEW = clamp(process.env.QZIH_MAX_REVIEW, 0, 20, 5);
const RUN_LIMIT_MINUTES = clamp(process.env.QZIH_RUN_LIMIT_MINUTES, 4, 25, 20);
const RUN_DEADLINE = Date.now() + RUN_LIMIT_MINUTES * 60 * 1000;
const DIVAR_AUTH_SESSION_ENDPOINT = process.env.QZIH_DIVAR_AUTH_SESSION_ENDPOINT || deriveDivarAuthEndpoint(ENDPOINT, 'session');
const DIVAR_LOGIN_PHONE = normalizePhone(process.env.QZIH_DIVAR_LOGIN_PHONE || '');
let SEED_URLS = String(process.env.QZIH_SEED_URLS || '').split(/[\n,]+/).map(v => v.trim()).filter(Boolean);
let CONTROLLED_TEST_FROM_HUB = false;


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

// Controlled-test handshake: WordPress is the single source of truth for the
// URL armed by the admin. This prevents an old/empty GitHub seed_url from
// causing a different ad to be parsed during a controlled re-import.
const HUB_CONTROL = await loadHubControlState();
if (HUB_CONTROL?.active && HUB_CONTROL?.url) {
 const controlledUrl = cleanUrl(HUB_CONTROL.url);
 const controlledSource = detectSource(controlledUrl);
 if (controlledSource && !activeSources.includes(controlledSource)) {
   console.log(`Controlled test is armed for ${controlledSource}; current ${activeSources.join(',')} job exits without crawling.`);
   process.exit(0);
 }
 if (controlledSource && isJobUrl(controlledUrl, controlledSource)) {
   if (SEED_URLS.length && !SEED_URLS.some(url => cleanUrl(url) === controlledUrl)) {
     console.warn('GitHub seed_url differs from the armed WordPress test URL; WordPress URL wins.');
   }
   SEED_URLS = [controlledUrl];
   CONTROLLED_TEST_FROM_HUB = true;
   console.log(`Controlled test URL loaded from WordPress Hub: ${controlledUrl}`);
 }
}


const RUN_STARTED_AT = Date.now();
const sourceStats = Object.fromEntries(Object.entries(SOURCES).map(([key, value]) => [
 key,
 {
 name: value.name,
 discovered: 0,
 inspected: 0,
 accepted: 0,
 review_only: 0,
 no_location: 0,
 no_contact: 0,
 login_required: 0,
 contact_reveal_failed: 0,
 manual_contact_drafts: 0,
 auth_loaded: false,
 auth_status: '',
 errors: 0
 }
]));


const cities = [
 'محمودآباد نمونه','بوئین زهرا','بوئین‌زهرا','معلم کلایه','دانسفهان','اسفرورین','ضیاءآباد',
 'محمدیه','اقبالیه','خرمدشت','تاکستان','آبیک','الوند','آوج','آبگرم','رازمیان','کوهین',
 'سیردان','نرجه','ارداق','سگزآباد','خاکعلی','بیدستان','شال','قزوین'
];


console.log('CRAWLER VERSION 0.3.28 - STRICT CANONICAL FIELD VALIDATION');
console.log(`Sources: ${activeSources.join(', ')}`);
console.log(`Run limits: pages/source=${MAX_PAGES}, candidates/source=${MAX_PER_SOURCE}, draft_target=${MAX_ACCEPT}, minutes=${RUN_LIMIT_MINUTES}`);


const browser = await chromium.launch({
 headless: true,
 args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage']
});
const divarAuth = activeSources.includes('divar')
  ? await loadDivarAuthState()
  : { state: null, status: 'not_requested' };
sourceStats.divar.auth_loaded = Boolean(divarAuth.state);
sourceStats.divar.auth_status = divarAuth.status;


const contextOptions = {
 locale: 'fa-IR',
 timezoneId: 'Asia/Tehran',
 viewport: { width: 1365, height: 900 },
 userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
 extraHTTPHeaders: { 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.5' }
};
if (divarAuth.state) contextOptions.storageState = divarAuth.state;
const context = await browser.newContext(contextOptions);


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
 if (source && activeSources.includes(source) && isJobUrl(seed, source)) discovered.set(cleanUrl(seed), source);
}

if (SEED_URLS.length > 0) {
 console.log(`Seed-only mode: general discovery is disabled; exact URLs=${[...discovered.keys()].join(', ')}`);
 for (const source of activeSources) {
   sourceStats[source].discovered = [...discovered.values()].filter(v => v === source).length;
 }
} else {
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
  sourceStats[source].discovered = [...discovered.values()].filter(v => v === source).length;
  await page.close();
 }
}


if (discovered.size === 0) {
 throw new Error('No job links were discovered after browser rendering.');
}


const directAccepted = [];
const reviewQueued = [];
const sentItems = [];
// In manual-contact fallback mode, Divar login is optional. The crawler still
// tries to reveal the phone when a session exists, but lack/expiry of login
// must never block creation of a draft.
let divarLoginBlocked = false;
if (activeSources.includes('divar') && !divarAuth.state) {
 sourceStats.divar.login_required = 1;
 sourceStats.divar.auth_status = 'missing_fallback_active';
 console.log('Divar authenticated state is missing; draft-all fallback remains active and phone will be completed manually.');
}
const rejected = { noLocation: 0, noContact: 0, errors: 0 };
const detailPage = await context.newPage();
detailPage.setDefaultTimeout(5000);


const candidatesBySource = Object.fromEntries(activeSources.map(source => [
 source,
 [...discovered.entries()].filter(([, detectedSource]) => detectedSource === source)
]));
const candidates = [];
const maxSourceLength = Math.max(0, ...Object.values(candidatesBySource).map(rows => rows.length));
for (let index = 0; index < maxSourceLength; index++) {
 for (const source of activeSources) {
 if (candidatesBySource[source]?.[index]) candidates.push(candidatesBySource[source][index]);
 }
}
console.log(`Candidate pages to inspect (round-robin): ${candidates.length}`);


for (let index = 0; index < candidates.length; index++) {
 if (directAccepted.length >= MAX_ACCEPT) break;
 if (Date.now() >= RUN_DEADLINE) {
 console.log('Inspection stopped safely: overall run time limit reached.');
 break;
 }


 const [url, source] = candidates[index];
 const config = SOURCES[source];
 const started = Date.now();
 console.log(`Inspect ${index + 1}/${candidates.length} [${config.name}]: ${url}`);
 sourceStats[source].inspected++;


 try {
 await detailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 18000 });
 await detailPage.waitForTimeout(800);
 const reveal = await revealDirectContact(detailPage, source, url);
 await detailPage.waitForTimeout(600);


 if (source === 'divar' && reveal.loginRequired) {
 sourceStats[source].login_required++;
 sourceStats[source].auth_status = 'login_required_fallback_active';
 console.log('Divar requested login while revealing contact; continuing with manual-contact draft fallback.');
 await detailPage.keyboard.press('Escape').catch(() => {});
 }


 const data = await extractJob(detailPage, source);
 const cityResolution = resolveCityFromData(data, source, url);
 const city = cityResolution.city;
 if (cityResolution.source === 'feed') {
 console.log(`Location fallback [${config.name}]: ${city} (configured city feed)`);
 } else if (city) {
 console.log(`Location source [${config.name}]: ${cityResolution.source} -> ${city}`);
 }
 const contacts = extractContacts(`${reveal.contactText || ''} ${reveal.networkText || ''} ${data.contactText || data.contentText}`, [...(reveal.contactLinks || []), ...(data.contactLinks || [])], source);


 if (!city) {
 rejected.noLocation++;
 sourceStats[source].no_location++;
 console.log(`Reject: outside Qazvin (${elapsed(started)})`);
 continue;
 }
 const directContact = Boolean(hasContact(contacts));
 // Final operational fallback: every valid Qazvin employment ad from Divar
 // becomes a WordPress draft. When no phone is extracted, the draft is
 // explicitly marked for manual contact completion by the manager.
 const manualContactRequired = source === 'divar' && !directContact;
 const contactReviewRequired = manualContactRequired;


 if (source === 'divar' && !directContact) {
 sourceStats[source].contact_reveal_failed++;
 await saveDivarContactDiagnostics(detailPage, canonicalSourceUrl(url, detailPage.url(), source), data, reveal).catch(error => {
 console.warn(`Divar contact diagnostics failed: ${error.message}`);
 });
 }


 if (!directContact && source !== 'divar') {
 rejected.noContact++;
 sourceStats[source].no_contact++;
 console.log(`Reject: no direct public contact or explicit contact instruction (${elapsed(started)})`);
 continue;
 }


 const role = detectRole(`${data.title} ${data.contentText}`);
 const sourceUrl = canonicalSourceUrl(url, detailPage.url(), source);
 const structured = buildSourceFirstFields(data, city, role, source, sourceUrl);
 if (SEED_URLS.length > 0) {
   console.log(`Mapped source fields [${config.name}]: ${Object.keys(structured).sort().join(', ')}`);
 }
 const item = {
      source,
 source_name: config.name,
 source_id: sourceId(sourceUrl, source),
 url: sourceUrl,
 title: data.title,
      role,
 content_text: data.contentText.slice(0, 50000),
 content_html: data.contentHtml.slice(0, 100000),
 published_at: data.publishedAt,
      city,
      city_exact: city,
      city_source: cityResolution.source,
      location_city: city,
      source_category: data.sourceCategory || '',
      contacts,
 direct_contact: directContact,
 contact_review_required: contactReviewRequired,
 manual_contact_required: manualContactRequired,
 contact_review_label: contactReviewRequired
        ? (reveal.contactAvailable
          ? 'دکمه اطلاعات تماس دیوار موجود است؛ شماره خودکار استخراج نشد و نیازمند بررسی مدیر است'
          : 'نیازمند بررسی اطلاعات تماس در دیوار')
        : '',
 platform_contact_only: contactReviewRequired,
 contact_reveal: source === 'divar' ? {
 clicked: reveal.clicked,
 contact_available: reveal.contactAvailable,
 network_response_count: reveal.networkResponseCount || 0,
 extraction_status: directContact ? 'extracted' : (manualContactRequired ? 'manual_contact_draft' : 'not_found')
 } : undefined,
 structured,
 fields: structured
 };


 await sendBatch([item]);
 directAccepted.push(item);
 sentItems.push(item);
 sourceStats[source].accepted++;
 if (manualContactRequired) {
 sourceStats[source].manual_contact_drafts++;
 console.log(`Divar draft accepted ${directAccepted.length}/${MAX_ACCEPT} with MANUAL CONTACT REQUIRED [${role}]: ${data.title} (${elapsed(started)})`);
 } else {
 console.log(`Direct-contact ad accepted and sent ${directAccepted.length}/${MAX_ACCEPT} [${config.name}/${role}]: ${data.title} (${elapsed(started)})`);
 }
 } catch (error) {
 rejected.errors++;
 sourceStats[source].errors++;
 console.warn(`Detail failed (${elapsed(started)}): ${error.message}`);
 }
}


await detailPage.close();
await browser.close();


const diagnostics = {
 crawler_version: '0.3.28',
 source_mode: SOURCE_MODE,
 duration_seconds: Math.round((Date.now() - RUN_STARTED_AT) / 1000),
 direct_accepted: directAccepted.length,
 review_queued: reviewQueued.length,
 total_sent: sentItems.length,
 sources: sourceStats
};
await sendDiagnostics(diagnostics);


console.log(JSON.stringify({
 discovered: discovered.size,
 direct_accepted: directAccepted.length,
 review_queued: reviewQueued.length,
 total_sent: sentItems.length,
  rejected,
 sources: sourceStats
}, null, 2));


if (sentItems.length === 0) {
 console.log('No direct-contact or manager-review ads were sent in this run.');
} else {
 console.log(`Run complete. Draft candidates sent: ${directAccepted.length}; manual-contact drafts: ${sourceStats.divar.manual_contact_drafts || 0}; total sent: ${sentItems.length}.`);
}


// In an explicit seed-URL test, a parser exception must fail the GitHub Action.
// Scheduled/bulk runs keep their tolerant behavior so one bad ad does not abort the whole crawl.
if (SEED_URLS.length > 0 && sentItems.length === 0 && rejected.errors > 0) {
 console.error(`Seed test failed: ${rejected.errors} parser/runtime error(s), 0 items sent.`);
 process.exitCode = 1;
}




async function revealDirectContact(page, source, sourceUrl = '') {
 const result = {
 clicked: 0,
 loginRequired: false,
 contactAvailable: false,
 contactText: '',
 contactLinks: [],
 networkText: '',
 networkResponseCount: 0
 };


 const networkPayloads = [];
 // The listener is written without relying on URL.prototype helpers so it also
 // works in older Node runtimes used by GitHub-hosted runners.
 const divarResponseListener = async response => {
 if (source !== 'divar') return;
 let hostname = '';
 try { hostname = new URL(response.url()).hostname; } catch { return; }
 if (!/(^|\.)divar\.ir$/i.test(hostname)) return;


 const contentType = String(await response.headerValue('content-type').catch(() => '') || '');
 if (!/json|javascript|text/i.test(contentType)) return;


 const responseUrl = response.url();
 if (!/(contact|phone|post|widget|action|api|v\d|web)/i.test(responseUrl)) return;


 const body = await response.text().catch(() => '');
 if (!body || body.length > 500000) return;


 const normalized = toEnglishDigits(body);
 if (
 /(?:^|\D)0?9(?:[\s\-().]*\d){9}(?:\D|$)/.test(normalized) ||
 /(?:^|\D)0?28(?:[\s\-().]*\d){7,8}(?:\D|$)/.test(normalized) ||
 /"(?:phone|mobile|telephone|contact|tel|phone_number|mobile_number)"\s*:/i.test(body)
 ) {
 networkPayloads.push(body);
 }
 };


 if (source === 'divar') page.on('response', divarResponseListener);


 try {
 const initialBody = cleanText(await page.locator('body').innerText().catch(() => ''));
 result.contactAvailable = /اطلاعات\s*تماس|نمایش\s*شماره|شماره\s*تماس|چت\s*و\s*تماس/i.test(initialBody);


 const firstClick = await clickBestContactControl(page, false);
 if (firstClick.clicked) {
 result.clicked++;
 result.contactAvailable = true;
 console.log(`Divar primary contact control clicked: ${firstClick.text}`);
 await page.waitForTimeout(1400);
 }


 if (source === 'divar' && await divarLoginRequired(page)) {
 result.loginRequired = true;
 console.log('Divar contact panel requested account login.');
 return result;
 }


 // Divar may first open a sheet containing a second "show phone/call" action.
 // Try secondary contact controls twice because the first click can reveal
 // another menu rather than the actual phone number.
 if (source === 'divar') {
 for (let attempt = 0; attempt < 2; attempt++) {
 if (await renderedContactExists(page)) break;
 const secondary = await clickBestContactControl(page, true);
 if (!secondary.clicked) break;
 result.clicked++;
 result.contactAvailable = true;
 console.log(`Divar secondary contact control clicked: ${secondary.text}`);
 await page.waitForTimeout(1400);


 if (await divarLoginRequired(page)) {
 result.loginRequired = true;
 console.log('Divar requested login after the contact action; saved session is expired or incomplete.');
 return result;
 }
 }
 }


 await page.waitForFunction(() => {
 const fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
 const text = (document.body?.innerText || '').replace(/[۰-۹٠-٩]/g, ch => fa.includes(ch) ? String(fa.indexOf(ch)) : String(ar.indexOf(ch)));
 return Boolean(
 document.querySelector('a[href^="tel:"], a[href^="mailto:"]') ||
 /(?:^|\D)0?9(?:[\s\-().]*\d){9}(?:\D|$)/.test(text) ||
 /(?:^|\D)0?28(?:[\s\-().]*\d){7,8}(?:\D|$)/.test(text)
 );
 }, { timeout: 6500 }).catch(() => {});


 await page.waitForTimeout(500);


 const snapshot = await page.evaluate(() => {
 const clean = value => String(value || '')
 .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();

 const toEnglishDigitsLocal = value => String(value || '').replace(/[۰-۹٠-٩]/g, ch => {
   const p = '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch);
   if (p >= 0) return String(p);
   const a = '٠١٢٣٤٥٦٧٨٩'.indexOf(ch);
   return a >= 0 ? String(a) : ch;
 });
 const visible = node => {
 const style = window.getComputedStyle(node);
 const rect = node.getBoundingClientRect();
 return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
 };


 const selector = [
 '[role="dialog"]',
 '[aria-modal="true"]',
 '[class*="modal" i]',
 '[class*="dialog" i]',
 '[class*="bottom-sheet" i]',
 '[class*="contact" i]',
 '[class*="phone" i]'
 ].join(',');


 const roots = Array.from(document.querySelectorAll(selector)).filter(visible);
 const preferred = roots.filter(node => /اطلاعات تماس|شماره تماس|نمایش شماره|موبایل|تلفن|تماس/i.test(clean(node.innerText || node.textContent || '')));
 const selectedRoots = preferred.length ? preferred : roots;
 const textParts = selectedRoots.map(node => clean(node.innerText || node.textContent || '')).filter(Boolean);


 // Also include visible text around contact-related controls because Divar
 // can render the number in a sibling node rather than inside the dialog.
 const contactNodes = Array.from(document.querySelectorAll('button, a, [role="button"], div, span'))
 .filter(visible)
 .filter(node => /اطلاعات تماس|نمایش شماره|شماره تماس|موبایل|تلفن|برقراری تماس/i.test(clean(node.innerText || node.textContent || '')))
 .slice(0, 30);
 for (const node of contactNodes) {
 let current = node;
 for (let depth = 0; depth < 3 && current; depth++, current = current.parentElement) {
 const value = clean(current.innerText || current.textContent || '');
 if (value && value.length <= 4000) textParts.push(value);
 }
 }


 const links = Array.from(document.querySelectorAll('a[href]'), anchor => anchor.href)
 .filter(href => /^(tel:|mailto:)|wa\.me|whatsapp|t\.me/i.test(href));


 return {
 text: clean(textParts.join(' ')),
 links: [...new Set(links)]
 };
 }).catch(() => ({ text: '', links: [] }));


 result.contactText = snapshot.text;
 result.contactLinks = snapshot.links;
 result.networkText = networkPayloads.join(' ');
 result.networkResponseCount = networkPayloads.length;


 const finalBody = cleanText(await page.locator('body').innerText().catch(() => ''));
 result.contactAvailable = result.contactAvailable || /اطلاعات\s*تماس|نمایش\s*شماره|شماره\s*تماس|چت\s*و\s*تماس/i.test(finalBody);


 if (result.clicked) {
 console.log(`Contact reveal clicks [${source}]: ${result.clicked}; captured contact responses: ${result.networkResponseCount}`);
 }
 return result;
 } finally {
 if (source === 'divar') page.off('response', divarResponseListener);
 }
}


async function clickBestContactControl(page, secondaryOnly = false) {
 const controls = page.locator('button, a, [role="button"]');
 const candidates = [];


 const priorities = secondaryOnly
    ? [
 [/^نمایش\s*شماره$/i, 0],
 [/^شماره\s*تماس$/i, 1],
 [/^تماس\s*تلفنی$/i, 2],
 [/^برقراری\s*تماس$/i, 3],
 [/^تماس$/i, 4],
 [/تماس\s*با\s*آگهی.?دهنده/i, 5]
 ]
    : [
 [/^اطلاعات\s*تماس$/i, 0],
 [/^نمایش\s*شماره$/i, 1],
 [/^شماره\s*تماس$/i, 2],
 [/^چت\s*و\s*تماس$/i, 3],
 [/تماس\s*با\s*آگهی.?دهنده/i, 4],
 [/اطلاعات\s*تماس/i, 5]
 ];


 const count = await controls.count();
 for (let i = 0; i < count; i++) {
 const node = controls.nth(i);
 if (!await node.isVisible().catch(() => false)) continue;
 const text = cleanText(
 await node.innerText().catch(() => '') ||
 await node.getAttribute('aria-label').catch(() => '') ||
 await node.getAttribute('title').catch(() => '') ||
 ''
 );
 if (!text || /پشتیبانی|گزارش|اشتراک|نشان/i.test(text)) continue;


 for (const [pattern, score] of priorities) {
 if (pattern.test(text)) {
 candidates.push({ node, text, score, index: i });
 break;
 }
 }
 }


 candidates.sort((a, b) => a.score - b.score || a.index - b.index);
 for (const candidate of candidates) {
 try {
 await candidate.node.scrollIntoViewIfNeeded().catch(() => {});
 await candidate.node.click({ timeout: 4000 });
 return { clicked: true, text: candidate.text };
 } catch {
 try {
 await candidate.node.click({ timeout: 2500, force: true });
 return { clicked: true, text: candidate.text };
 } catch {
 // Try the next candidate.
 }
 }
 }


 return { clicked: false, text: '' };
}


async function renderedContactExists(page) {
 return await page.evaluate(() => {
 const fa = '۰۱۲۳۴۵۶۷۸۹', ar = '٠١٢٣٤٥٦٧٨٩';
 const text = (document.body?.innerText || '').replace(/[۰-۹٠-٩]/g, ch => fa.includes(ch) ? String(fa.indexOf(ch)) : String(ar.indexOf(ch)));
 return Boolean(
 document.querySelector('a[href^="tel:"], a[href^="mailto:"]') ||
 /(?:^|\D)0?9(?:[\s\-().]*\d){9}(?:\D|$)/.test(text) ||
 /(?:^|\D)0?28(?:[\s\-().]*\d){7,8}(?:\D|$)/.test(text)
 );
 }).catch(() => false);
}


async function saveDivarContactDiagnostics(page, sourceUrl, data, reveal) {
 const directory = 'divar-contact-diagnostics';
 await mkdir(directory, { recursive: true });


 const id = (sourceId(sourceUrl, 'divar') || `divar-${Date.now()}`)
 .replace(/[^a-z0-9_-]+/gi, '-')
 .slice(0, 90);
 const prefix = `${directory}/${id}`;


 await page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {});
 await writeFile(`${prefix}.html`, await page.content().catch(() => ''), 'utf8').catch(() => {});
 await writeFile(`${prefix}.json`, JSON.stringify({
 crawler_version: '0.3.28',
 source_url: sourceUrl,
 current_url: page.url(),
 title: data.title,
 clicked: reveal.clicked,
 contact_available: reveal.contactAvailable,
 login_required: reveal.loginRequired,
 network_response_count: reveal.networkResponseCount,
 contact_text_excerpt: cleanText(reveal.contactText).slice(0, 5000),
 network_text_excerpt: cleanText(reveal.networkText).slice(0, 10000),
 visible_page_text_excerpt: cleanText(await page.locator('body').innerText().catch(() => '')).slice(0, 15000)
 }, null, 2), 'utf8');


 console.log(`Divar contact diagnostics saved: ${prefix}`);
}


async function divarLoginRequired(page) {
 const body = cleanText(await page.locator('body').innerText().catch(() => ''));
 const inputs = page.locator('input');
 let loginInputVisible = false;


 for (let i = 0; i < await inputs.count(); i++) {
 const input = inputs.nth(i);
 if (!await input.isVisible().catch(() => false)) continue;
 const attrs = cleanText([
 await input.getAttribute('type').catch(() => ''),
 await input.getAttribute('name').catch(() => ''),
 await input.getAttribute('placeholder').catch(() => ''),
 await input.getAttribute('aria-label').catch(() => ''),
 await input.getAttribute('autocomplete').catch(() => '')
 ].join(' '));
 if (/tel|phone|mobile|شماره|موبایل/i.test(attrs)) {
 loginInputVisible = true;
 break;
 }
 }


 return Boolean(
 loginInputVisible &&
 /ورود\s*به\s*حساب|شماره\s*موبایل\s*خود\s*را\s*وارد|کد\s*تایید\s*به\s*این\s*شماره/i.test(body)
 );
}


async function extractJob(page, source) {
 return await page.evaluate(({ source }) => {
 const clean = value => String(value || '')
 .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
 .replace(/\s+/g, ' ')
 .trim();

 // IMPORTANT: page.evaluate() runs in the browser context. Any helper used
 // below must be declared inside this callback and cannot reference Node-side
 // functions. Keep Persian/Arabic digit normalization local to this scope.
 const toEnglishDigitsLocal = value => String(value || '').replace(/[۰-۹٠-٩]/g, ch => {
   const p = '۰۱۲۳۴۵۶۷۸۹'.indexOf(ch);
   if (p >= 0) return String(p);
   const a = '٠١٢٣٤٥٦٧٨٩'.indexOf(ch);
   return a >= 0 ? String(a) : ch;
 });

 const normalizeLabel = value => clean(value)
 .replace(/[：:]+$/g, '')
 .replace(/\s+/g, ' ')
 .trim();

 const firstText = selectors => {
   for (const selector of selectors) {
     const node = document.querySelector(selector);
     const value = clean(node?.innerText || node?.textContent || '');
     if (value) return value;
   }
   return '';
 };

 // Parse JobPosting JSON-LD before touching generic page text.
 let jobPosting = {};
 for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
   try {
     const parsed = JSON.parse(node.textContent || '{}');
     const rows = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.['@graph']) ? parsed['@graph'] : [parsed]);
     const found = rows.find(row => {
       const type = row?.['@type'];
       return type === 'JobPosting' || (Array.isArray(type) && type.includes('JobPosting'));
     });
     if (found) { jobPosting = found; break; }
   } catch {}
 }

 let title = clean(
   document.querySelector('h1')?.innerText ||
   jobPosting?.title ||
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

 const rawBodyText = String(document.body?.innerText || document.body?.textContent || '');
 const bodyText = clean(rawBodyText);
 const bodyLines = rawBodyText.split(/\n+/).map(clean).filter(Boolean);
 const contentText = clean(root?.innerText || root?.textContent || bodyText);
 const contentHtml = root?.innerHTML || '';

 // E-Estekhdam renders several important facts as compact label/value chips.
 // Read exact adjacent lines before falling back to generic DOM heuristics.
 const lineValueAfter = (labels) => {
   const wanted = Array.isArray(labels) ? labels : [labels];
   for (let i = 0; i < bodyLines.length - 1; i++) {
     if (wanted.includes(normalizeLabel(bodyLines[i]))) {
       const value = clean(bodyLines[i + 1]);
       if (value && value.length <= 300) return value;
     }
   }
   return '';
 };
 const sectionLines = (startLabels, stopLabels) => {
   const starts = Array.isArray(startLabels) ? startLabels : [startLabels];
   const stops = Array.isArray(stopLabels) ? stopLabels : [stopLabels];
   let start = -1;
   for (let i = 0; i < bodyLines.length; i++) {
     if (starts.includes(normalizeLabel(bodyLines[i]))) { start = i + 1; break; }
   }
   if (start < 0) return '';
   const out = [];
   for (let i = start; i < bodyLines.length; i++) {
     const label = normalizeLabel(bodyLines[i]);
     if (stops.includes(label)) break;
     if (bodyLines[i]) out.push(bodyLines[i]);
     if (out.length >= 24) break;
   }
   return clean(out.join(' • '));
 };

 // Build a conservative label/value map. Only short, local rows are accepted,
 // which prevents "similar jobs" cards from becoming job facts.
 const labelValues = {};
 const knownLabels = [
   'نوع همکاری','نوع قرارداد','نحوه حضور','حقوق','حقوق ماهانه','بازه حقوق','سابقه کار','سابقه',
   'تحصیلات','حداقل تحصیلات','رشته تحصیلی','جنسیت','سن','بازه سنی','وضعیت سربازی',
   'تعداد نیروی مورد نیاز','تعداد نیروی موردنیاز','تعداد نفر','سطح شغلی','شیفت کاری',
   'ساعات کاری','ساعت کاری','روزهای کاری','بیمه','محل کار','موقعیت مکانی','آدرس',
   'مزایا','تسهیلات و مزایا','سایر مزایا','مهارت‌ها','مهارت های مورد نیاز','مهارت‌های مورد نیاز','شرح وظایف','شرایط احراز',
   'حوزه فعالیت','نام شرکت','نام مجموعه','مهلت ارسال رزومه','مهلت درخواست','زمان شروع همکاری','زمان‌بندی جذب',
   'دوره آزمایشی','اضافه کاری','اضافه‌کاری','مراحل مصاحبه','روش مصاحبه','مهارت‌های رفتاری','مهارت های رفتاری',
   'امکان همکاری با افراد دارای معلولیت','محیط اصلی کار','محیط کار','مدارک لازم برای درخواست','مدارک مورد نیاز',
   'حداقل مدرک تحصیلی','مدرک تحصیلی'
 ];
 const candidates = Array.from(root?.querySelectorAll?.('tr,li,dl,div,p,section') || []);
 for (const node of candidates) {
   const text = clean(node.innerText || node.textContent || '');
   if (!text || text.length > 800) continue;
   const children = Array.from(node.children || []).map(ch => clean(ch.innerText || ch.textContent || '')).filter(Boolean);
   if (children.length >= 2 && children.length <= 6) {
     const label = normalizeLabel(children[0]);
     const matched = knownLabels.find(k => label === k || label.startsWith(`${k} `));
     if (matched) {
       const value = clean(children.slice(1).join(' '));
       if (value && value !== label && value.length <= 500 && !labelValues[matched]) labelValues[matched] = value;
     }
   }
   const colon = text.match(/^([^:：]{2,40})[:：]\s*(.{1,500})$/);
   if (colon) {
     const label = normalizeLabel(colon[1]);
     const matched = knownLabels.find(k => label === k || label.startsWith(`${k} `));
     if (matched && !labelValues[matched]) labelValues[matched] = clean(colon[2]);
   }
 }

 // Source-specific exact facts for E-Estekhdam. These values come from
 // the ad fact chips/sections, not from similar-job cards or page-wide guesses.
 if (source === 'e-estekhdam') {
   const exactPairs = {
     'استان': lineValueAfter('استان'),
     'شهر': lineValueAfter('شهر'),
     'جنسیت': lineValueAfter('جنسیت'),
     'سابقه کار': lineValueAfter('سابقه کار'),
     'نوع همکاری': lineValueAfter('نوع همکاری'),
     'نحوه حضور': lineValueAfter('نحوه حضور'),
     'حقوق ماهانه': lineValueAfter(['حقوق ماهانه','حقوق']),
     'حداقل تحصیلات': lineValueAfter(['حداقل تحصیلات','حداقل مدرک تحصیلی','مدرک تحصیلی','تحصیلات']),
     'رشته تحصیلی': lineValueAfter('رشته تحصیلی'),
     'نوع قرارداد': lineValueAfter('نوع قرارداد'),
     'شیفت کاری': lineValueAfter('شیفت کاری'),
     'ساعات کاری': lineValueAfter(['ساعات کاری','ساعت کاری']),
     'روزهای کاری': lineValueAfter('روزهای کاری'),
     'تعداد نیروی مورد نیاز': lineValueAfter(['تعداد نیروی مورد نیاز','تعداد نیروی موردنیاز','تعداد نفر']),
     'سطح شغلی': lineValueAfter('سطح شغلی'),
     'وضعیت سربازی': lineValueAfter('وضعیت سربازی'),
     'بازه سنی': lineValueAfter(['بازه سنی','سن']),
     'دوره آزمایشی': lineValueAfter('دوره آزمایشی'),
     'اضافه‌کاری': lineValueAfter(['اضافه‌کاری','اضافه کاری']),
     'مراحل مصاحبه': lineValueAfter(['مراحل مصاحبه','روش مصاحبه']),
     'مهلت ارسال رزومه': lineValueAfter(['مهلت ارسال رزومه','مهلت درخواست']),
     'مهارت‌های رفتاری': lineValueAfter(['مهارت‌های رفتاری','مهارت های رفتاری']),
     'امکان همکاری با افراد دارای معلولیت': lineValueAfter('امکان همکاری با افراد دارای معلولیت'),
     'محیط اصلی کار': lineValueAfter(['محیط اصلی کار','محیط کار']),
     'مدارک لازم برای درخواست': lineValueAfter(['مدارک لازم برای درخواست','مدارک مورد نیاز'])
   };
   for (const [k,v] of Object.entries(exactPairs)) if (v && !labelValues[k]) labelValues[k] = v;
   const req = sectionLines(['شرایط احراز'], ['تسهیلات و مزایا','سایر مزایا','محل کار','اطلاعات تماس']);
   const benefitsPrimary = sectionLines(['تسهیلات و مزایا'], ['سایر مزایا','محل کار','اطلاعات تماس','آگهی‌های استخدام مشابه','آگهی های استخدام مشابه']);
   const benefitsOther = sectionLines(['سایر مزایا'], ['محل کار','اطلاعات تماس','آگهی‌های استخدام مشابه','آگهی های استخدام مشابه']);
   const benefitsSection = clean([...new Set([benefitsPrimary, benefitsOther].filter(Boolean))].join(' • '));
   const locationSection = sectionLines(['محل کار'], ['اطلاعات تماس','آگهی‌های استخدام مشابه','آگهی های استخدام مشابه']);
   if (req && !labelValues['شرایط احراز']) labelValues['شرایط احراز'] = req;
   if (benefitsSection && !labelValues['مزایا']) labelValues['مزایا'] = benefitsSection;
   if (locationSection && !labelValues['محل کار']) labelValues['محل کار'] = locationSection;
   const addressLine = bodyLines.find(line => /^آدرس\s*[:：]/u.test(line));
   if (addressLine && !labelValues['آدرس']) labelValues['آدرس'] = clean(addressLine.replace(/^آدرس\s*[:：]\s*/u,''));
 }

 const jsonAddress = jobPosting?.jobLocation?.address || jobPosting?.jobLocation?.[0]?.address || {};
 const cityExact = clean(
   labelValues['شهر'] ||
   jsonAddress?.addressLocality ||
   jsonAddress?.addressRegion ||
   labelValues['موقعیت مکانی'] ||
   labelValues['محل کار'] ||
   ''
 );
 const companyName = clean(
   jobPosting?.hiringOrganization?.name ||
   labelValues['نام شرکت'] ||
   labelValues['نام مجموعه'] ||
   ''
 );
 const sourceCategory = clean(
   jobPosting?.occupationalCategory ||
   firstText([
     '[class*="job-category"]','[class*="category"] [class*="active"]',
     'nav[aria-label*="breadcrumb" i] a:nth-last-of-type(2)',
     '[class*="breadcrumb" i] a:nth-last-of-type(2)'
   ])
 );

 const metaDescription = clean(
   document.querySelector('meta[property="og:description"]')?.content ||
   document.querySelector('meta[name="description"]')?.content ||
   ''
 );
 // locationText is diagnostic only in 0.3.18. It is never used as the primary
 // city source because generic body/breadcrumb text can include other cities.
 const locationText = clean(`${cityExact} ${labelValues['آدرس'] || ''} ${metaDescription}`);

 const markerRegex = /اطلاعات تماس|نحوه ارتباط|راه ارتباطی|شماره تماس|موبایل|تلفن|چت و تماس/i;
 const directContactEvidence = /(?:^|\D)(?:0?9(?:[\s\-().]*\d){9}|0?28(?:[\s\-().]*\d){7,8})(?!\d)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
 const markerNodes = Array.from(document.querySelectorAll('h1,h2,h3,h4,strong,b,p,span,div,section,button,a'));
 let contactRoot = null;
 let bestContactScore = -1;
 for (const node of markerNodes) {
   const own = clean(node.innerText || node.textContent || '');
   if (!markerRegex.test(own) || own.length > 350) continue;
   // The marker itself is often only the heading. Start from its parent and
   // choose the smallest nearby container that actually contains a phone/email.
   let current = node.parentElement || node;
   for (let i = 0; i < 5 && current; i++, current = current.parentElement) {
     const text = clean(current.innerText || current.textContent || '');
     if (text.length < 8 || text.length > 7000) continue;
     const links = Array.from(current.querySelectorAll?.('a[href]') || [], a => a.href || '').join(' ');
     const evidence = directContactEvidence.test(toEnglishDigitsLocal(`${text} ${links}`));
     const score = (evidence ? 10000 : 0) - text.length;
     if (score > bestContactScore) { bestContactScore = score; contactRoot = current; }
     if (evidence && text.length < 1800) break;
   }
 }
 if (!contactRoot) contactRoot = root;

 const scopedContactText = clean(contactRoot?.innerText || contactRoot?.textContent || '');
 const globalContactLinks = Array.from(document.querySelectorAll(
   'a[href^="tel:"], a[href^="mailto:"], a[href*="wa.me/"], a[href*="whatsapp"], a[href*="t.me/"]'
 ), a => a.href);
 const scopedLinks = Array.from(contactRoot?.querySelectorAll?.('a[href]') || [], a => a.href);
 const contactLinks = [...new Set([...scopedLinks, ...globalContactLinks])];
 const contactText = source === 'divar'
      ? clean(`${scopedContactText} ${bodyText}`)
      : source === 'e-estekhdam'
        ? clean(`${scopedContactText} ${sectionLines(['اطلاعات تماس'], ['آگهی‌های استخدام مشابه','آگهی های استخدام مشابه'])} ${bodyText}`)
        : scopedContactText;

 const publishedAt = clean(
   jobPosting?.datePosted ||
   document.querySelector('meta[property="article:published_time"]')?.content ||
   ''
 );

 const structured = {
   city_name: cityExact,
   source_city: cityExact,
   source_category: sourceCategory,
   company_name: companyName,
   company_activity: labelValues['حوزه فعالیت'] || clean(jobPosting?.industry || ''),
   cooperation_type: labelValues['نوع همکاری'] || clean(jobPosting?.employmentType || ''),
   contract_type: labelValues['نوع قرارداد'] || '',
   workplace_mode: labelValues['نحوه حضور'] || '',
   salary_range: labelValues['بازه حقوق'] || labelValues['حقوق ماهانه'] || labelValues['حقوق'] || '',
   experience_years: labelValues['سابقه کار'] || labelValues['سابقه'] || labelValues['شرایط احراز'] || clean(jobPosting?.experienceRequirements || ''),
   education_level: labelValues['حداقل تحصیلات'] || labelValues['تحصیلات'] || clean(jobPosting?.educationRequirements || ''),
   study_field: labelValues['رشته تحصیلی'] || '',
   gender_preference: labelValues['جنسیت'] || '',
   age_range: labelValues['بازه سنی'] || labelValues['سن'] || '',
   military_status: labelValues['وضعیت سربازی'] || '',
   vacancy_count: labelValues['تعداد نیروی مورد نیاز'] || labelValues['تعداد نیروی موردنیاز'] || labelValues['تعداد نفر'] || '',
   seniority_level: labelValues['سطح شغلی'] || '',
   preferred_shift: labelValues['شیفت کاری'] || '',
   work_days: labelValues['روزهای کاری'] || '',
   work_hours: labelValues['ساعات کاری'] || labelValues['ساعت کاری'] || '',
   trial_period: labelValues['دوره آزمایشی'] || '',
   overtime: labelValues['اضافه‌کاری'] || labelValues['اضافه کاری'] || '',
   interview_method: labelValues['مراحل مصاحبه'] || labelValues['روش مصاحبه'] || '',
   insurance: labelValues['بیمه'] || '',
   address_detail: labelValues['آدرس'] || labelValues['محل کار'] || '',
   benefits_description: labelValues['تسهیلات و مزایا'] || labelValues['مزایا'] || labelValues['سایر مزایا'] || '',
   technical_skills: labelValues['مهارت‌ها'] || labelValues['مهارت های مورد نیاز'] || labelValues['مهارت‌های مورد نیاز'] || labelValues['شرایط احراز'] || '',
   soft_skills: labelValues['مهارت‌های رفتاری'] || labelValues['مهارت های رفتاری'] || '',
   disability_support: labelValues['امکان همکاری با افراد دارای معلولیت'] || '',
   work_environment: labelValues['محیط اصلی کار'] || labelValues['محیط کار'] || '',
   required_documents: labelValues['مدارک لازم برای درخواست'] || labelValues['مدارک مورد نیاز'] || '',
   responsibilities: labelValues['شرح وظایف'] || '',
   requirements: labelValues['شرایط احراز'] || '',
   application_deadline: labelValues['مهلت ارسال رزومه'] || labelValues['مهلت درخواست'] || '',
   hiring_timeline: labelValues['زمان‌بندی جذب'] || labelValues['زمان شروع همکاری'] || '',
   job_description: clean(jobPosting?.description || '')
 };

 return {
   title, contentText, contentHtml, contactText, contactLinks, publishedAt,
   locationText, cityExact, sourceCategory, companyName, labelValues, structured
 };
 }, { source });
}

async function loadHubControlState() {
 const statusEndpoint = deriveStatusEndpoint(ENDPOINT);
 if (!statusEndpoint) return { active: false };
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 12000);
 try {
  const response = await fetch(statusEndpoint, {
   headers: { 'X-QZIH-Token': TOKEN, 'User-Agent': 'QazvinJobsImportCrawler/0.3.28' },
   signal: controller.signal
  });
  if (!response.ok) return { active: false };
  const json = await response.json();
  return json?.controlled_test || { active: false };
 } catch (error) {
  console.warn(`WordPress controlled-test status unavailable: ${error.message}`);
  return { active: false };
 } finally {
  clearTimeout(timer);
 }
}

function deriveStatusEndpoint(batchEndpoint) {
 try {
  const u = new URL(batchEndpoint);
  u.pathname = u.pathname.replace(/\/batch\/?$/, '/status');
  return u.toString();
 } catch {
  return '';
 }
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
 'User-Agent': 'QazvinJobsImportCrawler/0.3.28'
 },
 body: JSON.stringify({ source: 'multi', crawler_version: '0.3.28', items }),
 signal: controller.signal
 });
 const body = await response.text();
 if (!response.ok) throw new Error(`WordPress receiver HTTP ${response.status}: ${body.slice(0, 1000)}`);
 console.log(`WordPress receiver accepted batch: ${body}`);
 } finally {
 clearTimeout(timer);
 }
}


async function sendDiagnostics(diagnostics) {
 const controller = new AbortController();
 const timer = setTimeout(() => controller.abort(), 20000);
 try {
 const response = await fetch(ENDPOINT, {
 method: 'POST',
 headers: {
 'Content-Type': 'application/json',
 'X-QZIH-Token': TOKEN,
 'User-Agent': 'QazvinJobsImportCrawler/0.3.28'
 },
 body: JSON.stringify({ source: 'multi', crawler_version: '0.3.28', items: [], diagnostics }),
 signal: controller.signal
 });
 const body = await response.text();
 if (!response.ok) throw new Error(`Diagnostics receiver HTTP ${response.status}: ${body.slice(0, 1000)}`);
 console.log(`Crawler diagnostics saved in WordPress: ${body}`);
 } finally {
 clearTimeout(timer);
 }
}


async function loadDivarAuthState() {
 if (!DIVAR_AUTH_SESSION_ENDPOINT) return { state: null, status: 'endpoint_missing' };
 try {
 const response = await fetch(DIVAR_AUTH_SESSION_ENDPOINT, {
 headers: { 'X-QZIH-Token': TOKEN, 'User-Agent': 'QazvinJobsImportCrawler/0.3.28' }
 });
 const body = await response.text();
 if (!response.ok) {
 console.warn(`Divar auth session unavailable: HTTP ${response.status}`);
 return { state: null, status: response.status === 404 ? 'missing' : 'unavailable' };
 }
 const json = JSON.parse(body);
 if (!json?.storage_state?.cookies) return { state: null, status: 'invalid' };
 console.log(`Divar authenticated state loaded (${json.storage_state.cookies.length} cookies).`);
 return { state: json.storage_state, status: 'connected' };
 } catch (error) {
 console.warn(`Divar auth session load failed: ${error.message}`);
 return { state: null, status: 'error' };
 }
}
function deriveDivarAuthEndpoint(batchEndpoint, action) {
 try {
 const u = new URL(batchEndpoint);
 u.pathname = u.pathname.replace(/\/batch\/?$/, `/divar-auth/${action}`);
 return u.toString();
 } catch { return ''; }
}


function clamp(value, min, max, fallback) {
 const parsed = Number.parseInt(value || '', 10);
 return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}
function elapsed(started) { return `${((Date.now() - started) / 1000).toFixed(1)}s`; }
function cleanUrl(url) {
 try {
 const u = new URL(url);
 u.hash = '';
 if (detectSource(u.toString()) === 'divar' && /^\/v\//i.test(u.pathname)) u.search = '';
 return u.toString();
 } catch { return url; }
}
function canonicalSourceUrl(originalUrl, currentUrl, source = detectSource(originalUrl)) {
 for (const candidate of [currentUrl, originalUrl]) {
 if (detectSource(candidate) === source && isJobUrl(candidate, source)) return cleanUrl(candidate);
 }
 return cleanUrl(originalUrl);
}
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
 if (source === 'divar') return /(^|\.)divar\.ir$/i.test(u.hostname) && /^\/v\/[^/?#]+(?:\/[^/?#]+)?\/?$/iu.test(u.pathname);
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
 const parts = decodeURIComponent(u.pathname).split('/').filter(Boolean).filter(part => part.toLowerCase() !== 'v');
 const token = [...parts].reverse().find(part => /^[a-z0-9_-]{5,}$/i.test(part));
 if (token) return `divar-${token.toLowerCase()}`;
 return `divar-url-${createHash('sha256').update(cleanUrl(url)).digest('hex').slice(0, 20)}`;
 }
 return '';
}
function cleanText(value) { return String(value || '').replace(/[\u200c\u200f\u202a-\u202e]/g, ' ').replace(/\s+/g, ' ').trim(); }
function toEnglishDigits(value) { return String(value || '').replace(/[۰-۹٠-٩]/g, ch => '۰۱۲۳۴۵۶۷۸۹'.includes(ch) ? String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)) : String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch))); }
function detectCity(text) {
 const normalized = cleanText(text).replace(/ي/g,'ی').replace(/ك/g,'ک');
 const matches = cities.filter(city => normalized.includes(city.replace('بوئین زهرا','بوئین‌زهرا')) || normalized.includes(city));
 return matches.length === 1 ? matches[0].replace('بوئین زهرا','بوئین‌زهرا') : '';
}

function normalizeCityCandidate(value) {
 const normalized = cleanText(value).replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/بوئین زهرا/g,'بوئین‌زهرا');
 if (!normalized) return '';
 const exact = cities.find(city => cleanText(city).replace(/بوئین زهرا/g,'بوئین‌زهرا') === normalized);
 if (exact) return exact.replace('بوئین زهرا','بوئین‌زهرا');
 const explicit = normalized.match(/(?:شهر|محل\s*کار|موقعیت)\s*[:：\-]?\s*([^،؛|]{2,40})/);
 if (explicit) {
   const found = cities.find(city => explicit[1].includes(city.replace('بوئین زهرا','بوئین‌زهرا')));
   if (found) return found.replace('بوئین زهرا','بوئین‌زهرا');
 }
 const matches = cities.filter(city => normalized.includes(city.replace('بوئین زهرا','بوئین‌زهرا')));
 return matches.length === 1 ? matches[0].replace('بوئین زهرا','بوئین‌زهرا') : '';
}

function cityFromTitle(title) {
 const normalized = cleanText(title).replace(/بوئین زهرا/g,'بوئین‌زهرا');
 // Prefer the final "در <city>" phrase used by E-Estekhdam H1.
 for (const rawCity of [...cities].sort((a,b) => b.length - a.length)) {
   const city = rawCity.replace('بوئین زهرا','بوئین‌زهرا');
   const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   const re = new RegExp(`(?:^|\\s)در\\s+${escaped}(?:\\s|$|[-–|،])`, 'u');
   if (re.test(`${normalized} `)) return city;
 }
 return '';
}

function resolveCityFromData(data, source, url) {
 const exact = normalizeCityCandidate(data?.cityExact || data?.structured?.city_name || data?.structured?.source_city || '');
 if (exact) return { city: exact, source: 'structured_location' };
 const fromTitle = cityFromTitle(data?.title || '');
 if (fromTitle) return { city: fromTitle, source: 'title_h1' };
 const fallback = sourceCityFallback(source, url);
 if (fallback) return { city: fallback, source: 'feed' };
 return { city: '', source: 'none' };
}

function sourceCityFallback(source, url) {
 if (source !== 'divar') return '';
 try {
 const search = new URL(SOURCES.divar.searchUrl);
 const isQazvinJobsFeed = /^\/s\/qazvin\/jobs\/?$/i.test(search.pathname);
 const candidate = new URL(url);
 const isDivarAd = /(^|\.)divar\.ir$/i.test(candidate.hostname) && /^\/v\//i.test(candidate.pathname);
 return isQazvinJobsFeed && isDivarAd ? 'قزوین' : '';
 } catch {
 return '';
 }
}

function normalizeCooperation(value) {
 const t = cleanText(value).toLowerCase();
 if (!t) return '';
 if (/full.?time|تمام\s*وقت|تمام‌وقت/.test(t)) return 'تمام‌وقت';
 if (/part.?time|پاره\s*وقت|پاره‌وقت/.test(t)) return 'پاره‌وقت';
 if (/intern|کارآموز/.test(t)) return 'کارآموزی';
 if (/contract|project|پروژه|پیمانکار/.test(t)) return 'پروژه‌ای / پیمانکاری';
 if (/shift|شیفت/.test(t)) return 'شیفتی';
 if (/hour|day|ساعتی|روزانه/.test(t)) return 'ساعتی / روزانه';
 return '';
}

function normalizeWorkplaceMode(value) {
 const t = cleanText(value);
 if (/دورکار|remote/i.test(t)) return 'دورکاری';
 if (/ترکیبی|هیبرید|hybrid/i.test(t)) return 'ترکیبی';
 if (/حضوری|on.?site/i.test(t)) return 'حضوری';
 return '';
}

function normalizeGender(value) {
 const t = cleanText(value);
 if (/آقا|مرد/.test(t) && !/خانم|زن/.test(t)) return 'آقا';
 if (/خانم|زن/.test(t) && !/آقا|مرد/.test(t)) return 'خانم';
 if (/مهم\s*نیست|فرقی\s*ندارد|آقا\s*و\s*خانم|خانم\s*و\s*آقا/.test(t)) return 'مهم نیست';
 return '';
}

function normalizeEducation(value) {
 const t = cleanText(value);
 if (!t) return '';
 if (/مهم\s*نیست|فرقی\s*ندارد/.test(t)) return 'مهم نیست';
 if (/دکتری|phd/i.test(t)) return 'دکتری';
 if (/کارشناسی\s*ارشد|فوق\s*لیسانس|master/i.test(t)) return 'کارشناسی ارشد';
 if (/کارشناسی|لیسانس|bachelor/i.test(t)) return 'کارشناسی';
 if (/کاردانی|فوق\s*دیپلم|associate/i.test(t)) return 'کاردانی';
 if (/دیپلم/.test(t)) return 'دیپلم';
 if (/سیکل|زیر\s*دیپلم/.test(t)) return 'زیر دیپلم';
 return '';
}

function normalizeExperience(value) {
 const t = cleanText(value);
 if (!t) return '';
 if (/بدون\s*(?:نیاز\s*به\s*)?سابقه|مهم\s*نیست/.test(t)) return 'بدون نیاز به سابقه';
 const wordNums = { 'نیم':'0.5', 'یک':'1', 'دو':'2', 'سه':'3', 'چهار':'4', 'پنج':'5', 'شش':'6', 'هفت':'7', 'هشت':'8', 'نه':'9', 'ده':'10' };
 let latin = toEnglishDigits(t);
 latin = latin.replace(/(?:حداقل\s*)?(نیم|یک|دو|سه|چهار|پنج|شش|هفت|هشت|نه|ده)\s*سال/g, (m,w) => m.replace(w, wordNums[w]));
 const range = latin.match(/(\d+(?:\.\d+)?)\s*(?:تا|-)\s*(\d+(?:\.\d+)?)\s*سال/);
 const single = latin.match(/(?:حداقل\s*)?(\d+(?:\.\d+)?)\s*سال/);
 const max = range ? Number(range[2]) : (single ? Number(single[1]) : NaN);
 if (!Number.isFinite(max)) return '';
 if (max < 1) return 'کمتر از ۱ سال';
 if (max <= 2) return '۱ تا ۲ سال';
 if (max <= 3) return '۲ تا ۳ سال';
 if (max <= 5) return '۳ تا ۵ سال';
 if (max <= 8) return '۵ تا ۸ سال';
 return 'بیشتر از ۸ سال';
}

function extractSoftwareTools(text) {
 const t = cleanText(text);
 if (!t) return '';
 const out = [];
 const add = v => { const x = cleanText(v).replace(/^(?:نرم\s*افزار|نرم‌افزار)\s*/u,'').replace(/(?:حداقل|سابقه|سال|مرتبط).*$/u,'').trim(); if (x && x.length <= 80 && !out.includes(x)) out.push(x); };
 const known = [
   ['هلو', /(?:^|\s)هلو(?:\s|$|[،؛,.])/u], ['سپیدار', /سپیدار/u], ['راهکاران', /راهکاران/u],
   ['Excel', /(?:excel|اکسل)/iu], ['Word', /(?:word|ورد)/iu], ['PowerPoint', /(?:powerpoint|پاورپوینت)/iu],
   ['CRM', /(?:crm|سی\s*آر\s*ام)/iu], ['اتوماسیون اداری', /اتوماسیون\s*اداری/u]
 ];
 for (const [label,re] of known) if (re.test(t)) add(label);
 const patterns = [
   /(?:مسلط|آشنا)\s*(?:به)?\s*(?:نرم\s*افزار|نرم‌افزار)\s*([^،؛.\n]{2,60})/gu,
   /(?:نرم\s*افزار|نرم‌افزار)\s*(?:های)?\s*(?:مورد\s*نیاز)?\s*[:：]?\s*([^،؛.\n]{2,60})/gu
 ];
 for (const re of patterns) { let m; while ((m=re.exec(t))) add(m[1]); }
 return out.join('، ');
}

function normalizeInsurance(value) {
 const t = cleanText(value);
 if (!t) return '';
 if (/از\s*روز\s*اول/.test(t)) return 'بیمه از روز اول';
 if (/پس\s*از.*آزمایش/.test(t)) return 'بیمه پس از دوره آزمایشی';
 if (/ندارد|بدون\s*بیمه|فاقد\s*بیمه/.test(t)) return 'بیمه ندارد';
 if (/قابل\s*مذاکره|توافق/.test(t)) return 'قابل مذاکره';
 // Supplementary insurance alone is a benefit, not proof of base insurance.
 const base = t.replace(/بیمه\s*تکمیلی/g,' ');
 if (/(?:^|[\s،؛•])بیمه(?:\s+(?:تأمین|تامین)\s+اجتماعی|\s+دارد)?(?:$|[\s،؛•])/.test(base)) return 'بیمه دارد';
 return '';
}

function normalizeBenefits(text) {
 const t = cleanText(text);
 const out = [];
 const add = (cond, value) => { if (cond && !out.includes(value)) out.push(value); };
 add(/بیمه\s*تکمیلی/.test(t),'بیمه تکمیلی');
 add(/پاداش/.test(t),'پاداش');
 add(/پورسانت|درصدی/.test(t),'پورسانت');
 add(/سرویس\s*(?:رفت\s*و\s*برگشت|رفت‌وبرگشت)/.test(t),'سرویس رفت‌وبرگشت');
 add(/صبحانه/.test(t),'صبحانه');
 add(/ناهار|غذا|وعده/.test(t),'ناهار / غذا');
 add(/جای\s*خواب|خوابگاه/.test(t),'جای خواب');
 add(/وام/.test(t),'وام');
 add(/آموزش\s*(?:رایگان|حین\s*کار)/.test(t),'آموزش رایگان');
 add(/ساعت.*منعطف|ساعات.*منعطف/.test(t),'ساعت کاری منعطف');
 add(/هدایای\s*مناسبتی|هدیه\s*مناسبتی|هدایای?\s*مناسبت/.test(t),'هدایا و مناسبت‌ها');
 add(/پزشک\s*سازمانی|پزشک\s*شرکت/.test(t),'پزشک سازمانی');
 add(/پارکینگ/.test(t),'پارکینگ');
 add(/بن\s*(?:خرید|کالا)|بسته\s*خرید/.test(t),'بن / بسته خرید');
 add(/کمک.?هزینه\s*درمان/.test(t),'کمک‌هزینه درمان');
 add(/بیمه\s*عمر/.test(t),'بیمه عمر');
 add(/کمک.?هزینه\s*رفت.*آمد/.test(t),'کمک‌هزینه رفت‌وآمد');
 return out;
}

function explicitInsuranceFromBenefits(value) {
 const t = cleanText(value);
 if (!t) return '';
 if (/بیمه\s+از\s+روز\s+اول/.test(t)) return 'بیمه از روز اول';
 if (/بیمه\s+پس\s+از\s+(?:دوره\s+)?آزمایشی/.test(t)) return 'بیمه پس از دوره آزمایشی';
 if (/(?:بدون|فاقد)\s+بیمه|بیمه\s+ندارد/.test(t)) return 'بیمه ندارد';
 const base = t.replace(/بیمه\s*تکمیلی/g,' ');
 if (/(?:^|[\s،؛•])بیمه(?:\s+(?:تأمین|تامین)\s+اجتماعی|\s+دارد)?(?:$|[\s،؛•])/.test(base)) return 'بیمه دارد';
 return '';
}

function normalizeShiftList(value) {
 const t = cleanText(value);
 if (!t) return [];
 const out = [];
 const add = (re,v) => { if (re.test(t) && !out.includes(v)) out.push(v); };
 add(/صبح/,'صبح'); add(/عصر/,'عصر'); add(/شب/,'شب'); add(/چرخشی|گردشی/,'چرخشی'); add(/شناور/,'شناور'); add(/آخر\s*هفته|پنجشنبه.*جمعه/,'آخر هفته');
 return out;
}

function normalizeWorkDaysList(value) {
 const t = cleanText(value);
 if (!t) return [];
 const days = ['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه'];
 const out = [];
 const add = d => { if (!out.includes(d)) out.push(d); };
 for (const d of days) if (t.includes(d)) add(d);
 const range = t.match(/(شنبه|یکشنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنجشنبه|جمعه)\s*(?:تا|-|الی)\s*(شنبه|یکشنبه|دوشنبه|سه‌شنبه|چهارشنبه|پنجشنبه|جمعه)/);
 if (range) {
   const a=days.indexOf(range[1]), b=days.indexOf(range[2]);
   if (a>=0 && b>=0) {
     if (a<=b) for (let i=a;i<=b;i++) add(days[i]);
     else { for (let i=a;i<days.length;i++) add(days[i]); for (let i=0;i<=b;i++) add(days[i]); }
   }
 }
 return out;
}

function normalizeInterviewList(value) {
 const t = cleanText(value);
 if (!t) return [];
 const out=[]; const add=(re,v)=>{if(re.test(t)&&!out.includes(v))out.push(v)};
 add(/تماس\s*اولیه|تماس\s*تلفنی/,'تماس اولیه');
 add(/مصاحبه\s*(?:آنلاین|انلاین|مجازی)/,'مصاحبه آنلاین');
 add(/مصاحبه\s*حضوری/,'مصاحبه حضوری');
 add(/آزمون\s*تخصصی|آزمون\s*فنی/,'آزمون تخصصی');
 add(/تست\s*عملی|آزمون\s*عملی/,'تست عملی');
 add(/استعلام\s*معرف|معرف\s*شغلی/,'استعلام معرف');
 return out;
}

function normalizeSoftSkillsList(value) {
 const t = cleanText(value);
 if (!t) return [];
 const out=[]; const add=(re,v)=>{if(re.test(t)&&!out.includes(v))out.push(v)};
 add(/روابط\s*عمومی|ارتباط\s*(?:موثر|مؤثر)/,'ارتباط مؤثر');
 add(/فن\s*بیان|بیان\s*مناسب|بیان\s*قوی/,'فن بیان');
 add(/خوش.?برخورد|برخورد\s*مناسب/,'خوش‌برخوردی');
 add(/کار\s*تیمی|روحیه\s*تیمی/,'کار تیمی');
 add(/حل\s*مسئله/,'حل مسئله');
 add(/مسئولیت.?پذیر/,'مسئولیت‌پذیری');
 add(/نظم|منظم|انضباط/,'نظم و انضباط');
 add(/پیگیر|پیگیری/,'پیگیری');
 add(/صبر|حوصله|صبور/,'صبر و حوصله');
 add(/مدیریت\s*زمان/,'مدیریت زمان');
 add(/مذاکره/,'مذاکره');
 add(/دقت|توجه\s*به\s*جزئیات/,'دقت و توجه به جزئیات');
 add(/یادگیری\s*سریع/,'یادگیری سریع');
 add(/خلاق/,'خلاقیت');
 add(/رهبری/,'رهبری');
 add(/گزارش.?نویسی/,'گزارش‌نویسی');
 add(/مراجعان|والدین|اولیا/,'تعامل با مراجعان / والدین');
 return out;
}

function normalizeRequiredDocumentsList(value) {
 const t = cleanText(value);
 if (!t) return [];
 const out=[]; const add=(re,v)=>{if(re.test(t)&&!out.includes(v))out.push(v)};
 add(/رزومه/,'رزومه'); add(/نمونه.?کار/,'نمونه‌کار'); add(/مدرک\s*تحصیلی/,'مدرک تحصیلی'); add(/گواهی(?:نامه)?\s*دوره/,'گواهی دوره');
 add(/گواهینامه\s*رانندگی/,'گواهینامه رانندگی'); add(/معرف\s*شغلی/,'معرف شغلی'); add(/کاورلتر|نامه\s*پوششی/,'کاورلتر');
 return out;
}

function normalizeVacancyCount(value) {
 const t = toEnglishDigits(cleanText(value));
 if (!t) return '';
 const n = Number((t.match(/\d+/)||[])[0]);
 if (!Number.isFinite(n)) return '';
 if (n===1) return '۱ نفر'; if (n===2) return '۲ نفر'; if (n===3) return '۳ نفر'; if (n<=5) return '۴ تا ۵ نفر'; if (n<=10) return '۶ تا ۱۰ نفر'; return 'بیشتر از ۱۰ نفر';
}

function normalizeSeniority(value) {
 const t = cleanText(value); if (!t) return '';
 if (/کارآموز/.test(t)) return 'کارآموز'; if (/تازه.?کار|جونیور|junior/i.test(t)) return 'تازه‌کار';
 if (/مدیر\s*ارشد|مدیریت\s*ارشد/.test(t)) return 'مدیر ارشد'; if (/سرپرست/.test(t)) return 'سرپرست'; if (/مدیر/.test(t)) return 'مدیر';
 if (/کارشناس\s*ارشد|senior/i.test(t)) return 'کارشناس ارشد'; if (/کارشناس|mid/i.test(t)) return 'کارشناس'; return '';
}

function normalizeContract(value) {
 const t = cleanText(value); if (!t) return '';
 if (/دائم/.test(t)) return 'قرارداد کار دائم'; if (/موقت/.test(t)) return 'قرارداد کار موقت'; if (/پروژه/.test(t)) return 'قرارداد پروژه‌ای';
 if (/پیمانکار/.test(t)) return 'پیمانکاری'; if (/کارآموز/.test(t)) return 'کارآموزی'; if (/توافق/.test(t)) return 'توافقی'; return '';
}

function normalizeMilitary(value) {
 const t = cleanText(value); if (!t) return '';
 if (/مهم\s*نیست|فرقی\s*ندارد/.test(t)) return 'مهم نیست';
 if (/پایان\s*خدمت|معاف/.test(t)) return 'پایان خدمت / معافیت الزامی';
 if (/امریه/.test(t)) return 'امریه پذیرفته می‌شود';
 if (/مشمول/.test(t)) return 'مشمول هم پذیرفته می‌شود';
 return '';
}

function normalizeAgeRange(value) {
 const t=toEnglishDigits(cleanText(value)); if(!t)return '';
 if(/مهم\s*نیست|فرقی\s*ندارد/.test(t))return 'مهم نیست';
 const m=t.match(/(\d{2})\s*(?:تا|-|الی)\s*(\d{2})/); if(!m)return '';
 const a=Number(m[1]), b=Number(m[2]);
 if(a===18 && b<=24)return '۱۸ تا ۲۴ سال'; if(a>=25&&a<=26&&b<=30)return '۲۵ تا ۳۰ سال'; if(a>=31&&a<=32&&b<=35)return '۳۱ تا ۳۵ سال';
 if(a>=36&&a<=37&&b<=40)return '۳۶ تا ۴۰ سال'; if(a>=41&&b<=50)return '۴۱ تا ۵۰ سال'; if(a>50)return 'بیشتر از ۵۰ سال'; return '';
}

function extractAgeBounds(value) {
 const t = toEnglishDigits(cleanText(value));
 const out = {};
 if (!t) return out;
 let m = t.match(/(?:حداقل\s*(?:سن)?|سن\s*حداقل)\s*[:：]?\s*(\d{2})/u);
 if (m) out.age_min = Number(m[1]);
 m = t.match(/(?:حداکثر\s*(?:سن)?|سن\s*حداکثر)\s*[:：]?\s*(\d{2})/u);
 if (m) out.age_max = Number(m[1]);
 const range = t.match(/(?:سن\s*)?(\d{2})\s*(?:تا|-|الی)\s*(\d{2})\s*(?:سال)?/u);
 if (range) { if (!out.age_min) out.age_min=Number(range[1]); if (!out.age_max) out.age_max=Number(range[2]); }
 return out;
}

function extractStudyField(value) {
 const t = cleanText(value);
 if (!t) return '';
 const known = [
  ['شیمی',/\bشیمی\b/u],['مهندسی شیمی',/مهندسی\s*شیمی/u],['حسابداری',/حسابداری/u],['مدیریت مالی',/مدیریت\s*مالی/u],
  ['مهندسی صنایع',/مهندسی\s*صنایع/u],['مهندسی مکانیک',/مهندسی\s*مکانیک/u],['مهندسی برق',/مهندسی\s*برق/u],['عمران',/(?:مهندسی\s*)?عمران/u],
  ['معماری',/معماری/u],['علوم آزمایشگاهی',/علوم\s*آزمایشگاهی/u],['روانشناسی',/روانشناسی/u],['علوم تربیتی',/علوم\s*تربیتی/u],
  ['مدیریت',/(?:رشته\s*)?مدیریت/u],['کامپیوتر',/(?:مهندسی\s*)?(?:کامپیوتر|نرم\s*افزار|نرم‌افزار)/u]
 ];
 // Prefer the most specific labels first.
 known.sort((a,b)=>b[0].length-a[0].length);
 for (const [label,re] of known) if (re.test(t)) return label;
 return '';
}

function extractResidenceRequirement(value) {
 const t = cleanText(value);
 if (!t) return { text:'', locations:[] };
 const pieces = t.split(/[\n•؛]+|(?<=[.!؟])\s+/u).map(cleanText).filter(Boolean);
 const sentence = pieces.find(x => /محل\s*سکونت|ساکن|سکونت/u.test(x)) || '';
 if (!sentence) return { text:'', locations:[] };
 const qCities = ['قزوین','آبیک','الوند','محمدیه','مهرگان','بوئین زهرا','بوئین‌زهرا','تاکستان','اقبالیه','محمودآباد نمونه','آوج','دانسفهان','اسفرورین','ضیاءآباد','خرمدشت','بیدستان','شال','نرجه','خاکعلی'];
 const locations = qCities.filter(city => sentence.includes(city));
 return { text: sentence, locations: [...new Set(locations)] };
}

function extractWorkScheduleText(value) {
 const t = toEnglishDigits(cleanText(value));
 if (!t) return '';
 const pieces = t.split(/[\n•؛]+|(?<=[.!؟])\s+/u).map(cleanText).filter(Boolean);
 return pieces.find(x => /(?:شنبه|یکشنبه|دوشنبه|سه.?شنبه|چهارشنبه|پنجشنبه|جمعه).*(?:ساعت|\d{1,2}\s*(?:تا|-|الی)\s*\d{1,2})|(?:ساعت|\d{1,2}\s*(?:تا|-|الی)\s*\d{1,2}).*(?:شنبه|پنجشنبه|جمعه)/u.test(x)) || '';
}

function normalizeHiringTimeline(value) {
 const t=cleanText(value); if(!t)return '';
 if(/فوری/.test(t))return 'فوری'; if(/اولین\s*فرصت/.test(t))return 'در اولین فرصت'; if(/پایان\s*هفته/.test(t))return 'تا پایان هفته';
 if(/پایان\s*ماه/.test(t))return 'تا پایان ماه'; if(/تکمیل\s*ظرفیت/.test(t))return 'تا تکمیل ظرفیت'; if(/تاریخ|شروع/.test(t))return 'شروع از تاریخ مشخص'; return '';
}

function normalizeTrialPeriod(value) {
 const t=toEnglishDigits(cleanText(value)); if(!t)return '';
 if(/ندارد|بدون/.test(t))return 'ندارد'; if(/توافق/.test(t))return 'توافقی';
 if(/1\s*هفته/.test(t))return '۱ هفته'; if(/1\s*ماه/.test(t))return '۱ ماه'; if(/2\s*ماه/.test(t))return '۲ ماه'; if(/3\s*ماه/.test(t))return '۳ ماه'; return '';
}

function normalizeOvertime(value) {
 const t=cleanText(value); if(!t)return '';
 if(/ندارد|بدون/.test(t))return 'ندارد'; if(/اختیاری/.test(t)&&/پرداخت/.test(t))return 'اختیاری با پرداخت';
 if(/الزامی/.test(t)&&/پرداخت/.test(t))return 'الزامی با پرداخت'; if(/گاهی|در\s*صورت\s*نیاز/.test(t))return 'گاهی موردنیاز'; if(/توافق/.test(t))return 'توافقی'; return '';
}

function normalizeDisabilitySupport(value) {
 const t=cleanText(value); if(!t)return '';
 if(/امکان.?پذیر\s*نیست|خیر|نمی.?باشد/.test(t))return 'برای این موقعیت امکان‌پذیر نیست';
 if(/امکان.?پذیر|بله|پذیرفته/.test(t))return 'امکان‌پذیر است';
 if(/بررسی/.test(t))return 'بررسی می‌شود'; return '';
}

function normalizeWorkEnvironment(value) {
 const t=cleanText(value); if(!t)return '';
 const map=[['دفتر اداری',/دفتر|اداری/],['فروشگاه',/فروشگاه/],['کارگاه',/کارگاه/],['کارخانه',/کارخانه/],['پروژه / کارگاه ساختمانی',/ساختمان|پروژه\s*ساختمانی/],['محیط درمانی',/بیمارستان|کلینیک|درمان|داروخانه/],['میدانی',/میدانی/],['منزل / دورکاری',/منزل|دورکاری/]];
 for(const [v,re] of map) if(re.test(t)) return v; return '';
}

function cleanSourceSalary(value) {
 const t = cleanText(value);
 if (!t) return '';
 // E-Estekhdam renders navigation/help text such as «حقوق افراد دارای شغل مشابه».
 // It is not the salary of the current advertisement and must never populate salary fields.
 if (/حقوق\s+افراد\s+دارای\s+شغل\s+مشابه|حقوق\s+شغل\s+مشابه|مشاهده.{0,25}حقوق|میانگین.{0,25}حقوق/u.test(t)) return '';
 return t;
}

function parseSalaryFields(value) {
 const t = cleanSourceSalary(value);
 const out = {};
 if (!t) return out;
 if (/توافقی/.test(t)) {
   out.salary_negotiable = true;
   out.salary_range = 'توافقی';
   out.salary_structure = 'توافقی';
   return out;
 }
 if (/قانون\s*کار|وزارت\s*کار/.test(t)) {
   out.salary_range = 'مطابق قانون کار';
   out.salary_structure = 'حقوق ثابت ماهانه';
   return out;
 }
 const latin = toEnglishDigits(t).replace(/,/g,'');
 const range = latin.match(/(\d+(?:\.\d+)?)\s*(?:تا|-)\s*(\d+(?:\.\d+)?)\s*(?:میلیون|م)/);
 if (range) {
   out.salary_min = Number(range[1]);
   out.salary_max = Number(range[2]);
   out.salary_period = 'میلیون تومان / ماه';
   out.salary_structure = 'حقوق ثابت ماهانه';
 }
 out.salary_range = t;
 return out;
}

function parseWorkHours(value) {
 const t = toEnglishDigits(cleanText(value));
 if (!t) return {};
 const m = t.match(/(\d{1,2})(?::(\d{2}))?\s*(?:تا|-|الی)\s*(\d{1,2})(?::(\d{2}))?/);
 if (!m) return {};
 const pad = n => String(n).padStart(2,'0');
 return {
   work_start: `${pad(m[1])}:${pad(m[2] || '00')}`,
   work_end: `${pad(m[3])}:${pad(m[4] || '00')}`
 };
}

function canonicalJobTitle(sourceTitle, city='') {
 let title = cleanText(sourceTitle)
   .replace(/^استخدام\s+/,'')
   .replace(/\s*[-–|].*(?:ای\s*استخدام|دیوار).*$/i,'');
 if (city) {
   const escaped = city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   title = title.replace(new RegExp(`\\s+(?:در|شهر|استان)\\s+${escaped}\\s*$`,'u'),'');
 }
 return cleanText(title);
}

function buildSourceFirstFields(data, city, role, source, sourceUrl) {
 const raw = { ...(data?.structured || {}) };
 const fields = {};
 const set = (key, value) => {
   if (Array.isArray(value)) {
     const cleanValues = [...new Set(value.map(cleanText).filter(Boolean))];
     if (cleanValues.length) fields[key] = cleanValues;
   } else if (typeof value === 'boolean') {
     fields[key] = value;
   } else {
     const v = cleanText(value);
     if (v) fields[key] = v;
   }
 };

 set('job_title', canonicalJobTitle(data?.title || '', city));
 set('city_name', city);
 set('source_city', city);
 set('province', 'قزوین');
 set('source_category', data?.sourceCategory || raw.source_category || '');
 set('company_name', raw.company_name || data?.companyName || '');
 set('company_activity', raw.company_activity || '');
 set('cooperation_type', normalizeCooperation(raw.cooperation_type || ''));
 set('contract_type', normalizeContract(raw.contract_type || ''));
 set('workplace_mode', normalizeWorkplaceMode(raw.workplace_mode || ''));
 const strictRequirementText = [raw.requirements, raw.technical_skills].filter(Boolean).join(' ');
 const experienceText = source === 'e-estekhdam' ? [raw.experience_years, strictRequirementText].filter(Boolean).join(' ') : [raw.experience_years, strictRequirementText, raw.job_description].filter(Boolean).join(' ');
 set('experience_years', normalizeExperience(experienceText));
 set('education_level', normalizeEducation(raw.education_level || strictRequirementText));
 set('study_field', raw.study_field || extractStudyField(strictRequirementText));
 set(role === 'job_seeker' ? 'gender' : 'gender_preference', normalizeGender(raw.gender_preference || raw.gender || ''));
 set('age_range', normalizeAgeRange(raw.age_range || strictRequirementText));
 Object.assign(fields, extractAgeBounds(raw.age_range || strictRequirementText));
 const residence = extractResidenceRequirement(strictRequirementText);
 set('residence_requirement', residence.text);
 set('accepted_residence_locations', residence.locations);
 set('military_status', normalizeMilitary(raw.military_status || ''));
 set('vacancy_count', normalizeVacancyCount(raw.vacancy_count || ''));
 set(role === 'job_seeker' ? 'career_level' : 'seniority_level', normalizeSeniority(raw.seniority_level || raw.career_level || ''));
 set('preferred_shift', normalizeShiftList(raw.preferred_shift || strictRequirementText));
 set('work_days', normalizeWorkDaysList(raw.work_days || strictRequirementText));
 const workScheduleText = raw.work_hours || extractWorkScheduleText(strictRequirementText);
 set('work_schedule_text', workScheduleText);
 Object.assign(fields, parseWorkHours(workScheduleText));
 set('trial_period', normalizeTrialPeriod(raw.trial_period || ''));
 set('overtime', normalizeOvertime(raw.overtime || ''));
 set('interview_method', normalizeInterviewList(raw.interview_method || ''));
 set('insurance', normalizeInsurance(raw.insurance || explicitInsuranceFromBenefits(raw.benefits_description || '')));
 set('address_detail', raw.address_detail || '');
 const requirementText = source === 'e-estekhdam' ? strictRequirementText : [strictRequirementText, raw.job_description].filter(Boolean).join(' ');
 set('technical_skills', raw.technical_skills || raw.requirements || '');
 set('soft_skills', normalizeSoftSkillsList(raw.soft_skills || raw.requirements || ''));
 set('required_documents', normalizeRequiredDocumentsList(raw.required_documents || raw.requirements || ''));
 set('disability_support', normalizeDisabilitySupport(raw.disability_support || ''));
 set('work_environment', normalizeWorkEnvironment(raw.work_environment || ''));
 const softwareTools = extractSoftwareTools(requirementText);
 if (softwareTools) {
   // Current QazvinJobs UI uses office_tools for admin/accounting roles while
   // the canonical contract keeps technical_skills. Sending both preserves the
   // existing UI without losing the source meaning.
   set('office_tools', softwareTools);
   set('software_tools', softwareTools);
 }
 set('responsibilities', raw.responsibilities || '');
 set('requirements', raw.requirements || '');
 set('job_description', raw.job_description || '');
 set('hiring_timeline', normalizeHiringTimeline(raw.hiring_timeline || raw.application_deadline || ''));
 set('source_application_deadline', raw.application_deadline || '');
 set('benefits_description', raw.benefits_description || '');
 const benefitSource = raw.benefits_description || (source === 'divar' ? (data?.contentText || '') : '');
 // Keep an explicit empty list for E-Estekhdam so WordPress cannot refill
 // benefits from similar-ad text or a previous recovered draft.
 fields.benefits_list = normalizeBenefits(benefitSource);
 const explicitBenefitSalary = /حقوق\s*[:：]?\s*توافقی|حقوق\s+توافقی/u.test(cleanText(benefitSource)) ? 'توافقی' : '';
 Object.assign(fields, parseSalaryFields(cleanSourceSalary(raw.salary_range || explicitBenefitSalary)));
 fields.source_name = source === 'e-estekhdam' ? 'ای‌استخدام' : 'دیوار';
 fields.source_url = sourceUrl;
 fields.source_raw_title = cleanText(data?.title || '');
 return validateCanonicalFields(fields, role);
}

function validateCanonicalFields(fields, role='employer') {
 const out = { ...(fields || {}) };
 const selects = {
   cooperation_type: ['تمام‌وقت','پاره‌وقت','پروژه‌ای / پیمانکاری','کارآموزی','شیفتی','ساعتی / روزانه','فریلنسری'],
   workplace_mode: ['حضوری','دورکاری','ترکیبی'],
   experience_years: ['بدون نیاز به سابقه','کمتر از ۱ سال','۱ تا ۲ سال','۲ تا ۳ سال','۳ تا ۵ سال','۵ تا ۸ سال','بیشتر از ۸ سال'],
   education_level: ['مهم نیست','زیر دیپلم','دیپلم','کاردانی','کارشناسی','کارشناسی ارشد','دکتری'],
   age_range: ['مهم نیست','۱۸ تا ۲۴ سال','۲۵ تا ۳۰ سال','۳۱ تا ۳۵ سال','۳۶ تا ۴۰ سال','۴۱ تا ۵۰ سال','بیشتر از ۵۰ سال'],
   military_status: ['مهم نیست','پایان خدمت / معافیت الزامی','امریه پذیرفته می‌شود','مشمول هم پذیرفته می‌شود'],
   vacancy_count: ['۱ نفر','۲ نفر','۳ نفر','۴ تا ۵ نفر','۶ تا ۱۰ نفر','بیشتر از ۱۰ نفر'],
   seniority_level: ['کارآموز','تازه‌کار','کارشناس','کارشناس ارشد','سرپرست','مدیر','مدیر ارشد'],
   insurance: ['بیمه دارد','بیمه از روز اول','بیمه پس از دوره آزمایشی','بیمه ندارد','قابل مذاکره'],
   contract_type: ['قرارداد کار موقت','قرارداد کار دائم','قرارداد پروژه‌ای','پیمانکاری','کارآموزی','توافقی'],
   hiring_timeline: ['فوری','در اولین فرصت','تا پایان هفته','تا پایان ماه','تا تکمیل ظرفیت','شروع از تاریخ مشخص'],
   trial_period: ['ندارد','۱ هفته','۱ ماه','۲ ماه','۳ ماه','توافقی'],
   overtime: ['ندارد','اختیاری با پرداخت','الزامی با پرداخت','گاهی موردنیاز','توافقی'],
   disability_support: ['بررسی می‌شود','امکان‌پذیر است','برای این موقعیت امکان‌پذیر نیست'],
   work_environment: ['دفتر اداری','فروشگاه','کارگاه','کارخانه','پروژه / کارگاه ساختمانی','محیط درمانی','میدانی','منزل / دورکاری','سایر'],
   salary_structure: ['حقوق ثابت ماهانه','ساعتی','روزانه','پورسانتی / درصدی','حقوق ثابت + پورسانت','پروژه‌ای','توافقی']
 };
 if (role === 'job_seeker') selects.gender = ['ترجیح می‌دهم اعلام نکنم','خانم','آقا'];
 else selects.gender_preference = ['مهم نیست','خانم','آقا'];
 for (const [key, allowed] of Object.entries(selects)) {
   if (!(key in out)) continue;
   const v = cleanText(out[key]);
   if (!allowed.includes(v)) delete out[key]; else out[key] = v;
 }
 const multi = {
   preferred_shift: ['صبح','عصر','شب','چرخشی','شناور','آخر هفته'],
   soft_skills: ['ارتباط مؤثر','فن بیان','خوش‌برخوردی','کار تیمی','حل مسئله','مسئولیت‌پذیری','نظم و انضباط','پیگیری','صبر و حوصله','مدیریت زمان','مذاکره','دقت و توجه به جزئیات','یادگیری سریع','خلاقیت','رهبری','گزارش‌نویسی','تعامل با مراجعان / والدین'],
   interview_method: ['تماس اولیه','مصاحبه آنلاین','مصاحبه حضوری','آزمون تخصصی','تست عملی','استعلام معرف'],
   required_documents: ['رزومه','نمونه‌کار','مدرک تحصیلی','گواهی دوره','گواهینامه رانندگی','معرف شغلی','کاورلتر'],
   work_days: ['شنبه','یکشنبه','دوشنبه','سه‌شنبه','چهارشنبه','پنجشنبه','جمعه'],
   benefits_list: ['بیمه تکمیلی','پاداش','پورسانت','سرویس رفت‌وبرگشت','صبحانه','ناهار / غذا','جای خواب','وام','آموزش رایگان','ساعت کاری منعطف','هدایا و مناسبت‌ها','پزشک سازمانی','پارکینگ','بن / بسته خرید','کمک‌هزینه درمان','بیمه عمر','کمک‌هزینه رفت‌وآمد']
 };
 for (const [key, allowed] of Object.entries(multi)) {
   if (!(key in out)) continue;
   const vals = Array.isArray(out[key]) ? out[key] : [out[key]];
   out[key] = [...new Set(vals.map(cleanText).filter(v => allowed.includes(v)))];
 }
 for (const key of ['age_min','age_max']) {
   if (!(key in out)) continue;
   const n = Number(toEnglishDigits(out[key]));
   if (!Number.isFinite(n) || n < 14 || n > 99) delete out[key]; else out[key] = Math.trunc(n);
 }
 if (Number.isFinite(out.age_min) && Number.isFinite(out.age_max) && out.age_min > out.age_max) {
   delete out.age_min; delete out.age_max;
 }
 return out;
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
 for (const m of flat.matchAll(/(?<!\d)(?:(?:\+|00)?98[\s\-().]*)?0?9(?:[\s\-().]*\d){9}(?!\d)/g)) phones.push(normalizePhone(m[0]));
 for (const m of flat.matchAll(/(?<!\d)(?:(?:\+|00)?98[\s\-().]*)?0?28(?:[\s\-().]*\d){7,8}(?!\d)/g)) phones.push(normalizePhone(m[0]));
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
 return { phones: uniq(removeLoginPhone(phones)), emails: uniq(emails), whatsapp: uniq(removeLoginPhone(whatsapp)), telegram: uniq(telegram) };
}
function uniq(values) { return [...new Set(values.filter(Boolean))]; }
function hasExplicitDivarContactIntent(text) {
 const normalized = cleanText(text)
 .replace(/چت\s*و\s*تماس/gi, ' ')
 .replace(/اطلاعات\s*تماس/gi, ' ')
 .replace(/\s+/g, ' ');


 // Generic employment wording is not sufficient. The ad must explicitly ask
 // the reader to call, send an SMS, or send a resume/message.
 return /(?:تماس\s+(?:بگیرید|حاصل\s+(?:فرمایید|کنید)|برقرار\s+کنید)|لطفاً?\s+تماس|فقط\s+تماس|پیامک\s+(?:بزنید|ارسال\s+کنید|دهید)|فقط\s+پیامک|ارسال\s+رزومه|رزومه\s+(?:ارسال\s+کنید|بفرستید)|واتساپ\s+(?:کنید|پیام\s+دهید)|تلگرام\s+(?:کنید|پیام\s+دهید)|جهت\s+(?:هماهنگی|همکاری)[^.!؟]{0,80}تماس)/i.test(normalized);
}


function removeLoginPhone(values) { return DIVAR_LOGIN_PHONE ? values.filter(v => normalizePhone(v) !== DIVAR_LOGIN_PHONE) : values; }
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