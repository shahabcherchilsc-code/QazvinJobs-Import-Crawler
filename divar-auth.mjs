import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const ENDPOINT = process.env.QZIH_IMPORT_ENDPOINT || '';
const TOKEN = process.env.QZIH_IMPORT_TOKEN || '';
const PHONE = normalizePhone(process.env.QZIH_DIVAR_LOGIN_PHONE || '');
const AUTH_BASE = deriveAuthBase(ENDPOINT);
const SESSION_ID = randomUUID().replace(/-/g, '');
const WAIT_MS = 7 * 60 * 1000;
const DEBUG_PREFIX = 'divar-auth-debug';

if (!ENDPOINT || !TOKEN || !/^09\d{9}$/.test(PHONE)) {
  throw new Error('QZIH_IMPORT_ENDPOINT, QZIH_IMPORT_TOKEN and a valid QZIH_DIVAR_LOGIN_PHONE are required.');
}

console.log(`::add-mask::${PHONE}`);

const browser = await chromium.launch({
  headless: true,
  args: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-dev-shm-usage'
  ]
});

const context = await browser.newContext({
  locale: 'fa-IR',
  timezoneId: 'Asia/Tehran',
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  extraHTTPHeaders: {
    'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.5'
  }
});

const page = await context.newPage();
page.setDefaultTimeout(15000);

try {
  console.log('Opening Divar account page...');
  await page.goto('https://divar.ir/my-divar', {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await dismissObstructions(page);

  let phoneInput = await findPhoneInput(page);

  if (!phoneInput) {
    console.log('Phone input is not visible yet; opening the Divar login form...');
    const clicked = await openLoginForm(page);
    if (!clicked) {
      console.log('The normal login control was not found. Trying the account page once more after dismissing overlays...');
      await dismissObstructions(page);
      await openLoginForm(page);
    }

    phoneInput = await waitForPhoneInput(page, 18000);
  }

  if (!phoneInput) {
    await saveDebug(page, 'phone_input_not_found');
    throw new Error(
      'Divar phone input was not found after opening the login form. Diagnostics were uploaded as an artifact.'
    );
  }

  console.log('Divar phone field found. Requesting OTP...');
  await phoneInput.fill(PHONE);

  const nextClicked = await clickByText(page, [
    /^بعدی$/,
    /^ادامه$/,
    /ارسال\s*کد/,
    /دریافت\s*کد/,
    /تایید\s*شماره/
  ], false);

  if (!nextClicked) {
    await phoneInput.press('Enter').catch(() => {});
  }

  await page.waitForTimeout(1800);

  const pageTextAfterPhone = clean(await page.locator('body').innerText().catch(() => ''));

  if (/کپچا|captcha|ربات|امنیتی/i.test(pageTextAfterPhone)) {
    await saveDebug(page, 'captcha_or_security_challenge');
    throw new Error(
      'Divar requested a CAPTCHA or security challenge. No bypass was attempted.'
    );
  }

  const otpInputs = await waitForOtpInputs(page, 18000);
  if (!otpInputs.length) {
    await saveDebug(page, 'otp_input_not_found');
    throw new Error(
      'Divar OTP input was not found after requesting the code. The phone request may have been rejected or the page changed.'
    );
  }

  await api('/begin', 'POST', {
    session_id: SESSION_ID,
    phone_masked: maskPhone(PHONE),
    expires_at: Math.floor(Date.now() / 1000) + 8 * 60
  });

  console.log('OTP requested successfully.');
  console.log('Open WordPress > QazvinJobs > ورود آگهی‌ها and submit the SMS code.');

  const otp = await waitForOtp();
  console.log(`::add-mask::${otp}`);

  await fillOtp(page, otp);

  await clickByText(page, [
    /^بعدی$/,
    /^تایید$/,
    /^ورود$/,
    /^ادامه$/,
    /ثبت\s*کد/
  ], false);

  await page.waitForTimeout(3000);

  await page.goto('https://divar.ir/my-divar', {
    waitUntil: 'domcontentloaded',
    timeout: 45000
  });
  await page.waitForLoadState('networkidle', { timeout: 12000 }).catch(() => {});
  await page.waitForTimeout(1500);

  if (await loginRequired(page)) {
    await saveDebug(page, 'otp_not_accepted');
    throw new Error('Divar did not accept the OTP or requested login again.');
  }

  const state = await context.storageState({ indexedDB: true });
  const hasDivarState =
    state.cookies.some(c => String(c.domain || '').includes('divar.ir')) ||
    state.origins.some(o => String(o.origin || '').includes('divar.ir'));

  if (!hasDivarState) {
    await saveDebug(page, 'authenticated_state_missing');
    throw new Error('Authenticated Divar state was not created.');
  }

  await api('/session', 'POST', {
    session_id: SESSION_ID,
    storage_state: state
  });

  console.log('Divar authenticated session was encrypted and saved in WordPress successfully.');
} catch (error) {
  await saveDebug(page, 'failure').catch(() => {});
  await api('/fail', 'POST', {
    session_id: SESSION_ID,
    error: String(error.message || error)
  }).catch(() => {});
  throw error;
} finally {
  await browser.close();
}

async function openLoginForm(page) {
  await dismissObstructions(page);

  const candidates = [
    page.getByRole('button', { name: /ورود\s*به\s*حساب\s*کاربری|ورود\s*به\s*حساب|^ورود$/ }),
    page.getByRole('link', { name: /ورود\s*به\s*حساب\s*کاربری|ورود\s*به\s*حساب|^ورود$/ }),
    page.getByText(/ورود\s*به\s*حساب\s*کاربری/, { exact: false }),
    page.locator('button:has-text("ورود به حساب کاربری")'),
    page.locator('a:has-text("ورود به حساب کاربری")'),
    page.locator('[role="button"]:has-text("ورود به حساب کاربری")'),
    page.locator('button:has-text("ورود")'),
    page.locator('[role="button"]:has-text("ورود")')
  ];

  for (const group of candidates) {
    const count = await group.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const node = group.nth(i);
      if (!await node.isVisible().catch(() => false)) continue;
      try {
        await node.scrollIntoViewIfNeeded().catch(() => {});
        await node.click({ timeout: 8000 });
        await page.waitForTimeout(1200);
        return true;
      } catch {
        // Try the next matching control.
      }
    }
  }

  return false;
}

async function dismissObstructions(page) {
  const patterns = [
    /^متوجه\s*شدم$/,
    /^بستن$/,
    /^بعداً$/,
    /^فعلاً\s*نه$/,
    /^انصراف$/
  ];

  for (let pass = 0; pass < 3; pass++) {
    const clicked = await clickByText(page, patterns, false);
    if (!clicked) break;
    await page.waitForTimeout(400);
  }

  await page.keyboard.press('Escape').catch(() => {});
}

async function findPhoneInput(page) {
  const inputs = page.locator('input');
  const bodyText = clean(await page.locator('body').innerText().catch(() => ''));
  const phoneContext = /شماره\s*موبایل|شماره\s*خود\s*را\s*وارد|کد\s*تایید\s*به\s*این\s*شماره/i.test(bodyText);

  let fallback = null;

  for (let i = 0; i < await inputs.count(); i++) {
    const node = inputs.nth(i);
    if (!await node.isVisible().catch(() => false)) continue;

    const attrs = await inputAttributes(node);
    const joined = clean(Object.values(attrs).join(' '));

    if (/کد|تایید|رمز|otp|one.?time/i.test(joined)) continue;

    const strongMatch =
      attrs.type === 'tel' ||
      /phone|mobile|tel/i.test(attrs.name) ||
      /phone|mobile|tel/i.test(attrs.id) ||
      /tel/i.test(attrs.autocomplete) ||
      /شماره|موبایل/i.test(attrs.placeholder) ||
      /شماره|موبایل/i.test(attrs.ariaLabel);

    if (strongMatch) return node;

    if (!fallback && phoneContext && ['text', 'number', ''].includes(attrs.type)) {
      fallback = node;
    }
  }

  return fallback;
}

async function waitForPhoneInput(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const input = await findPhoneInput(page);
    if (input) return input;
    await page.waitForTimeout(500);
  }
  return null;
}

async function waitForOtpInputs(page, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const inputs = await visibleOtpInputs(page);
    if (inputs.length) return inputs;
    await page.waitForTimeout(500);
  }
  return [];
}

async function waitForOtp() {
  const started = Date.now();

  while (Date.now() - started < WAIT_MS) {
    const result = await api(
      `/otp?session_id=${encodeURIComponent(SESSION_ID)}`,
      'GET'
    ).catch(() => null);

    if (result?.otp && /^\d{4,8}$/.test(String(result.otp))) {
      return String(result.otp);
    }

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  throw new Error('Timed out waiting for OTP submission in WordPress.');
}

async function api(path, method, body) {
  const response = await fetch(`${AUTH_BASE}${path}`, {
    method,
    headers: {
      'X-QZIH-Token': TOKEN,
      'Content-Type': 'application/json',
      'User-Agent': 'QazvinJobsDivarAuth/0.3.10'
    },
    body: method === 'GET' ? undefined : JSON.stringify(body || {})
  });

  const text = await response.text();
  let json = {};

  try {
    json = JSON.parse(text);
  } catch {
    // Keep the HTTP status as the primary error.
  }

  if (!response.ok) {
    throw new Error(
      json?.message || `WordPress auth endpoint HTTP ${response.status}`
    );
  }

  return json;
}

async function clickByText(page, patterns, required = true) {
  const nodes = page.locator(
    'button, a, [role="button"], input[type="submit"], input[type="button"]'
  );

  for (let i = 0; i < await nodes.count(); i++) {
    const node = nodes.nth(i);
    if (!await node.isVisible().catch(() => false)) continue;

    const text = clean(
      await node.innerText().catch(() => '') ||
      await node.getAttribute('aria-label').catch(() => '') ||
      await node.getAttribute('value').catch(() => '') ||
      ''
    );

    if (!patterns.some(pattern => pattern.test(text))) continue;

    try {
      await node.scrollIntoViewIfNeeded().catch(() => {});
      await node.click({ timeout: 8000 });
      return true;
    } catch {
      // Try the next matching control.
    }
  }

  if (required) {
    throw new Error(
      `Required Divar control was not found: ${patterns.map(String).join(', ')}`
    );
  }

  return false;
}

async function visibleOtpInputs(page) {
  const locator = page.locator('input');
  const out = [];
  const bodyText = clean(await page.locator('body').innerText().catch(() => ''));
  const otpContext = /کد\s*تایید|کد\s*پیامک|رمز\s*یکبار|کد\s*ارسال/i.test(bodyText);

  for (let i = 0; i < await locator.count(); i++) {
    const node = locator.nth(i);
    if (!await node.isVisible().catch(() => false)) continue;

    const attrs = await inputAttributes(node);
    const joined = clean(Object.values(attrs).join(' '));

    const match =
      /one.?time|otp|کد|تایید|یکبار|رمز/i.test(joined) ||
      attrs.maxlength === '1' ||
      attrs.autocomplete === 'one-time-code' ||
      (
        otpContext &&
        ['tel', 'number', 'text', ''].includes(attrs.type) &&
        Number(attrs.maxlength || 8) <= 8
      );

    if (match) out.push(node);
  }

  return out;
}

async function fillOtp(page, otp) {
  const inputs = await visibleOtpInputs(page);

  if (!inputs.length) {
    throw new Error('OTP input disappeared before code submission.');
  }

  if (inputs.length === 1) {
    await inputs[0].fill(otp);
    return;
  }

  for (let i = 0; i < Math.min(inputs.length, otp.length); i++) {
    await inputs[i].fill(otp[i]);
  }
}

async function loginRequired(page) {
  const text = clean(await page.locator('body').innerText().catch(() => ''));
  const input = await findPhoneInput(page);

  return Boolean(
    input &&
    /ورود\s*به\s*حساب|شماره\s*موبایل\s*خود\s*را\s*وارد/i.test(text)
  );
}

async function inputAttributes(node) {
  return {
    type: String(await node.getAttribute('type').catch(() => '') || '').toLowerCase(),
    name: String(await node.getAttribute('name').catch(() => '') || ''),
    id: String(await node.getAttribute('id').catch(() => '') || ''),
    placeholder: String(await node.getAttribute('placeholder').catch(() => '') || ''),
    ariaLabel: String(await node.getAttribute('aria-label').catch(() => '') || ''),
    autocomplete: String(await node.getAttribute('autocomplete').catch(() => '') || ''),
    inputmode: String(await node.getAttribute('inputmode').catch(() => '') || ''),
    maxlength: String(await node.getAttribute('maxlength').catch(() => '') || '')
  };
}

async function saveDebug(page, reason) {
  const bodyText = clean(
    await page.locator('body').innerText().catch(() => '')
  ).slice(0, 12000);

  const inputRows = [];
  const inputs = page.locator('input');

  for (let i = 0; i < Math.min(await inputs.count(), 30); i++) {
    const node = inputs.nth(i);
    inputRows.push({
      visible: await node.isVisible().catch(() => false),
      ...(await inputAttributes(node))
    });
  }

  const controlRows = [];
  const controls = page.locator('button, a, [role="button"]');

  for (let i = 0; i < Math.min(await controls.count(), 80); i++) {
    const node = controls.nth(i);
    if (!await node.isVisible().catch(() => false)) continue;

    controlRows.push({
      tag: await node.evaluate(el => el.tagName).catch(() => ''),
      text: clean(
        await node.innerText().catch(() => '') ||
        await node.getAttribute('aria-label').catch(() => '') ||
        ''
      ).slice(0, 300)
    });
  }

  const report = {
    reason,
    url: page.url(),
    title: await page.title().catch(() => ''),
    bodyText,
    inputs: inputRows,
    controls: controlRows
  };

  await page.screenshot({
    path: `${DEBUG_PREFIX}.png`,
    fullPage: true
  }).catch(() => {});

  await writeFile(
    `${DEBUG_PREFIX}.html`,
    await page.content().catch(() => ''),
    'utf8'
  ).catch(() => {});

  await writeFile(
    `${DEBUG_PREFIX}.json`,
    JSON.stringify(report, null, 2),
    'utf8'
  ).catch(() => {});

  console.log(`Divar login diagnostics saved. Current URL: ${report.url}`);
  console.log(`Visible controls: ${controlRows.map(row => row.text).filter(Boolean).slice(0, 20).join(' | ')}`);
}

function deriveAuthBase(endpoint) {
  const url = new URL(endpoint);
  url.pathname = url.pathname.replace(/\/batch\/?$/, '/divar-auth');
  return url.toString().replace(/\/$/, '');
}

function normalizePhone(value) {
  let normalized = String(value || '')
    .replace(/[۰-۹٠-٩]/g, character =>
      '۰۱۲۳۴۵۶۷۸۹'.includes(character)
        ? String('۰۱۲۳۴۵۶۷۸۹'.indexOf(character))
        : String('٠١٢٣٤٥٦٧٨٩'.indexOf(character))
    )
    .replace(/\D/g, '');

  if (normalized.startsWith('0098')) {
    normalized = normalized.slice(4);
  } else if (normalized.startsWith('98')) {
    normalized = normalized.slice(2);
  }

  if (normalized.length === 10 && normalized.startsWith('9')) {
    normalized = `0${normalized}`;
  }

  return normalized;
}

function maskPhone(value) {
  return `${value.slice(0, 4)}***${value.slice(-3)}`;
}

function clean(value) {
  return String(value || '')
    .replace(/[\u200c\u200f\u202a-\u202e]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
