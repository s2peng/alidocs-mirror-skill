import fs from "node:fs/promises";
import path from "node:path";

const NODE_URL_PREFIX = "https://alidocs.dingtalk.com/i/nodes/";

const KNOWN_FILE_EXTENSIONS = new Set([
  "adoc", "axls", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf",
  "zip", "rar", "7z", "png", "jpg", "jpeg", "gif", "webp", "svg",
  "mp4", "mov", "avi", "m4v", "mp3", "wav", "txt", "md", "csv",
  "key", "pages", "numbers", "hlink"
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripInvisible(value) {
  return String(value || "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeName(name) {
  const cleaned = stripInvisible(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  return cleaned || "_未命名";
}

function remoteUrl(id) {
  return `${NODE_URL_PREFIX}${id}`;
}

function getExtension(name) {
  const match = stripInvisible(name).match(/\.([A-Za-z0-9]{1,12})$/);
  return match ? match[1].toLowerCase() : "";
}

function looksLikeFileName(name) {
  const ext = getExtension(name);
  return Boolean(ext && KNOWN_FILE_EXTENSIONS.has(ext));
}

function classifyItem(item) {
  const icon = String(item.iconClasses || "").toLowerCase();
  if (item.hasExpandArea || icon.includes("folder")) return "folder";
  if (looksLikeFileName(item.name)) return "file";
  if (/(pdf|office|doc|sheet|slide|image|video|audio|zip|link|mind|draw|file)/.test(icon)) {
    return "file";
  }
  return "folder";
}

function safeJoin(root, parts) {
  return path.join(root, ...parts.map(sanitizeName));
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function moveFile(src, dest, { overwrite }) {
  await ensureDir(path.dirname(dest));
  if (await pathExists(dest)) {
    if (!overwrite) return { moved: false, reason: "exists" };
    await fs.rm(dest, { force: true });
  }
  try {
    await fs.rename(src, dest);
  } catch {
    await fs.copyFile(src, dest);
    await fs.rm(src, { force: true });
  }
  return { moved: true };
}

async function evalPage(tab, source, timeoutMs = 30000) {
  return tab.playwright.evaluate(source, { timeoutMs });
}

async function getCurrentUrl(tab) {
  return evalPage(tab, "location.href", 10000);
}

async function navigateToNode(tab, id) {
  const target = remoteUrl(id);
  const current = await getCurrentUrl(tab).catch(() => "");
  if (!current.includes(`/nodes/${id}`)) {
    await tab.goto(target);
    await tab.playwright.waitForLoadState({ state: "domcontentloaded", timeoutMs: 30000 }).catch(() => null);
  }
  for (let i = 0; i < 40; i += 1) {
    await sleep(i === 0 ? 700 : 500);
    const state = await extractPageState(tab).catch(() => null);
    if (state && state.url && state.url.includes(`/nodes/${id}`)) return state;
  }
  return extractPageState(tab);
}

async function extractPageState(tab) {
  return evalPage(tab, `(() => {
    function clean(value) {
      return String(value || "")
        .replace(/[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f]/g, "")
        .replace(/\\s+/g, " ")
        .trim();
    }
    function text(el) {
      return clean((el && (el.innerText || el.textContent)) || "");
    }
    const bodyText = text(document.body);
    const countMatch = bodyText.match(/(\\d+)个文档\\s*\\/\\s*(\\d+)个文件夹/);
    const gridCandidates = Array.from(document.querySelectorAll('[role="grid"]'))
      .map((grid, position) => {
        const rows = Array.from(grid.querySelectorAll(".portal-tree-selection-target[data-rbd-draggable-id]"));
        const rect = grid.getBoundingClientRect();
        return { grid, position, rows, left: rect.left || 0, width: rect.width || 0, height: rect.height || 0 };
      })
      .filter((candidate) => candidate.rows.length);
    gridCandidates.sort((a, b) => {
      const aCenter = a.left + a.width / 2;
      const bCenter = b.left + b.width / 2;
      if (Math.abs(bCenter - aCenter) > 5) return bCenter - aCenter;
      if (Math.abs(b.width - a.width) > 5) return b.width - a.width;
      return b.position - a.position;
    });
    const mainGridCandidate = gridCandidates[0] || null;
    const mainGrid = mainGridCandidate?.grid || document.body;
    const rows = Array.from(mainGrid.querySelectorAll(".portal-tree-selection-target[data-rbd-draggable-id]"));
    const items = [];
    for (const el of rows) {
      const ctx = el.getAttribute("data-rbd-draggable-context-id") || "";
      const id = el.getAttribute("data-rbd-draggable-id") || el.getAttribute("data-rbd-drag-handle-draggable-id") || "";
      if (!id) continue;
      const titleEl = el.querySelector("[title]");
      const rawText = text(el);
      const lines = rawText.split("\\n").map(clean).filter(Boolean);
      const title = clean(titleEl ? titleEl.getAttribute("title") : "");
      const name = title || lines[0] || id;
      const iconClasses = Array.from(el.querySelectorAll("svg"))
        .map((svg) => clean(svg.getAttribute("class") || ""))
        .filter(Boolean)
        .join(" ");
      const item = {
        id,
        name,
        text: rawText,
        contextId: ctx,
        index: Number(el.getAttribute("data-index") || 0),
        hasExpandArea: Boolean(el.querySelector('[data-testid="expand-click-area"]')),
        iconClasses
      };
      items.push(item);
    }
    const contextCounts = {};
    for (const item of items) contextCounts[item.contextId] = (contextCounts[item.contextId] || 0) + 1;
    const nameInputs = Array.from(document.querySelectorAll('input[type="text"], textarea'))
      .map((input) => clean(input.value || input.getAttribute("value") || ""))
      .filter(Boolean)
      .filter((value) => value !== "搜索");
    const pageTitle = clean(document.title).replace(/ · 钉钉文档$/, "");
    return {
      url: location.href,
      title: pageTitle,
      currentName: nameInputs[0] || pageTitle,
      hasFolderCounts: Boolean(countMatch),
      docCount: countMatch ? Number(countMatch[1]) : null,
      folderCount: countMatch ? Number(countMatch[2]) : null,
      totalCount: countMatch ? Number(countMatch[1]) + Number(countMatch[2]) : null,
      hasPreview: Boolean(document.querySelector("iframe#uni-preview")),
      mainContextId: "main-grid",
      mainGridIndex: mainGridCandidate ? mainGridCandidate.position : -1,
      items: items.sort((a, b) => a.index - b.index),
      groupSizes: { "main-grid": items.length, ...contextCounts }
    };
  })()`);
}

async function scrollMainList(tab, contextId, direction = "down") {
  return evalPage(tab, `(() => {
    const ctx = ${JSON.stringify(contextId)};
    function pickMainGrid() {
      const candidates = Array.from(document.querySelectorAll('[role="grid"]'))
        .map((grid, position) => {
          const rows = Array.from(grid.querySelectorAll(".portal-tree-selection-target[data-rbd-draggable-id]"));
          const rect = grid.getBoundingClientRect();
          return { grid, position, rows, left: rect.left || 0, width: rect.width || 0 };
        })
        .filter((candidate) => candidate.rows.length);
      candidates.sort((a, b) => {
        const aCenter = a.left + a.width / 2;
        const bCenter = b.left + b.width / 2;
        if (Math.abs(bCenter - aCenter) > 5) return bCenter - aCenter;
        if (Math.abs(b.width - a.width) > 5) return b.width - a.width;
        return b.position - a.position;
      });
      return candidates[0]?.grid || null;
    }
    const grid = ctx === "main-grid" ? pickMainGrid() : null;
    const row = ctx === "main-grid"
      ? (grid ? grid.querySelector('[data-rbd-draggable-id]') : null)
      : document.querySelector('[data-rbd-draggable-context-id="' + ctx + '"][data-rbd-draggable-id]');
    let el = grid || (row ? row.parentElement : null);
    while (el) {
      if (el.scrollHeight > el.clientHeight + 20) {
        const before = el.scrollTop;
        if (${JSON.stringify(direction)} === "top") {
          el.scrollTop = 0;
        } else {
          el.scrollTop = Math.min(el.scrollHeight, before + Math.max(300, Math.floor(el.clientHeight * 0.85)));
        }
        return { scrolled: el.scrollTop !== before, before, after: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
      }
      el = el.parentElement;
    }
    const before = scrollY;
    if (${JSON.stringify(direction)} === "top") scrollTo(0, 0);
    else scrollBy(0, 600);
    return { scrolled: scrollY !== before, before, after: scrollY, window: true };
  })()`, 10000);
}

async function waitForNodeUrl(tab, id, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await extractPageState(tab).catch(() => null);
    if (state?.url?.includes(`/nodes/${id}`)) return state;
    await sleep(400);
  }
  return extractPageState(tab).catch(() => null);
}

async function visibleLocatorCount(tab, selector) {
  return tab.playwright.locator(selector).count().catch(() => 0);
}

async function findVisibleNodeLocator(tab, id, preferredContextId) {
  const state = await extractPageState(tab).catch(() => null);
  const gridIndex = Number.isInteger(state?.mainGridIndex) ? state.mainGridIndex : -1;

  if (gridIndex >= 0) {
    await scrollMainList(tab, "main-grid", "top").catch(() => null);
    await sleep(200);
    for (let i = 0; i < 25; i += 1) {
      const row = tab.playwright.locator('[role="grid"]').nth(gridIndex).locator(`[data-rbd-draggable-id="${id}"]`).first();
      if (await row.count().catch(() => 0)) return row;
      const scroll = await scrollMainList(tab, "main-grid", "down").catch(() => ({ scrolled: false }));
      if (!scroll?.scrolled) break;
      await sleep(250);
    }
  }

  const selector = await findVisibleNodeSelector(tab, id, preferredContextId || state?.mainContextId);
  return selector ? tab.playwright.locator(selector).first() : null;
}

async function findVisibleNodeSelector(tab, id, preferredContextId) {
  const selectors = [];
  if (preferredContextId != null && preferredContextId !== "" && preferredContextId !== "main-grid") {
    selectors.push(`[data-rbd-draggable-context-id="${preferredContextId}"][data-rbd-draggable-id="${id}"]`);
  }
  selectors.push(`[data-rbd-draggable-id="${id}"]`);

  for (const selector of selectors) {
    if (await visibleLocatorCount(tab, selector)) return selector;
  }

  const state = await extractPageState(tab).catch(() => null);
  const contextId = preferredContextId || state?.mainContextId;
  if (contextId) {
    await scrollMainList(tab, contextId, "top").catch(() => null);
    await sleep(200);
    for (let i = 0; i < 25; i += 1) {
      const selector = contextId === "main-grid" ? `[data-rbd-draggable-id="${id}"]` : `[data-rbd-draggable-context-id="${contextId}"][data-rbd-draggable-id="${id}"]`;
      if (await visibleLocatorCount(tab, selector)) return selector;
      const scroll = await scrollMainList(tab, contextId, "down").catch(() => ({ scrolled: false }));
      if (!scroll?.scrolled) break;
      await sleep(250);
    }
  }

  for (const selector of selectors) {
    if (await visibleLocatorCount(tab, selector)) return selector;
  }
  return "";
}

async function openVisibleNode(tab, id, preferredContextId) {
  const current = await getCurrentUrl(tab).catch(() => "");
  if (current.includes(`/nodes/${id}`)) return extractPageState(tab);

  const row = await findVisibleNodeLocator(tab, id, preferredContextId);
  if (!row) throw new Error(`node is not visible: ${id}`);

  await tab.playwright.locator("body").press("Escape", { timeoutMs: 3000 }).catch(() => null);
  await row.dblclick({ timeoutMs: 12000 }).catch(async () => {
    await row.click({ timeoutMs: 12000 });
  });
  let state = await waitForNodeUrl(tab, id, 12000);
  if (!state?.url?.includes(`/nodes/${id}`)) {
    await tab.playwright.locator("body").press("Escape", { timeoutMs: 3000 }).catch(() => null);
    await row.dblclick({ timeoutMs: 12000 }).catch(() => null);
    state = await waitForNodeUrl(tab, id, 15000);
  }
  if (!state?.url?.includes(`/nodes/${id}`)) {
    state = await navigateToNode(tab, id);
  }
  if (!state?.url?.includes(`/nodes/${id}`)) {
    throw new Error(`failed to open node: ${id}`);
  }
  await sleep(600);
  return extractPageState(tab);
}

async function returnToNode(tab, id) {
  const current = await getCurrentUrl(tab).catch(() => "");
  if (current.includes(`/nodes/${id}`)) return extractPageState(tab);
  return navigateToNode(tab, id);
}

async function collectFolderItems(tab, initialState) {
  let state = initialState || await extractPageState(tab);
  if (!state.hasFolderCounts) return state;

  const known = new Map();
  await scrollMainList(tab, state.mainContextId, "top").catch(() => null);
  await sleep(300);

  for (let pass = 0; pass < 25; pass += 1) {
    state = await extractPageState(tab);
    for (const item of state.items || []) {
      known.set(item.id, item);
    }
    if (!state.totalCount || known.size >= state.totalCount) break;
    const scroll = await scrollMainList(tab, state.mainContextId, "down").catch(() => ({ scrolled: false }));
    if (!scroll || !scroll.scrolled) break;
    await sleep(500);
  }

  await scrollMainList(tab, state.mainContextId, "top").catch(() => null);
  return { ...state, items: Array.from(known.values()).sort((a, b) => a.index - b.index) };
}

async function writeLinkFile(outDir, file, targetPath, status, reason) {
  const linkPath = `${targetPath}.url.txt`;
  await ensureDir(path.dirname(linkPath));
  await fs.writeFile(linkPath, [
    `名称：${file.name || file.id}`,
    `钉钉地址：${remoteUrl(file.id)}`,
    `状态：${status}`,
    reason ? `原因：${reason}` : "",
    ""
  ].filter(Boolean).join("\n"), "utf8");
  return linkPath;
}

async function downloadCurrentFile(tab, file, outDir, options, progress) {
  const relParts = file.relParts && file.relParts.length ? file.relParts : [file.name || file.id];
  let targetPath = safeJoin(outDir, relParts);

  if (options.skipExisting && await pathExists(targetPath)) {
    return { status: "skipped", reason: "exists", targetPath };
  }

  progress?.({ phase: "download-file", name: file.name || file.id, path: relParts.join("/") });
  const state = await extractPageState(tab);
  if (!state.hasPreview) {
    const linkPath = await writeLinkFile(outDir, file, targetPath, "未发现可自动下载的预览下载按钮", "no-preview");
    return { status: "linked", reason: "no-preview", targetPath: linkPath };
  }

  let result;
  try {
    result = await clickDownloadInPreview(tab);
  } catch (error) {
    result = { ok: false, reason: String(error).slice(0, 500) };
  }

  if (!result.ok) {
    const linkPath = await writeLinkFile(outDir, file, targetPath, "下载失败或无下载按钮", result.reason || "download-failed");
    return { status: "linked", reason: result.reason || "download-failed", targetPath: linkPath };
  }

  if (!path.extname(targetPath) && result.suggestedFilename) {
    const suggestedExt = path.extname(result.suggestedFilename);
    if (suggestedExt) targetPath = `${targetPath}${suggestedExt}`;
  }
  await moveFile(result.downloadedPath, targetPath, { overwrite: options.overwrite });
  await fs.rm(`${targetPath}.url.txt`, { force: true }).catch(() => null);
  return { status: "downloaded", targetPath, suggestedFilename: result.suggestedFilename || "" };
}

async function downloadVisibleFileFromMenu(tab, file, outDir, options, contextId, progress, parentId) {
  const relParts = file.relParts && file.relParts.length ? file.relParts : [file.name || file.id];
  let targetPath = safeJoin(outDir, relParts);

  if (options.skipExisting && await pathExists(targetPath)) {
    return { status: "skipped", reason: "exists", targetPath };
  }

  progress?.({ phase: "download-file", name: file.name || file.id, path: relParts.join("/") });
  const row = await findVisibleNodeLocator(tab, file.id, contextId);
  if (!row) {
    const linkPath = await writeLinkFile(outDir, file, targetPath, "未发现可点击的文件行", "row-not-visible");
    return { status: "linked", reason: "row-not-visible", targetPath: linkPath };
  }

  const menuButton = row.locator('[data-testid="pc-dentry-operation"]').first();
  const menuButtonCount = await menuButton.count().catch(() => 0);
  if (!menuButtonCount) {
    const linkPath = await writeLinkFile(outDir, file, targetPath, "未发现右侧三点菜单", "no-row-menu");
    return { status: "linked", reason: "no-row-menu", targetPath: linkPath };
  }

  await tab.playwright.locator("body").press("Escape", { timeoutMs: 3000 }).catch(() => null);
  await menuButton.click({ timeoutMs: 12000 });
  await sleep(500);

  let result;
  let eventPromise;
  try {
    const downloadItem = tab.playwright.locator('span.action-btn-text[title="下载"]').last();
    const downloadItemCount = await downloadItem.count().catch(() => 0);
    if (!downloadItemCount) {
      throw new Error("download-menu-item-not-found");
    }
    eventPromise = tab.playwright.waitForEvent("download", { timeoutMs: 30000 });
    await downloadItem.click({ timeoutMs: 12000 });
    const download = await eventPromise;
    const downloadedPath = await download.path?.();
    const suggestedFilename = await download.suggestedFilename?.().catch(() => "");
    if (!downloadedPath) throw new Error("no-download-path");
    result = { ok: true, downloadedPath, suggestedFilename };
  } catch (error) {
    eventPromise?.catch(() => null);
    result = { ok: false, reason: String(error).slice(0, 500) };
  }

  if (!result.ok) {
    if (parentId) {
      try {
        await openVisibleNode(tab, file.id, contextId);
        const fallback = await downloadCurrentFile(tab, file, outDir, options, progress);
        await returnToNode(tab, parentId).catch(() => null);
        if (fallback.status === "downloaded" || fallback.status === "skipped") {
          return { ...fallback, via: "preview-fallback" };
        }
      } catch (fallbackError) {
        await returnToNode(tab, parentId).catch(() => null);
        result.reason = `${result.reason || "menu-download-failed"}; preview fallback failed: ${String(fallbackError).slice(0, 300)}`;
      }
    }
    const linkPath = await writeLinkFile(outDir, file, targetPath, "三点菜单下载失败", result.reason || "menu-download-failed");
    return { status: "linked", reason: result.reason || "menu-download-failed", targetPath: linkPath };
  }

  if (!path.extname(targetPath) && result.suggestedFilename) {
    const suggestedExt = path.extname(result.suggestedFilename);
    if (suggestedExt) targetPath = `${targetPath}${suggestedExt}`;
  }
  await moveFile(result.downloadedPath, targetPath, { overwrite: options.overwrite });
  await fs.rm(`${targetPath}.url.txt`, { force: true }).catch(() => null);
  return { status: "downloaded", targetPath, suggestedFilename: result.suggestedFilename || "" };
}

async function crawlAndMirrorCurrentFolder(tab, folder, outDir, options, acc, progress) {
  let state = await extractPageState(tab);
  if (!state.hasFolderCounts) {
    return;
  }

  const folderName = folder.name || state.currentName || folder.id;
  if (!acc.rootName) acc.rootName = folderName;
  acc.nodes.push(makeTreeNode({ id: folder.id, name: folderName, type: "folder", relParts: folder.relParts, state }));
  await ensureDir(folder.relParts.length ? safeJoin(outDir, folder.relParts) : outDir);

  progress?.({ phase: "crawl-folder", name: folderName, path: folder.relParts.join("/") });
  const page = await collectFolderItems(tab, state);
  if (page.totalCount != null && page.items.length < page.totalCount) {
    acc.unresolved.push({
      type: "incomplete-list",
      id: folder.id,
      name: folderName,
      path: folder.relParts.join("/"),
      expected: page.totalCount,
      found: page.items.length
    });
  }

  for (const item of page.items) {
    const itemName = item.name || item.id;
    const relParts = [...folder.relParts, itemName];
    const hint = classifyItem(item);

    if (hint === "folder") {
      await openVisibleNode(tab, item.id, page.mainContextId);
      const childState = await extractPageState(tab);
      if (childState.hasFolderCounts) {
        await crawlAndMirrorCurrentFolder(tab, { id: item.id, name: itemName, relParts }, outDir, options, acc, progress);
        await returnToNode(tab, folder.id);
      } else {
        acc.nodes.push(makeTreeNode({ id: item.id, name: itemName, type: "file", relParts, state: childState, item }));
        const result = await downloadCurrentFile(tab, { id: item.id, name: itemName, relParts, item }, outDir, options, progress);
        acc.results.push({ id: item.id, name: itemName, path: relParts.join("/"), ...result });
        await returnToNode(tab, folder.id);
      }
      continue;
    }

    acc.nodes.push(makeTreeNode({ id: item.id, name: itemName, type: "file", relParts, item }));
    const result = await downloadVisibleFileFromMenu(tab, { id: item.id, name: itemName, relParts, item }, outDir, options, page.mainContextId, progress, folder.id);
    acc.results.push({ id: item.id, name: itemName, path: relParts.join("/"), ...result });
  }
}

async function detectNodeKind(tab, item) {
  const state = await navigateToNode(tab, item.id);
  if (state.hasFolderCounts) return { kind: "folder", state };
  return { kind: "file", state };
}

function makeTreeNode({ id, name, type, relParts, state, item }) {
  return {
    id,
    name,
    type,
    path: relParts.join("/"),
    url: remoteUrl(id),
    docCount: state?.docCount ?? null,
    folderCount: state?.folderCount ?? null,
    iconClasses: item?.iconClasses || "",
    crawledAt: new Date().toISOString()
  };
}

async function crawlTree(tab, rootId, progress) {
  const folders = [{ id: rootId, name: "", relParts: [] }];
  const seenFolders = new Set();
  const nodes = [];
  const files = [];
  const unresolved = [];
  let rootName = "";

  while (folders.length) {
    const folder = folders.shift();
    if (seenFolders.has(folder.id)) continue;
    seenFolders.add(folder.id);

    progress?.({ phase: "crawl-folder", name: folder.name || folder.id, path: folder.relParts.join("/") });
    const state = await navigateToNode(tab, folder.id);
    if (!state.hasFolderCounts) {
      files.push({ ...folder, name: folder.name || state.currentName || folder.id, sourceState: state });
      continue;
    }

    const folderName = folder.name || state.currentName || folder.id;
    if (!rootName) rootName = folderName;
    const relParts = folder.relParts;
    nodes.push(makeTreeNode({ id: folder.id, name: folderName, type: "folder", relParts, state }));

    const page = await collectFolderItems(tab, state);
    if (page.totalCount != null && page.items.length < page.totalCount) {
      unresolved.push({
        type: "incomplete-list",
        id: folder.id,
        name: folderName,
        path: relParts.join("/"),
        expected: page.totalCount,
        found: page.items.length
      });
    }

    for (const item of page.items) {
      const itemName = item.name || item.id;
      const childParts = [...relParts, itemName];
      const hint = classifyItem(item);
      if (hint === "file") {
        files.push({ id: item.id, name: itemName, relParts: childParts, item });
        nodes.push(makeTreeNode({ id: item.id, name: itemName, type: "file", relParts: childParts, item }));
      } else {
        const detected = await detectNodeKind(tab, item);
        if (detected.kind === "folder") {
          folders.push({ id: item.id, name: itemName, relParts: childParts });
        } else {
          files.push({ id: item.id, name: itemName, relParts: childParts, item, sourceState: detected.state });
          nodes.push(makeTreeNode({ id: item.id, name: itemName, type: "file", relParts: childParts, item }));
        }
      }
    }
  }

  return { rootId, rootName, nodes, files, unresolved };
}

async function clickDownloadInPreview(tab) {
  const preview = tab.playwright.frameLocator("#uni-preview");
  const downloadButton = preview.locator('[data-testid="download"]');
  const count = await downloadButton.count().catch(() => 0);
  if (!count) return { ok: false, reason: "no-download-button" };

  let eventPromise;
  try {
    eventPromise = tab.playwright.waitForEvent("download", { timeoutMs: 45000 });
    await downloadButton.first().click({ timeoutMs: 15000 });
  } catch (error) {
    eventPromise?.catch(() => null);
    return { ok: false, reason: String(error).slice(0, 500) };
  }
  const download = await eventPromise;
  const downloadedPath = await download.path?.();
  const suggestedFilename = await download.suggestedFilename?.().catch(() => "");
  if (!downloadedPath) return { ok: false, reason: "no-download-path", suggestedFilename };
  return { ok: true, downloadedPath, suggestedFilename };
}

async function downloadFile(tab, file, outDir, options, progress) {
  const relParts = file.relParts && file.relParts.length ? file.relParts : [file.name || file.id];
  const fallbackName = sanitizeName(file.name || file.id);
  let targetPath = safeJoin(outDir, relParts);
  const ext = path.extname(targetPath);

  if (options.skipExisting && await pathExists(targetPath)) {
    return { status: "skipped", reason: "exists", targetPath };
  }

  progress?.({ phase: "download-file", name: file.name || file.id, path: relParts.join("/") });
  const state = await navigateToNode(tab, file.id);
  if (!state.hasPreview) {
    const linkPath = ext ? `${targetPath}.url.txt` : `${targetPath}.url.txt`;
    await ensureDir(path.dirname(linkPath));
    await fs.writeFile(linkPath, [
      `名称：${file.name || fallbackName}`,
      `钉钉地址：${remoteUrl(file.id)}`,
      `状态：未发现可自动下载的预览下载按钮`,
      ""
    ].join("\n"), "utf8");
    return { status: "linked", reason: "no-preview", targetPath: linkPath };
  }

  let result;
  try {
    result = await clickDownloadInPreview(tab);
  } catch (error) {
    result = { ok: false, reason: String(error).slice(0, 500) };
  }

  if (!result.ok) {
    const linkPath = ext ? `${targetPath}.url.txt` : `${targetPath}.url.txt`;
    await ensureDir(path.dirname(linkPath));
    await fs.writeFile(linkPath, [
      `名称：${file.name || fallbackName}`,
      `钉钉地址：${remoteUrl(file.id)}`,
      `状态：下载失败或无下载按钮`,
      `原因：${result.reason || "unknown"}`,
      ""
    ].join("\n"), "utf8");
    return { status: "linked", reason: result.reason || "download-failed", targetPath: linkPath };
  }

  if (!path.extname(targetPath) && result.suggestedFilename) {
    const suggestedExt = path.extname(result.suggestedFilename);
    if (suggestedExt) targetPath = `${targetPath}${suggestedExt}`;
  }
  await moveFile(result.downloadedPath, targetPath, { overwrite: options.overwrite });
  return { status: "downloaded", targetPath, suggestedFilename: result.suggestedFilename || "" };
}

async function createFolderSkeleton(outDir, nodes) {
  for (const node of nodes) {
    if (node.type !== "folder") continue;
    const dir = node.path ? safeJoin(outDir, node.path.split("/")) : outDir;
    await ensureDir(dir);
  }
}

async function writeReports(outDir, mirror) {
  const treePath = path.join(outDir, "_alidocs_tree.json");
  await fs.writeFile(treePath, JSON.stringify(mirror.tree, null, 2), "utf8");

  const linkItems = mirror.results.filter((item) => item.status !== "downloaded" && item.status !== "skipped");
  const indexLines = [
    "# 在线文档与链接入口索引",
    "",
    `镜像时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    "",
    linkItems.length
      ? `以下 ${linkItems.length} 项未能直接下载，已生成本地入口说明文件。`
      : "本次没有发现需要单独记录的在线入口；可下载文件已保存到对应目录。",
    ""
  ];
  for (const item of linkItems) {
    indexLines.push(`## ${item.name}`);
    indexLines.push(`- 本地位置：${item.targetPath || ""}`);
    indexLines.push(`- 钉钉地址：${remoteUrl(item.id)}`);
    indexLines.push(`- 状态：${item.status}${item.reason ? `（${item.reason}）` : ""}`);
    indexLines.push("");
  }
  await fs.writeFile(path.join(outDir, "_在线文档与链接入口索引.md"), indexLines.join("\n"), "utf8");

  const downloaded = mirror.results.filter((item) => item.status === "downloaded").length;
  const skipped = mirror.results.filter((item) => item.status === "skipped").length;
  const linked = mirror.results.filter((item) => item.status === "linked").length;
  const failed = mirror.results.filter((item) => item.status === "failed").length;
  const folders = mirror.tree.nodes.filter((item) => item.type === "folder").length;
  const files = mirror.tree.nodes.filter((item) => item.type === "file").length;

  const reportLines = [
    "# 钉钉知识库镜像报告",
    "",
    `镜像时间：${new Date().toLocaleString("zh-CN", { hour12: false })}`,
    `来源根节点：${mirror.tree.rootName || mirror.tree.rootId}`,
    `来源地址：${remoteUrl(mirror.tree.rootId)}`,
    `本地目录：${outDir}`,
    "",
    "## 结果概览",
    "",
    `- 文件夹：${folders}`,
    `- 文件条目：${files}`,
    `- 已下载：${downloaded}`,
    `- 已跳过：${skipped}`,
    `- 入口说明：${linked}`,
    `- 失败：${failed}`,
    "",
    "## 未完整读取的目录",
    "",
    mirror.tree.unresolved.length ? "" : "无。",
    ...mirror.tree.unresolved.map((item) => `- ${item.path || item.name}：应有 ${item.expected} 项，已读取 ${item.found} 项`),
    "",
    "## 文件明细",
    "",
    ...mirror.results.map((item) => `- [${item.status}] ${item.path} -> ${item.targetPath || item.reason || ""}`)
  ];
  await fs.writeFile(path.join(outDir, "_mirror_report.md"), reportLines.join("\n"), "utf8");

  return { treePath, reportPath: path.join(outDir, "_mirror_report.md") };
}

export async function mirrorAliDocsFromBrowser({
  tab,
  rootId,
  rootUrl,
  outDir,
  overwrite = true,
  skipExisting = false,
  progress
}) {
  if (!tab) throw new Error("tab is required");
  if (!outDir) throw new Error("outDir is required");
  const resolvedRootId = rootId || String(rootUrl || "").match(/\/nodes\/([^?/#]+)/)?.[1];
  if (!resolvedRootId) throw new Error("rootId or rootUrl is required");

  await ensureDir(outDir);
  await openVisibleNode(tab, resolvedRootId).catch(async () => {
    const state = await extractPageState(tab);
    if (!state?.url?.includes(`/nodes/${resolvedRootId}`)) throw new Error(`root node is not visible: ${resolvedRootId}`);
  });

  const acc = { rootName: "", nodes: [], results: [], unresolved: [] };
  await crawlAndMirrorCurrentFolder(
    tab,
    { id: resolvedRootId, name: "", relParts: [] },
    outDir,
    { overwrite, skipExisting },
    acc,
    progress
  );

  const tree = {
    source: "alidocs-browser-ui",
    rootId: resolvedRootId,
    rootName: acc.rootName,
    rootUrl: remoteUrl(resolvedRootId),
    mirroredAt: new Date().toISOString(),
    nodes: acc.nodes,
    unresolved: acc.unresolved
  };
  const mirror = { tree, results: acc.results };
  const reports = await writeReports(outDir, mirror);
  return {
    outDir,
    reports,
    tree,
    results: acc.results,
    summary: {
      folders: tree.nodes.filter((item) => item.type === "folder").length,
      files: tree.nodes.filter((item) => item.type === "file").length,
      downloaded: acc.results.filter((item) => item.status === "downloaded").length,
      skipped: acc.results.filter((item) => item.status === "skipped").length,
      linked: acc.results.filter((item) => item.status === "linked").length,
      failed: acc.results.filter((item) => item.status === "failed").length,
      unresolved: tree.unresolved.length
    }
  };
}
