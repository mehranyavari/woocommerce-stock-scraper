import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

// ---------------------- CONFIG -----------------------
const PRODUCT_URL =
  "https://www.decathlon.com.tr/p/kadin-tenis-ayakkabisi-pembe-tum-zeminler-artengo-fast/_/R-p-333408?mc=8646590";

// پروکسی صحیح ترکیه
const PROXY_HOST = "45.145.20.148";
const PROXY_PORT = "3128";
const PROXY_USER = "mehran";
const PROXY_PASS = "mehran75";
// -----------------------------------------------------

puppeteer.use(StealthPlugin());

// random realistic user-agent
function randomUA() {
  const list = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  ];
  return list[Math.floor(Math.random() * list.length)];
}

async function run() {
  console.log("🚀 Starting Decathlon Debug (Puppeteer + Stealth + TR Proxy)");
  console.log("🎯 URL:", PRODUCT_URL);

  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: puppeteer.executablePath(),
    args: [
      `--proxy-server=http://${PROXY_HOST}:${PROXY_PORT}`,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const page = await browser.newPage();

  // پروکسی authentication
  await page.authenticate({
    username: PROXY_USER,
    password: PROXY_PASS
  });

  await page.setUserAgent(randomUA());

  await page.setExtraHTTPHeaders({
    "Accept-Language": "tr-TR,tr;q=0.9"
  });

  // تست IP داخل مرورگر
  console.log("🌍 Checking proxy IP...");
  try {
    const ipData = await page.evaluate(async () => {
      const r = await fetch("https://api.myip.com/");
      return await r.json();
    });
    console.log("🌍 Puppeteer IP:", ipData);
  } catch (e) {
    console.log("⚠️ Could not verify IP:", e.message);
  }

  // باز کردن صفحه اصلی
  console.log("🏠 Visiting Decathlon homepage...");
  await page.goto("https://www.decathlon.com.tr/", {
    waitUntil: "domcontentloaded",
    timeout: 90000
  });

  // رفتن به صفحه محصول
  console.log("🚀 Navigating to product page...");
  const resp = await page.goto(PRODUCT_URL, {
    waitUntil: "networkidle2",
    timeout: 90000
  });

  const status = resp.status();
  console.log("🌐 HTTP Status:", status);

  const title = await page.title();
  console.log("📄 Final Page Title:", title);

  if (title.includes("Bir dakika")) {
    console.log("❌ BLOCKED BY CLOUDFLARE (Bir dakika lütfen...)");
  }

  // گرفتن __DKT
  console.log("📥 Extracting __DKT JSON...");

  const dkt = await page.evaluate(() => {
    try {
      return window.__DKT || null;
    } catch {
      return null;
    }
  });

  if (!dkt) console.log("❌ __DKT NOT FOUND!");
  else console.log("✅ __DKT FOUND!");

  // ذخیره خروجی‌ها
  const html = await page.content();
  const fs = await import("fs");

  fs.writeFileSync("decathlon_debug.html", html);
  await page.screenshot({ path: "decathlon_debug.png", fullPage: true });

  if (dkt) fs.writeFileSync("dkt.json", JSON.stringify(dkt, null, 2));

  console.log("📦 Output saved: decathlon_debug.html, decathlon_debug.png, dkt.json");

  await browser.close();
  console.log("✅ Done.");
}

run().catch(err => {
  console.error("🔥 ERROR:", err);
});
