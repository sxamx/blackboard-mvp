const scanButton = document.getElementById("scan");
const classOpener = document.getElementById("class-opener");
const openAllClassesCheckbox = document.getElementById("open-all-classes");
const openClassList = document.getElementById("open-class-list");
const openClassesButton = document.getElementById("open-classes-button");
const openClassesStatus = document.getElementById("open-classes-status");
const resultsBox = document.getElementById("results");
const statusBox = document.getElementById("status");
const selectionSummary = document.getElementById("selection-summary");
const downloadButton = document.getElementById("download-selected");
const downloadFormat = document.getElementById("download-format");
const downloadJobPanel = document.getElementById("download-job");
const jobSummary = document.getElementById("job-summary");
const jobHelp = document.getElementById("job-help");
const jobItemsBox = document.getElementById("job-items");
const jobStatusBadge = document.getElementById("job-status-badge");
const jobProgress = document.getElementById("job-progress");
const resumeJobButton = document.getElementById("resume-job");
const refreshJobLinksButton = document.getElementById("refresh-job-links");
const clearJobButton = document.getElementById("clear-job");
const classesView = document.getElementById("classes-view");
const queueView = document.getElementById("queue-view");
const classesTabButton = document.getElementById("tab-classes");
const queueTabButton = document.getElementById("tab-queue");
const classesTabCount = document.getElementById("classes-tab-count");
const queueTabCount = document.getElementById("queue-tab-count");
const queueEmpty = document.getElementById("queue-empty");
const queueStatusBox = document.getElementById("queue-status");
const queueGoClassesButton = document.getElementById("queue-go-classes");
const scanWelcome = document.getElementById("scan-welcome");
const classWorkspace = document.getElementById("class-workspace");
const downloadPanel = document.getElementById("download-panel");
const courseTitle = document.getElementById("course-title");
const openClassCount = document.getElementById("open-class-count");
const jobProgressLabel = document.getElementById("job-progress-label");
const formatHelp = document.getElementById("format-help");
document.getElementById("version").textContent = chrome.runtime.getManifest().version;
let currentSelectionRecords = [];
let currentTabId = null;
let currentBlackboardHostname = "";
let currentCourseName = "Curso";
let downloadInProgress = false;
let latestDownloadJob = null;
let matchingRefreshLinks = [];
let currentClassNames = [];
let openingClasses = false;

function selectedFileRecords() {
  return currentSelectionRecords.filter((record) => record.checkbox.checked);
}

function updateDownloadButton() {
  const selected = selectedFileRecords();
  const isZip = downloadFormat.value === "zip";
  const isLoose = downloadFormat.value === "loose";
  const countLabel = selected.length === 1 ? "1 archivo" : `${selected.length} archivos`;
  downloadButton.textContent = isZip ? `Crear ZIP · ${countLabel}` : `Descargar ${countLabel}`;
  formatHelp.textContent = isZip
    ? "Un ZIP con una subcarpeta por clase. Límite actual: 100 MB de contenido."
    : isLoose
      ? "Archivos juntos en una carpeta del curso, sin separarlos por clase."
      : "Una subcarpeta por clase. Edge puede pedir Guardar por cada archivo.";
  for (const button of document.querySelectorAll(".format-option")) {
    const selectedFormat = button.dataset.format === downloadFormat.value;
    button.classList.toggle("is-selected", selectedFormat);
    button.setAttribute("aria-pressed", String(selectedFormat));
  }
  const folderJobActive = !isZip && latestDownloadJob && latestDownloadJob.status !== "complete";
  downloadButton.disabled = downloadInProgress || Boolean(folderJobActive) || selected.length === 0 || selected.some((record) => !record.url);
}

for (const button of document.querySelectorAll(".format-option")) {
  button.addEventListener("click", () => {
    downloadFormat.value = button.dataset.format;
    downloadFormat.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

downloadFormat.addEventListener("change", updateDownloadButton);

function showView(viewName) {
  const queueActive = viewName === "queue";
  classesView.hidden = queueActive;
  queueView.hidden = !queueActive;
  classesTabButton.classList.toggle("is-active", !queueActive);
  queueTabButton.classList.toggle("is-active", queueActive);
  classesTabButton.setAttribute("aria-selected", String(!queueActive));
  queueTabButton.setAttribute("aria-selected", String(queueActive));
  classesTabButton.tabIndex = queueActive ? -1 : 0;
  queueTabButton.tabIndex = queueActive ? 0 : -1;
  if (queueActive) void refreshDownloadJob();
}

classesTabButton.addEventListener("click", () => showView("classes"));
queueTabButton.addEventListener("click", () => showView("queue"));
for (const [index, button] of [classesTabButton, queueTabButton].entries()) {
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextIndex = (index + (event.key === "ArrowRight" ? 1 : -1) + 2) % 2;
    const nextButton = [classesTabButton, queueTabButton][nextIndex];
    nextButton.focus();
    nextButton.click();
  });
}
queueGoClassesButton.addEventListener("click", () => showView("classes"));

openAllClassesCheckbox.addEventListener("change", () => {
  for (const checkbox of openClassList.querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = openAllClassesCheckbox.checked;
  }
  updateOpenClassesButton();
});

openClassesButton.addEventListener("click", async () => {
  const selectedNames = currentClassNames.filter((_name, index) => {
    const checkbox = openClassList.querySelector(`[data-class-index="${index}"]`);
    return checkbox?.checked;
  });
  if (!selectedNames.length || currentTabId === null) return;

  openingClasses = true;
  updateOpenClassesButton();
  openClassesStatus.textContent = `Abriendo ${selectedNames.length} clase(s) en Blackboard…`;
  try {
    const [outcome] = await chrome.scripting.executeScript({
      target: { tabId: currentTabId },
      world: "MAIN",
      func: expandSelectedBlackboardFolders,
      args: [selectedNames]
    });
    const result = outcome?.result;
    if (!result?.ok) throw new Error(result?.error || "No pude abrir las clases seleccionadas.");
    const parts = [];
    if (result.opened) parts.push(`${result.opened} abierta(s)`);
    if (result.alreadyOpen) parts.push(`${result.alreadyOpen} ya estaba(n) abierta(s)`);
    if (result.missing) parts.push(`${result.missing} no encontrada(s)`);
    if (result.failed) parts.push(`${result.failed} no se pudo expandir`);
    openClassesStatus.textContent = `${parts.join(", ")}. Actualizando archivos visibles…`;
    if (result.opened || result.alreadyOpen) {
      await new Promise((resolve) => window.setTimeout(resolve, 450));
      scanButton.click();
    } else {
      openClassesStatus.textContent = `${parts.join(", ")}. No pude localizar un control de carpeta; revisa los logs [DuocClassOpener] en la consola de Blackboard.`;
    }
  } catch (error) {
    openClassesStatus.textContent = error.message || "No pude abrir las clases seleccionadas.";
  } finally {
    openingClasses = false;
    updateOpenClassesButton();
  }
});

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
    if (result?.ok) statusBox.textContent = `Actualicé ${result.updated} enlace(s) y envié a Edge las solicitudes pendientes.`;
  } catch (error) {
    jobHelp.textContent = error.message || "No pude actualizar los enlaces.";
  } finally {
    refreshJobLinksButton.disabled = false;
  }
});

clearJobButton.addEventListener("click", async () => {
  if (!latestDownloadJob) return;
  const confirmed = window.confirm(
    "¿Cancelar las descargas activas y eliminar esta cola? Los archivos ya completados se conservarán. Si Edge tiene una ventana Guardar abierta, ciérrala también."
  );
  if (!confirmed) return;

  clearJobButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "clear-folder-download-job" });
    if (!result?.ok) throw new Error(result?.error || "No pude eliminar la cola.");
    renderDownloadJob(null);
    const cancelledText = result.cancelled
      ? ` Cancelé ${result.cancelled} descarga(s) activa(s).`
      : "";
    const waitingText = result.waitingForSave
      ? ` Cierra cualquier ventana Guardar pendiente de Edge.`
      : "";
    queueStatusBox.textContent = `Eliminé la cola; los archivos completados se conservaron.${cancelledText}${waitingText}`;
  } catch (error) {
    jobHelp.textContent = error.message || "No pude eliminar la cola.";
  } finally {
    clearJobButton.disabled = false;
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
  classOpener.hidden = true;
  downloadPanel.hidden = true;
  resultsBox.replaceChildren();
  if (!classWorkspace.hidden) {
    resultsBox.hidden = false;
    const loading = document.createElement("p");
    loading.className = "muted";
    loading.textContent = "Actualizando la lista de clases y archivos…";
    resultsBox.append(loading);
  }
  currentSelectionRecords = [];
  selectionSummary.textContent = "0 archivos seleccionados.";
  updateDownloadButton();
  scanButton.disabled = true;
  scanButton.textContent = classWorkspace.hidden ? "Detectando…" : "Actualizando…";
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
    scanWelcome.hidden = true;
    classWorkspace.hidden = false;
    resultsBox.hidden = false;
    resultsBox.replaceChildren();
    const message = document.createElement("p");
    message.className = "muted";
    message.textContent = error.message || "No pude leer esta página.";
    resultsBox.append(message);
    classOpener.hidden = true;
    currentSelectionRecords = [];
    selectionSummary.textContent = "0 archivos seleccionados.";
    updateDownloadButton();
    statusBox.textContent = "No se modificó el curso.";
    void refreshDownloadJob();
  } finally {
    scanButton.disabled = false;
    scanButton.textContent = classWorkspace.hidden ? "Detectar clases y archivos" : "Detectar de nuevo";
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
      await downloadSelectedAsFolders(selected, { flat: downloadFormat.value === "loose" });
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

async function downloadSelectedAsFolders(selected, { flat = false } = {}) {
  const courseFolder = sanitizePathSegment(currentCourseName);
  const selectedClasses = [...new Set(selected
    .filter((record) => record.folder !== "Archivos sin clase identificada")
    .map((record) => sanitizePathSegment(record.folder)))];
  const classLabel = summarizeClassNames(selectedClasses);
  const files = selected.map((record) => {
    const url = getDownloadUrl(record);
    const filename = flat
      ? `${courseFolder}/${sanitizePathSegment(record.name)}`
      : `${courseFolder}/${sanitizePathSegment(record.folder)}/${sanitizePathSegment(record.name)}`;
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
  showView("queue");
  const needsLinks = result.job?.items?.filter((item) => item.status === "needs-link").length || 0;
  const destinationLabel = flat
    ? `en Descargas/${courseFolder}, todos juntos`
    : `para ${selectedClasses.length} clase(s) (${classLabel})`;
  statusBox.textContent = `Envié a Edge las solicitudes de ${selected.length} archivo(s) ${destinationLabel}. La extensión ya no espera a que termine cada archivo para solicitar el siguiente; Edge aún puede mostrar sus ventanas de Guardar por separado.${needsLinks ? ` ${needsLinks} archivo(s) necesitan un enlace nuevo.` : ""}`;
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
    queueEmpty.hidden = false;
    downloadJobPanel.hidden = true;
    queueTabCount.textContent = "";
    queueTabCount.hidden = true;
    jobStatusBadge.textContent = "";
    jobProgress.value = 0;
    jobProgressLabel.textContent = "0%";
    updateDownloadButton();
    return;
  }

  queueStatusBox.textContent = "";
  queueEmpty.hidden = true;
  downloadJobPanel.hidden = false;
  const total = job.items.length;
  const completed = job.items.filter((item) => item.status === "complete").length;
  const activeItems = job.items.filter((item) => item.status === "downloading" || item.status === "starting");
  const active = activeItems.find((item) => item.status === "downloading") || activeItems[0];
  const resumable = job.items.filter((item) => item.canResume && ["paused", "interrupted"].includes(item.status));
  const needsLinks = job.items.filter((item) => item.status === "needs-link");
  const unfinished = Math.max(0, total - completed);
  queueTabCount.textContent = unfinished ? String(unfinished) : "";
  queueTabCount.hidden = unfinished === 0;
  queueTabCount.setAttribute("aria-label", unfinished ? `${unfinished} archivo(s) pendientes o en curso` : "Cola completada");
  if (!currentTabId) {
    currentCourseName = job.courseName || currentCourseName;
    courseTitle.textContent = currentCourseName;
  }

  jobSummary.textContent = `${job.courseName}: ${completed} de ${total} archivos completados.`;
  jobProgress.max = Math.max(1, total);
  jobProgress.value = completed;
  jobProgressLabel.textContent = `${Math.floor(completed / Math.max(1, total) * 100)}%`;
  const statusLabels = {
    downloading: "Activa",
    queued: "Pendiente",
    paused: "Pausada",
    interrupted: "Interrumpida",
    "needs-links": "Requiere atención",
    complete: "Completada"
  };
  const badgeStatus = statusLabels[job.status] ? job.status : "needs-links";
  jobStatusBadge.textContent = statusLabels[badgeStatus];
  jobStatusBadge.className = `job-badge job-badge-${badgeStatus}`;

  if (job.status === "complete") {
    jobHelp.textContent = "La cola terminó. Puedes iniciar otra descarga cuando quieras.";
  } else if (active) {
    const received = Number(active.bytesReceived) || 0;
    const totalBytes = Number(active.totalBytes);
    const percent = totalBytes > 0 ? ` (${Math.min(100, Math.floor(received / totalBytes * 100))}%)` : "";
    const startingCount = activeItems.filter((item) => item.status === "starting").length;
    const waitingText = startingCount ? `${startingCount} esperando inicio o confirmación de Guardar. ` : "";
    const progressText = active.status === "starting" ? "" : `Descargando ${active.name}${percent}. `;
    jobHelp.textContent = `${activeItems.length} solicitud(es) en Edge. ${waitingText}${progressText}Puedes cerrar este panel; la cola sigue en Edge.`;
  } else if (resumable.length) {
    jobHelp.textContent = `${resumable.length} archivo(s) se pueden reanudar desde donde se interrumpieron.`;
  } else if (needsLinks.length && matchingRefreshLinks.length) {
    jobHelp.textContent = `Detecté enlaces para ${matchingRefreshLinks.length} de ${needsLinks.length} archivo(s) pendientes. Pulsa el botón para reanudar la cola.`;
  } else if (needsLinks.length) {
    jobHelp.textContent = `Faltan enlaces para ${needsLinks.length} archivo(s). Abre Blackboard, detecta el contenido y usa Abrir clases para expandir las carpetas pendientes.`;
  } else {
    jobHelp.textContent = "La cola está esperando que Edge actualice el estado de la descarga.";
  }

  resumeJobButton.hidden = !resumable.length;
  resumeJobButton.textContent = resumable.length > 1
    ? `Reanudar archivos interrumpidos (${resumable.length})`
    : "Reanudar archivo interrumpido";
  refreshJobLinksButton.hidden = !matchingRefreshLinks.length;
  refreshJobLinksButton.textContent = `Actualizar enlaces pendientes (${matchingRefreshLinks.length})`;

  const previousScrollTop = jobItemsBox.scrollTop;
  jobItemsBox.replaceChildren();
  const groups = new Map();
  for (const item of job.items) {
    const folder = item.folder || "Archivos sin clase identificada";
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(item);
  }

  for (const [folder, items] of groups) {
    const groupItem = document.createElement("li");
    groupItem.className = "job-class-group";
    const heading = document.createElement("div");
    heading.className = "job-class-heading";
    const folderName = document.createElement("span");
    folderName.textContent = folder;
    const groupCompleted = items.filter((item) => item.status === "complete").length;
    const groupSummary = document.createElement("span");
    groupSummary.className = "job-class-summary";
    groupSummary.textContent = `${groupCompleted} / ${items.length}`;
    heading.append(folderName, groupSummary);

    const fileList = document.createElement("ul");
    fileList.className = "job-class-files";
    for (const item of items) {
      const listItem = document.createElement("li");
      const row = document.createElement("div");
      row.className = "job-item-row";
      const name = document.createElement("span");
      name.className = "job-item-name";
      name.textContent = item.name;
      const state = document.createElement("span");
      state.className = `job-item-status job-item-status-${item.status || "pending"}`;
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
      fileList.append(listItem);
    }
    groupItem.append(heading, fileList);
    jobItemsBox.append(groupItem);
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
      maxBytes: 100 * 1024 * 1024
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
              throw new Error("La selección supera el límite de 100 MB para ZIP. Usa el formato de carpetas o selecciona menos archivos.");
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
          throw new Error("La selección supera el límite de 100 MB para ZIP. Usa el formato de carpetas o selecciona menos archivos.");
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

function updateOpenClassesButton() {
  const checkboxes = [...openClassList.querySelectorAll('input[type="checkbox"]')];
  const selectedCount = checkboxes.filter((checkbox) => checkbox.checked).length;
  openAllClassesCheckbox.checked = checkboxes.length > 0 && selectedCount === checkboxes.length;
  openAllClassesCheckbox.indeterminate = selectedCount > 0 && selectedCount < checkboxes.length;
  openClassesButton.disabled = openingClasses || currentTabId === null || selectedCount === 0;
  openClassesButton.textContent = selectedCount === 1
    ? "Abrir 1 clase"
    : selectedCount > 1 ? `Abrir ${selectedCount} clases` : "Abrir clases seleccionadas";
}

function renderClassOpener(classes) {
  currentClassNames = classes.map((classEntry) => classEntry.name);
  classesTabCount.textContent = currentClassNames.length ? String(currentClassNames.length) : "";
  classesTabCount.hidden = currentClassNames.length === 0;
  openClassCount.textContent = currentClassNames.length ? `${currentClassNames.length} clases` : "";
  openClassCount.hidden = currentClassNames.length === 0;
  openClassList.replaceChildren();
  openClassesStatus.textContent = "";
  classOpener.hidden = currentClassNames.length === 0;
  openAllClassesCheckbox.checked = false;
  openAllClassesCheckbox.indeterminate = false;
  openAllClassesCheckbox.disabled = currentClassNames.length === 0;

  currentClassNames.forEach((name, index) => {
    const item = document.createElement("li");
    const label = document.createElement("label");
    label.className = "open-class-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.classIndex = String(index);
    checkbox.addEventListener("change", updateOpenClassesButton);
    const text = document.createElement("span");
    text.textContent = name;
    label.append(checkbox, text);
    item.append(label);
    openClassList.append(item);
  });
  updateOpenClassesButton();
}

async function expandSelectedBlackboardFolders(requestedNames) {
  const logPrefix = "[DuocClassOpener]";
  const analyticsId = "course.learningModule.tableOfContents.folder.list.folder.item.list-item";
  const parentAnalyticsId = "course.learningModule.tableOfContents.folder.list.folder.item.list-item-parent";
  const currentFolderAnalyticsId = "content.item.folder.toggleFolder.button";
  const drawer = document.querySelector(".js-content-navigation-drawer");
  const scope = document;
  const normalize = (value) => String(value || "").normalize("NFC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const classNumber = (value) => String(value || "").match(/\bCLASE\s+(?:N\s*[°ºo.]?\s*)?(\d{1,3})\b/i)?.[1] || "";
  const currentControlSelector = `button[data-analytics-id="${currentFolderAnalyticsId}"]`;
  const legacyControlSelector = `[data-analytics-id="${parentAnalyticsId}"]`;
  const rowSelector = `li[data-analytics-id="${analyticsId}"]`;
  console.info(logPrefix, "inicio", {
    requestedCount: requestedNames.length,
    drawerFound: Boolean(drawer),
    legacyFolderRows: drawer?.querySelectorAll(rowSelector).length || 0,
    legacyFolderControls: drawer?.querySelectorAll(legacyControlSelector).length || 0,
    contentFolderControls: scope.querySelectorAll(currentControlSelector).length
  });
  let opened = 0;
  let alreadyOpen = 0;
  let missing = 0;
  let failed = 0;

  function findFolderControl(requestedName) {
    const target = normalize(requestedName);
    const requestedNumber = classNumber(requestedName);
    const controls = [
      ...scope.querySelectorAll(currentControlSelector),
      ...(drawer?.querySelectorAll(legacyControlSelector) || [])
    ];
    return controls.find((control) => {
      const row = control.matches(currentControlSelector)
        ? control.closest(".content-list-item")
        : control.closest(rowSelector) || control.closest("li");
      const labels = [control.innerText || control.textContent || "", row?.innerText || row?.textContent || ""];
      for (const element of (row || control).querySelectorAll("[title], [aria-label]")) {
        labels.push(element.getAttribute("title") || "", element.getAttribute("aria-label") || "");
      }
      return labels.some((label) => normalize(label).includes(target)
        || Boolean(requestedNumber && classNumber(label) === requestedNumber));
    }) || null;
  }

  function folderCollapse(control) {
    if (control?.matches(currentControlSelector)) return null;
    const row = control?.closest(rowSelector) || control?.closest("li");
    const sibling = row?.nextElementSibling;
    return sibling?.classList.contains("MuiCollapse-root") ? sibling : null;
  }

  function isCollapsed(collapse) {
    if (!collapse) return false;
    if (collapse.classList.contains("MuiCollapse-hidden")) return true;
    const style = window.getComputedStyle(collapse);
    return style.display === "none" || (collapse.offsetHeight === 0 && style.height === "0px");
  }

  function expandedState(control) {
    const value = control?.getAttribute("aria-expanded");
    if (value === "true") return true;
    if (value === "false") return false;
    const collapse = folderCollapse(control);
    return collapse ? !isCollapsed(collapse) : null;
  }

  function describeState(control) {
    const collapse = folderCollapse(control);
    const row = control?.matches(currentControlSelector)
      ? control.closest(".content-list-item")
      : control?.closest(rowSelector) || control?.closest("li");
    const observedArea = collapse || row;
    const observedText = observedArea?.innerText || observedArea?.textContent || "";
    const style = collapse ? window.getComputedStyle(collapse) : null;
    return {
      controlFound: Boolean(control),
      controlAnalytics: control?.getAttribute("data-analytics-id") || "",
      rowFound: Boolean(row),
      collapseFound: Boolean(collapse),
      ariaExpanded: control?.getAttribute("aria-expanded"),
      expanded: expandedState(control),
      collapseClasses: collapse?.className || "",
      height: style?.height || "",
      childCount: observedArea?.children.length || 0,
      loadingIndicator: Boolean(observedArea?.querySelector('[data-testid*="skeleton" i], [aria-label*="cargando" i]'))
        || /\bcargando\b|\bloading\b/i.test(observedText),
      textLength: observedText.length
    };
  }

  for (let index = 0; index < requestedNames.length; index += 1) {
    const requestedName = requestedNames[index];
    const classId = classNumber(requestedName) || `selección-${index + 1}`;
    const control = findFolderControl(requestedName);
    if (!control) {
      missing += 1;
      console.warn(logPrefix, "control-no-encontrado", { classId });
      continue;
    }

    console.info(logPrefix, "antes-del-clic", { classId, state: describeState(control) });
    if (expandedState(control) === true) {
      alreadyOpen += 1;
      console.info(logPrefix, "ya-estaba-abierta", { classId });
      continue;
    }

    control.click();
    console.info(logPrefix, "clic-enviado", {
      classId,
      controlAnalytics: control.getAttribute("data-analytics-id") || ""
    });
    const deadline = Date.now() + 1800;
    let updatedControl = null;
    while (Date.now() < deadline) {
      updatedControl = findFolderControl(requestedName);
      if (expandedState(updatedControl) === true) break;
      await new Promise((resolve) => window.setTimeout(resolve, 60));
    }
    const state = describeState(updatedControl);
    if (updatedControl && expandedState(updatedControl) === true) {
      opened += 1;
      console.info(logPrefix, "despues-del-clic", { classId, state });
    } else {
      failed += 1;
      console.warn(logPrefix, "sin-expansion-detectada", { classId, state });
    }
  }

  if (opened || alreadyOpen) await new Promise((resolve) => window.setTimeout(resolve, 350));
  const result = { ok: true, opened, alreadyOpen, missing, failed };
  console.info(logPrefix, "fin", result);
  return result;
}

function renderResult(result) {
  scanWelcome.hidden = true;
  classWorkspace.hidden = false;
  resultsBox.hidden = false;
  downloadPanel.hidden = true;
  resultsBox.replaceChildren();
  currentCourseName = result.courseName || result.pageTitle || "Curso";
  courseTitle.textContent = currentCourseName;
  scanButton.textContent = "Detectar de nuevo";
  renderClassOpener(result.classes || []);
  const heading = document.createElement("h2");
  heading.textContent = "Clases y archivos";
  resultsBox.append(heading);
  const pageTitle = document.createElement("p");
  pageTitle.className = "muted";
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

  downloadPanel.hidden = false;
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
