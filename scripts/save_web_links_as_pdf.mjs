import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Google\\Chrome\\Application\\chrome.exe") : "",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return "";
}

function cleanText(value) {
  return String(value || "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function readLinkFile(linkFile) {
  const text = await fs.readFile(linkFile, "utf8");
  const name = text.match(/^名称：(.+)$/m)?.[1]?.trim() || path.basename(linkFile, ".url.txt");
  const aliUrl = text.match(/^钉钉地址：(.+)$/m)?.[1]?.trim() || "";
  const actualUrl = text.match(/^真实链接：(.+)$/m)?.[1]?.trim() || text.match(/https?:\/\/mp\.weixin\.qq\.com\/s\/[^\s]+/)?.[0] || "";
  return { text, name, aliUrl, actualUrl };
}

async function writeUpdatedLinkFile(linkFile, original, result) {
  const lines = [
    `名称：${original.name}`,
    original.aliUrl ? `钉钉地址：${original.aliUrl}` : "",
    result.url ? `真实链接：${result.url}` : "",
    result.pdfPath ? `网页PDF：${result.pdfPath}` : "",
    `状态：${result.ok ? "网页已另存为PDF" : "网页PDF保存失败"}`,
    result.reason ? `原因：${result.reason}` : "",
    ""
  ].filter(Boolean);
  await fs.writeFile(linkFile, lines.join("\n"), "utf8");
}

async function openUrl(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4500);
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const timer = setInterval(() => {
        window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.8)));
        total += 1;
        if (total >= 14 || window.scrollY + window.innerHeight >= document.body.scrollHeight - 20) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 250);
    });
  }).catch(() => null);
  await page.waitForTimeout(1000);
}

async function extractReadableInfo(page) {
  return page.evaluate(() => {
    function clean(value) {
      return String(value || "")
        .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    }
    const title = clean(document.querySelector("#activity-name")?.textContent || document.title);
    const account = clean(document.querySelector("#js_name")?.textContent || "");
    const contentText = clean(document.querySelector("#js_content")?.innerText || document.body.innerText || "");
    return { title, account, textLength: contentText.length, url: location.href };
  });
}

async function makeFallbackPdf(page, pdfPath, title, sourceUrl, reason) {
  const bodyText = await page.evaluate(() => document.body?.innerText || "").catch(() => "");
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif; padding: 36px; line-height: 1.65; color: #222; }
  h1 { font-size: 22px; margin: 0 0 14px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 24px; word-break: break-all; }
  pre { white-space: pre-wrap; word-break: break-word; font-family: inherit; font-size: 12px; }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">来源：${escapeHtml(sourceUrl)}<br>说明：${escapeHtml(reason)}</div>
  <pre>${escapeHtml(bodyText)}</pre>
</body>
</html>`;
  await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.pdf({
    path: pdfPath,
    format: "A4",
    printBackground: true,
    margin: { top: "14mm", right: "12mm", bottom: "14mm", left: "12mm" }
  });
}

export async function saveWebLinksAsPdf(items, options = {}) {
  const executablePath = options.executablePath || await findBrowserExecutable();
  const browser = await chromium.launch({
    headless: true,
    executablePath: executablePath || undefined
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1600 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    locale: "zh-CN"
  });
  const results = [];

  try {
    for (const item of items) {
      const linkInfo = item.linkFile ? await readLinkFile(item.linkFile) : { name: item.name, aliUrl: item.aliUrl || "", actualUrl: item.url || "" };
      const url = item.url || linkInfo.actualUrl;
      const pdfPath = item.pdfPath || path.join(path.dirname(item.linkFile), `${linkInfo.name}.pdf`);
      await ensureDir(path.dirname(pdfPath));

      if (!url) {
        const result = { ok: false, name: linkInfo.name, url, pdfPath, reason: "missing-url" };
        if (item.linkFile) await writeUpdatedLinkFile(item.linkFile, linkInfo, result);
        results.push(result);
        continue;
      }

      if (options.skipExisting && await fileExists(pdfPath)) {
        const result = { ok: true, skipped: true, name: linkInfo.name, url, pdfPath };
        if (item.linkFile) await writeUpdatedLinkFile(item.linkFile, linkInfo, result);
        results.push(result);
        continue;
      }

      const page = await context.newPage();
      let result;
      try {
        await openUrl(page, url);
        const info = await extractReadableInfo(page);
        await page.emulateMedia({ media: "screen" });
        await page.pdf({
          path: pdfPath,
          format: "A4",
          printBackground: true,
          margin: { top: "12mm", right: "10mm", bottom: "12mm", left: "10mm" }
        });
        result = {
          ok: true,
          name: linkInfo.name,
          url: info.url || url,
          pdfPath,
          title: cleanText(info.title),
          account: cleanText(info.account),
          textLength: info.textLength
        };

        if (result.textLength < 100) {
          await makeFallbackPdf(page, pdfPath, linkInfo.name, url, "页面正文较短，已保留当前页面文本。");
          result.reason = "short-readable-text";
        }
      } catch (error) {
        result = { ok: false, name: linkInfo.name, url, pdfPath, reason: String(error).slice(0, 500) };
      } finally {
        await page.close().catch(() => null);
      }

      if (item.linkFile) await writeUpdatedLinkFile(item.linkFile, linkInfo, result);
      results.push(result);
    }
  } finally {
    await browser.close().catch(() => null);
  }

  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("Usage: node save_web_links_as_pdf.mjs <items.json>");
  const items = JSON.parse(await fs.readFile(inputPath, "utf8"));
  const results = await saveWebLinksAsPdf(items);
  console.log(JSON.stringify(results, null, 2));
}
