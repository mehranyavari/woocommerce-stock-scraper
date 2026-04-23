import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

async function start() {
    const proxyHost = "45.145.20.148:3128";
    const proxyUser = "mehran";
    const proxyPass = "mehran75";

    console.log("Launching Chrome with proxy...");

    const browser = await puppeteer.launch({
        headless: "new",
        channel: "chrome",
        args: [
            `--proxy-server=http://${proxyHost}`,
            "--no-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-blink-features=AutomationControlled",
            "--disable-features=IsolateOrigins,site-per-process",
            "--disable-software-rasterizer",
            "--window-size=1280,800"
        ]
    });

    const page = await browser.newPage();

    // Proxy authentication (Puppeteer ONLY — Playwright doesn’t have this)
    await page.authenticate({
        username: proxyUser,
        password: proxyPass
    });

    // Fake user agent (Chrome real)
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36"
    );

    // Small anti-Cloudflare tweaks
    await page.setExtraHTTPHeaders({
        "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8"
    });

    console.log("Visiting Decathlon TR…");

    try {
        const url = "https://www.decathlon.com.tr/sd/er-fsk-cerceve-adi-151231.html";

        await page.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: 60000
        });

        console.log("Waiting 7 seconds for Cloudflare…");
        await page.waitForTimeout(7000);

        // Check IP inside Puppeteer (IMPORTANT!)
        try {
            const ip = await page.evaluate(async () => {
                const r = await fetch("https://api.ipify.org?format=json");
                return await r.json();
            });
            console.log("Puppeteer IP:", ip);
        } catch (e) {
            console.log("Cannot get IP inside Puppeteer:", e.message);
        }

        // Try reading __DKT
        const dkt = await page.evaluate(() => window.__DKT || null);
        console.log("__DKT:", dkt);

        if (!dkt) {
            await page.screenshot({ path: "no_dkt.png", fullPage: true });
            await page.content().then(html => {
                require("fs").writeFileSync("no_dkt_source.html", html);
            });
        } else {
            require("fs").writeFileSync("dkt_raw.json", JSON.stringify(dkt, null, 2));
        }

    } catch (err) {
        console.error("ERROR:", err.message);
        await page.screenshot({ path: "error.png", fullPage: true });
    }

    await browser.close();
}

start();
