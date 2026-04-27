const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const fs = require("fs");

puppeteer.use(StealthPlugin());

const TEST_URL = "https://www.decathlon.com.tr/p/kadin-tenis-ayakkabisi-pembe-tum-zeminler-artengo-fast/_/R-p-333408?mc=8646590";

async function scrapeDecathlon() {

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox"
    ]
  });

  const page = await browser.newPage();

  await page.setViewport({
    width: 1366,
    height: 900
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  );

  console.log("🏠 Opening homepage...");
  await page.goto("https://www.decathlon.com.tr", { waitUntil: "domcontentloaded" });

  await new Promise(r => setTimeout(r, 4000));

  console.log("🚀 Opening product page...");
  await page.goto(TEST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

  await new Promise(r => setTimeout(r, 5000));

  const title = await page.title();
  console.log("Page title:", title);

  await page.screenshot({
    path: "debug.png",
    fullPage: true
  });

  const html = await page.content();
  fs.writeFileSync("page.html", html);

  await browser.close();
}

scrapeDecathlon();
