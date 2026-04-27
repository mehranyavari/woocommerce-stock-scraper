const axios = require('axios');
const fs = require('fs');

const API_KEY = process.env.SCRAPER_API_KEY;
const TEST_URL = "https://www.decathlon.com.tr/p/kadin-tenis-ayakkabisi-pembe-tum-zeminler-artengo-fast/_/R-p-333408?mc=8646590";

async function scrape() {
    console.log("🚀 Starting ScraperAPI...");
    console.log("🎯 URL:", TEST_URL);

    const response = await axios.get('https://api.scraperapi.com', {
        params: {
            api_key: API_KEY,
            url: TEST_URL,
            render: true,
            country_code: 'tr'
        },
        timeout: 120000
    });

    console.log("✅ Status:", response.status);
    fs.writeFileSync("debug_source.html", response.data);

    if (!response.data.includes('__DKT')) {
        console.log("❌ __DKT NOT FOUND!");
        return;
    }

    console.log("🎉 __DKT FOUND!");

    const html = response.data;
    const start = html.indexOf("__DKT = ");
    const end = html.indexOf("__CONF =");
    const dktJson = html.substring(start + 8, end).trim().replace(/;$/, "");

    const dkt = JSON.parse(dktJson);
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
}

scrape().catch(err => {
    console.error("⚠️ Error:", err.message);
    fs.writeFileSync("debug_source.html", err.message);
});
