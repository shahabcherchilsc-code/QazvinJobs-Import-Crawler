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
const PREFLIGHT_CONTROLLED_ACTIVE = String(process.env.QZIH_CONTROLLED_TEST_ACTIVE || '') === '1';
const PREFLIGHT_CONTROLLED_URL = String(process.env.QZIH_CONTROLLED_TEST_URL || '').trim();
const PREFLIGHT_CONTROLLED_SOURCE_ID = String(process.env.QZIH_CONTROLLED_TEST_SOURCE_ID || '').trim().toLowerCase();


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
const HUB_CONTROL = (PREFLIGHT_CONTROLLED_ACTIVE && PREFLIGHT_CONTROLLED_URL)
  ? { active: true, url: PREFLIGHT_CONTROLLED_URL, source_id: PREFLIGHT_CONTROLLED_SOURCE_ID, via: 'workflow_preflight' }
  : await loadHubControlState();
if (HUB_CONTROL?.active && HUB_CONTROL?.url) {
 if (HUB_CONTROL?.via === 'workflow_preflight') {
   console.log(`Controlled test state loaded from workflow preflight: ${HUB_CONTROL.url} (source_id=${HUB_CONTROL.source_id || 'n/a'})`);
 }
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
 duplicates: 0,
 positions_found: 0,
 auth_loaded: false,
 auth_status: '',
 errors: 0
 }
]));


const POSITION_FACT_LABELS = [
 'جنسیت','نوع همکاری','نوع قرارداد','سابقه کار','سابقه','حداقل تحصیلات','تحصیلات','مدرک تحصیلی','مقطع تحصیلی',
 'رشته تحصیلی','گروه رشته تحصیلی','رشته / گرایش تخصصی','بازه سنی','رده سنی','سن','حداکثر سن','حداقل سن',
 'وضعیت سربازی','تعداد نیروی مورد نیاز','تعداد نیروی موردنیاز','تعداد نفر','تعداد','سطح شغلی','رده شغلی',
 'شیفت کاری','شیفت','روزهای کاری','روز کاری','ساعات کاری','ساعت کاری','دوره آزمایشی','اضافه‌کاری','اضافه کاری',
 'مراحل مصاحبه','روش مصاحبه','نحوه حضور','محل فعالیت','بازه حقوق','حقوق ماهانه','حقوق','شهر','محل کار','موقعیت مکانی',
 'آدرس','زمان شروع همکاری','زمان‌بندی جذب','مهلت ارسال رزومه','مهلت درخواست'
];

const SOURCE_EXPLICIT_PASSTHROUGH_FIELDS = [
 'service_area','physical_requirements','required_equipment',
 'production_line','machine_types','safety_certificates',
 'engineering_discipline','professional_license','software_tools','tech_stack','seniority','skill_assessment',
 'sales_channel','commission_model','target_kpi',
 'teaching_subject','learner_level','teaching_mode',
 'vehicle_requirement','license_requirement','route_area',
 'restaurant_station','hygiene_card','meal_benefit',
 'medical_specialty','clinical_setting',
 'accounting_area','tax_insurance_knowledge','hr_area','labor_law_knowledge',
 'content_specialty','legal_area','contract_experience','agriculture_area','field_work',
 'office_tools','typing_speed','language_requirement','portfolio_url','portfolio_link','remote_possible'
];

const cities = [
 'محمودآباد نمونه','بوئین زهرا','بوئین‌زهرا','معلم کلایه','دانسفهان','اسفرورین','ضیاءآباد',
 'محمدیه','اقبالیه','خرمدشت','تاکستان','آبیک','الوند','آوج','آبگرم','رازمیان','کوهین',
 'سیردان','نرجه','ارداق','سگزآباد','خاکعلی','بیدستان','شال','قزوین'
];


console.log('CRAWLER VERSION 0.3.45 - FINAL DIVAR CONTACT CHANNELS');
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


 const baseData = await extractJob(detailPage, source);
 const sourceUrl = canonicalSourceUrl(url, detailPage.url(), source);
 const pageSourceId = sourceId(sourceUrl, source);
 if (CONTROLLED_TEST_FROM_HUB) {
   const expectedId = String(HUB_CONTROL?.source_id || '').trim().toLowerCase();
   console.log(`Controlled inspect identity: expected=${expectedId || 'n/a'} actual=${pageSourceId || 'n/a'} url=${sourceUrl}`);
   if (expectedId && pageSourceId && expectedId !== pageSourceId) {
     throw new Error(`Controlled test redirected to a different job identity: expected ${expectedId}, got ${pageSourceId}`);
   }
 }
 const positionRows = source === 'e-estekhdam'
   ? await extractEEstekhdamPositionRows(detailPage)
   : [];
 if (source === 'e-estekhdam' && CONTROLLED_TEST_FROM_HUB) {
   await saveEEstekhdamControlledDiagnostics(detailPage, sourceUrl, baseData, positionRows).catch(error => {
     console.warn(`E-Estekhdam controlled diagnostics failed: ${error.message}`);
   });
 }
 const jobs = positionRows.length > 1
   ? positionRows.map((row, rowIndex) => buildMultiPositionData(baseData, row, rowIndex, positionRows.length))
   : [baseData];
 const positionTitleCounts = new Map();
 const positionTitleSeen = new Map();
 for (const job of jobs) {
   const key = normalizedPositionTitle(job?.title || '');
   positionTitleCounts.set(key, (positionTitleCounts.get(key) || 0) + 1);
 }

 if (positionRows.length > 1) {
   sourceStats[source].positions_found += positionRows.length;
   console.log(`Multi-position E-Estekhdam page detected: ${positionRows.length} positions on ${sourceUrl}`);
 }

 // Divar contact evidence is deliberately scoped. A phone number elsewhere in
 // the page (support/footer/recommendations) must never become the employer's
 // phone. We accept only the revealed contact UI/network payload plus a local
 // ad contact block that itself contains direct phone/email evidence.
 const divarInlineContactText = source === 'divar' && hasExplicitDivarContactIntent(baseData?.structured?.job_description || '')
   ? (baseData.structured.job_description || '')
   : '';
 const contactEvidenceText = source === 'e-estekhdam'
   ? `${reveal.contactText || ''} ${baseData.contactText || ''}`
   : `${reveal.contactText || ''} ${reveal.networkText || ''} ${baseData.contactText || ''} ${divarInlineContactText}`;
 const contacts = extractContacts(
   contactEvidenceText,
   [...(reveal.contactLinks || []), ...(baseData.contactLinks || [])],
   source
 );
 const directContact = Boolean(hasContact(contacts));

 // Final source policy:
 // E-Estekhdam requires a direct public employer contact. Divar keeps the
 // existing manual-contact draft fallback when phone reveal is unavailable.
 const manualContactRequired = source === 'divar' && !directContact;
 const contactReviewRequired = manualContactRequired;

 if (source === 'divar' && !directContact) {
   sourceStats[source].contact_reveal_failed++;
   await saveDivarContactDiagnostics(detailPage, sourceUrl, baseData, reveal).catch(error => {
     console.warn(`Divar contact diagnostics failed: ${error.message}`);
   });
 }

 const controlledNoContactBypass = false;

 if (source === 'e-estekhdam' && !directContact) {
   rejected.noContact++;
   sourceStats[source].no_contact++;
   console.log(`[${config.name}] REJECT_NO_DIRECT_CONTACT: internal platform resume submission is not a direct employer contact; no draft will be sent.`);
   if (CONTROLLED_TEST_FROM_HUB) {
     console.log('Controlled test diagnostics were collected, but the E-Estekhdam contact rule is never bypassed.');
   }
   continue;
 }

 for (let positionIndex = 0; positionIndex < jobs.length; positionIndex++) {
   if (directAccepted.length >= MAX_ACCEPT) break;

   const data = jobs[positionIndex];
   const cityResolution = resolveCityFromData(data, source, url);
   const city = cityResolution.city;
   if (cityResolution.source === 'feed') {
     console.log(`Location fallback [${config.name}]: ${city} (configured city feed)`);
   } else if (city) {
     console.log(`Location source [${config.name}]: ${cityResolution.source} -> ${city}`);
   }

   if (!city) {
     rejected.noLocation++;
     sourceStats[source].no_location++;
     console.log(`Reject position ${positionIndex + 1}/${jobs.length}: outside Qazvin (${elapsed(started)})`);
     continue;
   }

   const roleEvidence = source === 'divar'
     ? `${data.title || ''} ${data?.structured?.job_description || ''} ${data?.structured?.requirements || ''}`
     : `${data.title || ''} ${data.contentText || ''}`;
   const role = detectRole(roleEvidence);
   const structured = buildSourceFirstFields(data, city, role, source, sourceUrl);
   if (SEED_URLS.length > 0) {
     console.log(`Mapped source fields [${config.name} / ${data.title}]: ${Object.keys(structured).sort().join(', ')}`);
     console.log(`Position fidelity [${data.title}]: cooperation=${structured.cooperation_type || '-'} | gender=${structured.gender_preference || structured.gender || '-'} | level=${structured.seniority_level || structured.career_level || '-'} | benefits=${Array.isArray(structured.benefits_list) ? structured.benefits_list.join('،') : '-'} | salary=${structured.salary_range || structured.salary_structure || '-'}`);
   }

   const multiPosition = source === 'e-estekhdam' && jobs.length > 1;
   const titleKey = normalizedPositionTitle(data.title || '');
   const seenOrdinal = (positionTitleSeen.get(titleKey) || 0) + 1;
   positionTitleSeen.set(titleKey, seenOrdinal);
   const duplicateOrdinal = (positionTitleCounts.get(titleKey) || 0) > 1 ? seenOrdinal : 0;
   const scopedSourceId = multiPosition
     ? positionSourceId(pageSourceId, data.title, duplicateOrdinal)
     : pageSourceId;

   const divarScopedContent = source === 'divar'
     ? cleanText([
         data?.structured?.job_description || '',
         data?.structured?.responsibilities || '',
         data?.structured?.requirements || '',
         data?.structured?.benefits_description || '',
         data?.structured?.address_detail || ''
       ].filter(Boolean).join('\n'))
     : '';

   const item = {
     source,
     source_name: config.name,
     source_id: scopedSourceId,
     parent_source_id: multiPosition ? pageSourceId : '',
     position_index: multiPosition ? (data.position_index || (positionIndex + 1)) : 0,
     position_count: multiPosition ? jobs.length : 1,
     multi_position: multiPosition,
     controlled_test_last: Boolean(CONTROLLED_TEST_FROM_HUB && multiPosition && (
       positionIndex === jobs.length - 1 || directAccepted.length + 1 >= MAX_ACCEPT
     )),
     url: sourceUrl,
     title: data.title,
     role,
     content_text: (source === 'divar' ? (divarScopedContent || data.title || '') : data.contentText).slice(0, 50000),
     // Divar sends scoped plain text only. Raw page HTML can contain related
     // cards and authenticated UI; WordPress will safely build its own draft HTML.
     content_html: source === 'divar' ? '' : data.contentHtml.slice(0, 100000),
     published_at: data.publishedAt,
     city,
     city_exact: city,
     city_source: cityResolution.source,
     location_city: city,
     source_category: data.sourceCategory || '',
     contacts,
     direct_contact: directContact,
     controlled_test_no_contact: false,
     contact_review_required: contactReviewRequired,
     manual_contact_required: manualContactRequired,
     contact_review_label: contactReviewRequired
       ? (reveal.contactAvailable
         ? 'دکمه اطلاعات تماس دیوار موجود است؛ شماره خودکار استخراج نشد و نیازمند بررسی مدیر است'
         : 'اطلاعات تماس مستقیم دیوار استخراج نشد؛ قبل از انتشار بررسی شود')
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

   const receiver = await sendBatch([item]);
   const receiverResult = Array.isArray(receiver?.results) ? receiver.results[0] : null;
   const receiverStatus = receiverResult?.status || (receiver?.accepted ? 'accepted' : '');

   if (receiverStatus === 'accepted') {
     directAccepted.push(item);
     sentItems.push(item);
     sourceStats[source].accepted++;
     if (manualContactRequired) {
       sourceStats[source].manual_contact_drafts++;
       console.log(`[${config.name}] Draft accepted ${directAccepted.length}/${MAX_ACCEPT} with CONTACT REVIEW REQUIRED [${role}]: ${data.title} (${elapsed(started)})`);
     } else {
       const multiLabel = multiPosition ? ` position ${positionIndex + 1}/${jobs.length}` : '';
       console.log(`Draft accepted ${directAccepted.length}/${MAX_ACCEPT}${multiLabel} [${config.name}/${role}]: ${data.title} (${elapsed(started)})`);
     }
   } else if (receiverStatus === 'duplicates') {
     sourceStats[source].duplicates++;
     console.log(`Receiver duplicate; continuing scan instead of consuming draft quota: ${data.title}`);
   } else if (receiverStatus === 'no_location') {
     sourceStats[source].no_location++;
   } else if (receiverStatus === 'no_contact') {
     sourceStats[source].no_contact++;
   } else if (receiverStatus) {
     console.warn(`Receiver returned ${receiverStatus} for ${data.title}; continuing scan.`);
   }
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
 crawler_version: '0.3.45',
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
 const manualDrafts = Object.values(sourceStats).reduce((sum, row) => sum + Number(row.manual_contact_drafts || 0), 0);
 console.log(`Run complete. Draft candidates sent: ${directAccepted.length}; contact-review drafts: ${manualDrafts}; total sent: ${sentItems.length}.`);
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

 // E-Estekhdam contact is parsed conservatively from the current ad block in
 // extractJob(). The reveal routine is Divar-specific and its page-wide UI scan
 // must never be used as employer-contact evidence for E-Estekhdam.
 if (source !== 'divar') return result;

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


 const body = await response.text().catch(() => '');
 if (!body || body.length > 500000) return;


 const explicitContactKey = /"(?:phone|mobile|telephone|contact|contact_info|contactInfo|tel|phone_number|mobile_number|phoneNumbers)"\s*:/i.test(body);
 const contactEndpoint = /(?:contact|phone|telephone|call)/i.test(responseUrl);
 // A generic Divar API/widget response may contain recommendations or account
 // metadata. For generic endpoints, retain only values that live under an
 // explicit contact/phone key. A contact-specific endpoint may use arbitrary
 // response keys, so its body remains eligible as scoped contact evidence.
 if (!contactEndpoint && !explicitContactKey) return;
 const networkEvidence = extractNetworkContactEvidence(body, contactEndpoint);
 if (!networkEvidence) return;

 const normalized = toEnglishDigits(networkEvidence);
 if (
 /(?:^|\D)0?9(?:[\s\-().]*\d){9}(?:\D|$)/.test(normalized) ||
 /(?:^|\D)0?28(?:[\s\-().]*\d){7,8}(?:\D|$)/.test(normalized) ||
 /[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/i.test(networkEvidence) ||
 /(?:wa\.me|whatsapp|t\.me)/i.test(networkEvidence)
 ) {
 networkPayloads.push(networkEvidence);
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


 // Wait only for contact UI evidence. Page-wide phone scans can match Divar's
 // own/support/recommended-ad numbers and prematurely stop the reveal sequence.
 const contactWaitDeadline = Date.now() + 6500;
 while (Date.now() < contactWaitDeadline) {
   if (await renderedContactExists(page)) break;
   await page.waitForTimeout(350);
 }
 await page.waitForTimeout(350);


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
 '[class*="sheet" i]',
 '[class*="drawer" i]',
 '[class*="contact" i]',
 '[class*="phone" i]',
 '[data-testid*="contact" i]',
 '[data-cy*="contact" i]'
 ].join(',');


 const roots = Array.from(document.querySelectorAll(selector)).filter(visible);
 const preferred = roots.filter(node => /اطلاعات تماس|شماره تماس|نمایش شماره|موبایل|تلفن|تماس/i.test(clean(node.innerText || node.textContent || '')));
 const selectedRoots = preferred.length ? preferred : roots;
 const textParts = selectedRoots.map(node => clean(node.innerText || node.textContent || '')).filter(Boolean);


 // Current Divar can render the revealed phone in an unclassified bottom sheet
 // (no role=dialog/contact class). Capture only short, explicit contact action
 // rows that themselves contain a phone number. This stays safe because generic
 // page-wide numbers are still ignored unless they are labelled as call/SMS.
 const explicitActionNodes = Array.from(document.querySelectorAll('button, a, [role="button"], li, p, div, span'))
 .filter(visible)
 .map(node => ({ node, text: clean(node.innerText || node.textContent || '') }))
 .filter(({ text }) => {
   if (!text || text.length > 280) return false;
   const english = toEnglishDigitsLocal(text);
   const hasPhone = /(?:^|\D)0?9(?:[\s\-().]*\d){9}(?:\D|$)/.test(english) || /(?:^|\D)0?28(?:[\s\-().]*\d){7,8}(?:\D|$)/.test(english);
   const labelled = /(?:تماس\s*تلفنی\s*با|ارسال\s*پیامک\s*به|شماره\s*تماس|موبایل\s*[:：]|تلفن\s*[:：])/i.test(text);
   return hasPhone && labelled;
 });
 for (const { text } of explicitActionNodes) textParts.push(text);

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


 const linkRoots = [...selectedRoots, ...explicitActionNodes.map(item => item.node)];
 for (const node of contactNodes) {
   const parent = node.closest('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [class*="bottom-sheet" i], [class*="sheet" i], [class*="drawer" i], [class*="contact" i], [class*="phone" i], [data-testid*="contact" i], [data-cy*="contact" i]') || node.parentElement;
   if (parent) linkRoots.push(parent);
 }
 const links = linkRoots.flatMap(rootNode => {
   const own = rootNode.matches?.('a[href]') ? [rootNode.href] : [];
   const nested = Array.from(rootNode.querySelectorAll?.('a[href]') || [], anchor => anchor.href);
   return [...own, ...nested];
 }).filter(href => /^(tel:|sms:|mailto:)|wa\.me|whatsapp|t\.me/i.test(href));

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
 result.contactAvailable = result.contactAvailable || /اطلاعات\s*تماس|نمایش\s*شماره|شماره\s*تماس|چت\s*و\s*تماس|تماس\s*تلفنی\s*با|ارسال\s*پیامک\s*به/i.test(finalBody);


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
 const clean = value => String(value || '').replace(/[\u200c\u200f\u202a-\u202e]/g, ' ').replace(/\s+/g, ' ').trim();
 const visible = node => {
   const style = window.getComputedStyle(node);
   const rect = node.getBoundingClientRect();
   return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
 };
 const actionNodes = Array.from(document.querySelectorAll('button, a, [role="button"], li, p, div, span')).filter(visible);
 for (const node of actionNodes) {
   const raw = clean(node.innerText || node.textContent || '');
   if (!raw || raw.length > 280) continue;
   const text = raw.replace(/[۰-۹٠-٩]/g, ch => fa.includes(ch) ? String(fa.indexOf(ch)) : String(ar.indexOf(ch)));
   const hasPhone = /(?:^|\D)0?9(?:[\s\-().]*\d){9}(?:\D|$)/.test(text) || /(?:^|\D)0?28(?:[\s\-().]*\d){7,8}(?:\D|$)/.test(text);
   if (hasPhone && /(?:تماس\s*تلفنی\s*با|ارسال\s*پیامک\s*به|شماره\s*تماس|موبایل\s*[:：]|تلفن\s*[:：])/i.test(raw)) return true;
   const href = node.matches?.('a[href]') ? String(node.getAttribute('href') || '') : '';
   if (/^(?:tel:|sms:)/i.test(href)) return true;
 }

 const roots = Array.from(document.querySelectorAll([
   '[role="dialog"]','[aria-modal="true"]','[class*="modal" i]','[class*="dialog" i]',
   '[class*="bottom-sheet" i]','[class*="sheet" i]','[class*="drawer" i]','[class*="contact" i]','[class*="phone" i]','[data-testid*="contact" i]','[data-cy*="contact" i]'
 ].join(','))).filter(visible);
 for (const root of roots) {
   const raw = clean(root.innerText || root.textContent || '');
   const text = raw.replace(/[۰-۹٠-٩]/g, ch => fa.includes(ch) ? String(fa.indexOf(ch)) : String(ar.indexOf(ch)));
   const scopedLink = root.querySelector('a[href^="tel:"], a[href^="sms:"], a[href^="mailto:"], a[href*="wa.me/"], a[href*="whatsapp"], a[href*="t.me/"]');
   if (scopedLink || /(?:^|\D)0?9(?:[\s\-().]*\d){9}(?:\D|$)/.test(text) || /(?:^|\D)0?28(?:[\s\-().]*\d){7,8}(?:\D|$)/.test(text)) return true;
 }
 return false;
 }).catch(() => false);
}


async function saveDivarContactDiagnostics(page, sourceUrl, data, reveal) {
 const directory = 'divar-contact-diagnostics';
 await mkdir(directory, { recursive: true });


 const id = (sourceId(sourceUrl, 'divar') || `divar-${Date.now()}`)
 .replace(/[^a-z0-9_-]+/gi, '-')
 .slice(0, 90);
 const prefix = `${directory}/${id}`;
 const redact = value => {
   const normalized = toEnglishDigits(cleanText(value || ''));
   return normalized
     .replace(/[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}/giu, '[REDACTED_EMAIL]')
     .replace(/(?<!\d)0?9(?:[\s\-().]*\d){9}(?!\d)/g, '[REDACTED_PHONE]')
     .replace(/(?<!\d)0?28(?:[\s\-().]*\d){7,8}(?!\d)/g, '[REDACTED_PHONE]');
 };

 // Contact diagnostics are only for failed reveal attempts. Keep enough layout
 // evidence to diagnose UI changes, but never archive raw authenticated HTML or
 // unredacted phone/email payloads in GitHub artifacts.
 const maskTargets = page.locator([
   'input','textarea','a[href^="tel:"]','a[href^="sms:"]','a[href^="mailto:"]',
   '[role="dialog"]','[aria-modal="true"]','[class*="contact" i]','[class*="phone" i]'
 ].join(','));
 await page.screenshot({ path: `${prefix}.png`, fullPage: true, mask: [maskTargets] }).catch(() => {});
 await writeFile(`${prefix}.json`, JSON.stringify({
 crawler_version: '0.3.45',
 source_url: sourceUrl,
 current_url: page.url(),
 title: data.title,
 clicked: reveal.clicked,
 contact_available: reveal.contactAvailable,
 login_required: reveal.loginRequired,
 network_response_count: reveal.networkResponseCount,
 contact_text_excerpt: redact(reveal.contactText).slice(0, 5000),
 network_text_excerpt: redact(reveal.networkText).slice(0, 10000),
 visible_page_text_excerpt: redact(await page.locator('body').innerText().catch(() => '')).slice(0, 15000)
 }, null, 2), 'utf8');


 console.log(`Safe Divar contact diagnostics saved: ${prefix}`);
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


 const loggedOutText = /(?:برای\s*مشاهده\s*و\s*مدیریت\s*آگهی.?ها[^.!؟]{0,100}وارد\s*حساب\s*کاربری\s*خود\s*شوید|وارد\s*حساب\s*کاربری\s*خود\s*شوید|ورود\s*به\s*حساب\s*کاربری)/i.test(body);
 const controls = page.locator('button, a, [role="button"]');
 let visibleLoginControl = false;
 for (let i = 0; i < Math.min(await controls.count(), 80); i++) {
   const node = controls.nth(i);
   if (!await node.isVisible().catch(() => false)) continue;
   const label = cleanText(await node.innerText().catch(() => '') || await node.getAttribute('aria-label').catch(() => '') || '');
   if (/^ورود(?:\s*به\s*حساب(?:\s*کاربری)?)?$/i.test(label)) { visibleLoginControl = true; break; }
 }
 return Boolean(
   loggedOutText || visibleLoginControl ||
   (loginInputVisible && /ورود\s*به\s*حساب|شماره\s*موبایل\s*خود\s*را\s*وارد|کد\s*تایید\s*به\s*این\s*شماره/i.test(body))
 );
}



async function extractEEstekhdamPositionRows(page) {
 return await page.evaluate(() => {
   const clean = value => String(value || '')
     .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
     .replace(/\s+/g, ' ')
     .trim();
   const cleanBlock = value => String(value || '')
     .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
     .split(/\n+/)
     .map(line => clean(line))
     .filter(Boolean)
     .join('\n');
   const norm = value => clean(value).replace(/[ي]/g,'ی').replace(/[ك]/g,'ک');
   const headerIndex = (headers, patterns) => headers.findIndex(text => patterns.some(re => re.test(norm(text))));
   const positions = [];
   const seen = new Set();
   const reqSignature = /جنسیت\s*[:：]|نوع\s*(?:قرارداد|همکاری)\s*[:：]|سابقه\s*کار\s*[:：]|مدرک\s*تحصیلی\s*[:：]/u;
   const benefitSignature = /(?:^|\s)(?:حقوق\s*ثابت|بیمه(?:\s*تکمیلی)?|سرویس(?:\s*رفت\s*و\s*برگشت)?|پاداش|وام|ناهار|صبحانه|مزایا|تسهیلات)(?:$|\s|[،؛])/u;
   const badTitle = /^(?:موقعیت|عنوان)\s*شغلی$|^عنوان$|^شرایط\s*احراز$|^مزایا$|^تسهیلات(?:\s*و\s*مزایا)?$/u;
   const factLabels = [
     'جنسیت','نوع همکاری','نوع قرارداد','سابقه کار','سابقه','حداقل تحصیلات','تحصیلات','مدرک تحصیلی','مقطع تحصیلی',
     'رشته تحصیلی','بازه سنی','رده سنی','حداقل سن','حداکثر سن','وضعیت سربازی','تعداد نیروی مورد نیاز','تعداد نیروی موردنیاز',
     'سطح شغلی','رده شغلی','شیفت کاری','روزهای کاری','ساعات کاری','ساعت کاری','نحوه حضور','محل فعالیت','بازه حقوق','حقوق ماهانه',
     'شهر','محل کار','موقعیت مکانی','آدرس','زمان شروع همکاری','زمان‌بندی جذب','مهلت ارسال رزومه','مهلت درخواست'
   ];
   const esc = value => clean(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   const inlineFactPattern = [...factLabels].sort((a,b)=>b.length-a.length).map(esc).join('|');
   const parseInlineFacts = text => {
     const source = cleanBlock(text).replace(/\n+/g, ' | ');
     const out = {};
     for (const label of factLabels) {
       const re = new RegExp(`(?:^|[\\s|،؛])${esc(label)}\\s*[:：\-]?\\s*(.*?)(?=\\s*(?:\\||،|؛)?\\s*(?:${inlineFactPattern})\\s*[:：\-]?|$)`, 'u');
       const m = source.match(re);
       const value = clean(m?.[1] || '').replace(/^[،؛|\-–—]+|[،؛|\-–—]+$/gu,'').trim();
       if (value && value !== label) out[label] = value;
     }
     return out;
   };

   const addPosition = (title, requirements, benefits, rowText='', facts={}) => {
     title = clean(title);
     requirements = cleanBlock(requirements);
     benefits = cleanBlock(benefits);
     const cleanFacts = {};
     for (const [key, value] of Object.entries(facts || {})) {
       const k = clean(key), v = cleanBlock(value);
       if (k && v) cleanFacts[k] = v;
     }
     if (!title || title.length < 2 || title.length > 180 || badTitle.test(norm(title))) return;
     if (!requirements && !benefits) return;
     // A real position row normally contains at least one employment fact.
     // This guard avoids turning navigation/similar-ad cards into positions.
     if (!reqSignature.test(norm(requirements)) && !/سابقه|تحصیلات|مهارت|مسلط|آشنا|حداقل|حداکثر|سن/u.test(norm(requirements))) return;
     const key = `${norm(title).toLowerCase()}|${norm(requirements).slice(0,500)}`;
     if (seen.has(key)) return;
     seen.add(key);
     positions.push({
       title,
       requirements,
       benefits,
       facts: cleanFacts,
       row_text: cleanBlock(rowText || [title, requirements, benefits].filter(Boolean).join('\n'))
     });
   };

   // 1) Native <table> and ARIA table/grid rows.
   const tableLike = Array.from(document.querySelectorAll('table,[role="table"],[role="grid"]'));
   for (const table of tableLike) {
     const rows = Array.from(table.querySelectorAll('tr,[role="row"]'));
     if (rows.length < 2) continue;
     let headerRowIndex = -1, titleIndex = -1, requirementsIndex = -1, benefitsIndex = -1, headerTexts = [];
     for (let i = 0; i < Math.min(rows.length, 6); i++) {
       const cells = Array.from(rows[i].querySelectorAll(':scope > th,:scope > td,:scope > [role="columnheader"],:scope > [role="cell"],:scope > [role="gridcell"]'));
       const texts = cells.map(cell => clean(cell.innerText || cell.textContent || ''));
       if (texts.length < 2) continue;
       const ti = headerIndex(texts, [/^(?:موقعیت|عنوان)\s*شغلی$/u, /^عنوان$/u]);
       const ri = headerIndex(texts, [/شرایط\s*احراز/u, /شرح\s*(?:وظایف|همکاری)/u]);
       const bi = headerIndex(texts, [/مزایا/u, /تسهیلات/u]);
       if (ti >= 0 && ri >= 0) {
         headerRowIndex = i; titleIndex = ti; requirementsIndex = ri; benefitsIndex = bi; headerTexts = texts; break;
       }
     }
     if (headerRowIndex < 0) continue;
     for (let i = headerRowIndex + 1; i < rows.length; i++) {
       const cells = Array.from(rows[i].querySelectorAll(':scope > th,:scope > td,:scope > [role="columnheader"],:scope > [role="cell"],:scope > [role="gridcell"]'));
       const needed = Math.max(titleIndex, requirementsIndex, benefitsIndex);
       if (cells.length <= needed) continue;
       const cellTexts = cells.map(cell => cleanBlock(cell?.innerText || cell?.textContent || ''));
       const title = clean(cellTexts[titleIndex] || '');
       const requirements = cleanBlock(cellTexts[requirementsIndex] || '');
       const benefits = benefitsIndex >= 0 ? cleanBlock(cellTexts[benefitsIndex] || '') : '';
       const facts = {};
       for (let c = 0; c < Math.min(headerTexts.length, cellTexts.length); c++) {
         const header = clean(headerTexts[c]);
         const value = cleanBlock(cellTexts[c]);
         if (header && value && c !== titleIndex && c !== requirementsIndex && c !== benefitsIndex) facts[header] = value;
       }
       addPosition(title, requirements, benefits, rows[i].innerText || rows[i].textContent || '', facts);
     }
     if (positions.length > 1) return positions;
   }

   // 2) E-Estekhdam can render the same visual table with DIV/CSS grid rather
   // than actual <table> tags. Find row containers by their direct children:
   // one short title child + one child containing employment facts + optional benefits child.
   const containers = Array.from(document.querySelectorAll('article,section,li,div'));
   for (const node of containers) {
     const children = Array.from(node.children || []);
     if (children.length < 2 || children.length > 12) continue;
     const texts = children.map(ch => cleanBlock(ch.innerText || ch.textContent || ''));
     const reqIndex = texts.findIndex(text => reqSignature.test(norm(text)));
     if (reqIndex < 0) continue;
     // Skip large wrapper containers that contain several position rows.
     const full = cleanBlock(node.innerText || node.textContent || '');
     const genderHits = (norm(full).match(/جنسیت\s*[:：]/gu) || []).length;
     const contractHits = (norm(full).match(/نوع\s*(?:قرارداد|همکاری)\s*[:：]/gu) || []).length;
     if (genderHits > 1 || contractHits > 1) continue;

     let title = '';
     for (let i = Math.max(0, reqIndex - 3); i < reqIndex; i++) {
       const t = clean(texts[i]);
       if (t && t.length <= 180 && !badTitle.test(norm(t)) && !reqSignature.test(norm(t)) && !benefitSignature.test(norm(t))) title = t;
     }
     if (!title) {
       const heading = node.querySelector('h2,h3,h4,h5,h6,strong,b,[role="heading"]');
       const t = clean(heading?.innerText || heading?.textContent || '');
       if (t && t.length <= 180 && !badTitle.test(norm(t))) title = t;
     }
     if (!title) continue;

     const requirements = texts[reqIndex];
     let benefits = '';
     for (let i = reqIndex + 1; i < texts.length; i++) {
       const t = texts[i];
       if (t && benefitSignature.test(norm(t)) && !reqSignature.test(norm(t))) { benefits = t; break; }
     }
     addPosition(title, requirements, benefits, full, parseInlineFacts(full));
   }
   if (positions.length > 1) return positions;

   // 3) Last-resort semantic row detection. Pick the smallest DOM blocks that
   // contain exactly one set of position facts and infer their nearby heading.
   const factNodes = Array.from(document.querySelectorAll('div,section,li,td,[role="cell"],[role="gridcell"]'));
   for (const node of factNodes) {
     const text = cleanBlock(node.innerText || node.textContent || '');
     if (text.length < 30 || text.length > 3500 || !reqSignature.test(norm(text))) continue;
     const hits = (norm(text).match(/جنسیت\s*[:：]/gu) || []).length + (norm(text).match(/نوع\s*(?:قرارداد|همکاری)\s*[:：]/gu) || []).length;
     if (hits > 2) continue;
     // If a child already contains the same fact signature, this is probably a wrapper.
     const childHasFacts = Array.from(node.children || []).some(ch => reqSignature.test(norm(cleanBlock(ch.innerText || ch.textContent || ''))));
     if (childHasFacts) continue;

     let row = node.parentElement;
     for (let hop = 0; hop < 3 && row; hop++, row = row.parentElement) {
       const siblings = Array.from(row.children || []).map(ch => cleanBlock(ch.innerText || ch.textContent || '')).filter(Boolean);
       if (siblings.length < 2 || siblings.length > 10) continue;
       const reqIdx = siblings.findIndex(t => reqSignature.test(norm(t)));
       if (reqIdx < 0) continue;
       const titleCandidates = siblings.slice(0, reqIdx).map(clean).filter(t => t.length >= 2 && t.length <= 180 && !badTitle.test(norm(t)) && !reqSignature.test(norm(t)));
       const title = titleCandidates.at(-1) || '';
       if (!title) continue;
       const benefits = siblings.slice(reqIdx + 1).find(t => benefitSignature.test(norm(t)) && !reqSignature.test(norm(t))) || '';
       addPosition(title, siblings[reqIdx], benefits, row.innerText || row.textContent || '', parseInlineFacts(row.innerText || row.textContent || ''));
       break;
     }
   }

   return positions;
 });
}

function extractPositionFact(text, labels) {
 const source = cleanText(String(text || '')
   .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
   .replace(/[•●▪◦]/g, ' '));
 if (!source) return '';
 const wanted = Array.isArray(labels) ? labels : [labels];
 const esc = v => cleanText(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
 const allLabels = [...new Set([...POSITION_FACT_LABELS, ...wanted].map(cleanText).filter(Boolean))]
   .sort((a,b)=>b.length-a.length)
   .map(esc)
   .join('|');
 for (const rawLabel of wanted) {
   const label = cleanText(rawLabel);
   if (!label) continue;
   const rx = new RegExp(`(?:^|[\\s،؛|])${esc(label)}\\s*[:：\\-]?\\s*(.*?)(?=\\s+(?:${allLabels})\\s*[:：\\-]?|$)`, 'u');
   const match = source.match(rx);
   if (match) {
     const value = cleanText(match[1]).replace(/^[،؛|\-–—]+|[،؛|\-–—]+$/gu,'').trim();
     if (value && value !== label) return value;
   }
 }
 return '';
}

function cleanPositionNarrative(text, title='') {
 let t = cleanText(String(text || '')
   .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
   .replace(/[•●▪◦]/g, ' '));
 if (!t) return '';
 const factPatterns = [
   /(?:^|[\s،؛|])جنسیت\s*[:：\-]?\s*(?:آقا|خانم|مهم\s*نیست|آقا\s*و\s*خانم|خانم\s*و\s*آقا)(?=$|[\s،؛|])/gu,
   /(?:^|[\s،؛|])نوع\s*(?:قرارداد|همکاری)\s*[:：\-]?\s*(?:تمام(?:‌|\s)*وقت|پاره(?:‌|\s)*وقت|پروژه(?:‌|\s)*ای|پروژه‌ای|پیمانکاری|کارآموزی|شیفتی|ساعتی|روزانه)(?=$|[\s،؛|])/gu,
   /(?:^|[\s،؛|])سابقه\s*کار\s*[:：\-]?\s*(?:دارای\s*سابقه\s*کار|بدون\s*(?:نیاز\s*به\s*)?سابقه(?:\s*کار)?|مهم\s*نیست)(?=$|[\s،؛|])/gu,
   /(?:^|[\s،؛|])سطح\s*شغلی\s*[:：\-]?\s*(?:مدیر|سرپرست|کارشناس|کارمند|کارگر)(?=$|[\s،؛|])/gu
 ];
 for (const re of factPatterns) t = t.replace(re, ' ');
 const titleClean = cleanText(title);
 if (titleClean) {
   const escTitle = titleClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
   t = t.replace(new RegExp(`(?:^|[\\s،؛|])${escTitle}(?=$|[\\s،؛|])`, 'u'), ' ');
 }
 return cleanText(t).replace(/^[،؛|\-–—]+|[،؛|\-–—]+$/gu, '').trim();
}

function extractExplicitTechnicalSkills(text) {
 const t = cleanText(text);
 if (!t) return '';
 const parts = t.split(/[\n؛]|(?<=[.!؟])\s+/u).map(cleanText).filter(Boolean);
 const selected = parts.filter(part =>
   /(?:مسلط|آشنا(?:یی)?|مهارت|توانایی|کار\s*با|دانش\s+(?:کار|فنی|تخصصی)|تجربه\s+در)/u.test(part) &&
   !/(?:^|\s)(?:جنسیت|نوع\s*(?:قرارداد|همکاری)|حقوق|بیمه|محل\s*کار|آدرس)\s*[:：]/u.test(part)
 );
 return cleanText(selected.join('؛ '));
}

function buildMultiPositionData(baseData, row, rowIndex, positionCount) {
 const requirements = String(row?.requirements || '').trim();
 const benefits = String(row?.benefits || '').trim();
 const rowText = String(row?.row_text || row?.rawText || '').trim();
 const facts = (row?.facts && typeof row.facts === 'object') ? row.facts : {};
 const normKey = value => cleanText(value).replace(/[ي]/g,'ی').replace(/[ك]/g,'ک').replace(/\s+/g,' ').trim();
 const fact = (...labels) => {
   const wanted = labels.flat().map(normKey).filter(Boolean);
   for (const [key, value] of Object.entries(facts)) {
     const nk = normKey(key);
     if (wanted.some(w => nk === w || nk.includes(w) || w.includes(nk))) {
       const v = cleanText(value);
       if (v) return v;
     }
   }
   return '';
 };
 const serializedFacts = Object.entries(facts).map(([k,v]) => `${k}: ${v}`).join(' | ');
 const positionFactSource = cleanText([requirements, rowText, serializedFacts].filter(Boolean).join(' '));
 const cleanedRequirements = cleanPositionNarrative(requirements, row?.title || '');
 const reqAndBenefits = [positionFactSource, benefits].filter(Boolean).join('\n');
 const cooperationRaw = fact('نوع همکاری','نوع قرارداد') || extractPositionFact(positionFactSource, ['نوع همکاری','نوع قرارداد']);
 const cooperation = normalizeCooperation(cooperationRaw || positionFactSource);
 const explicitContract = fact('نوع قرارداد') || extractPositionFact(positionFactSource, ['نوع قرارداد']);
 const rowCity = normalizeCityCandidate(
   fact('شهر','محل کار','موقعیت مکانی') || extractPositionFact(positionFactSource, ['شهر','محل کار','موقعیت مکانی']) || detectCity(reqAndBenefits)
 );
 const address = fact('آدرس','محل کار') || extractPositionFact(positionFactSource, ['آدرس','محل کار']) || baseData?.structured?.address_detail || '';
 const explicitSalary = fact('بازه حقوق','حقوق ماهانه','حقوق') || (/(?:بازه\s*حقوق|حقوق\s*ماهانه|حقوق)\s*[:：]/u.test(positionFactSource) ? extractPositionFact(positionFactSource, ['بازه حقوق','حقوق ماهانه','حقوق']) : '');

 // Category-specific facts are copied only when they are explicit in the current
 // position row. This is intentionally source-first: no fabricated defaults.
 const specific = {};
 const putSpecific = (key, value) => {
   if (Array.isArray(value)) {
     const vals = [...new Set(value.map(cleanText).filter(Boolean))];
     if (vals.length) specific[key] = vals;
   } else {
     const v = cleanText(value);
     if (v) specific[key] = v;
   }
 };
 const ptitle = normKey(row?.title || '');
 const ptext = normKey(positionFactSource);
 const listSalesChannels = () => {
   const vals = [];
   if (/فروش\s*حضوری/u.test(ptext)) vals.push('حضوری');
   if (/فروش\s*تلفنی|تله.?مارکت/u.test(ptext)) vals.push('تلفنی');
   if (/فروش\s*آنلاین|فروش\s*اینترنتی/u.test(ptext)) vals.push('آنلاین');
   if (/ویزیتور|ویزیتوری/u.test(ptext)) vals.push('ویزیتوری');
   if (/\bB2B\b|بی\s*تو\s*بی/iu.test(ptext)) vals.push('B2B');
   if (/صادرات|بازرگانی/u.test(ptext)) vals.push('صادرات و بازرگانی');
   return vals;
 };
 if (/حسابدار|حسابداری|مالی|خزانه|حسابرس/u.test(ptitle)) {
   putSpecific('accounting_area', fact('حوزه مالی / حسابداری','حوزه حسابداری','واحد مالی','نوع حسابداری'));
   putSpecific('tax_insurance_knowledge', fact('آشنایی با مالیات، بیمه و قوانین مرتبط','مالیات و بیمه','قوانین مالیاتی','مالیات'));
 }
 if (/فروش|بازاریاب|ویزیتور|بازرگان/u.test(ptitle)) {
   putSpecific('sales_channel', fact('کانال فروش / بازاریابی','کانال فروش','شیوه فروش') || listSalesChannels());
   putSpecific('commission_model', fact('پورسانت و پاداش','پورسانت','پاداش فروش'));
   putSpecific('target_kpi', fact('هدف یا شاخص عملکرد','هدف فروش','تارگت','KPI','شاخص عملکرد'));
 }
 if (/انبار|لجستیک|راننده|پیک|پخش|توزیع|لیفتراک/u.test(ptitle)) {
   putSpecific('vehicle_requirement', fact('وسیله نقلیه مورد نیاز','وسیله نقلیه','خودرو مورد نیاز'));
   putSpecific('license_requirement', fact('نوع گواهینامه لازم','گواهینامه','مجوز رانندگی'));
   putSpecific('route_area', fact('محدوده مسیر یا توزیع','محدوده توزیع','مسیر توزیع','محدوده مسیر'));
 }
 if (/مهندس|تکنسین|فنی|تصفیه|تأسیسات|تاسیسات|برق|مکانیک|عمران|معمار/u.test(ptitle)) {
   putSpecific('engineering_discipline', fact('رشته / گرایش تخصصی','رشته تخصصی','گرایش تخصصی'));
   putSpecific('professional_license', fact('پروانه یا صلاحیت حرفه‌ای','پروانه','صلاحیت حرفه‌ای','مجوز حرفه‌ای'));
 }
 if (/مدرس|معلم|مربی|آموزش|پانسیون|مراقب/u.test(ptitle)) {
   putSpecific('teaching_subject', fact('موضوع یا رشته آموزشی','موضوع آموزشی','رشته آموزشی','درس'));
   putSpecific('learner_level', fact('گروه سنی / سطح فراگیران','گروه سنی','سطح فراگیران','پایه تحصیلی'));
   putSpecific('teaching_mode', fact('شیوه آموزش','روش تدریس'));
 }
 if (/خدمات|نظافت|نگهبان|سرایدار|آبدارچی/u.test(ptitle)) {
   putSpecific('service_area', fact('حوزه خدمات','نوع خدمات'));
   putSpecific('physical_requirements', fact('شرایط جسمانی یا فعالیت میدانی','شرایط جسمانی','فعالیت میدانی'));
   putSpecific('required_equipment', fact('ابزار یا تجهیزات مورد نیاز','تجهیزات مورد نیاز','ابزار مورد نیاز'));
 }
 if (/تولید|اپراتور|مونتاژ|بسته.?بندی|کنترل کیفیت/u.test(ptitle)) {
   putSpecific('production_line', fact('خط تولید / واحد کاری','خط تولید','واحد کاری'));
   putSpecific('machine_types', fact('ماشین‌آلات یا دستگاه‌های مرتبط','ماشین آلات','دستگاه‌های مرتبط','دستگاه'));
   putSpecific('safety_certificates', fact('الزامات ایمنی و گواهی‌ها','گواهی ایمنی','الزامات ایمنی'));
 }
 if (/برنامه.?نویس|شبکه|IT|آی.?تی|داده|نرم.?افزار/u.test(ptitle)) {
   putSpecific('tech_stack', fact('فناوری‌ها و مهارت‌های فنی','فناوری‌ها','مهارت‌های فنی','Tech Stack'));
   putSpecific('skill_assessment', fact('شیوه ارزیابی مهارت','ارزیابی مهارت'));
 }
 if (/آشپز|رستوران|باریستا|قناد|صندوق|سالن/u.test(ptitle)) {
   putSpecific('restaurant_station', fact('بخش یا ایستگاه کاری','ایستگاه کاری','بخش کاری'));
   putSpecific('hygiene_card', fact('کارت بهداشت'));
   putSpecific('meal_benefit', fact('وعده غذایی / تخفیف پرسنلی','وعده غذایی','تخفیف پرسنلی'));
 }
 if (/پزشک|پرستار|داروخانه|آزمایشگاه|دندان|کلینیک|زیبایی/u.test(ptitle)) {
   putSpecific('medical_specialty', fact('تخصص یا واحد درمانی','تخصص','واحد درمانی'));
   putSpecific('clinical_setting', fact('محیط کاری','محیط درمانی'));
 }
 if (/منابع انسانی|کارگزینی|استخدام|HR/u.test(ptitle)) {
   putSpecific('hr_area', fact('حوزه منابع انسانی','حوزه HR'));
   putSpecific('labor_law_knowledge', fact('آشنایی با قانون کار و تأمین اجتماعی','قانون کار','تأمین اجتماعی'));
 }
 if (/طراح|گرافیک|محتوا|رسانه|عکاس|ویدئو|موشن/u.test(ptitle)) putSpecific('content_specialty', fact('حوزه طراحی / محتوا','حوزه طراحی','حوزه محتوا'));
 if (/حقوق|وکیل|قرارداد/u.test(ptitle)) {
   putSpecific('legal_area', fact('حوزه حقوقی','تخصص حقوقی'));
   putSpecific('contract_experience', fact('تجربه قراردادها و دعاوی','تجربه قرارداد','دعاوی'));
 }
 if (/کشاورز|کشاورزی|دام|طیور|گلخانه|باغ/u.test(ptitle)) {
   putSpecific('agriculture_area', fact('حوزه کشاورزی / دام','حوزه کشاورزی','حوزه دام'));
   putSpecific('field_work', fact('نیاز به فعالیت میدانی','فعالیت میدانی'));
 }
 if (/اداری|منشی|مسئول دفتر|دفتری/u.test(ptitle)) {
   putSpecific('typing_speed', fact('سرعت تایپ یا مهارت ورود داده','سرعت تایپ','ورود داده'));
   putSpecific('language_requirement', fact('زبان خارجی مورد نیاز','زبان خارجی'));
 }

 const structured = {
   city_name: rowCity || baseData?.structured?.city_name || baseData?.cityExact || '',
   source_city: rowCity || baseData?.structured?.source_city || baseData?.cityExact || '',
   source_category: baseData?.structured?.source_category || baseData?.sourceCategory || '',
   company_name: baseData?.structured?.company_name || baseData?.companyName || '',
   company_activity: baseData?.structured?.company_activity || '',
   address_detail: address,
   cooperation_type: cooperation,
   contract_type: explicitContract,
   workplace_mode: fact('نحوه حضور','محل فعالیت') || extractPositionFact(positionFactSource, ['نحوه حضور','محل فعالیت']),
   salary_range: explicitSalary,
   experience_years: fact('سابقه کار','سابقه') || extractPositionFact(positionFactSource, ['سابقه کار','سابقه']),
   education_level: fact('حداقل تحصیلات','تحصیلات','مدرک تحصیلی','مقطع تحصیلی') || extractPositionFact(positionFactSource, ['حداقل تحصیلات','تحصیلات','مدرک تحصیلی','مقطع تحصیلی']),
   study_field: fact('رشته تحصیلی','گروه رشته تحصیلی','رشته / گرایش تخصصی') || extractStudyField(positionFactSource),
   gender_preference: fact('جنسیت') || extractPositionFact(positionFactSource, ['جنسیت']),
   age_range: fact('بازه سنی','رده سنی','سن','حداکثر سن','حداقل سن') || extractPositionFact(positionFactSource, ['بازه سنی','رده سنی','سن','حداکثر سن','حداقل سن']),
   military_status: fact('وضعیت سربازی') || extractPositionFact(positionFactSource, ['وضعیت سربازی']),
   vacancy_count: fact('تعداد نیروی مورد نیاز','تعداد نیروی موردنیاز','تعداد نفر','تعداد') || extractPositionFact(positionFactSource, ['تعداد نیروی مورد نیاز','تعداد نیروی موردنیاز','تعداد نفر','تعداد']),
   seniority_level: fact('سطح شغلی','رده شغلی') || extractPositionFact(positionFactSource, ['سطح شغلی','رده شغلی']) || (/مدیر/u.test(cleanText(row?.title || '')) ? 'مدیر' : (/سرپرست/u.test(cleanText(row?.title || '')) ? 'سرپرست' : '')),
   // E-Estekhdam schedule is SOURCE-EXPLICIT only. Never infer work time/days/shift
   // from requirements, interview/contact instructions, or free narrative text.
   preferred_shift: fact('شیفت کاری','شیفت'),
   work_days: fact('روزهای کاری','روز کاری'),
   work_hours: fact('ساعات کاری','ساعت کاری'),
   trial_period: fact('دوره آزمایشی') || extractPositionFact(positionFactSource, ['دوره آزمایشی']),
   overtime: fact('اضافه‌کاری','اضافه کاری') || extractPositionFact(positionFactSource, ['اضافه‌کاری','اضافه کاری']),
   interview_method: fact('مراحل مصاحبه','روش مصاحبه') || extractPositionFact(positionFactSource, ['مراحل مصاحبه','روش مصاحبه']),
   insurance: fact('بیمه') || explicitInsuranceFromBenefits(benefits),
   benefits_description: benefits,
   technical_skills: extractExplicitTechnicalSkills(cleanedRequirements || requirements),
   requirements: cleanedRequirements || requirements,
   soft_skills: cleanedRequirements || requirements,
   required_documents: fact('مدارک لازم برای درخواست','مدارک مورد نیاز'),
   responsibilities: '',
   job_description: '',
   hiring_timeline: fact('زمان شروع همکاری','زمان‌بندی جذب','مهلت ارسال رزومه','مهلت درخواست') || extractPositionFact(positionFactSource, ['زمان شروع همکاری','زمان‌بندی جذب','مهلت ارسال رزومه','مهلت درخواست']),
   ...specific
 };

 const locationText = [rowCity, address, baseData?.locationText || ''].filter(Boolean).join(' ');
 const contentText = [row?.title || '', cleanedRequirements || requirements, benefits, address].filter(Boolean).join('\n');
 const contentHtml = [
   (cleanedRequirements || requirements) ? `<h3>شرایط احراز و شرح همکاری</h3><p>${escapeHtml(cleanedRequirements || requirements).replace(/\n/g, '<br>')}</p>` : '',
   benefits ? `<h3>مزایا و تسهیلات</h3><p>${escapeHtml(benefits).replace(/\n/g, '<br>')}</p>` : '',
   address ? `<h3>محل کار</h3><p>${escapeHtml(address)}</p>` : ''
 ].filter(Boolean).join('');

 return {
   ...baseData,
   title: cleanText(row?.title || baseData?.title || ''),
   contentText,
   contentHtml,
   locationText,
   cityExact: rowCity || baseData?.cityExact || '',
   structured,
   multi_position: true,
   position_index: rowIndex + 1,
   position_count: positionCount,
   position_ordinal: rowIndex + 1
 };
}

function normalizedPositionTitle(title) {
 return cleanText(title)
   .toLowerCase()
   .replace(/[ي]/g, 'ی')
   .replace(/[ك]/g, 'ک');
}

function positionSourceId(pageSourceId, title, duplicateOrdinal = 0) {
 const normalizedTitle = normalizedPositionTitle(title);
 const digest = createHash('sha256').update(normalizedTitle).digest('hex').slice(0, 12);
 return `${pageSourceId}-pos-${digest}${duplicateOrdinal > 0 ? `-${duplicateOrdinal}` : ''}`;
}

function escapeHtml(value) {
 return String(value || '')
   .replace(/&/g, '&amp;')
   .replace(/</g, '&lt;')
   .replace(/>/g, '&gt;')
   .replace(/"/g, '&quot;')
   .replace(/'/g, '&#039;');
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
 .normalize('NFKC')
 .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
 .replace(/[يى]/g, 'ی')
 .replace(/ك/g, 'ک')
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
 const rootRawText = String(root?.innerText || root?.textContent || '');
 const rootLines = rootRawText.split(/\n+/).map(clean).filter(Boolean);
 const contentText = clean(rootRawText || bodyText);
 const contentHtml = root?.innerHTML || '';

 // Exact adjacent-line parsing accepts an explicit line scope. E-Estekhdam
 // keeps the historical page scope; Divar is restricted to the current-ad
 // portion so related/recommended cards cannot become vacancy facts.
 const lineValueAfter = (labels, lines = bodyLines) => {
   const wanted = (Array.isArray(labels) ? labels : [labels]).map(normalizeLabel);
   for (let i = 0; i < lines.length - 1; i++) {
     if (wanted.includes(normalizeLabel(lines[i]))) {
       const value = clean(lines[i + 1]);
       if (value && value.length <= 300) return value;
     }
   }
   return '';
 };
 const sectionLines = (startLabels, stopLabels, lines = bodyLines) => {
   const starts = (Array.isArray(startLabels) ? startLabels : [startLabels]).map(normalizeLabel);
   const stops = (Array.isArray(stopLabels) ? stopLabels : [stopLabels]).map(normalizeLabel);
   let start = -1;
   for (let i = 0; i < lines.length; i++) {
     if (starts.includes(normalizeLabel(lines[i]))) { start = i + 1; break; }
   }
   if (start < 0) return '';
   const out = [];
   for (let i = start; i < lines.length; i++) {
     const label = normalizeLabel(lines[i]);
     if (stops.includes(label)) break;
     if (lines[i]) out.push(lines[i]);
     if (out.length >= 24) break;
   }
   return clean(out.join(' • '));
 };
 const divarStopLabels = new Set([
   'آگهی‌های مشابه','آگهی های مشابه','آگهی‌های مرتبط','آگهی های مرتبط',
   'آگهی‌های پیشنهادی','آگهی های پیشنهادی','لینک های مرتبط','لینک‌های مرتبط'
 ].map(normalizeLabel));
 let divarAdLines = rootLines;
 if (source === 'divar') {
   const stopIndex = rootLines.findIndex(line => {
     const normalized = normalizeLabel(line);
     return [...divarStopLabels].some(stop => normalized === stop || normalized.startsWith(`${stop} `));
   });
   if (stopIndex > 0) divarAdLines = rootLines.slice(0, stopIndex);
 }

 // Build a conservative label/value map. Only short, local rows are accepted,
 // which prevents "similar jobs" cards from becoming job facts.
 const labelValues = {};
 const knownLabels = [
   'نوع همکاری','نوع قرارداد','نحوه حضور','شیوه پرداخت','روش پرداخت','حقوق','حقوق ماهانه','بازه حقوق','سابقه کار','سابقه','سابقه مورد نیاز','سابقه موردنیاز',
   'تحصیلات','حداقل تحصیلات','رشته تحصیلی','جنسیت','سن','بازه سنی','وضعیت سربازی','پایان خدمت/معافیت','پایان خدمت / معافیت',
   'تعداد نیروی مورد نیاز','تعداد نیروی موردنیاز','تعداد نفر','سطح شغلی','شیفت کاری',
   'ساعات کاری','ساعت کاری','روزهای کاری','بیمه','با بیمه','امکان دورکاری','با امکان دورکاری','محل کار','موقعیت مکانی','آدرس',
   'مزایا','تسهیلات و مزایا','سایر مزایا','مهارت‌ها','مهارت های مورد نیاز','مهارت‌های مورد نیاز','شرح وظایف','شرایط احراز',
   'حوزه فعالیت','نام شرکت','نام مجموعه','مهلت ارسال رزومه','مهلت درخواست','زمان شروع همکاری','زمان‌بندی جذب',
   'دوره آزمایشی','اضافه کاری','اضافه‌کاری','مراحل مصاحبه','روش مصاحبه','مهارت‌های رفتاری','مهارت های رفتاری',
   'امکان همکاری با افراد دارای معلولیت','محیط اصلی کار','محیط کار','مدارک لازم برای درخواست','مدارک مورد نیاز',
   'حداقل مدرک تحصیلی','مدرک تحصیلی'
 ];
 const candidates = source === 'divar'
   ? []
   : Array.from(root?.querySelectorAll?.('tr,li,dl,div,p,section') || []);
 for (const node of candidates) {
   const text = clean(node.innerText || node.textContent || '');
   if (!text || text.length > 800) continue;
   const children = Array.from(node.children || []).map(ch => clean(ch.innerText || ch.textContent || '')).filter(Boolean);
   if (children.length >= 2 && children.length <= 6) {
     const label = normalizeLabel(children[0]);
     const matched = knownLabels.find(k => { const nk = normalizeLabel(k); return label === nk || label.startsWith(`${nk} `); });
     if (matched) {
       const value = clean(children.slice(1).join(' '));
       if (value && value !== label && value.length <= 500 && !labelValues[matched]) labelValues[matched] = value;
     }
   }
   const colon = text.match(/^([^:：]{2,40})[:：]\s*(.{1,500})$/);
   if (colon) {
     const label = normalizeLabel(colon[1]);
     const matched = knownLabels.find(k => { const nk = normalizeLabel(k); return label === nk || label.startsWith(`${nk} `); });
     if (matched && !labelValues[matched]) labelValues[matched] = clean(colon[2]);
   }
 }

 // Divar is intentionally line-scoped rather than DOM-wide. Recommended cards
 // often live under the same <main>; accepting their chips would silently fill
 // missing fields with another vacancy's facts. Prefer an empty field over a
 // false value, because WordPress keeps the import as a reviewable draft.
 if (source === 'divar') {
   const booleanLabels = new Set(['با بیمه','با امکان دورکاری'].map(normalizeLabel));
   for (const key of knownLabels) {
     if (booleanLabels.has(normalizeLabel(key))) continue;
     const value = lineValueAfter(key, divarAdLines);
     if (value && !labelValues[key]) labelValues[key] = value;
   }
   for (const line of divarAdLines) {
     if (!line || line.length > 520) continue;
     const colon = line.match(/^([^:：]{2,40})[:：]\s*(.{1,500})$/);
     if (colon) {
       const label = normalizeLabel(colon[1]);
       const matched = knownLabels.find(k => normalizeLabel(k) === label);
       if (matched && !labelValues[matched]) labelValues[matched] = clean(colon[2]);
       continue;
     }
     const normalized = normalizeLabel(line);
     const matched = knownLabels
       .map(k => [k, normalizeLabel(k)])
       .filter(([,nk]) => !booleanLabels.has(nk) && normalized.startsWith(`${nk} `))
       .sort((a,b) => b[1].length - a[1].length)[0];
     if (matched) {
       const value = clean(normalized.slice(matched[1].length));
       if (value && value.length <= 300 && !labelValues[matched[0]]) labelValues[matched[0]] = value;
     }
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

 // Divar's current jobs UI uses these labels (including diacritics on some
 // surfaces). Read exact adjacent values as a second conservative source.
 if (source === 'divar') {
   const exactPairs = {
     'نوع همکاری': lineValueAfter('نوع همکاری', divarAdLines),
     'شیوه پرداخت': lineValueAfter(['شیوه پرداخت','روش پرداخت'], divarAdLines),
     'حقوق': lineValueAfter(['حقوق','حقوق ماهانه','بازه حقوق'], divarAdLines),
     'سابقه مورد نیاز': lineValueAfter(['سابقه مورد نیاز','سابقه موردنیاز'], divarAdLines),
     'پایان خدمت/معافیت': lineValueAfter(['پایان خدمت/معافیت','پایان خدمت / معافیت'], divarAdLines),
     'بیمه': lineValueAfter('بیمه', divarAdLines),
     'امکان دورکاری': lineValueAfter('امکان دورکاری', divarAdLines)
   };
   // Source-scoped Divar facts take precedence over generic DOM candidates.
   for (const [k,v] of Object.entries(exactPairs)) if (v) labelValues[k] = v;
 }

 const divarDescription = source === 'divar'
   ? sectionLines(
       ['توضیحات','شرح آگهی'],
       ['اطلاعات تماس','چت و تماس','گزارش آگهی','نکات امنیتی','آگهی‌های مشابه','آگهی های مشابه','آگهی‌های مرتبط','آگهی های مرتبط'],
       divarAdLines
     )
   : '';

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

 const markerRegex = /اطلاعات تماس|نحوه ارتباط|راه ارتباطی|شماره تماس|موبایل|تلفن|واتس.?اپ|تلگرام|ایمیل|چت و تماس/i;
 const directContactEvidence = /(?:^|\D)(?:0?9(?:[\s\-().]*\d){9}|0?28(?:[\s\-().]*\d){7,8})(?!\d)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
 const contactSearchRoot = root || document;
 const markerNodes = Array.from(contactSearchRoot.querySelectorAll('h1,h2,h3,h4,strong,b,p,span,div,section,button,a'));
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
     if (!evidence) continue;
     const score = 10000 - text.length;
     if (score > bestContactScore) { bestContactScore = score; contactRoot = current; }
     if (text.length < 1800) break;
   }
 }
 // For E-Estekhdam, absence of an explicit local contact block means there
 // is no direct employer contact. Never fall back to the full page: footer/admin
 // links belong to E-Estekhdam itself and must not qualify the vacancy.
 // No source falls back to the whole page for contact evidence.

 const scopedContactText = clean(contactRoot?.innerText || contactRoot?.textContent || '');
 const scopedLinks = Array.from(contactRoot?.querySelectorAll?.('a[href]') || [], a => a.href)
   .filter(href => /^(tel:|sms:|mailto:)|wa\.me|whatsapp|t\.me/i.test(href))
   .filter(href => !/(?:e[-_]?estekhdam|eestekhdam|divar\.ir)/i.test(href));
 const contactLinks = [...new Set(scopedLinks)];
 const contactText = scopedContactText;

 const publishedAt = clean(
   jobPosting?.datePosted ||
   document.querySelector('meta[property="article:published_time"]')?.content ||
   ''
 );

 const hasExactRootText = wanted => {
   const target = normalizeLabel(wanted);
   if (source === 'divar') return divarAdLines.some(line => normalizeLabel(line) === target);
   return Array.from(root?.querySelectorAll?.('span,div,p,li,strong,b') || [])
     .some(node => normalizeLabel(node.innerText || node.textContent || '') === target);
 };
 const divarRemoteFlag = source === 'divar'
   ? clean(labelValues['امکان دورکاری'] || labelValues['با امکان دورکاری'] || '')
   : '';
 // Divar's «با امکان دورکاری» is only a boolean capability. It does not prove
 // that the job is explicitly hybrid or fully remote, so preserve the exact
 // source fact without fabricating a canonical workplace_mode.
 const divarRemotePossible = source === 'divar' && (
   /^(?:بله|دارد|فعال|امکان.?پذیر)$/u.test(divarRemoteFlag) ||
   hasExactRootText('با امکان دورکاری')
 ) ? 'بله' : '';
 const divarInsuranceHint = source === 'divar' && hasExactRootText('با بیمه') ? 'بیمه دارد' : '';

 const structured = {
   city_name: cityExact,
   source_city: cityExact,
   source_category: sourceCategory,
   company_name: companyName,
   company_activity: labelValues['حوزه فعالیت'] || clean(jobPosting?.industry || ''),
   cooperation_type: labelValues['نوع همکاری'] || labelValues['نوع قرارداد'] || clean(jobPosting?.employmentType || ''),
   contract_type: labelValues['نوع قرارداد'] || '',
   workplace_mode: labelValues['نحوه حضور'] || '',
   remote_possible: divarRemotePossible,
   salary_structure: labelValues['شیوه پرداخت'] || labelValues['روش پرداخت'] || '',
   salary_range: labelValues['بازه حقوق'] || labelValues['حقوق ماهانه'] || labelValues['حقوق'] || '',
   experience_years: labelValues['سابقه کار'] || labelValues['سابقه مورد نیاز'] || labelValues['سابقه موردنیاز'] || labelValues['سابقه'] || labelValues['شرایط احراز'] || clean(jobPosting?.experienceRequirements || ''),
   education_level: labelValues['حداقل تحصیلات'] || labelValues['تحصیلات'] || clean(jobPosting?.educationRequirements || ''),
   study_field: labelValues['رشته تحصیلی'] || '',
   gender_preference: labelValues['جنسیت'] || '',
   age_range: labelValues['بازه سنی'] || labelValues['سن'] || '',
   military_status: labelValues['وضعیت سربازی'] || labelValues['پایان خدمت/معافیت'] || labelValues['پایان خدمت / معافیت'] || '',
   vacancy_count: labelValues['تعداد نیروی مورد نیاز'] || labelValues['تعداد نیروی موردنیاز'] || labelValues['تعداد نفر'] || '',
   seniority_level: labelValues['سطح شغلی'] || '',
   preferred_shift: labelValues['شیفت کاری'] || '',
   work_days: labelValues['روزهای کاری'] || '',
   work_hours: labelValues['ساعات کاری'] || labelValues['ساعت کاری'] || '',
   trial_period: labelValues['دوره آزمایشی'] || '',
   overtime: labelValues['اضافه‌کاری'] || labelValues['اضافه کاری'] || '',
   interview_method: labelValues['مراحل مصاحبه'] || labelValues['روش مصاحبه'] || '',
   insurance: labelValues['بیمه'] || labelValues['با بیمه'] || divarInsuranceHint || '',
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
   job_description: clean(jobPosting?.description || divarDescription || '')
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
 let lastError = null;
 for (let attempt = 1; attempt <= 2; attempt++) {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), 25000);
   try {
     const response = await fetch(statusEndpoint, {
       headers: { 'X-QZIH-Token': TOKEN, 'User-Agent': 'QazvinJobsImportCrawler/0.3.45' },
       signal: controller.signal
     });
     if (!response.ok) throw new Error(`HTTP ${response.status}`);
     const json = await response.json();
     const controlled = json?.controlled_test || { active: false };
     return { ...controlled, via: 'crawler_fetch' };
   } catch (error) {
     lastError = error;
     console.warn(`WordPress controlled-test status attempt ${attempt}/2 failed: ${error.message}`);
     if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1200));
   } finally {
     clearTimeout(timer);
   }
 }
 console.warn(`WordPress controlled-test status unavailable after retries: ${lastError?.message || 'unknown error'}`);
 return { active: false };
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
 'User-Agent': 'QazvinJobsImportCrawler/0.3.45'
 },
 body: JSON.stringify({ source: 'multi', crawler_version: '0.3.45', items }),
 signal: controller.signal
 });
 const body = await response.text();
 if (!response.ok) throw new Error(`WordPress receiver HTTP ${response.status}: ${body.slice(0, 1000)}`);
 console.log(`WordPress receiver accepted batch: ${body}`);
 try {
   return JSON.parse(body);
 } catch {
   return { accepted: items.length, results: items.map(() => ({ status: 'accepted' })) };
 }
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
 'User-Agent': 'QazvinJobsImportCrawler/0.3.45'
 },
 body: JSON.stringify({ source: 'multi', crawler_version: '0.3.45', items: [], diagnostics }),
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
 headers: { 'X-QZIH-Token': TOKEN, 'User-Agent': 'QazvinJobsImportCrawler/0.3.45' }
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
function controlledIdentityMatches(sourceUrl, source, control) {
 const expectedUrl = cleanUrl(control?.url || '');
 const expectedId = String(control?.source_id || '').trim().toLowerCase();
 const actualId = sourceId(sourceUrl, source);
 if (source === 'e-estekhdam' && expectedId && actualId) return expectedId === actualId;
 return Boolean(expectedUrl && cleanUrl(sourceUrl) === expectedUrl);
}

async function saveEEstekhdamControlledDiagnostics(page, sourceUrl, baseData, positionRows) {
 const directory = 'e-estekhdam-controlled-diagnostics';
 await mkdir(directory, { recursive: true });
 const id = (sourceId(sourceUrl, 'e-estekhdam') || `eest-${Date.now()}`)
   .replace(/[^a-z0-9_-]+/gi, '-')
   .slice(0, 90);
 const prefix = `${directory}/${id}`;
 const domSummary = await page.evaluate(() => {
   const clean = v => String(v || '').replace(/[\u200c\u200f\u202a-\u202e]/g, ' ').replace(/\s+/g, ' ').trim();
   const tables = Array.from(document.querySelectorAll('table,[role="table"],[role="grid"]')).slice(0, 20).map((table, ti) => ({
     index: ti,
     tag: table.tagName,
     role: table.getAttribute('role') || '',
     text: clean(table.innerText || table.textContent || '').slice(0, 12000),
     rows: Array.from(table.querySelectorAll('tr,[role="row"]')).slice(0, 40).map((row, ri) => ({
       index: ri,
       text: clean(row.innerText || row.textContent || '').slice(0, 5000),
       cells: Array.from(row.querySelectorAll(':scope > th,:scope > td,:scope > [role="columnheader"],:scope > [role="cell"],:scope > [role="gridcell"]')).map(cell => clean(cell.innerText || cell.textContent || '').slice(0, 3000))
     }))
   }));
   const factBlocks = Array.from(document.querySelectorAll('article,section,li,div')).map((node, index) => {
     const text = clean(node.innerText || node.textContent || '');
     return { index, tag: node.tagName, cls: node.className || '', text };
   }).filter(x => x.text.length >= 20 && x.text.length <= 6000 && /جنسیت|نوع\s*(?:قرارداد|همکاری)|سابقه\s*کار|مدرک\s*تحصیلی|حقوق|بیمه/u.test(x.text)).slice(0, 120);
   return { tables, factBlocks };
 });
 await page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {});
 await writeFile(`${prefix}.html`, await page.content().catch(() => ''), 'utf8').catch(() => {});
 await writeFile(`${prefix}.json`, JSON.stringify({
   crawler_version: '0.3.45',
   source_url: sourceUrl,
   current_url: page.url(),
   source_id: sourceId(sourceUrl, 'e-estekhdam'),
   title: baseData?.title || '',
   positions_found: Array.isArray(positionRows) ? positionRows.length : 0,
   positions: positionRows || [],
   visible_page_text: cleanText(await page.locator('body').innerText().catch(() => '')).slice(0, 50000),
   dom_summary: domSummary
 }, null, 2), 'utf8');
 console.log(`E-Estekhdam controlled diagnostics saved: ${prefix} (positions=${Array.isArray(positionRows) ? positionRows.length : 0})`);
}

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
 if (max <= 3) return '۱ تا ۳ سال';
 if (max <= 5) return '۳ تا ۵ سال';
 return 'بیشتر از ۵ سال';
}

function extractSoftwareTools(text) {
 const t = cleanText(text);
 if (!t) return '';
 const out = [];
 const add = value => { if (value && !out.includes(value)) out.push(value); };
 const known = [
   ['هلو', /(?:^|\s)هلو(?:\s|$|[،؛,.])/u],
   ['سپیدار', /سپیدار/u],
   ['راهکاران', /راهکاران/u],
   ['Excel', /(?:excel|اکسل)/iu],
   ['Word', /(?:word|ورد)/iu],
   ['PowerPoint', /(?:powerpoint|پاورپوینت)/iu],
   ['Microsoft Office', /(?:microsoft\s*office|\boffice\b|آفیس)/iu],
   ['AutoCAD', /(?:autocad|اتوکد)/iu],
   ['SolidWorks', /(?:solidworks|solid\s*works|سالیدورکس)/iu],
   ['Revit', /(?:revit|رویت)/iu],
   ['ETABS', /(?:etabs|ایتبس)/iu],
   ['Microsoft Project', /(?:microsoft\s*project|ms\s*project)/iu],
   ['Inventor', /(?:inventor|اینونتور)/iu],
   ['CATIA', /(?:catia|کتیا)/iu],
   ['CRM', /(?:crm|سی\s*آر\s*ام)/iu],
   ['اتوماسیون اداری', /اتوماسیون\s*اداری/u],
   ['نرم‌افزارهای مالی', /نرم(?:‌|\s)*افزارهای?\s*مالی/u]
 ];
 for (const [label,re] of known) if (re.test(t)) add(label);
 return out.join('، ');
}

function normalizeInsurance(value) {
 const t = cleanText(value);
 if (!t) return '';
 if (/^(?:بله|دارد|فعال|yes)$/i.test(t)) return 'بیمه دارد';
 if (/^(?:خیر|ندارد|غیرفعال|no)$/i.test(t)) return 'بیمه ندارد';
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
 add(/سرویس(?:\s*(?:رفت\s*و\s*برگشت|رفت‌وبرگشت|ایاب\s*و\s*ذهاب))?/.test(t),'سرویس رفت‌وبرگشت');
 add(/صبحانه/.test(t),'صبحانه');
 add(/ناهار|غذا|وعده/.test(t),'ناهار / غذا');
 add(/جای\s*خواب|خوابگاه/.test(t),'جای خواب');
 add(/وام/.test(t),'وام');
 add(/آموزش\s*(?:رایگان|حین\s*کار)/.test(t),'آموزش رایگان');
 add(/ساعت.*منعطف|ساعات.*منعطف/.test(t),'ساعت منعطف');
 add(/هدایای\s*مناسبتی|هدیه\s*مناسبتی|هدایای?\s*مناسبت/.test(t),'هدایا');
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
 if (/مهم\s*نیست|فرقی\s*ندارد|الزامی\s*نیست|لازم\s*نیست|نیازی\s*نیست|^(?:خیر|نه)$/u.test(t)) return 'مهم نیست';
 if (/^(?:بله|دارد|الزامی)$/u.test(t)) return 'پایان خدمت / معافیت الزامی';
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
 // Never treat a generic mention such as «نرم افزارهای مالی» as the applicant's
 // university field. Only inspect text that has an explicit education/field cue.
 const cuePatterns = [
   /(?:رشته(?:\s*تحصیلی)?|گرایش)\s*[:：]?\s*([^،؛.]{2,100})/u,
   /(?:مدرک(?:\s*تحصیلی)?|حداقل\s*مدرک)\s*[:：]?\s*([^،؛.]{2,130})/u,
   /(?:کارشناسی(?:\s*ارشد)?|لیسانس|فوق\s*لیسانس|کاردانی|دکتری)\s+(?:در\s+)?(?:رشته\s+)?([^،؛.]{2,100})/u
 ];
 const snippets = [];
 for (const re of cuePatterns) {
   const m = t.match(re);
   if (m?.[1]) snippets.push(cleanText(m[1]));
 }
 if (!snippets.length) return '';
 const scope = snippets.join(' ');
 const known = [
  ['مهندسی شیمی',/مهندسی\s*شیمی/u],['مدیریت مالی',/مدیریت\s*مالی/u],['مهندسی صنایع',/مهندسی\s*صنایع/u],
  ['مهندسی مکانیک',/مهندسی\s*مکانیک/u],['مهندسی برق',/مهندسی\s*برق/u],['علوم آزمایشگاهی',/علوم\s*آزمایشگاهی/u],
  ['علوم تربیتی',/علوم\s*تربیتی/u],['مهندسی کامپیوتر',/مهندسی\s*کامپیوتر/u],['مهندسی نرم‌افزار',/مهندسی\s*(?:نرم\s*افزار|نرم‌افزار)/u],
  ['حسابداری',/حسابداری/u],['شیمی',/(?:^|\s)شیمی(?:\s|$)/u],['عمران',/(?:مهندسی\s*)?عمران/u],['معماری',/معماری/u],
  ['روانشناسی',/روانشناسی/u],['مدیریت',/(?:^|\s)مدیریت(?:\s|$)/u]
 ];
 for (const [label,re] of known) if (re.test(scope)) return label;
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

function isNonWorkTimeContext(value) {
 const t = cleanText(value);
 if (!t) return false;
 return /(?:مصاحبه|هماهنگ(?:ی|ی\s*برای)?|تماس|مراجعه|پاسخگویی|پاسخ\s*گویی|ارسال\s*رزومه|تحویل\s*رزومه|پیامک|واتساپ|تلگرام|ثبت\s*نام)/u.test(t);
}

function extractWorkScheduleText(value) {
 const original = toEnglishDigits(cleanText(value));
 if (!original) return '';

 // Evaluate small textual segments independently. A sentence that talks about
 // interview/contact/coordination time is not a work schedule, even if it has
 // weekdays and a numeric time range.
 const pieces = original
   .split(/[\n؛.!؟]+/u)
   .map(cleanText)
   .filter(Boolean)
   .filter(piece => !isNonWorkTimeContext(piece));
 const t = cleanText(pieces.join(' ؛ '));
 if (!t) return '';

 const direct = t.match(/(?:ساعت(?:‌|\s)*کار(?:ی)?|ساعات(?:‌|\s)*کاری)\s*[:：]?\s*(\d{1,2}(?::\d{2})?\s*(?:تا|-|الی)\s*\d{1,2}(?::\d{2})?)/u);
 if (direct) return `ساعت کاری ${direct[1]}`;
 const daySchedule = t.match(/((?:شنبه|یکشنبه|دوشنبه|سه.?شنبه|چهارشنبه|پنجشنبه|جمعه)[^.!؟؛]{0,180}?(?:\d{1,2}(?::\d{2})?\s*(?:تا|-|الی)\s*\d{1,2}(?::\d{2})?))/u);
 if (daySchedule) return cleanText(daySchedule[1]);
 const plain = t.match(/(\d{1,2}(?::\d{2})?\s*(?:تا|-|الی)\s*\d{1,2}(?::\d{2})?)/u);
 return plain ? `ساعت کاری ${plain[1]}` : '';
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

function normalizeSalaryStructure(value) {
 const t = cleanText(value);
 if (!t) return '';
 if (/توافق/.test(t)) return 'توافقی';
 if (/قانون\s*کار|وزارت\s*کار/.test(t)) return 'مطابق قانون کار';
 if (/(?:ثابت|حقوق).{0,20}(?:پورسانت|درصد)|(?:پورسانت|درصد).{0,20}(?:ثابت|حقوق)/.test(t)) return 'ثابت + پورسانت';
 if (/پورسانت|درصد/.test(t)) return 'پورسانتی';
 if (/ساعتی/.test(t)) return 'ساعتی';
 if (/روزانه/.test(t)) return 'روزانه';
 if (/پروژه/.test(t)) return 'پروژه‌ای';
 if (/ماهانه|حقوق\s*ثابت|پرداخت\s*ماهانه/.test(t)) return 'حقوق ثابت ماهانه';
 return '';
}

function normalizeSalaryRangeBucket(value) {
 const t = cleanSourceSalary(value);
 if (!t) return '';
 if (/توافقی/.test(t)) return 'توافقی';
 if (/قانون\s*کار|وزارت\s*کار/.test(t)) return 'مطابق قانون کار';
 const latin = toEnglishDigits(t).replace(/[,٬]/g,'');
 const nums = [...latin.matchAll(/(\d+(?:\.\d+)?)\s*(?:میلیون|م(?:\s|$))/g)].map(m => Number(m[1])).filter(Number.isFinite);
 if (!nums.length) return '';
 const range = latin.match(/(\d+(?:\.\d+)?)\s*(?:تا|-|الی)\s*(\d+(?:\.\d+)?)\s*(?:میلیون|م)/);
 const maxHint = /حداکثر|تا\s*سقف/u.test(t);
 const minHint = /حداقل|از\s+/u.test(t);
 let representative = nums[0];
 if (range) representative = (Number(range[1]) + Number(range[2])) / 2;
 else if (maxHint) representative = Math.max(0, nums[0] - 0.01);
 else if (minHint) representative = nums[0];
 if (representative < 15) return 'کمتر از ۱۵ میلیون تومان';
 if (representative < 20) return '۱۵ تا ۲۰ میلیون تومان';
 if (representative < 25) return '۲۰ تا ۲۵ میلیون تومان';
 if (representative < 30) return '۲۵ تا ۳۰ میلیون تومان';
 if (representative < 40) return '۳۰ تا ۴۰ میلیون تومان';
 if (representative < 50) return '۴۰ تا ۵۰ میلیون تومان';
 if (representative < 70) return '۵۰ تا ۷۰ میلیون تومان';
 if (representative < 100) return '۷۰ تا ۱۰۰ میلیون تومان';
 return 'بیشتر از ۱۰۰ میلیون تومان';
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
 const latin = toEnglishDigits(t).replace(/[,٬]/g,'');
 const range = latin.match(/(\d+(?:\.\d+)?)\s*(?:تا|-|الی)\s*(\d+(?:\.\d+)?)\s*(?:میلیون|م)/);
 const single = latin.match(/(\d+(?:\.\d+)?)\s*(?:میلیون|م(?:\s|$))/);
 if (range) {
   out.salary_min = Number(range[1]);
   out.salary_max = Number(range[2]);
   out.salary_period = 'میلیون تومان / ماه';
   out.salary_structure = 'حقوق ثابت ماهانه';
 } else if (single) {
   const amount = Number(single[1]);
   if (/حداکثر/u.test(t)) out.salary_max = amount;
   else if (/حداقل/u.test(t)) out.salary_min = amount;
   out.salary_period = 'میلیون تومان / ماه';
 }
 const bucket = normalizeSalaryRangeBucket(t);
 if (bucket) out.salary_range = bucket;
 out.source_salary_text = t;
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
 for (const key of SOURCE_EXPLICIT_PASSTHROUGH_FIELDS) {
   if (Object.prototype.hasOwnProperty.call(raw, key)) set(key, raw[key]);
 }
 set('cooperation_type', normalizeCooperation([raw.cooperation_type, raw.contract_type, raw.requirements, raw.technical_skills].filter(Boolean).join(' ')));
 set('contract_type', normalizeContract(raw.contract_type || ''));
 set('workplace_mode', normalizeWorkplaceMode(raw.workplace_mode || ''));
 const strictRequirementText = [raw.requirements, raw.technical_skills].filter(Boolean).join(' ');
 const experienceText = source === 'e-estekhdam' ? [raw.experience_years, strictRequirementText].filter(Boolean).join(' ') : [raw.experience_years, strictRequirementText, raw.job_description].filter(Boolean).join(' ');
 set('experience_years', normalizeExperience(experienceText));
 set('education_level', normalizeEducation(raw.education_level || strictRequirementText));
 set('study_field', extractStudyField(strictRequirementText));
 set(role === 'job_seeker' ? 'gender' : 'gender_preference', normalizeGender(raw.gender_preference || raw.gender || ''));
 set('age_range', normalizeAgeRange(raw.age_range || strictRequirementText));
 Object.assign(fields, extractAgeBounds(raw.age_range || strictRequirementText));
 const residence = extractResidenceRequirement(strictRequirementText);
 set('residence_requirement', residence.text);
 set('accepted_residence_locations', residence.locations);
 set('military_status', normalizeMilitary(raw.military_status || ''));
 set('vacancy_count', normalizeVacancyCount(raw.vacancy_count || ''));
 set(role === 'job_seeker' ? 'career_level' : 'seniority_level', normalizeSeniority(raw.seniority_level || raw.career_level || data?.title || ''));
 const scheduleFallbackText = source === 'e-estekhdam' ? '' : strictRequirementText;
 set('preferred_shift', normalizeShiftList(raw.preferred_shift || scheduleFallbackText));
 set('work_days', normalizeWorkDaysList(raw.work_days || scheduleFallbackText));
 const workScheduleInput = source === 'e-estekhdam'
   ? (raw.work_hours || '')
   : [raw.work_hours, scheduleFallbackText].filter(Boolean).join(' ');
 const workScheduleText = extractWorkScheduleText(workScheduleInput);
 set('work_schedule_text', workScheduleText);
 Object.assign(fields, parseWorkHours(workScheduleText));
 set('trial_period', normalizeTrialPeriod(raw.trial_period || ''));
 set('overtime', normalizeOvertime(raw.overtime || ''));
 set('interview_method', normalizeInterviewList(raw.interview_method || ''));
 set('insurance', normalizeInsurance(raw.insurance || explicitInsuranceFromBenefits(raw.benefits_description || '')));
 set('address_detail', raw.address_detail || '');
 const requirementText = source === 'e-estekhdam' ? strictRequirementText : [strictRequirementText, raw.job_description].filter(Boolean).join(' ');
 set('technical_skills', raw.technical_skills || '');
 set('soft_skills', normalizeSoftSkillsList(raw.soft_skills || raw.requirements || ''));
 set('required_documents', normalizeRequiredDocumentsList(raw.required_documents || ''));
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
 const benefitSource = raw.benefits_description || (source === 'divar'
   ? (raw.job_description || raw.requirements || '')
   : '');
 // Keep an explicit empty list for E-Estekhdam so WordPress cannot refill
 // benefits from similar-ad text or a previous recovered draft.
 fields.benefits_list = normalizeBenefits(benefitSource);
 const benefitSalaryText = cleanText(benefitSource);
 const explicitBenefitSalary = /حقوق\s*[:：]?\s*توافقی|حقوق\s+توافقی/u.test(benefitSalaryText) ? 'توافقی' : '';
 Object.assign(fields, parseSalaryFields(cleanSourceSalary(raw.salary_range || explicitBenefitSalary)));
 const explicitSalaryStructure = normalizeSalaryStructure(raw.salary_structure || '');
 if (explicitSalaryStructure) fields.salary_structure = explicitSalaryStructure;
 if (!fields.salary_structure && /حقوق\s*ثابت\s*ماهانه/u.test(benefitSalaryText)) fields.salary_structure = 'حقوق ثابت ماهانه';
 fields.source_name = source === 'e-estekhdam' ? 'ای‌استخدام' : 'دیوار';
 fields.source_url = sourceUrl;
 fields.source_raw_title = cleanText(data?.title || '');
 return validateCanonicalFields(fields, role);
}

function validateCanonicalFields(fields, role='employer') {
 const out = { ...(fields || {}) };
 const selects = {
   cooperation_type: ['تمام‌وقت','پاره‌وقت','پروژه‌ای / پیمانکاری','کارآموزی','ساعتی / روزانه','فریلنسری'],
   workplace_mode: ['حضوری','دورکاری','ترکیبی'],
   experience_years: ['بدون نیاز به سابقه','کمتر از ۱ سال','۱ تا ۳ سال','۳ تا ۵ سال','بیشتر از ۵ سال'],
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
   salary_structure: ['توافقی','مطابق قانون کار','حقوق ثابت ماهانه','ثابت + پورسانت','پورسانتی','ساعتی','روزانه','پروژه‌ای']
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
   benefits_list: ['بیمه تکمیلی','پاداش','پورسانت','سرویس رفت‌وبرگشت','صبحانه','ناهار / غذا','جای خواب','وام','آموزش رایگان','ساعت منعطف','هدایا','پارکینگ','بن / بسته خرید','کمک‌هزینه درمان','بیمه عمر','کمک‌هزینه رفت‌وآمد']
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

function normalizePhone(value, source = '') {
 let v = toEnglishDigits(value).replace(/\D+/g, '');
 if (v.startsWith('0098')) v = v.slice(4); else if (v.startsWith('98')) v = v.slice(2);
 if (v.length === 10 && v.startsWith('9')) v = `0${v}`;
 if (v.length === 10 && v.startsWith('28')) v = `0${v}`;
 // E-Estekhdam sometimes displays Qazvin landlines without the 028 area code.
 // This conversion is intentionally limited to the Qazvin-scoped E-Estekhdam
 // contact block and an 8-digit local landline; it is never applied globally.
 if (source === 'e-estekhdam' && /^[2-9]\d{7}$/.test(v)) v = `028${v}`;
 return v;
}
function extractNetworkContactEvidence(body, contactEndpoint = false) {
 const raw = String(body || '');
 if (!raw) return '';

 // Generic API responses can include recommended ads/account metadata. When
 // the endpoint itself is not contact-specific, keep only the subtree under a
 // clearly named contact/phone key instead of scanning the full JSON payload.
 try {
   const parsed = JSON.parse(raw);
   const pieces = [];
   const contactKey = /^(?:phone(?:_?number)?s?|mobile(?:_?number)?s?|telephone|tel|contact(?:_?info)?|contactInfo|phoneNumbers)$/i;
   const walk = (value, active = false, depth = 0) => {
     if (depth > 12 || value === null || value === undefined) return;
     if (typeof value === 'string' || typeof value === 'number') {
       if (active) pieces.push(String(value));
       return;
     }
     if (Array.isArray(value)) {
       for (const item of value.slice(0, 80)) walk(item, active, depth + 1);
       return;
     }
     if (typeof value === 'object') {
       for (const [key, child] of Object.entries(value).slice(0, 120)) {
         walk(child, active || contactKey.test(key), depth + 1);
       }
     }
   };
   walk(parsed, false, 0);
   const scoped = cleanText(pieces.join(' '));
   if (scoped) return scoped.slice(0, 100000);
 } catch {
   // Some contact endpoints return non-JSON/text bodies; only a URL already
   // classified as contact-specific is allowed to fall back to that body.
 }

 return contactEndpoint ? raw.slice(0, 100000) : '';
}

function extractContacts(text, links = [], source = '') {
 // Keep UI text and href evidence separate. In 0.3.45, concatenating hrefs into
 // `flat` plus a generic "WhatsApp exists somewhere" check could mark every
 // revealed phone as WhatsApp even when Divar only offered Call + SMS.
 const flat = toEnglishDigits(String(text || ''));
 const phones = [];
 const sms = [];
 const emails = [];
 const whatsapp = [];
 const telegram = [];
 const mobilePattern = /(?<!\d)(?:(?:\+|00)?98[\s\-().]*)?0?9(?:[\s\-().]*\d){9}(?!\d)/g;
 const landlinePattern = /(?<!\d)(?:(?:\+|00)?98[\s\-().]*)?0?28(?:[\s\-().]*\d){7,8}(?!\d)/g;

 for (const m of flat.matchAll(mobilePattern)) phones.push(normalizePhone(m[0], source));
 for (const m of flat.matchAll(landlinePattern)) phones.push(normalizePhone(m[0], source));
 if (source === 'e-estekhdam') {
   // Contact text is already restricted to the vacancy's own contact block.
   // Accept a bare 8-digit local number only when its immediate context says
   // phone/contact; then attach Qazvin's 028 area code.
   for (const m of flat.matchAll(/(?<!\d)([2-9]\d{7})(?!\d)/g)) {
     const start = Math.max(0, (m.index || 0) - 90);
     const end = Math.min(flat.length, (m.index || 0) + m[0].length + 90);
     const context = flat.slice(start, end);
     if (/(?:شماره\s*(?:تماس|تلفن)?|تلفن|تماس)/u.test(context)) phones.push(normalizePhone(m[1], source));
   }
 }
 for (const m of flat.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)) {
   if (!/@(?:e-estekhdam\.com|estekhdam\.com|divar\.ir)$/i.test(m[0])) emails.push(m[0].toLowerCase());
 }

 // Channel detection must have direct evidence. Divar's current contact sheet
 // exposes separate rows such as "تماس تلفنی با 09..." and "ارسال پیامک به 09...".
 // SMS and WhatsApp are therefore recorded only from their own href/label context.
 const phoneToken = String.raw`(?:(?:\+|00)?98[\s\-().]*)?0?9(?:[\s\-().]*\d){9}`;
 for (const m of flat.matchAll(new RegExp(String.raw`(?:ارسال\s*پیامک\s*به|پیامک\s*(?:به|:|：|-)?|sms\s*(?:to|:|-)?)[^0-9+]{0,40}(${phoneToken})`, 'gi'))) {
   sms.push(normalizePhone(m[1], source));
 }
 for (const m of flat.matchAll(new RegExp(String.raw`(?:واتساپ|واتس.?اپ|whatsapp)\s*(?:به|با|شماره|:|：|-)?\s*(${phoneToken})`, 'gi'))) {
   whatsapp.push(normalizePhone(m[1], source));
 }
 for (const m of flat.matchAll(new RegExp(String.raw`(${phoneToken})\s*(?:در|روی)?\s*(?:واتساپ|واتس.?اپ|whatsapp)`, 'gi'))) {
   whatsapp.push(normalizePhone(m[1], source));
 }

 for (const link of links) {
   if (/^tel:/i.test(link)) phones.push(normalizePhone(link, source));
   if (/^sms:/i.test(link)) {
     const n = normalizePhone(link, source);
     phones.push(n);
     sms.push(n);
   }
   if (/^mailto:/i.test(link)) {
     const e = link.replace(/^mailto:/i,'').split('?')[0];
     if (!/@(?:e-estekhdam\.com|estekhdam\.com|divar\.ir)$/i.test(e)) emails.push(e.toLowerCase());
   }
   const wa = link.match(/(?:wa\.me\/|phone=)(\+?\d{10,15})/i);
   if (wa) whatsapp.push(normalizePhone(wa[1], source));
   const tg = link.match(/t\.me\/([A-Za-z0-9_]{5,32})/i);
   if (tg) telegram.push(`@${tg[1]}`);
 }
 // Scoped ad text may publish a Telegram username without an anchor link.
 for (const m of flat.matchAll(/(?:تلگرام|telegram)\s*[:：\-]?\s*@?([A-Za-z0-9_]{5,32})/gi)) telegram.push(`@${m[1]}`);

 return {
   phones: uniq(removeLoginPhone(phones)),
   sms: uniq(removeLoginPhone(sms)),
   emails: uniq(emails),
   whatsapp: uniq(removeLoginPhone(whatsapp)),
   telegram: uniq(telegram)
 };
}
function uniq(values) { return [...new Set(values.filter(Boolean))]; }
function hasExplicitDivarContactIntent(text) {
 const normalized = toEnglishDigits(cleanText(text))
 .replace(/چت\s*و\s*تماس/gi, ' ')
 .replace(/اطلاعات\s*تماس/gi, ' ')
 .replace(/\s+/g, ' ');


 // Generic employment wording is not sufficient. The ad must explicitly ask
 // the reader to call, send an SMS, or send a resume/message.
 return /(?:تماس\s+(?:بگیرید|حاصل\s+(?:فرمایید|کنید)|برقرار\s+کنید)|لطفاً?\s+تماس|فقط\s+تماس|پیامک\s+(?:بزنید|ارسال\s+کنید|دهید)|فقط\s+پیامک|ارسال\s+رزومه|رزومه\s+(?:ارسال\s+کنید|بفرستید)|واتس.?اپ\s*(?::|：|-|کنید|پیام\s+دهید)|تلگرام\s*(?::|：|-|کنید|پیام\s+دهید)|(?:شماره\s*تماس|موبایل|تلفن|واتس.?اپ)\s*[:：\-]?\s*(?:(?:\+|00)?98[\s\-().]*)?0?9(?:[\s\-().]*\d){9}|ایمیل\s*[:：\-]?\s*[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}|جهت\s+(?:هماهنگی|همکاری)[^.!؟]{0,80}تماس)/i.test(normalized);
}


function removeLoginPhone(values) { return DIVAR_LOGIN_PHONE ? values.filter(v => normalizePhone(v) !== DIVAR_LOGIN_PHONE) : values; }
function hasContact(c) { return c.phones.length || c.emails.length || c.whatsapp.length || c.telegram.length; }
function detectRole(text) {
 const t = cleanText(text);
 if (!t) return 'employer';
 // Avoid substring traps such as «به دنبال کارشناس فروش هستیم»: the word
 // «کار» inside «کارشناس» must never turn an employer ad into a job-seeker ad.
 const strongSeeker = [
   /(?:^|[\n.!؟؛،])\s*جویای\s+کار(?:\s|$|[،؛.!؟])/u,
   /(?:^|[\n.!؟؛،])\s*جویای[^\n.!؟]{0,100}(?:\s|^)ام(?:\s|$|[،؛.!؟])/u,
   /(?:به\s+)?دنبال\s+کار(?:\s|$|[،؛.!؟])[^\n.!؟]{0,80}(?:هستم|می[‌ ]?باشم|می[‌ ]?گردم|می[‌ ]?خواهم)/u,
   /(?:هستم|می[‌ ]?باشم)[^\n.!؟]{0,80}(?:به\s+)?دنبال\s+کار(?:\s|$|[،؛.!؟])/u,
   /درخواست\s+کار(?:\s|$|[،؛.!؟])/u,
   /(?:^|[\n.!؟؛،])\s*دنبال\s+کارم(?:\s|$|[،؛.!؟])/u,
   /کار\s*می[‌ ]?خواهم/u,
   /کار\s*میخوام/u,
   /رزومه\s+من(?:\s|$|[،؛.!؟])/u,
   /آماده\s+به\s+کار(?:م|\s+هستم|\s|$|[،؛.!؟])/u
 ];
 if (strongSeeker.some(pattern => pattern.test(t))) return 'job_seeker';
 // «آماده همکاری» is accepted only with first-person evidence; employers also
 // use this phrase when inviting contractors or partners.
 if (/آماده\s+همکاری/u.test(t) && /(?:هستم|می[‌ ]?باشم|آماده\s+همکاری\s+ام)/u.test(t)) return 'job_seeker';
 return 'employer';
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