import puppeteer from "@cloudflare/puppeteer";

/**
 * Render a URL in a headless Chromium and extract text content.
 *
 * Used as a Tier 3 fallback when Jina Reader returns empty/poor content
 * (JS-rendered SPAs, real-time dashboards, etc.).
 *
 * Blocks images/CSS/fonts for speed. Returns up to 4000 chars of visible text.
 */
export async function renderUrlViaBrowser(
  url: string,
  browserBinding: Fetcher,
): Promise<string | null> {
  let browser;
  try {
    browser = await puppeteer.launch(browserBinding, {
      keep_alive: 30000,
    });

    const page = await browser.newPage();

    // Block heavy resources for speed
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const rt = req.resourceType();
      if (["image", "stylesheet", "font", "media"].includes(rt)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });

    // Wait briefly for JS-rendered content
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 5000 }).catch(() => {});

    // Extract visible text
    const text = await page.evaluate(() => {
      // Remove script/style/nav elements
      const removeSelectors = ["script", "style", "nav", "header", "footer", "aside"];
      for (const sel of removeSelectors) {
        document.querySelectorAll(sel).forEach((el) => el.remove());
      }
      return document.body?.innerText ?? "";
    });

    return text.trim().slice(0, 4000) || null;
  } catch {
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

/**
 * Take a screenshot of a URL (for vision-capable models).
 * Returns base64-encoded PNG.
 */
export async function screenshotUrl(url: string, browserBinding: Fetcher): Promise<string | null> {
  let browser;
  try {
    browser = await puppeteer.launch(browserBinding, {
      keep_alive: 30000,
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await page.waitForNetworkIdle({ idleTime: 2000, timeout: 5000 }).catch(() => {});

    const screenshot = await page.screenshot({ type: "png", fullPage: false });
    const buffer = screenshot instanceof Uint8Array ? screenshot : new Uint8Array(screenshot);

    // Convert to base64
    let binary = "";
    for (let i = 0; i < buffer.length; i++) {
      binary += String.fromCharCode(buffer[i]);
    }
    return `data:image/png;base64,${btoa(binary)}`;
  } catch {
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
