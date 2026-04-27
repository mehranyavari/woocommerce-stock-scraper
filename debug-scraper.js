const puppeteer = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');

chromium.use(StealthPlugin());

const TEST_URL = "https://www.decathlon.com.tr/p/kadin-tenis-ayakkabisi-pembe-tum-zeminler-artengo-fast/_/R-p-333408?mc=8646590";

async function scrapeDecathlon() {
    console.log("🚀 Starting with Stealth Mode");

    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ]
    });

    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        timezoneId: "Europe/Istanbul",
        locale: "tr-TR",
        extraHTTPHeaders: {
            'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
            'sec-ch-ua-platform': '"Windows"',
            'sec-ch-ua-mobile': '?0',
        }
    });

    const page = await context.newPage();

    // رفتار انسانی
    await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        window.chrome = { runtime: {} };
    });

    try {
        console.log("🏠 Visiting homepage first...");
        await page.goto("https://www.decathlon.com.tr", { waitUntil: "domcontentloaded" });
        
        // تاخیر تصادفی انسانی
        await page.waitForTimeout(3000 + Math.random() * 3000);

        // شبیه‌سازی حرکت موس
        await page.mouse.move(400, 300);
        await page.mouse.move(600, 400);
        await page.waitForTimeout(1000);

        console.log("🚀 Going to product page...");
        await page.goto(TEST_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

        // چک Cloudflare
        let attempts = 0;
        while (attempts < 15) {
            const title = await page.title();
            console.log(`⏳ [${attempts+1}/15] Title: "${title}"`);
            if (!title.includes("Cloudflare") && !title.includes("Just a moment")) break;
            await page.waitForTimeout(3000);
            attempts++;
        }

        const finalTitle = await page.title();
        if (finalTitle.includes("Cloudflare") || finalTitle.includes("Just a moment")) {
            console.log("❌ Cloudflare blocked!");
            await page.screenshot({ path: "blocked.png", fullPage: true });
            fs.writeFileSync("blocked_source.html", await page.content());
            await browser.close();
            return;
        }

        console.log("✅ Page loaded! Extracting data...");
        await page.screenshot({ path: "debug_screenshot.png", fullPage: true });

        const dktJson = await page.evaluate(() => {
            const s = document.querySelector("#__dkt");
            if (!s) return null;
            const html = s.innerText;
            const start = html.indexOf("__DKT = ");
            const end = html.indexOf("__CONF =");
            if (start === -1 || end === -1) return null;
            return html.substring(start + 8, end).trim().replace(/;$/, "");
        });

        if (!dktJson) {
            console.log("❌ __DKT not found");
            fs.writeFileSync("debug_source.html", await page.content());
            return;
        }

        const dkt = JSON.parse(dktJson);
        fs.writeFileSync("debug_variable.json", JSON.stringify(dkt, null, 2));

        const supermodel = dkt._ctx.data.find(x => x.type === "Supermodel");
        const mc = new URL(TEST_URL).searchParams.get("mc");
        const model = supermodel.data.models.find(m => m.modelId === mc) || supermodel.data.models[0];

        let price = null;
        const stockMap = {};
        model.skus.forEach(sku => {
            if (!price && sku.price) price = sku.price;
            stockMap[sku.size] = (sku.isNotAvailable || sku.isNotAvailableOnline) ? 0 : 5;
        });

        console.log("\n💰 PRICE:", price);
        console.log("📦 STOCKS:", stockMap);
        fs.writeFileSync("debug_variable.json", JSON.stringify({ price, stockMap }, null, 2));
        console.log("🎉 Done!");

    } catch (err) {
        console.error("⚠ Error:", err.message);
        await page.screenshot({ path: "debug_screenshot.png", fullPage: true });
        fs.writeFileSync("debug_source.html", await page.content().catch(() => ""));
    }

    await browser.close();
}

scrapeDecathlon();
