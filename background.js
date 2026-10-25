const JOB_STORAGE_KEY = "folderDownloadJob";
const SESSION_URLS_KEY = "folderDownloadSessionUrls";
const pendingDownloadPaths = new Map();
const startingJobs = new Set();
let activeDownloadPath = null;

if (chrome.storage.local.setAccessLevel) {
  void chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
}
if (chrome.storage.session?.setAccessLevel) {
  void chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }).catch(() => {});
}

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

chrome.downloads.onChanged.addListener((delta) => {
  void handleDownloadChanged(delta).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!["get-folder-download-job", "start-folder-download-job", "resume-folder-download-job", "refresh-folder-download-links"].includes(message?.type)) return false;
  const operation = handleMessage(message);
  operation
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message || "No pude actualizar la cola." }));
  return true;
});

async function handleMessage(message) {
  if (message?.type === "get-folder-download-job") {
    const job = await getJobSnapshot();
    if (job?.status === "queued") void startNextPending(job.id);
    return { ok: true, job };
  }
  if (message?.type === "start-folder-download-job") return startFolderJob(message);
  if (message?.type === "resume-folder-download-job") return resumeFolderJob();
  if (message?.type === "refresh-folder-download-links") return refreshFolderJobLinks(message.links);
  return null;
}

async function startFolderJob(message) {
  if (!Array.isArray(message.files) || !message.files.length) throw new Error("No hay archivos para descargar.");
  const previous = await readJob();
  if (previous && previous.status !== "complete") {
    throw new Error("Hay una cola pendiente. Reanúdala o actualiza sus enlaces antes de iniciar otra.");
  }

  const urls = {};
  const items = message.files.map((file) => {
    const url = validateDuocDownloadUrl(file.url);
    const filename = sanitizeRelativePath(file.filename);
    const id = makeId();
    urls[id] = url;
    return {
      id,
      name: safeLabel(file.name, "Archivo"),
      folder: safeLabel(file.folder, "Clase"),
      filename,
      status: "pending",
      downloadId: null,
      downloadIds: [],
      startRequestedAt: null,
      bytesReceived: 0,
      totalBytes: -1,
      canResume: false,
      error: "",
      pathChanged: false
    };
  });

  const job = {
    id: makeId(),
    courseName: safeLabel(message.courseName, "Curso"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "queued",
    items
  };

  await chrome.storage.session.set({ [SESSION_URLS_KEY]: urls });
  await saveJob(job);
  await startNextPending(job.id);
  return { ok: true, job: await getJobSnapshot() };
}

async function resumeFolderJob() {
  const job = await readJob();
  if (!job) throw new Error("No hay una cola guardada.");
  const item = job.items.find((candidate) => ["paused", "interrupted"].includes(candidate.status) && candidate.downloadId);
  if (!item) throw new Error("No hay una descarga interrumpida que Edge pueda reanudar.");

  const [download] = await chrome.downloads.search({ id: item.downloadId });
  if (download?.state === "complete") {
    updateItemFromDownload(item, download);
    await saveJob(job);
    void startNextPending(job.id);
    return { ok: true, job: await getJobSnapshot() };
  }
  if (download?.state === "in_progress" && !download.paused) {
    updateItemFromDownload(item, download);
    await saveJob(job);
    return { ok: true, job: await getJobSnapshot() };
  }
  if (!download?.canResume) {
    item.status = "needs-link";
    item.canResume = false;
    item.downloadId = null;
    item.error = "Edge no puede continuar este archivo. Actualiza el enlace para volver a intentarlo.";
    await saveJob(job);
    return { ok: false, error: item.error, job: await getJobSnapshot() };
  }

  try {
    await chrome.downloads.resume(item.downloadId);
    item.status = "downloading";
    item.canResume = false;
    item.error = "";
    await saveJob(job);
    return { ok: true, job: await getJobSnapshot() };
  } catch {
    item.status = "needs-link";
    item.canResume = false;
    item.downloadId = null;
    item.error = "Edge no pudo continuar este archivo. Actualiza el enlace para volver a intentarlo.";
    await saveJob(job);
    return { ok: false, error: item.error, job: await getJobSnapshot() };
  }
}

async function refreshFolderJobLinks(links) {
  if (!Array.isArray(links) || !links.length) throw new Error("No encontré enlaces nuevos para la cola.");
  const job = await readJob();
  if (!job) throw new Error("No hay una cola guardada.");
  const stored = await chrome.storage.session.get(SESSION_URLS_KEY);
  const urls = stored[SESSION_URLS_KEY] || {};
  let updated = 0;

  for (const link of links) {
    const item = job.items.find((candidate) => candidate.id === link.itemId);
    if (!item || !["pending", "needs-link"].includes(item.status)) continue;
    urls[item.id] = validateDuocDownloadUrl(link.url);
    item.status = "pending";
    item.downloadId = null;
    item.bytesReceived = 0;
    item.totalBytes = -1;
    item.canResume = false;
    item.error = "";
    updated += 1;
  }

  if (!updated) throw new Error("No hay archivos pendientes con enlaces que actualizar.");
  await chrome.storage.session.set({ [SESSION_URLS_KEY]: urls });
  await saveJob(job);
  await startNextPending(job.id);
  return { ok: true, updated, job: await getJobSnapshot() };
}

async function startNextPending(jobId) {
  if (startingJobs.has(jobId)) return;
  startingJobs.add(jobId);
  let advance = false;

  try {
    const job = await readJob();
    if (!job || job.id !== jobId) return;
    const stored = await chrome.storage.session.get(SESSION_URLS_KEY);
    const urls = stored[SESSION_URLS_KEY] || {};
    const item = job.items.find((candidate) => candidate.status !== "complete");

    if (!item) {
      job.status = "complete";
      await chrome.storage.session.remove(SESSION_URLS_KEY);
      await saveJob(job);
      return;
    }
    if (["starting", "downloading", "paused", "interrupted"].includes(item.status)) return;
    if (item.status === "needs-link") return;

    const url = urls[item.id];
    if (!url) {
      item.status = "needs-link";
      item.error = "Abre Blackboard y detecta nuevamente esta clase para actualizar el enlace.";
      await saveJob(job);
      return;
    }

    const key = normalizeDownloadKey(url);
    const queue = pendingDownloadPaths.get(key) || [];
    queue.push(item.filename);
    pendingDownloadPaths.set(key, queue);
    activeDownloadPath = { url, key, filename: item.filename };
    item.status = "starting";
    item.startRequestedAt = Date.now();
    item.error = "";
    await saveJob(job);

    let downloadId;
    try {
      downloadId = await chrome.downloads.download({
        url,
        filename: item.filename,
        conflictAction: "uniquify",
        saveAs: false
      });
    } catch {
      removePendingDownloadPath(key, item.filename);
      delete urls[item.id];
      await chrome.storage.session.set({ [SESSION_URLS_KEY]: urls });
      item.status = "needs-link";
      item.error = "Edge no pudo iniciar este archivo. Actualiza el enlace para volver a intentarlo.";
      await saveJob(job);
      return;
    } finally {
      activeDownloadPath = null;
    }

    delete urls[item.id];
    await chrome.storage.session.set({ [SESSION_URLS_KEY]: urls });
    item.downloadId = downloadId;
    item.downloadIds.push(downloadId);
    item.status = "downloading";
    item.canResume = false;

    try {
      const [download] = await chrome.downloads.search({ id: downloadId });
      if (download) updateItemFromDownload(item, download);
    } catch {}
    await saveJob(job);
    advance = item.status === "complete";
  } finally {
    startingJobs.delete(jobId);
  }

  if (advance) await startNextPending(jobId);
}

async function handleDownloadChanged(delta) {
  const job = await readJob();
  if (!job) return;
  const item = job.items.find((candidate) => candidate.downloadId === delta.id);
  if (!item) return;

  const [download] = await chrome.downloads.search({ id: delta.id });
  if (!download) return;
  const previousStatus = item.status;
  updateItemFromDownload(item, download);
  await saveJob(job);

  if (item.status === "complete" && previousStatus !== "complete") {
    void startNextPending(job.id);
  }
}

async function getJobSnapshot() {
  const job = await readJob();
  if (!job) return null;
  const stored = await chrome.storage.session.get(SESSION_URLS_KEY);
  const urls = stored[SESSION_URLS_KEY] || {};
  const liveItems = new Map();
  let changed = false;

  for (const item of job.items) {
    if (item.status === "starting" && !item.downloadId) {
      const recovered = startingJobs.has(job.id) ? null : await findRecentDownload(job, item);
      if (startingJobs.has(job.id)) continue;
      if (recovered) {
        item.downloadId = recovered.id;
        item.downloadIds.push(recovered.id);
        updateItemFromDownload(item, recovered);
        delete urls[item.id];
        changed = true;
      } else if (urls[item.id]) {
        item.status = "pending";
        changed = true;
      } else {
        item.status = "needs-link";
        changed = true;
      }
    }

    if (item.downloadId && ["starting", "downloading", "paused", "interrupted"].includes(item.status)) {
      const [download] = await chrome.downloads.search({ id: item.downloadId });
      if (download) {
        if (updateItemFromDownload(item, download, false)) changed = true;
        liveItems.set(item.id, { bytesReceived: download.bytesReceived, totalBytes: download.totalBytes });
      } else {
        item.downloadId = null;
        item.status = "needs-link";
        item.canResume = false;
        item.error = "Edge ya no tiene esta descarga en su historial. Actualiza el enlace para reintentarlo.";
        changed = true;
      }
    }

    if (item.status === "pending" && !urls[item.id]) {
      item.status = "needs-link";
      item.error = "Abre Blackboard y detecta nuevamente esta clase para actualizar el enlace.";
      changed = true;
    }
  }

  const nextStatus = deriveJobStatus(job, urls);
  if (job.status !== nextStatus) {
    job.status = nextStatus;
    changed = true;
  }
  if (changed) {
    await chrome.storage.session.set({ [SESSION_URLS_KEY]: urls });
    await saveJob(job);
  }

  const snapshot = {
    ...job,
    items: job.items.map((item) => ({ ...item, ...(liveItems.get(item.id) || {}) }))
  };
  return snapshot;
}

async function findRecentDownload(job, item) {
  try {
    const filenameRegex = requestedFilenameRegex(item.filename);
    const results = await chrome.downloads.search({ filenameRegex, orderBy: ["-startTime"], limit: 30 });
    const createdAfter = Math.max(0, (item.startRequestedAt || job.createdAt) - 1_000);
    return results.find((download) => {
      if (download.byExtensionId !== chrome.runtime.id || !download.startTime) return false;
      if (new Date(download.startTime).getTime() < createdAfter) return false;
      return pathEndsWith(download.filename, item.filename);
    }) || null;
  } catch {
    return null;
  }
}

function updateItemFromDownload(item, download, includeProgress = true) {
  let changed = false;
  const set = (key, value) => {
    if (item[key] !== value) {
      item[key] = value;
      changed = true;
    }
  };

  if (includeProgress) {
    const received = Number(download.bytesReceived);
    const total = Number(download.totalBytes);
    set("bytesReceived", Number.isFinite(received) ? received : 0);
    set("totalBytes", Number.isFinite(total) ? total : -1);
  }
  set("canResume", Boolean(download.canResume));
  set("pathChanged", Boolean(download.filename && !downloadPathMatches(download.filename, item.filename)));

  if (download.state === "complete") {
    set("status", "complete");
    set("error", "");
  } else if (download.state === "interrupted") {
    set("status", download.canResume ? "interrupted" : "needs-link");
    set("error", download.canResume
      ? (download.error || "La conexión se interrumpió. Puedes intentar reanudar este archivo.")
      : "Edge no puede continuar este archivo. Actualiza el enlace para volver a intentarlo.");
    if (!download.canResume) set("downloadId", null);
  } else if (download.state === "in_progress") {
    set("status", download.paused ? "paused" : "downloading");
    set("error", "");
  }
  return changed;
}

async function saveJob(job) {
  const stored = await chrome.storage.session.get(SESSION_URLS_KEY);
  job.status = deriveJobStatus(job, stored[SESSION_URLS_KEY] || {});
  job.updatedAt = Date.now();
  await chrome.storage.local.set({ [JOB_STORAGE_KEY]: job });
  try {
    await chrome.runtime.sendMessage({ type: "folder-download-job-updated", job });
  } catch {}
}

async function readJob() {
  const stored = await chrome.storage.local.get(JOB_STORAGE_KEY);
  return stored[JOB_STORAGE_KEY] || null;
}

function deriveJobStatus(job, urls) {
  const item = job.items.find((candidate) => candidate.status !== "complete");
  if (!item) return "complete";
  if (item.status === "downloading" || item.status === "starting") return "downloading";
  if (item.status === "paused") return "paused";
  if (item.status === "interrupted") return "interrupted";
  if (item.status === "needs-link") return "needs-links";
  if (item.status === "pending") return urls[item.id] ? "queued" : "needs-links";
  return "needs-links";
}

function validateDuocDownloadUrl(value) {
  const url = new URL(String(value || ""));
  if (url.protocol !== "https:" || !(url.hostname === "duoc.cl" || url.hostname.endsWith(".duoc.cl"))) {
    throw new Error("El enlace no pertenece a un sitio HTTPS de Duoc.");
  }
  return url.href;
}

function safeLabel(value, fallback) {
  const label = String(value || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 300);
  return label || fallback;
}

function makeId() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

function pathEndsWith(absolutePath, expectedRelativePath) {
  const actualParts = String(absolutePath).replace(/\\/g, "/").split("/").filter(Boolean).map((part) => part.toLocaleLowerCase());
  const expectedParts = String(expectedRelativePath).replace(/\\/g, "/").split("/").filter(Boolean).map((part) => part.toLocaleLowerCase());
  if (!expectedParts.length || actualParts.length < expectedParts.length) return false;
  const expectedDirectories = expectedParts.slice(0, -1);
  const actualDirectories = actualParts.slice(0, -1);
  if (!expectedDirectories.every((part, index) => actualDirectories[actualDirectories.length - expectedDirectories.length + index] === part)) return false;

  const expectedName = expectedParts.at(-1);
  const actualName = actualParts.at(-1);
  if (actualName === expectedName) return true;
  const dot = expectedName.lastIndexOf(".");
  const extension = dot > 0 ? expectedName.slice(dot) : "";
  const stem = dot > 0 ? expectedName.slice(0, dot) : expectedName;
  const middle = actualName.slice(stem.length, actualName.length - extension.length);
  return actualName.startsWith(`${stem} (`) && actualName.endsWith(extension) && /^\(\d+\)$/.test(middle);
}

function requestedFilenameRegex(relativePath) {
  const name = String(relativePath).split(/[\\/]/).at(-1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot) : "";
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:${escape(stem)}(?: \\(\\d+\\))?${escape(extension)})$`;
}
