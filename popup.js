const scanButton = document.getElementById("scan");
const resultsBox = document.getElementById("results");
const statusBox = document.getElementById("status");
const selectionSummary = document.getElementById("selection-summary");
const downloadButton = document.getElementById("download-selected");
const downloadFormat = document.getElementById("download-format");
const downloadJobPanel = document.getElementById("download-job");
const jobSummary = document.getElementById("job-summary");
const jobHelp = document.getElementById("job-help");
const jobItemsBox = document.getElementById("job-items");
const resumeJobButton = document.getElementById("resume-job");
const refreshJobLinksButton = document.getElementById("refresh-job-links");
document.getElementById("version").textContent = chrome.runtime.getManifest().version;
let currentSelectionRecords = [];
let currentTabId = null;
let currentBlackboardHostname = "";
let currentCourseName = "Curso";
let downloadInProgress = false;
let latestDownloadJob = null;
let matchingRefreshLinks = [];

function selectedFileRecords() {
  return currentSelectionRecords.filter((record) => record.checkbox.checked);
}

function updateDownloadButton() {
  const selected = selectedFileRecords();
  downloadButton.textContent = downloadFormat.value === "zip" ? "Crear y descargar ZIP" : "Descargar seleccionados";
  const folderJobActive = downloadFormat.value === "folder" && latestDownloadJob && latestDownloadJob.status !== "complete";
  downloadButton.disabled = downloadInProgress || Boolean(folderJobActive) || selected.length === 0 || selected.some((record) => !record.url);
}

downloadFormat.addEventListener("change", updateDownloadButton);

resumeJobButton.addEventListener("click", async () => {
  resumeJobButton.disabled = true;
  jobHelp.textContent = "Intentando reanudar en Edge…";
  try {
    const result = await chrome.runtime.sendMessage({ type: "resume-folder-download-job" });
    if (!result?.ok) jobHelp.textContent = result?.error || "Edge no pudo reanudar el archivo.";
    if (result?.job) renderDownloadJob(result.job);
    else await refreshDownloadJob();
  } catch (error) {
    jobHelp.textContent = error.message || "No pude reanudar el archivo.";
  } finally {
    resumeJobButton.disabled = false;
  }
});

refreshJobLinksButton.addEventListener("click", async () => {
  if (!matchingRefreshLinks.length) return;
  refreshJobLinksButton.disabled = true;
  jobHelp.textContent = "Actualizando enlaces temporales de esta sesión…";
  try {
    const result = await chrome.runtime.sendMessage({
      type: "refresh-folder-download-links",
      links: matchingRefreshLinks.map(({ itemId, url }) => ({ itemId, url }))
    });
    if (!result?.ok) jobHelp.textContent = result?.error || "No pude actualizar los enlaces.";
    if (result?.job) renderDownloadJob(result.job);
    else await refreshDownloadJob();
    if (result?.ok) statusBox.textContent = `Actualicé ${result.updated} enlace(s). La cola continúa desde el primer archivo pendiente.`;
  } catch (error) {
    jobHelp.textContent = error.message || "No pude actualizar los enlaces.";
  } finally {
    refreshJobLinksButton.disabled = false;
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "folder-download-job-updated") renderDownloadJob(message.job || null);
});

void refreshDownloadJob();
window.setInterval(() => void refreshDownloadJob(), 1200);

function inspectClassInventory() {
  const detected = new Map();
  const unassignedFiles = new Map();
  const classNumberPattern = /\bCLASE\s+(?:N\s*[°ºo.]?\s*)?(\d{1,3})\b/i;
  const classOccurrencePattern = /\b(CLASE\s+(?:N\s*[°ºo.]?\s*)?\d{1,3}(?:\s*[-–—:]\s*[^\n\r›>]{1,70})?)/gi;
  const filePattern = /([^\r\n<>]{1,140}?\.(?:pdf|pptx?|xlsx?|docx?|csv|tsv|zip|rar|7z|txt|png|jpe?g|gif|mp3|mp4|mov|wav|odt|ods|odp|rtf)\b)/gi;

  function clean(value) {
    return String(value || "")
      .replace(/[\u00a0\t]+/g, " ")
      .replace(/\s+/g, " ")
      .replace(/[⌄⌃▼]+$/g, "")
      .trim()
      .slice(0, 200);
  }

  function classInfosIn(value) {
    const found = new Map();
    for (const line of String(value || "").split(/\r?\n/)) {
      for (const match of line.matchAll(classOccurrencePattern)) {
        let title = clean(match[1]);
        title = title.replace(/\s+Este elemento contiene otros elementos.*$/i, "").trim();
        title = title.replace(/\s+Se marcar[aá].*$/i, "").trim();
        title = title.replace(/\s+(?:\|\s*)?\d+\s+(?:completado|iniciado|sin iniciar)\b.*$/i, "").trim();
        const numberMatch = title.match(classNumberPattern);
        if (numberMatch) {
          const number = Number(numberMatch[1]);
          const previous = found.get(number);
          if (!previous || title.length > previous.title.length) found.set(number, { number, title });
        }
      }
    }
    return found;
  }

  function registerClass(info) {
    const old = detected.get(info.number);
    if (!old) detected.set(info.number, { name: info.title, files: [] });
    else if (info.title.length > old.name.length) old.name = info.title;
  }

  function fileNamesIn(value) {
    const found = new Map();
    for (const line of String(value || "").split(/\r?\n/)) {
      const matches = line.matchAll(filePattern);
      for (const match of matches) {
        const fileName = clean(match[1])
          .replace(/^[\s|:•·-]+/, "")
          .replace(/^(?:estado\s+de|marcar\s+como\s+completado|ir\s+a|go\s+to|open|abrir|descargar|download|ver|view|archivo)\s*[:\-]?\s*/i, "")
          .trim();
        if (!fileName || fileName.length > 140) continue;
        found.set(fileName.toLowerCase(), fileName);
      }
    }
    return [...found.values()];
  }

  function normalizedFileName(value) {
    return clean(value).normalize("NFC").toLocaleLowerCase();
  }

  function safeDownloadUrl(value, sourceField) {
    if (typeof value !== "string" || !value.trim()) return null;
    try {
      const url = new URL(value, location.href);
      if (url.protocol !== "https:") return null;
      const isDuocHost = url.hostname === location.hostname || url.hostname.endsWith(".duoc.cl");
      if (!isDuocHost) return null;
      if (/\/ultra\/courses\/.*\/file\//i.test(url.pathname)) return null;
      let mode = "direct";
      if (sourceField === "resourceUrl") mode = "forced";
      else if (sourceField === "downloadUrl" || /\/bbcswebdav\//i.test(url.pathname) || url.searchParams.has("xythos-download")) mode = "xythos";
      if (sourceField === "resourceUrl" || sourceField === "downloadUrl") return { url: url.href, mode };
      if (/\/bbcswebdav\//i.test(url.pathname) || /\/attachments?\/.*\/download(?:\/|$)/i.test(url.pathname)) return { url: url.href, mode };
      if (/\.(?:pdf|pptx?|xlsx?|docx?|csv|tsv|zip|rar|7z|txt|png|jpe?g|gif|mp3|mp4|mov|wav|odt|ods|odp|rtf)$/i.test(url.pathname)) return { url: url.href, mode };
    } catch {}
    return null;
  }

  function reactFileUrlForElement(element, fileName) {
    try {
      const targetName = normalizedFileName(fileName);

      function findUrlInProps(root) {
        const visited = new Set();
        const pending = [{ value: root, depth: 0 }];
        const candidates = [];
        let hasMatchingName = false;
        let examined = 0;
        while (pending.length && examined < 700) {
          const { value, depth } = pending.pop();
          if (!value || typeof value !== "object" || visited.has(value) || depth > 6) continue;
          visited.add(value);
          examined += 1;
          const keys = Object.keys(value).slice(0, 80);
          const labels = ["fileName", "filename", "displayName", "originalFileName", "name", "title"];
          if (labels.some((key) => typeof value[key] === "string" && normalizedFileName(value[key]) === targetName)) {
            hasMatchingName = true;
          }
          for (const key of ["resourceUrl", "downloadUrl", "fileUrl", "href", "url"]) {
            const candidate = safeDownloadUrl(value[key], key === "url" || key === "href" ? "href" : key);
            if (candidate && !candidates.some((existing) => existing.url === candidate.url)) candidates.push(candidate);
          }
          for (const key of keys) {
            if (key === "return" || key === "stateNode" || key === "_owner" || key === "_store") continue;
            const child = value[key];
            if (child && typeof child === "object") pending.push({ value: child, depth: depth + 1 });
          }
        }
        return hasMatchingName ? candidates[0] || null : null;
      }

      for (const key of Object.keys(element)) {
        if (key.startsWith("__reactProps$")) {
          const candidate = findUrlInProps(element[key]);
          if (candidate) return candidate;
        }
        if (key.startsWith("__reactFiber$")) {
          let fiber = element[key];
          let hops = 0;
          while (fiber && hops < 14) {
            if (fiber.memoizedProps) {
              const candidate = findUrlInProps(fiber.memoizedProps);
              if (candidate) return candidate;
            }
            fiber = fiber.return;
            hops += 1;
          }
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  function downloadUrlForFile(collapse, fileName) {
    const targetName = normalizedFileName(fileName);
    for (const anchor of collapse.querySelectorAll("a")) {
      const labels = [anchor.getAttribute("aria-label"), anchor.getAttribute("title"), anchor.innerText || anchor.textContent || ""];
      const anchorNames = labels.flatMap((value) => fileNamesIn(value || ""));
      if (!anchorNames.some((name) => normalizedFileName(name) === targetName)) continue;
      const row = anchor.closest('[class*="contentListItem"], [class*="content-list-item"]');
      const relatedElements = [anchor];
      if (row) {
        relatedElements.push(row);
        relatedElements.push(...row.querySelectorAll('button[data-analytics-id*="overflowMenu"], button[aria-label*="opciones" i], button[title*="opciones" i]'));
      }
      for (const element of relatedElements) {
        const modelUrl = reactFileUrlForElement(element, fileName);
        if (modelUrl) return modelUrl;
      }
      const directHref = safeDownloadUrl(anchor.href, "href");
      if (directHref) return directHref;
    }
    return null;
  }

  const selectors = 'a, button, li, span, [role="treeitem"], [role="button"], [title], [aria-label]';
  const scope = document;

  for (const element of scope.querySelectorAll(selectors)) {
    const values = [element.getAttribute("title"), element.getAttribute("aria-label")];
    const text = element.innerText || element.textContent || "";
    if (text.length <= 1200) values.push(text);
    for (const value of values) {
      for (const info of classInfosIn(value || "").values()) registerClass(info);
    }
  }

  for (const collapse of scope.querySelectorAll('[class*="MuiCollapse-root"]')) {
    const collapseText = collapse.innerText || collapse.textContent || "";
    const fileNames = fileNamesIn(collapseText);
    if (!fileNames.length) continue;

    const classesInside = classInfosIn(collapseText);
    if (classesInside.size > 1) continue;

    const previousSibling = collapse.previousElementSibling;
    const siblingClasses = previousSibling
      ? classInfosIn(previousSibling.innerText || previousSibling.textContent || "")
      : new Map();
    const classInfo = siblingClasses.size === 1
      ? [...siblingClasses.values()][0]
      : classesInside.size === 1 ? [...classesInside.values()][0] : null;
    const target = classInfo ? (registerClass(classInfo), detected.get(classInfo.number).files) : null;
    for (const fileName of fileNames) {
      const entry = { name: fileName, url: downloadUrlForFile(collapse, fileName) };
      if (target) {
        const existing = target.find((item) => item.name.toLowerCase() === fileName.toLowerCase());
        if (!existing) target.push(entry);
        else if (!existing.url && entry.url) Object.assign(existing, entry);
      } else if (!unassignedFiles.has(fileName.toLowerCase())) {
        unassignedFiles.set(fileName.toLowerCase(), entry);
      } else if (!unassignedFiles.get(fileName.toLowerCase()).url && entry.url) {
        unassignedFiles.set(fileName.toLowerCase(), entry);
      }
    }
  }

  const classes = [...detected.entries()]
    .sort(([numberA], [numberB]) => numberA - numberB)
    .map(([, record]) => ({ name: record.name, files: record.files }));
  const filesWithoutClass = [...unassignedFiles.values()];
  const fileCount = classes.reduce((total, item) => total + item.files.length, filesWithoutClass.length);
  const titleParts = document.title.split(/[|–—]/).map((part) => part.trim()).filter(Boolean);
  const pageTitle = titleParts[0] || "Título no visible";
  const courseName = titleParts.length > 1 ? titleParts.at(-1) : pageTitle;
  return { pageTitle, courseName, classes, filesWithoutClass, fileCount };
}

async function getActiveBlackboardTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) throw new Error("No pude identificar la pestaña activa.");
  const url = new URL(tab.url);
  if (url.protocol !== "https:" || !(url.hostname === "ava.duoc.cl" || url.hostname.endsWith(".duoc.cl"))) {
    throw new Error("Abre primero una página de Blackboard de Duoc en AVA.");
  }
  return tab;
}

scanButton.addEventListener("click", async () => {
  statusBox.textContent = "Leyendo nombres ya cargados en la pestaña…";
  resultsBox.replaceChildren();
  currentSelectionRecords = [];
  selectionSummary.textContent = "0 archivos seleccionados.";
  updateDownloadButton();
  scanButton.disabled = true;
  try {
    const tab = await getActiveBlackboardTab();
    currentTabId = tab.id;
    currentBlackboardHostname = new URL(tab.url).hostname;
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: inspectClassInventory
    });
    renderResult(result?.result || { pageTitle: "Título no visible", courseName: "Curso", classes: [], filesWithoutClass: [], fileCount: 0 });
    void refreshDownloadJob();
  } catch (error) {
    resultsBox.replaceChildren();
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = error.message || "No pude leer esta página.";
    resultsBox.append(message);
    currentSelectionRecords = [];
    selectionSummary.textContent = "0 archivos seleccionados.";
    updateDownloadButton();
    statusBox.textContent = "No se modificó el curso.";
    void refreshDownloadJob();
  } finally {
    scanButton.disabled = false;
  }
});

downloadButton.addEventListener("click", async () => {
  const selected = selectedFileRecords();
  if (!selected.length || selected.some((record) => !record.url)) return;

  downloadInProgress = true;
  updateDownloadButton();
  try {
    if (downloadFormat.value === "zip") {
      await downloadSelectedAsZip(selected);
    } else {
      await downloadSelectedAsFolders(selected);
    }
  } catch (error) {
    statusBox.textContent = error.message || "No pude preparar la descarga.";
  } finally {
    downloadInProgress = false;
    updateDownloadButton();
  }
});

function getDownloadUrl(record) {
  const url = new URL(record.url);
  const isDuocHost = url.hostname === currentBlackboardHostname || url.hostname.endsWith(".duoc.cl");
  if (isDuocHost && record.mode === "forced") {
    url.searchParams.set("isForcedDownload", "true");
    url.searchParams.set("downloadFileName", record.name);
  } else if (isDuocHost && record.mode === "xythos" && !url.searchParams.has("xythos-download")) {
    url.searchParams.set("xythos-download", "true");
  }
  return url;
}

async function downloadSelectedAsFolders(selected) {
  const courseFolder = sanitizePathSegment(currentCourseName);
  const selectedClasses = [...new Set(selected
    .filter((record) => record.folder !== "Archivos sin clase identificada")
    .map((record) => sanitizePathSegment(record.folder)))];
  const classLabel = summarizeClassNames(selectedClasses);
  const files = selected.map((record) => {
    const url = getDownloadUrl(record);
    const filename = `${courseFolder}/${sanitizePathSegment(record.folder)}/${sanitizePathSegment(record.name)}`;
    return { url: url.href, filename, name: record.name, folder: record.folder };
  });
  statusBox.textContent = "Guardando la cola de descargas…";
  const result = await chrome.runtime.sendMessage({
    type: "start-folder-download-job",
    courseName: currentCourseName,
    files
  });
  if (!result?.ok) throw new Error(result?.error || "No pude iniciar la cola de descargas.");
  if (result.job) renderDownloadJob(result.job);
  statusBox.textContent = result.job?.items?.[0]?.status === "needs-link"
    ? "Guardé la cola, pero Edge no pudo iniciar el primer archivo. Revisa el estado y actualiza su enlace."
    : `Cola iniciada: ${selected.length} archivo(s) para ${selectedClasses.length} clase(s) (${classLabel}). Se procesan uno a uno; el progreso queda guardado en este equipo.`;
}

async function refreshDownloadJob() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "get-folder-download-job" });
    if (result?.ok) renderDownloadJob(result.job || null);
  } catch {}
}

function renderDownloadJob(job) {
  latestDownloadJob = job;
  matchingRefreshLinks = job ? findRefreshableLinks(job) : [];
  if (!job) {
    downloadJobPanel.hidden = true;
    updateDownloadButton();
    return;
  }

  downloadJobPanel.hidden = false;
  const total = job.items.length;
  const completed = job.items.filter((item) => item.status === "complete").length;
  const active = job.items.find((item) => item.status === "downloading" || item.status === "starting");
  const resumable = job.items.filter((item) => item.canResume && ["paused", "interrupted"].includes(item.status));
  const needsLinks = job.items.filter((item) => item.status === "needs-link");
  jobSummary.textContent = `${job.courseName}: ${completed} de ${total} archivo(s) completados.`;

  if (job.status === "complete") {
    jobHelp.textContent = "La cola terminó. Puedes iniciar otra descarga cuando quieras.";
  } else if (active) {
    const received = Number(active.bytesReceived) || 0;
    const totalBytes = Number(active.totalBytes);
    const percent = totalBytes > 0 ? ` (${Math.min(100, Math.floor(received / totalBytes * 100))}%)` : "";
    jobHelp.textContent = `Descargando ${active.name}${percent}. Puedes cerrar este panel; la cola sigue en Edge.`;
  } else if (resumable.length) {
    jobHelp.textContent = `${resumable.length} archivo(s) se pueden reanudar desde donde se interrumpieron.`;
  } else if (needsLinks.length && matchingRefreshLinks.length) {
    jobHelp.textContent = `Detecté enlaces para ${matchingRefreshLinks.length} de ${needsLinks.length} archivo(s) pendientes. Pulsa el botón para reanudar la cola.`;
  } else if (needsLinks.length) {
    jobHelp.textContent = `Faltan enlaces para ${needsLinks.length} archivo(s). Abre Blackboard, detecta el contenido y expande las clases pendientes.`;
  } else {
    jobHelp.textContent = "La cola está esperando que Edge actualice el estado de la descarga.";
  }

  resumeJobButton.hidden = !resumable.length;
  resumeJobButton.textContent = resumable.length > 1
    ? `Reanudar archivo interrumpido (${resumable.length})`
    : "Reanudar archivo interrumpido";
  refreshJobLinksButton.hidden = !matchingRefreshLinks.length;
  refreshJobLinksButton.textContent = `Actualizar enlaces pendientes (${matchingRefreshLinks.length})`;

  const previousScrollTop = jobItemsBox.scrollTop;
  jobItemsBox.replaceChildren();
  for (const item of job.items) {
    const listItem = document.createElement("li");
    const row = document.createElement("div");
    row.className = "job-item-row";
    const name = document.createElement("span");
    name.className = "job-item-name";
    name.textContent = `${item.folder} · ${item.name}`;
    const state = document.createElement("span");
    state.className = "job-item-status";
    state.textContent = jobItemStatus(item);
    if (item.pathChanged) state.title = "Edge guardó este archivo en otra carpeta.";
    row.append(name, state);
    listItem.append(row);

    if (["downloading", "paused"].includes(item.status)) {
      const progress = document.createElement("progress");
      progress.className = "job-item-progress";
      progress.max = 1;
      if (Number(item.totalBytes) > 0) progress.value = Math.min(1, (Number(item.bytesReceived) || 0) / Number(item.totalBytes));
      listItem.append(progress);
    }
    jobItemsBox.append(listItem);
  }
  jobItemsBox.scrollTop = previousScrollTop;
  updateDownloadButton();
}

function findRefreshableLinks(job) {
  if (normalizeMatch(currentCourseName) !== normalizeMatch(job.courseName)) return [];
  const pending = job.items.filter((item) => item.status === "needs-link");
  const available = currentSelectionRecords.filter((record) => record.url);
  const used = new Set();
  const matches = [];

  for (const item of pending) {
    const record = available.find((candidate) => !used.has(candidate)
      && normalizeMatch(candidate.name) === normalizeMatch(item.name)
      && normalizeMatch(candidate.folder) === normalizeMatch(item.folder));
    if (!record) continue;
    try {
      matches.push({ itemId: item.id, url: getDownloadUrl(record).href });
      used.add(record);
    } catch {}
  }
  return matches;
}

function normalizeMatch(value) {
  return String(value || "").normalize("NFC").trim().toLocaleLowerCase();
}

function jobItemStatus(item) {
  const labels = {
    pending: "Pendiente",
    starting: "Iniciando",
    downloading: "Descargando",
    paused: "Pausado",
    interrupted: "Interrumpido",
    "needs-link": "Requiere enlace",
    complete: "Completado"
  };
  return item.pathChanged ? `${labels[item.status] || item.status} · ruta cambiada` : labels[item.status] || item.status;
}

function summarizeClassNames(names) {
  if (!names.length) return "sin clase identificada";
  if (names.length <= 2) return names.join(", ");
  return `${names[0]}, ${names[1]} y ${names.length - 2} más`;
}

async function downloadSelectedAsZip(selected) {
  if (!currentTabId) throw new Error("Vuelve a detectar el contenido antes de crear el ZIP.");
  const files = selected.map((record) => ({
    url: getDownloadUrl(record).href,
    path: `${sanitizePathSegment(record.folder)}/${sanitizePathSegment(record.name)}`
  }));
  statusBox.textContent = "Preparando ZIP en la pestaña de Blackboard…";
  const [outcome] = await chrome.scripting.executeScript({
    target: { tabId: currentTabId },
    world: "MAIN",
    func: buildZipAndDownloadInBlackboardPage,
    args: [{
      files,
      filename: `${sanitizePathSegment(currentCourseName)}.zip`,
      maxBytes: 50 * 1024 * 1024
    }]
  });
  if (!outcome?.result?.ok) throw new Error(outcome?.result?.error || "No pude preparar el ZIP.");
  statusBox.textContent = `Descarga del ZIP iniciada con ${outcome.result.fileCount} archivo(s), separados por clase.`;
}

async function buildZipAndDownloadInBlackboardPage(options) {
  const encoder = new TextEncoder();
  const maxBytes = options.maxBytes;
  const files = [];
  let totalBytes = 0;

  try {
    for (const item of options.files) {
      const url = new URL(item.url, location.href);
      if (url.origin !== location.origin) {
        throw new Error(`${item.path}: el enlace no pertenece al mismo sitio de Blackboard. Prueba el formato de carpetas.`);
      }
      const response = await fetch(url.href, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`${item.path}: Blackboard respondió HTTP ${response.status}.`);
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (contentType.includes("text/html")) {
        throw new Error(`${item.path}: Blackboard devolvió una página en vez del archivo. Prueba el formato de carpetas.`);
      }

      const chunks = [];
      let size = 0;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (totalBytes + size > maxBytes) {
              await reader.cancel();
              throw new Error("La selección supera el límite de 50 MB para ZIP. Usa el formato de carpetas o selecciona menos archivos.");
            }
            chunks.push(value);
          }
        } finally {
          reader.releaseLock();
        }
      } else {
        const buffer = await response.arrayBuffer();
        size = buffer.byteLength;
        if (totalBytes + size > maxBytes) {
          throw new Error("La selección supera el límite de 50 MB para ZIP. Usa el formato de carpetas o selecciona menos archivos.");
        }
        chunks.push(new Uint8Array(buffer));
      }

      const bytes = new Uint8Array(size);
      let byteOffset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, byteOffset);
        byteOffset += chunk.byteLength;
      }
      const preview = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trimStart().toLowerCase();
      if (preview.startsWith("<!doctype html") || preview.startsWith("<html") || preview.startsWith("<form")) {
        throw new Error(`${item.path}: Blackboard devolvió una página de inicio de sesión o del visor en vez del archivo.`);
      }
      totalBytes += bytes.length;
      files.push({ path: item.path, bytes });
    }

    const entries = [];
    const usedPaths = new Set();
    let localOffset = 0;
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
    const dosDate = ((Math.max(1980, now.getFullYear()) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const crcTable = new Uint32Array(256);
    for (let index = 0; index < crcTable.length; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      crcTable[index] = value >>> 0;
    }

    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
      return (crc ^ 0xffffffff) >>> 0;
    }

    for (const file of files) {
      let path = file.path;
      let duplicate = 2;
      while (usedPaths.has(path.toLocaleLowerCase())) {
        const slash = path.lastIndexOf("/");
        const directory = slash >= 0 ? path.slice(0, slash + 1) : "";
        const base = slash >= 0 ? path.slice(slash + 1) : path;
        const dot = base.lastIndexOf(".");
        const stem = dot > 0 ? base.slice(0, dot) : base;
        const extension = dot > 0 ? base.slice(dot) : "";
        path = `${directory}${stem} (${duplicate})${extension}`;
        duplicate += 1;
      }
      usedPaths.add(path.toLocaleLowerCase());
      const nameBytes = encoder.encode(path);
      const checksum = crc32(file.bytes);
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const local = new DataView(localHeader.buffer);
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, dosTime, true);
      local.setUint16(12, dosDate, true);
      local.setUint32(14, checksum, true);
      local.setUint32(18, file.bytes.length, true);
      local.setUint32(22, file.bytes.length, true);
      local.setUint16(26, nameBytes.length, true);
      local.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);
      entries.push({ path, nameBytes, bytes: file.bytes, checksum, localHeader, localOffset, dosTime, dosDate });
      localOffset += localHeader.length + file.bytes.length;
    }

    const centralParts = [];
    let centralSize = 0;
    for (const entry of entries) {
      const header = new Uint8Array(46 + entry.nameBytes.length);
      const central = new DataView(header.buffer);
      central.setUint32(0, 0x02014b50, true);
      central.setUint16(4, 20, true);
      central.setUint16(6, 20, true);
      central.setUint16(8, 0x0800, true);
      central.setUint16(10, 0, true);
      central.setUint16(12, entry.dosTime, true);
      central.setUint16(14, entry.dosDate, true);
      central.setUint32(16, entry.checksum, true);
      central.setUint32(20, entry.bytes.length, true);
      central.setUint32(24, entry.bytes.length, true);
      central.setUint16(28, entry.nameBytes.length, true);
      central.setUint16(30, 0, true);
      central.setUint16(32, 0, true);
      central.setUint16(34, 0, true);
      central.setUint16(36, 0, true);
      central.setUint32(38, 0, true);
      central.setUint32(42, entry.localOffset, true);
      header.set(entry.nameBytes, 46);
      centralParts.push(header);
      centralSize += header.length;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(4, 0, true);
    endView.setUint16(6, 0, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, centralSize, true);
    endView.setUint32(16, localOffset, true);
    endView.setUint16(20, 0, true);

    const archive = new Blob([
      ...entries.flatMap((entry) => [entry.localHeader, entry.bytes]),
      ...centralParts,
      end
    ], { type: "application/zip" });
    const objectUrl = URL.createObjectURL(archive);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = options.filename;
    anchor.style.display = "none";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    return { ok: true, fileCount: files.length, totalBytes };
  } catch (error) {
    return { ok: false, error: error.message || "No pude preparar el ZIP." };
  }
}

function sanitizePathSegment(value) {
  let safe = String(value || "")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 150);
  if (!safe || safe === "." || safe === "..") safe = "Sin nombre";
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  return safe;
}

function renderResult(result) {
  resultsBox.replaceChildren();
  currentCourseName = result.courseName || result.pageTitle || "Curso";
  const pageTitle = document.createElement("p");
  pageTitle.className = "summary";
  pageTitle.textContent = `Vista actual: ${result.pageTitle}`;
  resultsBox.append(pageTitle);

  if (!result.classes.length) {
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = "No encontré carpetas con nombre «CLASE N°…» en esta vista. Abre la lista de contenido del curso y vuelve a intentar.";
    resultsBox.append(message);
    currentSelectionRecords = [];
    selectionSummary.textContent = "0 archivos seleccionados.";
    updateDownloadButton();
    statusBox.textContent = "No se abrió ni modificó nada.";
    return;
  }

  const associatedCount = result.classes.reduce((total, item) => total + item.files.length, 0);
  const classesWithFiles = result.classes.filter((item) => item.files.length).length;
  const count = document.createElement("p");
  count.className = "muted";
  count.textContent = `Encontré ${result.classes.length} clase(s) y ${result.fileCount} nombre(s) de archivo: ${associatedCount} asociado(s) a ${classesWithFiles} clase(s), ${result.filesWithoutClass.length} sin asociación segura.`;
  resultsBox.append(count);

  const fileSelectionRecords = [];
  currentSelectionRecords = fileSelectionRecords;
  const groupStates = [];
  const selectAllRow = document.createElement("label");
  selectAllRow.className = "select-all-row";
  const selectAll = document.createElement("input");
  selectAll.type = "checkbox";
  selectAll.disabled = result.fileCount === 0;
  const selectAllText = document.createElement("span");
  selectAllText.textContent = "Seleccionar todos los archivos visibles";
  selectAllRow.append(selectAll, selectAllText);
  resultsBox.append(selectAllRow);

  const list = document.createElement("ul");
  list.className = "tree";

  function updateSelectionSummary() {
    for (const group of groupStates) {
      const selectedInGroup = group.children.filter((checkbox) => checkbox.checked).length;
      group.checkbox.checked = selectedInGroup > 0 && selectedInGroup === group.children.length;
      group.checkbox.indeterminate = selectedInGroup > 0 && selectedInGroup < group.children.length;
    }
    const selected = fileSelectionRecords.filter((record) => record.checkbox.checked);
    const withoutLinkCount = selected.filter((record) => !record.url).length;
    const selectedClasses = new Set(selected
      .filter((record) => record.folder !== "Archivos sin clase identificada")
      .map((record) => record.folder));
    selectionSummary.textContent = `${selected.length} archivo(s) seleccionado(s) de ${selectedClasses.size} clase(s), ${fileSelectionRecords.length} visible(s).${withoutLinkCount ? ` ${withoutLinkCount} sin enlace directo.` : ""}`;
    selectAll.checked = fileSelectionRecords.length > 0 && selected.length === fileSelectionRecords.length;
    selectAll.indeterminate = selected.length > 0 && selected.length < fileSelectionRecords.length;
    updateDownloadButton();
  }

  function addGroup(title, files, { emptyMessage = "", className = "", folder = title } = {}) {
    const item = document.createElement("li");
    if (className) item.className = className;
    const row = document.createElement("div");
    row.className = "tree-row";

    if (!files.length) {
      const spacer = document.createElement("span");
      spacer.className = "tree-spacer";
      spacer.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "tree-label";
      label.textContent = title;
      const empty = document.createElement("span");
      empty.className = "muted tree-empty";
      empty.textContent = emptyMessage;
      row.append(spacer, label, empty);
      item.append(row);
      list.append(item);
      return;
    }

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "tree-toggle";
    toggle.textContent = "▾";
    toggle.setAttribute("aria-expanded", "true");
    toggle.setAttribute("aria-label", `Contraer ${title}`);

    const groupCheckbox = document.createElement("input");
    groupCheckbox.type = "checkbox";
    groupCheckbox.setAttribute("aria-label", `Seleccionar todos los archivos de ${title}`);
    const label = document.createElement("label");
    label.className = "tree-label";
    const groupName = document.createElement("span");
    groupName.textContent = title;
    label.prepend(groupCheckbox);
    label.append(groupName);
    const groupCount = document.createElement("span");
    groupCount.className = "tree-count";
    groupCount.textContent = `${files.length}`;
    label.append(groupCount);
    row.append(toggle, label);

    const children = document.createElement("ul");
    children.className = "tree-children";
    const childCheckboxes = [];
    for (const fileEntry of files) {
      const fileName = typeof fileEntry === "string" ? fileEntry : fileEntry.name;
      const fileUrl = typeof fileEntry === "string" ? null : fileEntry.url?.url || null;
      const fileMode = typeof fileEntry === "string" ? "" : fileEntry.url?.mode || "";
      const fileItem = document.createElement("li");
      const fileRow = document.createElement("label");
      fileRow.className = "tree-file-row";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.addEventListener("change", updateSelectionSummary);
      childCheckboxes.push(checkbox);
      fileSelectionRecords.push({ checkbox, name: fileName, folder, url: fileUrl, mode: fileMode });
      const fileLabel = document.createElement("span");
      fileLabel.className = "file-name";
      fileLabel.textContent = fileName;
      const linkStatus = document.createElement("span");
      linkStatus.className = fileUrl ? "download-status ready" : "download-status missing";
      linkStatus.textContent = fileUrl ? "enlace listo" : "sin enlace";
      linkStatus.title = fileUrl ? "Blackboard expuso un enlace directo para este archivo." : "No encontré un enlace directo seguro en esta vista.";
      fileRow.append(checkbox, fileLabel, linkStatus);
      fileItem.append(fileRow);
      children.append(fileItem);
    }
    groupStates.push({ checkbox: groupCheckbox, children: childCheckboxes });

    groupCheckbox.addEventListener("change", () => {
      for (const checkbox of childCheckboxes) checkbox.checked = groupCheckbox.checked;
      updateSelectionSummary();
    });
    toggle.addEventListener("click", () => {
      children.hidden = !children.hidden;
      toggle.textContent = children.hidden ? "▸" : "▾";
      toggle.setAttribute("aria-expanded", String(!children.hidden));
      toggle.setAttribute("aria-label", `${children.hidden ? "Expandir" : "Contraer"} ${title}`);
    });

    item.append(row, children);
    list.append(item);
    updateSelectionSummary();
  }

  for (const classEntry of result.classes) {
    addGroup(classEntry.name, classEntry.files, { emptyMessage: "sin archivos visibles", folder: classEntry.name });
  }
  if (result.filesWithoutClass.length) {
    addGroup("Archivos sin clase identificada", result.filesWithoutClass, {
      className: "unassigned-group",
      folder: "Archivos sin clase identificada"
    });
  }
  selectAll.addEventListener("change", () => {
    for (const record of fileSelectionRecords) record.checkbox.checked = selectAll.checked;
    updateSelectionSummary();
  });
  resultsBox.append(list);
  updateSelectionSummary();
  const readyCount = fileSelectionRecords.filter((record) => record.url).length;
  statusBox.textContent = readyCount
    ? `${readyCount} de ${fileSelectionRecords.length} archivo(s) tiene(n) enlace directo. Las descargas empiezan solo al pulsar el botón.`
    : result.fileCount
      ? "Encontré los nombres, pero Blackboard no expuso enlaces directos seguros en esta vista. No habilité la descarga para evitar guardar páginas del visor como archivos."
      : "No encontré archivos visibles. Abre manualmente una clase y vuelve a detectar.";
}
