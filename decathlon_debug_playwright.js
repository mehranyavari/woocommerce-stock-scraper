const { chromium } = require('playwright');
const fs = require('fs');

const TEST_URL = "https://www.decathlon.com.tr/p/kadin-tenis-ayakkabisi-pembe-tum-zeminler-artengo-fast/_/R-p-333408?mc=8646590";

/**
 * تست واقعی Playwright + Chrome برای عبور از Cloudflare Decathlon
 */
async function debugDecathlon() {
    console.log("🚀 Starting Decathlon Debug (Playwright + Real Chrome)");
    console.log("🎯 URL:", TEST_URL);

    // Chrome واقعی (نه Chromium)
    const browser = await chromium.launch({
    channel: "chrome",
    args: [
        "--headless=new",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-software-rasterizer",
        "--disable-background-networking",
        "--remote-debugging-port=0"
    ]
});



    const context = await browser.newContext({
        viewport: { width: 1366, height: 900 },
        userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        timezoneId: "Europe/Istanbul",
        locale: "tr-TR",
        javaScriptEnabled: true,
    });

    const page = await context.newPage();

    try {
        console.log("\n🏠 Visiting Decathlon homepage...");
        await page.goto("https://www.decathlon.com.tr", { waitUntil: "load" });
        await page.waitForTimeout(5000);

        console.log("\n🚀 Navigating to product page...");
        await page.goto(TEST_URL, { waitUntil: "load", timeout: 0 });

        // Cloudflare challenge check
        for (let i = 0; i < 10; i++) {
            const title = await page.title();
            console.log(`⏳ Checking challenge... title="${title}"`);

            if (!title.includes("Cloudflare") && !title.includes("Just a moment")) break;

            await page.waitForTimeout(2000);
        }

        const pageTitle = await page.title();
        console.log(`📄 Final Page Title: ${pageTitle}`);

        if (pageTitle.includes("Cloudflare") || pageTitle.includes("Just a moment")) {
            console.log("❌ Cloudflare still blocking!");
            await page.screenshot({ path: "blocked.png", fullPage: true });
            fs.writeFileSync("blocked_source.html", await page.content());
            await browser.close();
            return;
        }

        console.log("\n📥 Extracting __DKT JSON...");
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
            console.log("❌ __DKT NOT FOUND!");
            await page.screenshot({ path: "no_dkt.png", fullPage: true });
            fs.writeFileSync("no_dkt_source.html", await page.content());
            return;
        }

        console.log("✅ __DKT Extracted!");
        fs.writeFileSync("dkt_raw.json", dktJson);

        const dkt = JSON.parse(dktJson);

        // پیدا کردن مدل درست
        const supermodel = dkt._ctx.data.find((x) => x.type === "Supermodel");
        if (!supermodel) {
            console.log("❌ Supermodel not found!");
            return;
        }

        const urlObj = new URL(TEST_URL);
        const mc = urlObj.searchParams.get("mc");

        const model =
            supermodel.data.models.find((m) => m.modelId === mc) ||
            supermodel.data.models[0];

        console.log("\n🎯 MODEL:", model.modelId, model.webLabel);

        const stockMap = {};
        let price = null;

        model.skus.forEach((sku) => {
            if (!price && sku.price) price = sku.price;
            stockMap[sku.size] =
                sku.isNotAvailable || sku.isNotAvailableOnline ? 0 : 5;
        });

        console.log("\n📦 STOCKS:");
        console.table(stockMap);

        console.log("\n💰 PRICE:", price);

        fs.writeFileSync("result.json", JSON.stringify({ price, stockMap }, null, 2));

        console.log("\n🎉 DONE! Files saved:");
        console.log("- dkt_raw.json");
        console.log("- result.json");

    } catch (err) {
        console.error("⚠ Error:", err);
        await page.screenshot({ path: "error.png", fullPage: true });
    }

    await browser.close();
}

debugDecathlon();
