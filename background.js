const JOB_STORAGE_KEY = "folderDownloadJob";
const SESSION_URLS_KEY = "folderDownloadSessionUrls";
const pendingDownloadPaths = new Map();
const startingItems = new Set();
const startingItemUrls = new Map();
const jobMutationTails = new Map();

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
    return { ok: true, job };
  }
  if (message?.type === "start-folder-download-job") return startFolderJob(message);
  if (message?.type === "resume-folder-download-job") return resumeFolderJob();
  if (message?.type === "refresh-folder-download-links") return refreshFolderJobLinks(message.links);
  return null;
}

async function startFolderJob(message) {
  if (!Array.isArray(message.files) || !message.files.length) throw new Error("No hay archivos para descargar.");

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

  const tasks = [];
  await withJobMutationLock(null, async () => {
    const previous = await readJob();
    if (previous && previous.status !== "complete") {
      throw new Error("Hay una cola pendiente. Reanúdala o actualiza sus enlaces antes de iniciar otra.");
    }
    await chrome.storage.session.set({ [SESSION_URLS_KEY]: urls });
    for (const item of items) {
      const url = urls[item.id];
      const key = normalizeDownloadKey(url);
      const queue = pendingDownloadPaths.get(key) || [];
      queue.push(item.filename);
      pendingDownloadPaths.set(key, queue);
      item.status = "starting";
      item.startRequestedAt = Date.now();
      startingItems.add(item.id);
      startingItemUrls.set(item.id, url);
      tasks.push({ itemId: item.id, url, filename: item.filename, key });
    }
    await saveJob(job);
  });
  for (const task of tasks) {
    void startDownloadForItem(job.id, task).catch(() => {
      startingItems.delete(task.itemId);
      startingItemUrls.delete(task.itemId);
    });
  }
  return { ok: true, job: await getJobSnapshot() };
}

async function startDownloadForItem(jobId, task) {
  let downloadId;
  try {
    downloadId = await chrome.downloads.download({
      url: task.url,
      filename: task.filename,
      conflictAction: "uniquify",
      saveAs: false
    });
  } catch {
    removePendingDownloadPath(task.key, task.filename);
    await mutateJob(jobId, async (job) => {
      await removeSessionUrlUnlocked(task.itemId);
      const item = job.items.find((candidate) => candidate.id === task.itemId);
      if (!item) return false;
      item.status = "needs-link";
      item.downloadId = null;
      item.canResume = false;
      item.error = "Edge no pudo iniciar esta descarga. Actualiza el enlace para volver a intentarlo.";
      return true;
    });
    startingItems.delete(task.itemId);
    startingItemUrls.delete(task.itemId);
    return;
  }

  removePendingDownloadPath(task.key, task.filename);
  let download = null;
  try {
    [download] = await chrome.downloads.search({ id: downloadId });
  } catch {}

  await mutateJob(jobId, async (job) => {
    await removeSessionUrlUnlocked(task.itemId);
    const item = job.items.find((candidate) => candidate.id === task.itemId);
    if (!item) return false;
    item.downloadIds ||= [];
    if (!item.downloadIds.includes(downloadId)) item.downloadIds.push(downloadId);
    item.downloadId = downloadId;
    if (download) updateItemFromDownload(item, download);
    else item.status = "downloading";
    return true;
  });
  startingItems.delete(task.itemId);
  startingItemUrls.delete(task.itemId);
}

async function startReadyItems(jobId) {
  const tasks = await withJobMutationLock(jobId, async () => {
    const job = await readJob();
    if (!job || job.id !== jobId) return [];
    const stored = await chrome.storage.session.get(SESSION_URLS_KEY);
    const urls = stored[SESSION_URLS_KEY] || {};
    const ready = job.items.filter((item) => item.status === "pending" && urls[item.id]);
    if (!ready.length) return [];

    const nextTasks = [];
    for (const item of ready) {
      const url = urls[item.id];
      const key = normalizeDownloadKey(url);
      const queue = pendingDownloadPaths.get(key) || [];
      queue.push(item.filename);
      pendingDownloadPaths.set(key, queue);
      item.status = "starting";
      item.startRequestedAt = Date.now();
      item.error = "";
      startingItems.add(item.id);
      startingItemUrls.set(item.id, url);
      nextTasks.push({ itemId: item.id, url, filename: item.filename, key });
    }
    await saveJob(job);
    return nextTasks;
  });

  for (const task of tasks) {
    void startDownloadForItem(jobId, task).catch(() => {
      startingItems.delete(task.itemId);
      startingItemUrls.delete(task.itemId);
    });
  }
  return tasks.length;
}

async function removeSessionUrlUnlocked(itemId) {
  try {
    const stored = await chrome.storage.session.get(SESSION_URLS_KEY);
    const urls = stored[SESSION_URLS_KEY] || {};
    if (!(itemId in urls)) return;
    delete urls[itemId];
    await chrome.storage.session.set({ [SESSION_URLS_KEY]: urls });
  } catch {}
}

async function resumeFolderJob() {
  const job = await readJob();
  if (!job) throw new Error("No hay una cola guardada.");
  const candidates = job.items.filter((item) => ["paused", "interrupted"].includes(item.status) && item.downloadId);
  if (!candidates.length) throw new Error("No hay descargas interrumpidas que Edge pueda reanudar.");
  let resumed = 0;
  let needsLinks = 0;

  await Promise.all(candidates.map(async (candidate) => {
    const [download] = await chrome.downloads.search({ id: candidate.downloadId });
    if (download?.state === "complete" || (download?.state === "in_progress" && !download.paused)) {
      await mutateJob(job.id, (current) => {
        const item = current.items.find((entry) => entry.id === candidate.id);
        if (!item) return false;
        updateItemFromDownload(item, download);
        return true;
      });
      return;
    }

    if (download?.canResume) {
      try {
        await chrome.downloads.resume(candidate.downloadId);
        await mutateJob(job.id, (current) => {
          const item = current.items.find((entry) => entry.id === candidate.id);
          if (!item) return false;
          item.status = "downloading";
          item.canResume = false;
          item.error = "";
          return true;
        });
        resumed += 1;
        return;
      } catch {}
    }

    await mutateJob(job.id, (current) => {
      const item = current.items.find((entry) => entry.id === candidate.id);
      if (!item) return false;
      item.status = "needs-link";
      item.canResume = false;
      item.downloadId = null;
      item.error = "Edge no pudo continuar este archivo. Actualiza el enlace para volver a intentarlo.";
      return true;
    });
    needsLinks += 1;
  }));

  return { ok: resumed > 0 || needsLinks === 0, resumed, needsLinks, job: await getJobSnapshot() };
}

async function refreshFolderJobLinks(links) {
  if (!Array.isArray(links) || !links.length) throw new Error("No encontré enlaces nuevos para la cola.");
  const updated = await withJobMutationLock(null, async () => {
    const job = await readJob();
    if (!job) throw new Error("No hay una cola guardada.");
    const stored = await chrome.storage.session.get(SESSION_URLS_KEY);
    const urls = stored[SESSION_URLS_KEY] || {};
    let count = 0;

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
      count += 1;
    }

    if (!count) throw new Error("No hay archivos pendientes con enlaces que actualizar.");
    await chrome.storage.session.set({ [SESSION_URLS_KEY]: urls });
    await saveJob(job);
    return { jobId: job.id, count };
  });
  await startReadyItems(updated.jobId);
  return { ok: true, updated: updated.count, job: await getJobSnapshot() };
}

async function handleDownloadChanged(delta) {
  const [download] = await chrome.downloads.search({ id: delta.id });
  if (!download) return;
  const job = await readJob();
  if (!job) return;
  await mutateJob(job.id, (current) => {
    let item = current.items.find((candidate) => candidate.downloadId === delta.id);
    if (!item) item = findStartingItem(current, download);
    if (!item) return false;
    item.downloadIds ||= [];
    if (!item.downloadIds.includes(delta.id)) item.downloadIds.push(delta.id);
    item.downloadId = delta.id;
    startingItems.delete(item.id);
    startingItemUrls.delete(item.id);
    updateItemFromDownload(item, download);
    return true;
  });
}

async function getJobSnapshot() {
  const snapshot = await withJobMutationLock(null, async () => {
    const job = await readJob();
    if (!job) return null;
    const stored = await chrome.storage.session.get(SESSION_URLS_KEY);
    const urls = stored[SESSION_URLS_KEY] || {};
    const liveItems = new Map();
    let changed = false;

    for (const item of job.items) {
      if (item.status === "starting" && !item.downloadId) {
        if (startingItems.has(item.id)) continue;
        const recovered = await findRecentDownload(job, item);
        if (recovered) {
          item.downloadId = recovered.id;
          item.downloadIds ||= [];
          if (!item.downloadIds.includes(recovered.id)) item.downloadIds.push(recovered.id);
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

    return {
      job: { ...job, items: job.items.map((item) => ({ ...item, ...(liveItems.get(item.id) || {}) })) },
      hasResumablePending: job.items.some((item) => item.status === "pending" && urls[item.id])
    };
  });
  if (!snapshot) return null;
  if (snapshot.hasResumablePending) void startReadyItems(snapshot.job.id);
  return snapshot.job;
}

function findStartingItem(job, download) {
  if (!belongsToThisExtension(download)) return null;
  const urlKey = normalizeDownloadKey(download.url);
  const candidates = job.items.filter((item) => item.status === "starting" && !item.downloadId && startingItems.has(item.id)
    && normalizeDownloadKey(startingItemUrls.get(item.id) || "") === urlKey);
  if (!candidates.length) return null;
  if (download.filename) {
    const match = candidates.find((item) => pathEndsWith(download.filename, item.filename));
    if (match) return match;
  }
  return candidates.sort((a, b) => (a.startRequestedAt || 0) - (b.startRequestedAt || 0))[0];
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
  if (job.items.every((item) => item.status === "complete")) return "complete";
  if (job.items.some((item) => ["starting", "downloading"].includes(item.status))) return "downloading";
  if (job.items.some((item) => item.status === "paused")) return "paused";
  if (job.items.some((item) => item.status === "interrupted")) return "interrupted";
  if (job.items.some((item) => item.status === "needs-link" || (item.status === "pending" && !urls[item.id]))) return "needs-links";
  if (job.items.some((item) => item.status === "pending" && urls[item.id])) return "queued";
  return "needs-links";
}

async function withJobMutationLock(_jobId, operation) {
  const lockKey = JOB_STORAGE_KEY;
  const previous = jobMutationTails.get(lockKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  jobMutationTails.set(lockKey, current);
  try {
    return await current;
  } finally {
    if (jobMutationTails.get(lockKey) === current) jobMutationTails.delete(lockKey);
  }
}

async function mutateJob(jobId, operation) {
  return withJobMutationLock(jobId, async () => {
    const job = await readJob();
    if (!job || job.id !== jobId) return null;
    const changed = await operation(job);
    if (changed !== false) await saveJob(job);
    return job;
  });
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
