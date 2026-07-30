import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const ENDPOINT = process.env.QZIH_IMPORT_ENDPOINT || '';
const TOKEN = process.env.QZIH_IMPORT_TOKEN || '';
const SOURCE_MODE = String(process.env.QZIH_SOURCES || 'both').toLowerCase();
const MAX_PAGES = clamp(process.env.QZIH_MAX_PAGES, 1, 5, 1);
const MAX_PER_SOURCE = clamp(process.env.QZIH_MAX_CANDIDATES, 1, 80, 20);
const MAX_ACCEPT = clamp(process.env.QZIH_MAX_ACCEPT, 1, 20, 4);
const MAX_REVIEW = clamp(process.env.QZIH_MAX_REVIEW, 0, 20, 5);
const RUN_LIMIT_MINUTES = clamp(process.env.QZIH_RUN_LIMIT_MINUTES, 4, 25, 14);
const RUN_DEADLINE = Date.now() + RUN_LIMIT_MINUTES * 60 * 1000;
const DIVAR_AUTH_SESSION_ENDPOINT = process.env.QZIH_DIVAR_AUTH_SESSION_ENDPOINT || deriveDivarAuthEndpoint(ENDPOINT, 'session');
const DIVAR_LOGIN_PHONE = normalizePhone(process.env.QZIH_DIVAR_LOGIN_PHONE || '');
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

console.log('CRAWLER VERSION 0.3.14 - DIVAR URL NORMALIZATION');
console.log(`Sources: ${activeSources.join(', ')}`);
console.log(`Run limits: pages/source=${MAX_PAGES}, candidates/source=${MAX_PER_SOURCE}, direct_accept=${MAX_ACCEPT}, review_queue=${MAX_REVIEW}, minutes=${RUN_LIMIT_MINUTES}`);

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
  sourceStats[source].discovered = [...discovered.values()].filter(v => v === source).length;
  await page.close();
}

if (discovered.size === 0) {
  throw new Error('No job links were discovered after browser rendering.');
}

const directAccepted = [];
const reviewQueued = [];
const sentItems = [];
let divarLoginBlocked = activeSources.includes('divar') && !divarAuth.state;
if (divarLoginBlocked) {
  sourceStats.divar.login_required = 1;
  console.log('Divar authenticated state is missing; Divar detail inspection will be skipped until login is completed.');
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
  if (source === 'divar' && divarLoginBlocked) continue;
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
      sourceStats[source].auth_status = 'login_required';
      divarLoginBlocked = true;
      console.log('Divar login is required or the saved session has expired; remaining Divar ads are skipped safely.');
      continue;
    }

    const data = await extractJob(detailPage, source);
    const detectedCity = detectCity(`${data.title} ${data.locationText} ${data.contentText}`);
    const city = detectedCity || sourceCityFallback(source, url);
    if (!detectedCity && city) {
      console.log(`Location fallback [${config.name}]: ${city} (candidate came from the configured Qazvin jobs feed)`);
    }
    const contacts = extractContacts(`${reveal.contactText || ''} ${reveal.networkText || ''} ${data.contactText || data.contentText}`, [...(reveal.contactLinks || []), ...(data.contactLinks || [])], source);

    if (!city) {
      rejected.noLocation++;
      sourceStats[source].no_location++;
      console.log(`Reject: outside Qazvin (${elapsed(started)})`);
      continue;
    }
    const directContact = Boolean(hasContact(contacts));
    // Review-only Divar items are kept separate from direct-contact ads.
    // They must never consume QZIH_MAX_ACCEPT or stop the search for phone-bearing ads.
    const contactReviewRequired = !directContact
      && source === 'divar'
      && !reveal.loginRequired
      && (
        reveal.contactAvailable ||
        reveal.clicked > 0 ||
        Boolean(divarAuth.state) ||
        hasExplicitDivarContactIntent(`${data.title} ${data.contentText}`)
      );

    if (source === 'divar' && !directContact && !reveal.loginRequired) {
      sourceStats[source].contact_reveal_failed++;
      await saveDivarContactDiagnostics(detailPage, canonicalSourceUrl(url, detailPage.url(), source), data, reveal).catch(error => {
        console.warn(`Divar contact diagnostics failed: ${error.message}`);
      });
    }

    if (!directContact && !contactReviewRequired) {
      rejected.noContact++;
      sourceStats[source].no_contact++;
      console.log(`Reject: no direct public contact or explicit contact instruction (${elapsed(started)})`);
      continue;
    }

    const role = detectRole(`${data.title} ${data.contentText}`);
    const sourceUrl = canonicalSourceUrl(url, detailPage.url(), source);
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
      contacts,
      direct_contact: directContact,
      contact_review_required: contactReviewRequired,
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
        extraction_status: directContact ? 'extracted' : (contactReviewRequired ? 'manager_review' : 'not_found')
      } : undefined,
      fields: inferFields(`${data.title} ${data.contentText}`, city, role)
    };

    if (contactReviewRequired) {
      if (reviewQueued.length >= MAX_REVIEW) {
        console.log(`Manager review queue limit reached (${MAX_REVIEW}); skipping review-only item and continuing to search for a direct-contact ad: ${data.title} (${elapsed(started)})`);
        continue;
      }

      await sendBatch([item]);
      reviewQueued.push(item);
      sentItems.push(item);
      sourceStats[source].review_only++;
      console.log(`Queued for manager contact review ${reviewQueued.length}/${MAX_REVIEW} [${config.name}/${role}]: ${data.title} (${elapsed(started)}). This item does not count toward the direct-contact acceptance target.`);
    } else {
      await sendBatch([item]);
      directAccepted.push(item);
      sentItems.push(item);
      sourceStats[source].accepted++;
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
  crawler_version: '0.3.14',
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
  console.log(`Run complete. Direct-contact ads sent: ${directAccepted.length}; manager-review items queued: ${reviewQueued.length}; total sent: ${sentItems.length}.`);
}

if (directAccepted.length === 0 && reviewQueued.length > 0) {
  console.log('No phone-bearing ad was found before the candidate/time limit. Review-only items did not stop the crawl; increase max_candidates for broader inspection.');
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
    crawler_version: '0.3.14',
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

    const bodyText = clean(document.body?.innerText || document.body?.textContent || '');
    const metaDescription = clean(
      document.querySelector('meta[property="og:description"]')?.content ||
      document.querySelector('meta[name="description"]')?.content ||
      ''
    );
    const jsonLdText = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
      .map(node => clean(node.textContent || ''))
      .join(' ');
    const breadcrumbText = Array.from(document.querySelectorAll(
      'nav, [aria-label*="breadcrumb" i], [class*="breadcrumb" i], [class*="location" i], [class*="city" i]'
    )).map(node => clean(node.innerText || node.textContent || '')).join(' ');
    const locationText = clean(`${document.title} ${metaDescription} ${breadcrumbText} ${jsonLdText} ${bodyText.slice(0, 12000)}`);

    const contentText = clean(root?.innerText || root?.textContent || bodyText);
    const contentHtml = root?.innerHTML || '';
    const markerRegex = /اطلاعات تماس|نحوه ارتباط|راه ارتباطی|شماره تماس|موبایل|تلفن|چت و تماس/i;
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

    const scopedContactText = clean(contactRoot?.innerText || contactRoot?.textContent || '');
    const globalContactLinks = Array.from(document.querySelectorAll(
      'a[href^="tel:"], a[href^="mailto:"], a[href*="wa.me/"], a[href*="whatsapp"], a[href*="t.me/"]'
    ), a => a.href);
    const scopedLinks = Array.from(contactRoot?.querySelectorAll?.('a[href]') || [], a => a.href);
    const contactLinks = [...new Set([...scopedLinks, ...globalContactLinks])];

    // On Divar the revealed phone can be rendered in a dialog outside the original
    // "چت و تماس" container, so the complete rendered page text must be inspected.
    const contactText = source === 'divar'
      ? clean(`${scopedContactText} ${bodyText}`)
      : scopedContactText;

    const publishedAt = document.querySelector('meta[property="article:published_time"]')?.content || '';

    return { title, contentText, contentHtml, contactText, contactLinks, publishedAt, locationText };
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
        'User-Agent': 'QazvinJobsImportCrawler/0.3.14'
      },
      body: JSON.stringify({ source: 'multi', crawler_version: '0.3.14', items }),
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
        'User-Agent': 'QazvinJobsImportCrawler/0.3.14'
      },
      body: JSON.stringify({ source: 'multi', crawler_version: '0.3.14', items: [], diagnostics }),
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
      headers: { 'X-QZIH-Token': TOKEN, 'User-Agent': 'QazvinJobsImportCrawler/0.3.14' }
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
  return cities.find(city => normalized.includes(city.replace('بوئین زهرا','بوئین‌زهرا'))) || cities.find(city => normalized.includes(city)) || '';
}
function sourceCityFallback(source, url) {
  if (source !== 'divar') return '';

  // This fallback is intentionally limited to the configured Qazvin employment feed.
  // A Divar ad discovered from /s/qazvin/jobs is a Qazvin employment candidate even
  // when the dynamically rendered detail page hides the city from the extracted DOM.
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
