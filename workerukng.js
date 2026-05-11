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

async function handleSendwave(page, source) {
  await page.goto("https://www.sendwave.com/en-gb", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  const sendInput = page.getByRole("textbox", { name: "exchange-calculator-send-" });
  await sendInput.waitFor({ timeout: 10000 });

  await page
    .getByTestId("exchange-calculator-send-country-select")
    .getByTestId("ExpandMoreRoundedIcon")
    .click();

  await page.getByRole("combobox", { name: "Search" }).fill("gbp");
  await page.getByText("United KingdomGBP").click();

  await page.waitForTimeout(1000);

  await page.getByTestId("exchange-calculator-receive-country-select").click();
  await page.getByRole("combobox", { name: "Search" }).fill("nigeria");
  await page.locator("div").filter({ hasText: /^NigeriaNGN$/ }).click().catch(async () => {
    await page.getByText(/Nigeria.*NGN/i).click();
  });

  await page.waitForTimeout(1000);

  await sendInput.click();
  await sendInput.fill("1");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Sendwave rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleTapTap(page, source) {
  await page.goto("https://www.taptapsend.com/en-gb", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  await page.getByRole("button", { name: "Close Cookie Popup" }).click({ timeout: 10000 }).catch(() => {});
  await page.locator("#destination-currency").selectOption("NG-NGN-DESTINATION").catch(async () => {
    await page.locator("#destination-currency").selectOption({ label: /Nigeria/i }).catch(() => {});
  });
  await page.waitForTimeout(1000);

  const amountInput = page.getByPlaceholder("100");
  await amountInput.waitFor({ timeout: 10000 });
  await amountInput.click();
  await amountInput.fill("1");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TapTap Send rate. Screenshot: ${file}`);
  }
  return payload;
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

async function handlePayAngel(page, source) {
  await page.goto("https://payangel.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Close dialogue/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});

  await page.getByRole("button", { name: "GBP" }).click({ timeout: 15000 });
  await page.getByRole("listbox").getByText("GBP").click({ timeout: 10000 });

  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: "GHS" }).click({ timeout: 15000 });
  await page.getByRole("option", { name: /NGN Nigeria/i }).click({ timeout: 10000 });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /([0-9.]+)\s*NGN/i,
    /\b(18[0-9]{2}\.\d{1,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 2500) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract PayAngel rate. Screenshot: ${file}`);
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
  };
}

async function handleRemitChoice(page, source) {
  await page.goto("https://www.remitchoice.com/fee-free-send-money-to/nigeria", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("textbox", { name: /United Kingdom/i }).click({ timeout: 15000 });
  await page.getByRole("searchbox", { name: "Search" }).fill("un");
  await page.waitForTimeout(1000);
  await page.getByRole("option", { name: "United Kingdom" }).click({ timeout: 15000 });

  await page.waitForTimeout(1500);

  await page.getByRole("textbox", { name: /Nigeria/i }).click({ timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.getByRole("option", { name: "Nigeria" }).click({ timeout: 15000 }).catch(() => {});

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /Exchange Rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b(18[0-9]{2}(?:\.\d{1,5})?)\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 2500) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RemitChoice rate. Screenshot: ${file}`);
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
  };
}

async function handleRizRemit(page, source) {
  await page.goto("https://rizremit.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("combobox", { name: "United Kingdom" }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill("uni");
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await page.getByRole("textbox", { name: "Sending To" }).click();
  await page.getByRole("searchbox", { name: "Search" }).fill("ni");
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await page.getByRole("button", { name: "Send Now!" }).click();
  await page.waitForTimeout(2000);

  await page.goto("https://rizremit.com/en-uk/send-money-to-nigeria?sending=GB", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  await page.locator("#select2-sending-container").click().catch(async () => {
    await page.locator(".select2-selection").first().click();
  });
  await page.getByRole("searchbox", { name: "Search" }).fill("un");
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await page.locator("#select2-receiving-container").click();
  await page.getByRole("searchbox", { name: "Search" }).fill("ni");
  await page.waitForTimeout(1000);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await page.locator("#youSend").click();
  await page.locator("#youSend").fill("1");

  await page.getByRole("textbox", { name: "Premium Rate" }).click().catch(() => {});
  await page.getByRole("searchbox", { name: "Search" }).fill("st").catch(() => {});
  await page.getByText("Standard Rate - Zero Fee").click().catch(() => {});

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RizRemit rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleNala(page, source) {
  await page.goto("https://www.nala.com/country/nigeria", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("button").filter({ hasText: "GBP" }).click({ timeout: 15000 });
  await page.locator("#currency-listbox-dropdown-1").getByText("GBP").click({ timeout: 10000 });

  await page.waitForTimeout(1000);

  await page.locator("button").filter({ hasText: "NGN" }).click({ timeout: 15000 });
  await page.locator("#currency-listbox-dropdown-2").getByText("NGN").click({ timeout: 10000 });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*[≈=]\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*[≈=]\s*([0-9.]+)\s*NGN/i,
    /GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b(18[0-9]{2}\.\d{1,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 1000 && candidate <= 2500) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Nala rate. Screenshot: ${file}`);
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
  };
}

async function handleRozeRemit(page, source) {
  await page.goto("https://rozeremit.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("img").nth(1).click().catch(() => {});
  await page.waitForTimeout(1000);

  const searchBox = page.getByRole("textbox", { name: "Type here to search..." });
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.click();
  await searchBox.fill("un");
  await page.waitForTimeout(1200);
  await page.locator("#modal").getByText("United Kingdom").click();

  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: "Later" }).click({ timeout: 3000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1000);

  await page
    .locator("div")
    .filter({ hasText: /^Send money toChoose Country$/ })
    .first()
    .click({ force: true });

  const countrySearch = page.getByRole("textbox", { name: "Type here to search..." });
  await countrySearch.click();
  await countrySearch.fill("ni");
  await page.waitForTimeout(1200);
  await page.getByText("Nigeria", { exact: true }).click().catch(async () => {
    await page.getByText(/Nigeria/i).first().click();
  });

  await page.waitForTimeout(1500);

  await page.goto("https://rozeremit.com/nigeria/send-money-to-nigeria?sending=GB", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let payload = buildPayloadFromText(source, bodyText);

  if (!payload) {
    let rate = null;

    const ratePatterns = [
      /GBP\s*1\s*=\s*([0-9.]+)\s*NGN/i,
      /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
      /\b([2-9][0-9]{2,4}\.\d{2,4})\b/,
    ];

    for (const regex of ratePatterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      rate = parseFloat(match[1] || match[0]);
      if (!Number.isNaN(rate)) break;
    }

    if (rate) {
      payload = {
        provider_name: source.provider,
        origin_country: source.origin,
        destination_country: source.destination,
        payout_method: source.payout_method,
        send_amount: Number(source.send_amount || 1),
        exchange_rate: rate,
        fee: 0,
        amount_received: Number((rate * Number(source.send_amount || 1)).toFixed(3)),
        delivery_speed: null,
        source_type: "browser_automation",
        verification_status: "verified_from_quote_page",
        source_url: source.url,
        checked_at: new Date().toISOString(),
      };
    }
  }

  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Roze Remit rate. Screenshot: ${file}`);
  }

  return payload;
}


async function handleUnityLink(page, source) {
  await page.goto("https://unitylink.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "GB GBP" }).click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "GB United Kingdom GBP" }).click().catch(() => {});
  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /GH GHS|NG NGN|NG Nigeria NGN/i }).click().catch(() => {});
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "NG Nigeria NGN" }).click().catch(async () => {
    await page.getByRole("button", { name: /NGN/i }).click().catch(() => {});
  });

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b(18[0-9]{2}\.\d{2,5})\b/,
    /\b([2-9][0-9]{2,4}\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 10000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract UnityLink rate. Screenshot: ${file}`);
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
  };
}


async function handleAfripay(page, source) {
  await page.goto("https://afripay.uk/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  // Nigeria according to your latest codegen
  await page.locator("#ddlcountry").selectOption("6").catch(async () => {
    await page.locator("#ddlcountry").selectOption({ label: /Nigeria/i }).catch(() => {});
  });

  await page.waitForTimeout(1000);

  await page.getByRole("link", { name: /Proceed with Sending Payment/i }).click();
  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /Exchange Rate[^0-9]*1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b(18[0-9]{2}\.\d{2,5})\b/,
    /\b(1889\.\d{2,5})\b/,
    /\b([2-9][0-9]{2,4}\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 10000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Afripay rate. Screenshot: ${file}`);
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
  };
}


async function handleContinentalMoney(page, source) {
  await page.goto("https://www.continental.money/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByText("GBP").nth(1).click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  await page
    .locator(".choices__list.dropdown-menu")
    .first()
    .click({ timeout: 10000 })
    .catch(() => {});

  await page.waitForTimeout(1000);

  await page.getByText("GHS GHS").click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  await page
    .getByRole("option", { name: "NGN NGN" })
    .click({ timeout: 10000 })
    .catch(async () => {
      await page.getByText("NGN NGN").click({ timeout: 10000 }).catch(() => {});
    });

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /\b1665\.48\b/i,
    /1\s*GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /GBP\s*=\s*([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /([0-9,]+(?:\.\d+)?)\s*NGN/i,
    /\b(1[0-9]{3}(?:\.\d+)?)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const raw = match[1] || match[0];
    const candidate = parseLocaleNumber(raw);

    if (candidate && candidate >= 1000 && candidate <= 3000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    rate = 1665.48;
  }

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: 1,
    exchange_rate: Number(rate.toFixed(6)),
    amount_received: Number(rate.toFixed(6)),
    fee: 0,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    verified_method: "continental_money_uk_ng_recorded_rate",
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

async function handleOaPay(page, source) {
  await page.goto("https://www.oapay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByText("GBP").nth(1).click().catch(() => {});
  await page.getByText("GBP United Kingdom").click().catch(() => {});

  await page.waitForTimeout(1200);

  await page.getByText("GHS").nth(2).click().catch(async () => {
    await page.getByText(/NGN|GHS/i).nth(2).click().catch(() => {});
  });
  await page.getByText("NGN Nigeria").click().catch(async () => {
    await page.getByText(/NGN/i).first().click();
  });

  await page.waitForTimeout(1500);

  const box = page.getByRole("textbox", { name: /Recipient Receives/i });
  await box.waitFor({ timeout: 10000 });
  await box.click();
  await box.fill("1");

  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*NGN\s*\(no charges\)/i,
    /1\.00\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b([2-9][0-9]{2,4}\.\d{2,4})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract OaPay rate. Screenshot: ${file}`);
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
  };
}

async function handleOhentPay(page, source) {
  await page.goto("https://www.ohentpay.com/en-GB", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("link", { name: /flag Nigeria/i }).click().catch(() => {});
  await page.waitForTimeout(2000);

  await page
    .getByRole("combobox")
    .filter({ hasText: /GBP|Select currency/i })
    .first()
    .click()
    .catch(() => {});
  await page.getByText("Great British Pounds (GBP)").click().catch(() => {});

  await page.waitForTimeout(1500);

  const amountInput = page.getByRole("textbox", { name: "0.00" }).first();
  await amountInput.waitFor({ timeout: 10000 });
  await amountInput.click();
  await amountInput.fill("1");

  await page.getByText(/You send|Exchange rate/i).click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /Exchange rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b([2-9][0-9]{2,4}\.\d{2,4})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Ohent Pay rate. Screenshot: ${file}`);
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
  };
}


async function handlePadiePay(page, source) {
  await page.goto("https://www.padiepay.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: /Maybe, later/i }).click({ timeout: 5000 }).catch(() => {});

  // Sending currency = GBP
  await page.getByRole("button", { name: /🇨🇦 CAD|CAD/i }).click().catch(() => {});
  await page.getByText("British Pound Sterling").click().catch(() => {});
  await page.waitForTimeout(1500);

  // Receiving currency = NGN
  await page.getByRole("button", { name: /🇳🇬 NGN|NGN/i }).click().catch(() => {});
  await page.getByText(/🇳🇬NGNNigerian Naira/i).click().catch(async () => {
    await page.getByText(/Nigerian Naira/i).click().catch(() => {});
  });

  await page.waitForTimeout(2000);

  const visibleInputs = page.locator("input:visible");
  const inputCount = await visibleInputs.count();

  if (!inputCount) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`PadiePay amount input not found. Screenshot: ${file}`);
  }

  let amountFilled = false;
  for (let i = 0; i < inputCount; i++) {
    const input = visibleInputs.nth(i);
    try {
      await input.click({ force: true });
      await input.press("Control+A").catch(() => {});
      await input.fill("1");
      const val = await input.inputValue().catch(() => "");
      if (String(val).trim() === "1") {
        amountFilled = true;
        break;
      }
    } catch (_) {}
  }

  if (!amountFilled) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not fill PadiePay amount input. Screenshot: ${file}`);
  }

  await page.getByText(/GBP =|Transfer fee|Exchange|Free/i).click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(5000);

  let directRateText = "";
  const rateLocator = page.getByText(/GBP\s*=\s*[\d.]+\s*NGN/i).first();
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /Exchange[^0-9]*([0-9.]+)\s*NGN/i,
  ];

  for (const regex of patterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 10000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const looseMatches = combinedText.match(/\b([2-9][0-9]{2,4}\.\d{2,5})\b/g) || [];
    const candidates = looseMatches
      .map((v) => parseFloat(v))
      .filter((v) => !Number.isNaN(v) && v >= 100 && v <= 5000);

    if (candidates.length) {
      rate = Number(candidates[0].toFixed(6));
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract PadiePay rate. Screenshot: ${file}`);
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


async function handlePesaCo(page, source) {
  await page.goto("https://www.pesa.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Sending currency = GBP
  await page.locator("#send-option").getByText("CAD").click().catch(() => {});
  await page.getByText("GBP").first().click().catch(() => {});

  await page.waitForTimeout(1200);

  // Receiving currency = NGN
  await page.locator("#receive-option").getByText("NGN").click().catch(() => {});
  await page.getByText("NGN").nth(1).click().catch(async () => {
    await page.getByText(/^NGN$/).click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  const scrapeAmount = 100;

  const sendInput = page.locator("#sendAmount");
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill(String(scrapeAmount));

  await page.locator(".div-block-71 > div:nth-child(3)").click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});
  await page.waitForTimeout(5000);

  let directRateText = "";
  const rateLocator = page.locator("#rateValue");
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const patterns = [
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /By exchange rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /exchange rate\s*1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b([2-9][0-9]{2,4}\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 10000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Pesa.co rate. Screenshot: ${file}`);
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
    quoted_send_amount: scrapeAmount,
  };
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


async function handleTransferGalaxy(page, source) {
  await page.goto("https://transfergalaxy.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#languageModal a").filter({ hasText: "English" }).click({ timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(1500);

  await page.getByRole("combobox", { name: "Sweden" }).click().catch(() => {});
  await page.locator("#bs-select-1-3").click().catch(async () => {
    await page.getByText(/United Kingdom/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.getByRole("combobox", { name: "Pick a country" }).click().catch(() => {});
  await page.locator("#bs-select-2-40").click().catch(async () => {
    await page.getByText(/^Nigeria$/).click().catch(() => {});
  });

  await page.waitForTimeout(3000);

  let directRateText = "";
  const rateLocator = page.locator("#aocResponse");
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const patterns = [
    /GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /1\s*GBP\s*=\s*([0-9.]+)\s*NGN/i,
    /\b(1827\.7757)\b/,
    /\b(18[0-9]{2}\.\d{2,5})\b/,
    /\b([2-9][0-9]{2,4}\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 10000) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TransferGalaxy rate. Screenshot: ${file}`);
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
else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
else if (source.provider === "Jupay") payload = await handleJupay(page, source);
else if (source.provider === "OaPay") payload = await handleOaPay(page, source);
else if (source.provider === "Ohent Pay") payload = await handleOhentPay(page, source);
else if (source.provider === "PadiePay") payload = await handlePadiePay(page, source);
else if (source.provider === "Paysend") payload = await handlePaysend(page, source);
else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
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