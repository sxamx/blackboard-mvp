const pendingDownloadPaths = new Map();
let activeDownloadPath = null;

chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
  const key = normalizeDownloadKey(downloadItem.url);
  const queue = pendingDownloadPaths.get(key);
  let filename = "";
  if (belongsToThisExtension(downloadItem) && queue?.length) {
    filename = queue.shift();
    if (!queue.length) pendingDownloadPaths.delete(key);
  } else if (activeDownloadPath && isCurrentDownload(downloadItem, activeDownloadPath)) {
    filename = activeDownloadPath.filename;
  }
  if (filename) {
    suggest({ filename, conflictAction: "uniquify" });
    return;
  }
  suggest();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "download-blackboard-files") return false;
  downloadFilesIntoFolders(message.files)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: error.message || "No pude iniciar las descargas." }));
  return true;
});

async function downloadFilesIntoFolders(files) {
  if (!Array.isArray(files) || !files.length) throw new Error("No hay archivos para descargar.");
  let started = 0;
  const failures = [];
  const misplaced = [];
  const queuedUrls = new Set();

  for (const item of files) {
    let key = "";
    let filename = "";
    try {
      const url = new URL(item.url);
      if (url.protocol !== "https:" || !(url.hostname === "duoc.cl" || url.hostname.endsWith(".duoc.cl"))) {
        throw new Error("El enlace no pertenece a un sitio HTTPS de Duoc.");
      }
      filename = sanitizeRelativePath(item.filename);
      key = normalizeDownloadKey(url.href);
      const queue = pendingDownloadPaths.get(key) || [];
      queue.push(filename);
      pendingDownloadPaths.set(key, queue);
      queuedUrls.add(key);
      activeDownloadPath = { url: url.href, key, filename };

      const downloadId = await chrome.downloads.download({
        url: url.href,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      });
      started += 1;

      try {
        const [download] = await chrome.downloads.search({ id: downloadId });
        if (download?.filename && !downloadPathMatches(download.filename, filename)) {
          misplaced.push({ name: item.filename, expected: filename, actual: download.filename });
        }
      } catch {}
    } catch (error) {
      if (key && filename) removePendingDownloadPath(key, filename);
      failures.push(`${item?.filename || "Archivo"}: ${error.message || "error al iniciar"}`);
    } finally {
      activeDownloadPath = null;
    }
  }

  for (const key of queuedUrls) pendingDownloadPaths.delete(key);
  return { ok: true, started, failures, misplaced };
}

function sanitizeRelativePath(value) {
  const rawSegments = String(value || "").split(/[\\/]/);
  if (rawSegments.length < 2 || rawSegments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("La ruta de descarga no es relativa o no tiene carpetas.");
  }
  const segments = rawSegments.map((segment) => {
    let safe = segment
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .trim()
      .slice(0, 150);
    if (!safe || safe === "." || safe === "..") safe = "Sin nombre";
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
    return safe;
  });
  return segments.join("/");
}

function normalizeDownloadKey(url) {
  try { return new URL(url).href; } catch { return String(url || ""); }
}

function belongsToThisExtension(downloadItem) {
  return !downloadItem.byExtensionId || downloadItem.byExtensionId === chrome.runtime.id;
}

function isCurrentDownload(downloadItem, active) {
  if (!belongsToThisExtension(downloadItem)) return false;
  const itemKey = normalizeDownloadKey(downloadItem.url);
  if (itemKey === active.key) return true;
  try {
    const itemUrl = new URL(downloadItem.url);
    const activeUrl = new URL(active.url);
    return itemUrl.origin === activeUrl.origin && itemUrl.pathname === activeUrl.pathname;
  } catch {
    return false;
  }
}

function removePendingDownloadPath(key, filename) {
  const queue = pendingDownloadPaths.get(key);
  if (!queue) return;
  const index = queue.indexOf(filename);
  if (index >= 0) queue.splice(index, 1);
  if (!queue.length) pendingDownloadPaths.delete(key);
}

function downloadPathMatches(absolutePath, expectedRelativePath) {
  const actual = String(absolutePath).split(/[\\/]+/).filter(Boolean).map((part) => part.toLocaleLowerCase());
  const expected = String(expectedRelativePath).split(/[\\/]+/).filter(Boolean).slice(0, -1).map((part) => part.toLocaleLowerCase());
  if (!expected.length) return true;
  const actualDirectories = actual.slice(0, -1);
  if (actualDirectories.length < expected.length) return false;
  return expected.every((part, index) => actualDirectories[actualDirectories.length - expected.length + index] === part);
}
