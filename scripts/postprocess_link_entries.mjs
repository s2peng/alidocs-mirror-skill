import fs from "node:fs/promises";
import path from "node:path";
import { saveWebLinksAsPdf } from "./save_web_links_as_pdf.mjs";

const URL_RE = /https?:\/\/[^\s<>"'，。；；、)）\]]+/g;

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath));
    else files.push(fullPath);
  }
  return files;
}

function clean(value) {
  return String(value || "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripLinkSuffix(filePath) {
  const base = path.basename(filePath);
  if (base.endsWith(".url.txt")) return base.slice(0, -8);
  if (base.endsWith(".txt")) return base.slice(0, -4);
  return base;
}

function extractUrls(text) {
  return Array.from(new Set((text.match(URL_RE) || []).map((url) => url.trim())));
}

function pickExternalUrl(urls) {
  const wechat = urls.find((url) => url.includes("mp.weixin.qq.com/"));
  if (wechat) return wechat;
  return urls.find((url) => !url.includes("alidocs.dingtalk.com/")) || "";
}

async function readEntry(filePath, includeLegacyTextEntries) {
  const ext = path.extname(filePath).toLowerCase();
  const isUrlTxt = filePath.endsWith(".url.txt");
  const isLegacyText = includeLegacyTextEntries && (ext === ".txt" || ext === "");
  if (!isUrlTxt && !isLegacyText) return null;

  const text = await fs.readFile(filePath, "utf8").catch(() => "");
  if (!text) return null;

  const hasLinkMarker = /钉钉地址：|原始钉钉地址：|外部链接：|真实链接：/.test(text);
  if (!hasLinkMarker) return null;

  const name = clean(text.match(/^名称：(.+)$/m)?.[1])
    || clean(text.match(/^标题：(.+)$/m)?.[1])
    || stripLinkSuffix(filePath);
  const aliUrl = clean(text.match(/^钉钉地址：(.+)$/m)?.[1])
    || clean(text.match(/^原始钉钉地址：(.+)$/m)?.[1])
    || "";
  const listedUrls = extractUrls(text);
  const externalUrl = clean(text.match(/^真实链接：(.+)$/m)?.[1])
    || clean(text.match(/^外部链接：(.+)$/m)?.[1])
    || pickExternalUrl(listedUrls);

  return { filePath, name, aliUrl, externalUrl, text };
}

async function extractExternalUrlFromAliDocs(tab, aliUrl) {
  if (!tab || !aliUrl) return "";
  await tab.goto(aliUrl);
  await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 30000 }).catch(() => null);
  await tab.playwright.waitForTimeout(3500);
  const urls = await tab.playwright.evaluate(`(() => {
    const fromText = (document.body && document.body.innerText.match(${URL_RE}) || []);
    const fromAnchors = Array.from(document.querySelectorAll("a[href]")).map((a) => a.href);
    return Array.from(new Set([...fromText, ...fromAnchors]));
  })()`, { timeoutMs: 30000 }).catch(() => []);
  return pickExternalUrl(urls);
}

async function writeRemainingEntry(entry, externalUrl) {
  const lines = [
    `名称：${entry.name}`,
    entry.aliUrl ? `钉钉地址：${entry.aliUrl}` : "",
    externalUrl ? `外部链接：${externalUrl}` : "",
    "状态：保留链接入口",
    ""
  ].filter(Boolean);
  await fs.writeFile(entry.filePath, lines.join("\n"), "utf8");
}

async function writeIndex(outDir, converted, remaining) {
  const lines = [
    "# 在线文档与链接入口索引",
    "",
    `更新时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
    converted.length
      ? "以下网页链接已另存为 PDF；对应临时文本入口已清理。"
      : "本次没有网页链接被另存为 PDF。",
    ""
  ];

  for (const item of converted) {
    lines.push(`## ${item.name}`);
    lines.push(`- 外部链接：${item.url}`);
    lines.push(`- 网页PDF：${path.relative(outDir, item.pdfPath)}`);
    lines.push("");
  }

  if (remaining.length) {
    lines.push("## 保留的非PDF链接入口");
    lines.push("");
    for (const item of remaining) {
      lines.push(`- ${item.name}：${item.externalUrl || item.aliUrl || item.filePath}`);
    }
    lines.push("");
  }

  await fs.writeFile(path.join(outDir, "_在线文档与链接入口索引.md"), lines.join("\n"), "utf8");
}

export async function postprocessAliDocsLinkEntriesFromBrowser({
  tab,
  outDir,
  includeLegacyTextEntries = false,
  deleteTextWhenPdf = true,
  progress
}) {
  if (!outDir) throw new Error("outDir is required");

  const files = await walk(outDir);
  const entries = [];
  for (const filePath of files) {
    const entry = await readEntry(filePath, includeLegacyTextEntries);
    if (entry) entries.push(entry);
  }

  const jobs = [];
  const remaining = [];
  for (const entry of entries) {
    progress?.({ phase: "resolve-link", name: entry.name, path: entry.filePath });
    let externalUrl = entry.externalUrl;
    if (!externalUrl && entry.aliUrl) {
      externalUrl = await extractExternalUrlFromAliDocs(tab, entry.aliUrl);
    }

    if (externalUrl && externalUrl.includes("mp.weixin.qq.com/")) {
      const pdfPath = path.join(path.dirname(entry.filePath), `${stripLinkSuffix(entry.filePath)}.pdf`);
      jobs.push({ name: entry.name, url: externalUrl, pdfPath, sourceEntry: entry });
    } else {
      await writeRemainingEntry(entry, externalUrl);
      remaining.push({ ...entry, externalUrl });
    }
  }

  progress?.({ phase: "save-web-pdfs", count: jobs.length });
  const pdfResults = jobs.length ? await saveWebLinksAsPdf(jobs) : [];
  const converted = [];
  for (let i = 0; i < jobs.length; i += 1) {
    const job = jobs[i];
    const result = pdfResults[i] || {};
    if (result.ok && await exists(job.pdfPath)) {
      converted.push({ name: job.name, url: job.url, pdfPath: job.pdfPath });
      if (deleteTextWhenPdf) await fs.rm(job.sourceEntry.filePath, { force: true });
    } else {
      await writeRemainingEntry(job.sourceEntry, job.url);
      remaining.push({ ...job.sourceEntry, externalUrl: job.url, reason: result.reason || "pdf-failed" });
    }
  }

  await writeIndex(outDir, converted, remaining);
  return { converted, remaining, scanned: entries.length };
}
