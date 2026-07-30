import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';

const ENDPOINT = process.env.QZIH_IMPORT_ENDPOINT || '';
const TOKEN = process.env.QZIH_IMPORT_TOKEN || '';
const PHONE = normalizePhone(process.env.QZIH_DIVAR_LOGIN_PHONE || '');
const AUTH_BASE = deriveAuthBase(ENDPOINT);
const SESSION_ID = randomUUID().replace(/-/g, '');
const WAIT_MS = 7 * 60 * 1000;

if (!ENDPOINT || !TOKEN || !/^09\d{9}$/.test(PHONE)) {
  throw new Error('QZIH_IMPORT_ENDPOINT, QZIH_IMPORT_TOKEN and a valid QZIH_DIVAR_LOGIN_PHONE are required.');
}
console.log(`::add-mask::${PHONE}`);

const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--disable-dev-shm-usage'] });
const context = await browser.newContext({
  locale: 'fa-IR', timezoneId: 'Asia/Tehran', viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  extraHTTPHeaders: { 'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.5' }
});
const page = await context.newPage();
page.setDefaultTimeout(10000);

try {
  await page.goto('https://divar.ir/my-divar', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  let phoneInput = await firstVisible(page, ['input[type="tel"]','input[inputmode="tel"]','input[placeholder*="شماره"]','input[aria-label*="شماره"]']);
  if (!phoneInput) {
    await clickFirst(page, [/ورود\s*به\s*حساب/, /^ورود$/]);
    phoneInput = await firstVisible(page, ['input[type="tel"]','input[inputmode="tel"]','input[placeholder*="شماره"]','input[aria-label*="شماره"]']);
  }

  if (!phoneInput) throw new Error('Divar phone input was not found. The login page may have changed.');
  await phoneInput.fill(PHONE);
  await clickFirst(page, [/^بعدی$/, /ادامه/, /ارسال\s*کد/, /دریافت\s*کد/]);
  await page.waitForTimeout(1200);

  if (/کپچا|captcha|ربات/i.test(await page.locator('body').innerText().catch(() => ''))) {
    throw new Error('Divar requested CAPTCHA. No bypass was attempted; retry later or use a private persistent runner.');
  }

  const otpInputs = await visibleOtpInputs(page);
  if (!otpInputs.length) throw new Error('Divar OTP input was not found after requesting the code.');

  await api('/begin', 'POST', {
    session_id: SESSION_ID,
    phone_masked: maskPhone(PHONE),
    expires_at: Math.floor(Date.now() / 1000) + 8 * 60
  });
  console.log('OTP requested. Open WordPress > QazvinJobs > ورود آگهی‌ها and submit the SMS code.');

  const otp = await waitForOtp();
  console.log(`::add-mask::${otp}`);
  await fillOtp(page, otp);
  await clickFirst(page, [/^بعدی$/, /^تایید$/, /^ورود$/, /ادامه/], false);
  await page.waitForTimeout(2500);

  await page.goto('https://divar.ir/my-divar', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1200);
  if (await loginRequired(page)) throw new Error('Divar did not accept the OTP or requested login again.');

  const state = await context.storageState({ indexedDB: true });
  if (!state.cookies.some(c => String(c.domain || '').includes('divar.ir')) && !state.origins.some(o => String(o.origin || '').includes('divar.ir'))) {
    throw new Error('Authenticated Divar state was not created.');
  }
  await api('/session', 'POST', { session_id: SESSION_ID, storage_state: state });
  console.log('Divar authenticated session was encrypted and saved in WordPress successfully.');
} catch (error) {
  await api('/fail', 'POST', { session_id: SESSION_ID, error: String(error.message || error) }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}

async function waitForOtp() {
  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    const result = await api(`/otp?session_id=${encodeURIComponent(SESSION_ID)}`, 'GET').catch(() => null);
    if (result?.otp && /^\d{4,8}$/.test(String(result.otp))) return String(result.otp);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('Timed out waiting for OTP submission in WordPress.');
}

async function api(path, method, body) {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method,
    headers: { 'X-QZIH-Token': TOKEN, 'Content-Type': 'application/json', 'User-Agent': 'QazvinJobsDivarAuth/0.3.9' },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });
  const text = await response.text();
  let json = {}; try { json = JSON.parse(text); } catch {}
  if (!response.ok) throw new Error(json?.message || `WordPress auth endpoint HTTP ${response.status}`);
  return json;
}

async function clickFirst(page, patterns, required = true) {
  const nodes = page.locator('button, a, [role="button"]');
  for (let i = 0; i < await nodes.count(); i++) {
    const node = nodes.nth(i);
    if (!await node.isVisible().catch(() => false)) continue;
    const text = clean(await node.innerText().catch(() => '') || await node.getAttribute('aria-label').catch(() => '') || '');
    if (!patterns.some(re => re.test(text))) continue;
    await node.click(); return true;
  }
  if (required) throw new Error(`Required Divar control was not found: ${patterns.map(String).join(', ')}`);
  return false;
}
async function firstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector);
    for (let i = 0; i < await locator.count(); i++) if (await locator.nth(i).isVisible().catch(() => false)) return locator.nth(i);
  }
  return null;
}
async function visibleOtpInputs(page) {
  const locator = page.locator('input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"], input[type="number"], input[type="text"]');
  const out = [];
  for (let i = 0; i < await locator.count(); i++) {
    const node = locator.nth(i);
    if (!await node.isVisible().catch(() => false)) continue;
    const placeholder = clean(await node.getAttribute('placeholder').catch(() => '') || '');
    const max = await node.getAttribute('maxlength').catch(() => '');
    if (/کد|تایید|یکبار|رمز/i.test(placeholder) || max === '1' || await node.getAttribute('autocomplete') === 'one-time-code') out.push(node);
  }
  return out;
}
async function fillOtp(page, otp) {
  const inputs = await visibleOtpInputs(page);
  if (!inputs.length) throw new Error('OTP input disappeared before code submission.');
  if (inputs.length === 1) { await inputs[0].fill(otp); return; }
  for (let i = 0; i < Math.min(inputs.length, otp.length); i++) await inputs[i].fill(otp[i]);
}
async function loginRequired(page) {
  const text = clean(await page.locator('body').innerText().catch(() => ''));
  const input = await firstVisible(page, ['input[type="tel"]','input[placeholder*="شماره"]','input[aria-label*="شماره"]']);
  return Boolean(input && /ورود\s*به\s*حساب|شماره\s*موبایل\s*خود\s*را\s*وارد/i.test(text));
}
function deriveAuthBase(endpoint) { const u = new URL(endpoint); u.pathname = u.pathname.replace(/\/batch\/?$/, '/divar-auth'); return u.toString().replace(/\/$/, ''); }
function normalizePhone(value) { let v = String(value || '').replace(/[۰-۹٠-٩]/g, ch => '۰۱۲۳۴۵۶۷۸۹'.includes(ch) ? String('۰۱۲۳۴۵۶۷۸۹'.indexOf(ch)) : String('٠١٢٣٤٥٦٧٨٩'.indexOf(ch))).replace(/\D/g,''); if (v.startsWith('0098')) v=v.slice(4); else if (v.startsWith('98')) v=v.slice(2); if (v.length===10 && v.startsWith('9')) v='0'+v; return v; }
function maskPhone(v) { return `${v.slice(0,4)}***${v.slice(-3)}`; }
function clean(v) { return String(v || '').replace(/[\u200c\u200f\u202a-\u202e]/g,' ').replace(/\s+/g,' ').trim(); }
