import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export const config = {
  maxDuration: 60,
};

function allowedOrigin(req) {
  const configured = String(process.env.ALLOWED_ORIGIN || "").trim();
  if (configured) return configured;

  const origin = String(req.headers.origin || "").trim();
  return origin || "*";
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only." });
  }

  const { html, filename } = req.body || {};

  if (!html) {
    return res.status(400).json({ error: "Missing invoice HTML." });
  }

  let browser;

  try {
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      ignoreHTTPSErrors: true,
    });

    const page = await browser.newPage();

    await page.setViewport({
      width: 794,
      height: 1123,
      deviceScaleFactor: 1,
      isMobile: false,
    });

    await page.setContent(html, {
      waitUntil: ["domcontentloaded", "networkidle0"],
    });

    // Wait for the exact Khmer fonts used by the dashboard.
    await page.evaluate(async () => {
      if (document.fonts) {
        await Promise.allSettled([
          document.fonts.ready,
          document.fonts.load('20px "KhmerOSMuolUploaded"'),
          document.fonts.load('13px "KhmerOSBattambangUploaded"'),
        ]);
      }

      const images = [...document.images];

      await Promise.all(
        images.map((img) => {
          if (img.complete) return Promise.resolve();

          return new Promise((resolve) => {
            img.addEventListener("load", resolve, { once: true });
            img.addEventListener("error", resolve, { once: true });
          });
        })
      );

      await new Promise((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(resolve)
        )
      );

      const scaleRoot = document.getElementById("mfPdfScale");
      const invoice = scaleRoot?.querySelector(".mf-invoice");

      if (!scaleRoot || !invoice) return;

      // A4 height in CSS pixels at 96dpi.
      const A4_HEIGHT_PX = 1122.52;

      const height = Math.max(
        invoice.scrollHeight || 0,
        invoice.getBoundingClientRect().height || 0,
        invoice.offsetHeight || 0
      );

      const scale = Math.min(1, A4_HEIGHT_PX / height);

      scaleRoot.style.transformOrigin = "top left";
      scaleRoot.style.transform = `scale(${scale})`;
      scaleRoot.style.width = `${210 / scale}mm`;
    });

    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      landscape: false,
      margin: {
        top: "0mm",
        right: "0mm",
        bottom: "0mm",
        left: "0mm",
      },
      pageRanges: "1",
    });

    const safeName = String(filename || "invoice-A4.pdf")
      .replace(/[^a-zA-Z0-9._-]/g, "_");

    res.status(200);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeName}"`
    );
    res.setHeader("Content-Length", pdf.length);
    return res.send(pdf);
  } catch (error) {
    console.error("Invoice PDF generation error:", error);

    return res.status(500).json({
      error: "Could not generate invoice PDF.",
      detail: String(error?.message || error),
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
