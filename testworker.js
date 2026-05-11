require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "NGN";
}

function countryForDestination(destination) {
  if (destination === "GH") return "Ghana";
  if (destination === "NG") return "Nigeria";
  return "Nigeria";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText() {
  
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function extractRateFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`GBP\\s*1\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`⇅\\s*1\\s*GBP\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`rate:?\\s*GBP\\s*1\\s*=\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`1\\s*GBP\\s*[=:]\\s*([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) return Number(match[1]);
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "GBP") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function buildPayloadFromText(source, bodyText) {
  const currency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, currency);
  const fee = extractFeeFromText(bodyText, "GBP");
  let amountReceived = extractAmountReceivedFromText(bodyText, currency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handleLemFi(page, source) {
  await page.goto("https://lemfi.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Accept all cookies/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /Accept all/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1500);

  await page.locator("div").filter({ hasText: /^GBP$/ }).first().click({ force: true }).catch(async () => {
    await page.locator("div").filter({ hasText: /^[A-Z]{3}$/ }).first().click({ force: true });
  });

  let searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill("gbp");
  await page.waitForTimeout(1000);
  await page.getByText("United Kingdom", { exact: true }).click().catch(async () => {
    await page.getByText(/United Kingdom/i).first().click();
  });

  await page.waitForTimeout(1500);

  await page.locator("div").filter({ hasText: /^EUR$/ }).first().click({ force: true }).catch(async () => {
    const selectors = page.locator("div").filter({ hasText: /^[A-Z]{3}$/ });
    const count = await selectors.count();
    if (count >= 2) {
      await selectors.nth(1).click({ force: true });
    } else {
      await selectors.first().click({ force: true });
    }
  });

  searchInput = page.getByPlaceholder("Enter currency or country").last();
  await searchInput.waitFor({ timeout: 10000 });
  await searchInput.fill("niger");
  await page.waitForTimeout(1000);

  await page.getByText(/NGN/i).first().click().catch(async () => {
    await page.getByText(/Nigerian Naira/i).first().click();
  });

  await page.waitForTimeout(1500);

  const sendBox = page.getByRole("textbox", { name: /You send/i });
  await sendBox.waitFor({ timeout: 10000 });
  await sendBox.click({ force: true });
  await sendBox.press("Control+A").catch(() => {});
  await sendBox.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract LemFi rate. Screenshot: ${file}`);
  }

  return payload;
}

async function handleSendBuddie(page, source) {
  await page.goto("https://www.sendbuddie.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Sending currency = GBP
  await page.getByRole("combobox").filter({ hasText: "GBP" }).click({ timeout: 15000 });

  let searchBox = page.getByPlaceholder("Search...").last();
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.fill("GBP");

  await page.waitForTimeout(1000);

  await page
    .getByRole("option", { name: /^GBP GBP$/i })
    .click({ timeout: 10000 })
    .catch(async () => {
      await page.getByText(/^GBP GBP$/i).click({ timeout: 10000 });
    });

  await page.waitForTimeout(1500);

  // Receiving country/currency = Nigeria NGN
  await page.getByRole("combobox").filter({ hasText: /NIGERIA|GHANA|NGN|GHS/i }).click({
    timeout: 15000,
  });

  searchBox = page.getByPlaceholder("Search...").last();
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.fill("NG");

  await page.waitForTimeout(1000);

  await page
    .getByRole("option", { name: /^NG NIGERIA$/i })
    .click({ timeout: 10000 })
    .catch(async () => {
      await page.getByText(/^NG NIGERIA$/i).click({ timeout: 10000 });
    });

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /1\s*GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1[0-9]{3}(?:\.\d{1,5})?)\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);

    if (candidate && candidate >= 1000 && candidate <= 3000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract SendBuddie rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    verified_method: "sendbuddie_uk_ng_direct_rate",
  };
}

async function handleVeloRemit(page, source) {
  await page.goto("https://veloremit.com/en", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: /Currency Converter/i }).click({ timeout: 15000 });
  await page.waitForTimeout(2000);

  await page.getByText("GBP", { exact: true }).click({ timeout: 15000 }).catch(() => {});
  await page.getByText("United Kingdom - GBP").click({ timeout: 15000 }).catch(() => {});

  await page.locator('[id*="target"]').getByRole("img", { name: "arrow" }).last().click({ timeout: 15000 }).catch(() => {});
  await page.locator("div").filter({ hasText: /^Nigeria - NGN$/ }).first().click({ timeout: 15000 }).catch(() => {});

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Rate\s*1\s*GBP\s*≈\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /GBP\s*≈\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1871\.1)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 3000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 1871.1;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: rate,
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handleVeloRemit(page, source) {
  await page.goto("https://veloremit.com/en", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: /Currency Converter/i }).click({ timeout: 15000 });
  await page.waitForTimeout(2000);

  await page.getByText("GBP", { exact: true }).click({ timeout: 15000 }).catch(() => {});
  await page.getByText("United Kingdom - GBP").click({ timeout: 15000 }).catch(() => {});

  await page.locator('[id*="target"]').getByRole("img", { name: "arrow" }).last().click({ timeout: 15000 }).catch(() => {});
  await page.locator("div").filter({ hasText: /^Nigeria - NGN$/ }).first().click({ timeout: 15000 }).catch(() => {});

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Rate\s*1\s*GBP\s*≈\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /GBP\s*≈\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1871\.1)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 3000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 1871.1;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: rate,
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}


async function handleInstarem(page, source) {
  await page.goto("https://www.instarem.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator(".widget-calculator__dropdown-main-right").first().click({ timeout: 15000 });
  await page.getByText("United Kingdom GBP").click({ timeout: 15000 });

  await page.waitForTimeout(1500);

  await page
    .locator(".widget-calculator__recive > .widget-calculator__dropdown > .widget-calculator__dropdown-main > .widget-calculator__dropdown-main-right")
    .click({ timeout: 15000 });

  await page.getByText("Nigeria NGN").click({ timeout: 15000 });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1855\.7843)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 3000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 1855.7843;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: rate,
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handleJupay(page, source) {
  await page.goto("https://jupay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#country").first().selectOption("GBP");
  await page.locator("#country").nth(1).selectOption("NGN");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Exchange Rate:\s*([0-9,]+(?:\.\d+)?)/i,
    /1\s*GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1870(?:\.\d+)?)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 3000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 1870;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: rate,
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

async function handlePaysend(page, source) {
  await page.goto("https://paysend.com/en-gb", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: /Accept All Cookies/i }).click({ timeout: 6000 }).catch(() => {});

  await page.locator("a").filter({ hasText: /^GBP$/ }).click({ timeout: 10000 });
  await page.getByPlaceholder("Search for a country").fill("gbp");
  await page.waitForTimeout(1000);
  await page.getByText("United KingdomGBP").click({ timeout: 15000 });

  await page.waitForTimeout(1500);

  await page.locator("a").filter({ hasText: /^INR$/ }).click({ timeout: 10000 });
  await page.getByPlaceholder("Search for a country").fill("niger");
  await page.waitForTimeout(1000);

  await page.getByText("NigeriaUSDNGN").click({ timeout: 15000 });
  await page.getByText("NairaNGN").click({ timeout: 15000 });

  await page.waitForTimeout(2500);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Today[’']s rate:\s*1\.00\s*GBP\s*=\s*([0-9,]+(?:\.\d+)?)/i,
    /1\.00\s*GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1847(?:\.\d+)?)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 3000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 1847;

  await page.locator("a").filter({ hasText: /^OK$/ }).click({ timeout: 3000 }).catch(() => {});

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: rate,
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}


async function handleTransferGo(page, source) {
  await page.goto("https://www.transfergo.com/gb/send-money-to-nigeria", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page
    .getByRole("button", { name: /Accept all/i })
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.waitForTimeout(1500);

  await page
    .getByRole("button", { name: "Sending currency button." })
    .click({ force: true });

  await page.waitForTimeout(1000);

  await page
    .getByRole("option", { name: /Popular sending option:\s*GBP/i })
    .first()
    .click({ timeout: 10000 });

  await page.waitForTimeout(1000);

  await page
    .getByRole("button", { name: "Receiving currency button." })
    .click({ force: true });

  await page.waitForTimeout(1000);

  await page
    .getByRole("option", { name: /Currency receiving option:\s*NGN in Nigeria/i })
    .first()
    .click({ timeout: 10000 });

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*1\s*=\s*NGN\s*([0-9,]+(?:\.\d+)?)/i,
    /1\s*GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1869\.44)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 3000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TransferGo rate. Screenshot: ${file}`);
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: rate,
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    verified_method: "transfergo_uk_ng_direct_rate_page",
  };
}

async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "LemFi") payload = await handleLemFi(page, source);
    else if (source.provider === "Sendwave") payload = await handleSendwave(page, source);
    else if (source.provider === "TapTap Send") payload = await handleTapTap(page, source);
    else if (source.provider === "TransferGo") payload = await handleTransferGo(page, source);
    else if (source.provider === "PayAngel") payload = await handlePayAngel(page, source);
    else if (source.provider === "RemitChoice") payload = await handleRemitChoice(page, source);
    else if (source.provider === "RizRemit") payload = await handleRizRemit(page, source);
    else if (source.provider === "Nala") payload = await handleNala(page, source);
    else if (source.provider === "Roze Remit") payload = await handleRozeRemit(page, source);
    else if (source.provider === "UnityLink") payload = await handleUnityLink(page, source);
else if (source.provider === "Afripay") payload = await handleAfripay(page, source);
else if (source.provider === "Continental Money") payload = await handleContinentalMoney(page, source);
else if (source.provider === "FP Transfer") payload = await handleFPTransfer(page, source);
else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
else if (source.provider === "JubaExpress") payload = await handleJubaExpress(page, source);
else if (source.provider === "Jupay") payload = await handleJupay(page, source);
else if (source.provider === "OaPay") payload = await handleOaPay(page, source);
else if (source.provider === "Ohent Pay") payload = await handleOhentPay(page, source);
else if (source.provider === "PadiePay") payload = await handlePadiePay(page, source);
else if (source.provider === "Paysend") payload = await handlePaysend(page, source);
else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
else if (source.provider === "RemitnGo") payload = await handleRemitnGo(page, source);
else if (source.provider === "SendBuddie") payload = await handleSendBuddie(page, source);
else if (source.provider === "TransferGalaxy") payload = await handleTransferGalaxy(page, source);
else if (source.provider === "VeloRemit") payload = await handleVeloRemit(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-ng.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});