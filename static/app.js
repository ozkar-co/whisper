const MAX_UPLOAD_MB = 25;
const POLL_INTERVAL_MS = 1500;

const fileInput = document.getElementById("audio-file-input");
const uploadFileName = document.getElementById("upload-file-name");
const recordBtn = document.getElementById("record-btn");
const uploadCorner = document.getElementById("upload-corner");
const recorderText = document.getElementById("recorder-text");
const recordIcon = document.getElementById("record-icon");
const loading = document.getElementById("loading");
const recordStatus = document.getElementById("record-status");
const workflowPanel = document.getElementById("workflow-panel");
const confirmView = document.getElementById("confirm-view");
const progressView = document.getElementById("progress-view");
const progressFill = document.getElementById("progress-fill");
const progressTimer = document.getElementById("progress-timer");
const progressMessage = document.getElementById("progress-message");
const jobLink = document.getElementById("job-link");
const resultEmpty = document.getElementById("result-empty");
const resultText = document.getElementById("result-text");
const resultMeta = document.getElementById("result-meta");
const resultError = document.getElementById("result-error");
const copyBtn = document.getElementById("copy-btn");
const historyEmpty = document.getElementById("history-empty");
const historyTable = document.getElementById("history-table");
const confirmFilename = document.getElementById("confirm-filename");
const modelSelect = document.getElementById("model-select");
const confirmAudioDuration = document.getElementById("confirm-audio-duration");
const confirmEstimated = document.getElementById("confirm-estimated");
const confirmQueueCount = document.getElementById("confirm-queue-count");
const confirmWaitStart = document.getElementById("confirm-wait-start");
const confirmError = document.getElementById("confirm-error");
const confirmCancelBtn = document.getElementById("confirm-cancel-btn");
const confirmSubmitBtn = document.getElementById("confirm-submit-btn");

const DEFAULT_MODEL = "small";

let mediaRecorder = null;
let recordingChunks = [];
let mediaStream = null;
let isRecording = false;
let isConfirming = false;
let isTranscribing = false;
let pollTimer = null;
let activeJobId = null;
let pendingBlob = null;
let pendingFileName = "";
let pendingDurationSec = null;
let estimateRequestId = 0;
let confirmGeneration = 0;
let recordingStartedAt = null;

function clearResult() {
  resultError.classList.add("hidden");
  resultError.textContent = "";
  resultText.classList.add("hidden");
  resultText.textContent = "";
  resultMeta.classList.add("hidden");
  resultMeta.textContent = "";
  resultEmpty.classList.remove("hidden");
  copyBtn.textContent = "Copiar";
  copyBtn.disabled = true;
}

function showError(message) {
  resultEmpty.classList.add("hidden");
  resultText.classList.add("hidden");
  resultMeta.classList.add("hidden");
  resultError.classList.remove("hidden");
  resultError.textContent = message;
  copyBtn.textContent = "Copiar";
  copyBtn.disabled = true;
}

function showResult(text, metadata) {
  resultEmpty.classList.add("hidden");
  resultError.classList.add("hidden");
  resultText.classList.remove("hidden");
  resultText.textContent = text;
  copyBtn.disabled = !text;

  const bits = [];
  if (metadata?.model) {
    bits.push(`modelo: ${metadata.model}`);
  }
  if (metadata?.language) {
    bits.push(`language: ${metadata.language}`);
  }
  if (metadata?.fileSizeHuman) {
    bits.push(`archivo: ${metadata.fileSizeHuman}`);
  }
  if (typeof metadata?.transcriptionSeconds === "number") {
    bits.push(`tiempo: ${metadata.transcriptionSeconds.toFixed(2)} s`);
  }
  if (typeof metadata?.words === "number") {
    bits.push(`palabras: ${metadata.words}`);
  }

  if (bits.length > 0) {
    resultMeta.classList.remove("hidden");
    resultMeta.textContent = bits.join(" | ");
  } else {
    resultMeta.classList.add("hidden");
  }
}

function validateSize(blob) {
  const maxBytes = MAX_UPLOAD_MB * 1024 * 1024;
  if (blob.size > maxBytes) {
    showError(`File too large. Max ${MAX_UPLOAD_MB} MB.`);
    return false;
  }
  return true;
}

function toNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function formatDurationLabel(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  if (safe < 60) {
    return `${safe} s`;
  }
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  if (seconds === 0) {
    return `${minutes} min`;
  }
  return `${minutes} min ${seconds} s`;
}

function getAudioDurationSec(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio();

    const finish = (duration) => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(duration) && duration > 0 ? duration : null);
    };

    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      if (!Number.isFinite(audio.duration) || audio.duration === Infinity) {
        audio.currentTime = 1e10;
        audio.ontimeupdate = () => {
          audio.ontimeupdate = null;
          const duration = audio.duration;
          audio.currentTime = 0;
          finish(duration);
        };
        return;
      }
      finish(audio.duration);
    };
    audio.onerror = () => finish(null);
    audio.src = url;
  });
}

async function fetchEstimate(model) {
  if (!pendingBlob) {
    return null;
  }
  const response = await fetch("/api/estimate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      audio_duration_sec: pendingDurationSec,
      file_size_bytes: pendingBlob.size,
    }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.success) {
    throw new Error(payload.message || "No se pudo estimar el tiempo.");
  }
  return payload;
}

function updateIdleControls() {
  const busy = isConfirming || isTranscribing;
  recordBtn.classList.toggle("hidden", busy);
  uploadCorner.classList.toggle("hidden", busy);
  recorderText.classList.toggle("hidden", busy);
  recordBtn.disabled = isTranscribing || isConfirming;
  fileInput.disabled = isTranscribing || isConfirming;
}

function showConfirmView() {
  workflowPanel.classList.remove("hidden");
  confirmView.classList.remove("hidden");
  progressView.classList.add("hidden");
  loading.classList.add("hidden");
  updateIdleControls();
}

function showProgressView() {
  workflowPanel.classList.remove("hidden");
  confirmView.classList.add("hidden");
  progressView.classList.remove("hidden");
  loading.classList.add("hidden");
  updateIdleControls();
}

function hideWorkflowPanel() {
  workflowPanel.classList.add("hidden");
  confirmView.classList.add("hidden");
  progressView.classList.add("hidden");
  updateIdleControls();
}

function setConfirmLoading(loadingState) {
  modelSelect.disabled = loadingState;
  confirmSubmitBtn.disabled = loadingState;
}

async function refreshConfirmEstimate() {
  if (!pendingBlob || !isConfirming) {
    return;
  }
  const requestId = ++estimateRequestId;
  setConfirmLoading(true);
  confirmError.classList.add("hidden");
  confirmError.textContent = "";
  confirmEstimated.textContent = "Calculando...";
  confirmQueueCount.textContent = "…";
  confirmWaitStart.textContent = "…";

  try {
    const payload = await fetchEstimate(modelSelect.value);
    if (requestId !== estimateRequestId || !isConfirming || !pendingBlob) {
      return;
    }
    confirmEstimated.textContent = `~${formatDurationLabel(payload.estimated_seconds)}`;
    confirmQueueCount.textContent = String(payload.queue_count ?? 0);
    confirmWaitStart.textContent = `~${formatDurationLabel(payload.wait_until_start_seconds)}`;
  } catch (error) {
    if (requestId !== estimateRequestId || !isConfirming) {
      return;
    }
    confirmEstimated.textContent = "—";
    confirmQueueCount.textContent = "—";
    confirmWaitStart.textContent = "—";
    confirmError.textContent = error.message || "No se pudo estimar el tiempo.";
    confirmError.classList.remove("hidden");
  } finally {
    if (requestId === estimateRequestId) {
      setConfirmLoading(false);
    }
  }
}

function closeConfirmPanel() {
  confirmGeneration += 1;
  estimateRequestId += 1;
  isConfirming = false;
  pendingBlob = null;
  pendingFileName = "";
  pendingDurationSec = null;
  confirmError.classList.add("hidden");
  confirmError.textContent = "";
  setConfirmLoading(false);
  hideWorkflowPanel();
  recordStatus.textContent = "Listo para grabar";
  uploadFileName.textContent = "o sube un archivo para transcribir al instante";
}

async function openConfirmPanel(blob, fileNameHint = "recording.webm", durationHint = null) {
  if (isTranscribing || isConfirming) {
    return;
  }
  if (!validateSize(blob)) {
    return;
  }

  const generation = ++confirmGeneration;
  recordStatus.textContent = "Preparando audio...";

  pendingBlob = blob;
  pendingFileName = blob.name || fileNameHint || `recording.${mimeToExtension(blob.type)}`;
  pendingDurationSec = durationHint ?? (await getAudioDurationSec(blob));

  if (generation !== confirmGeneration || !pendingBlob) {
    return;
  }

  isConfirming = true;
  modelSelect.value = DEFAULT_MODEL;
  confirmFilename.textContent = stripExtension(pendingFileName);
  confirmAudioDuration.textContent = pendingDurationSec
    ? formatDurationLabel(pendingDurationSec)
    : "Desconocida";

  showConfirmView();
  recordStatus.textContent = "Revisa y encola";
  await refreshConfirmEstimate();
}

async function submitConfirmPanel() {
  if (!pendingBlob || !isConfirming || confirmSubmitBtn.disabled) {
    return;
  }
  const blob = pendingBlob;
  const fileName = pendingFileName;
  const model = modelSelect.value;
  isConfirming = false;
  pendingBlob = null;
  pendingFileName = "";
  pendingDurationSec = null;
  hideWorkflowPanel();
  await transcribeBlob(blob, fileName, model);
}

function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.floor(totalSeconds || 0));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function formatHistoryWhen(isoValue) {
  if (!isoValue) {
    return "";
  }
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  if (isSameDay(date, new Date())) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString();
}

function stripExtension(filename) {
  if (!filename) {
    return "audio";
  }
  const lastDot = filename.lastIndexOf(".");
  if (lastDot <= 0) {
    return filename;
  }
  return filename.slice(0, lastDot);
}

async function refreshHistory() {
  try {
    const response = await fetch("/api/jobs");
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      return;
    }
    renderHistory(payload.jobs || []);
  } catch (error) {
    // Ignore list refresh errors; main flow still works.
  }
}

function renderHistory(jobs) {
  historyTable.innerHTML = "";

  if (!jobs.length) {
    historyEmpty.classList.remove("hidden");
    historyTable.classList.add("hidden");
    return;
  }

  historyEmpty.classList.add("hidden");
  historyTable.classList.remove("hidden");

  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = "history-row";

    const whenCell = document.createElement("span");
    whenCell.className = "history-when";
    whenCell.textContent = formatHistoryWhen(job.created_at);

    const mainCell = document.createElement("div");
    mainCell.className = "history-main";

    const link = document.createElement("a");
    link.className = "history-link";
    link.href = `/?job=${encodeURIComponent(job.job_id)}`;
    link.textContent = stripExtension(job.filename);

    const modelBadge = document.createElement("span");
    modelBadge.className = "history-model";
    modelBadge.textContent = job.model || "—";

    mainCell.appendChild(link);
    mainCell.appendChild(modelBadge);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "delete-btn";
    deleteBtn.textContent = "Eliminar";
    deleteBtn.addEventListener("click", () => {
      deleteJob(job.job_id);
    });

    row.appendChild(whenCell);
    row.appendChild(mainCell);
    row.appendChild(deleteBtn);
    historyTable.appendChild(row);
  }
}

async function deleteJob(jobId) {
  try {
    const response = await fetch(`/api/jobs/${jobId}`, { method: "DELETE" });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      showError(payload.message || "No se pudo eliminar la transcripcion.");
      return;
    }

    if (jobId === activeJobId) {
      stopPolling();
      setTranscribingState(false);
      activeJobId = null;
      clearJobUrl();
      clearResult();
      recordStatus.textContent = "Listo para grabar";
    }

    await refreshHistory();
  } catch (error) {
    showError("Error de red al eliminar la transcripcion.");
  }
}

function setJobUrl(jobId) {
  const url = new URL(window.location.href);
  url.searchParams.set("job", jobId);
  window.history.replaceState({}, "", url);
}

function clearJobUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("job");
  window.history.replaceState({}, "", url.pathname + url.search);
}

function showProgressPanel(jobId, estimatedSeconds) {
  showProgressView();
  progressFill.style.width = "0%";
  progressTimer.textContent = `00:00 / ~${formatClock(estimatedSeconds)}`;
  progressMessage.textContent = "Transcribiendo...";
  const jobUrl = `${window.location.origin}${window.location.pathname}?job=${jobId}`;
  jobLink.href = jobUrl;
  jobLink.textContent = jobUrl;
}

function stopPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function setTranscribingState(active) {
  isTranscribing = active;
  if (!active) {
    hideWorkflowPanel();
    loading.classList.add("hidden");
  }
  updateIdleControls();
}

function updateProgressUI(payload) {
  const elapsed = toNumber(payload.elapsed_seconds) || 0;
  const estimated = toNumber(payload.estimated_seconds) || 0;
  const percent = toNumber(payload.progress_percent) || 0;
  const isQueued = payload.status === "queued";

  progressFill.style.width = isQueued ? "0%" : `${Math.min(100, Math.max(0, percent))}%`;
  progressTimer.textContent = isQueued
    ? `En cola · ~${formatClock(estimated)}`
    : `${formatClock(elapsed)} / ~${formatClock(estimated)}`;
  progressMessage.textContent = payload.message || (isQueued ? "En cola..." : "Transcribiendo...");
  recordStatus.textContent = payload.message || (isQueued ? "En cola..." : "Transcribiendo...");
}

async function pollJob(jobId) {
  try {
    const response = await fetch(`/api/jobs/${jobId}`);
    const payload = await response.json();

    if (!response.ok || !payload.job_id) {
      showError(payload.message || "No se encontro el proceso de transcripcion.");
      stopPolling();
      setTranscribingState(false);
      activeJobId = null;
      clearJobUrl();
      await refreshHistory();
      return;
    }

    updateProgressUI(payload);

    if (payload.status === "completed") {
      stopPolling();
      setTranscribingState(false);
      activeJobId = null;
      clearJobUrl();
      await refreshHistory();

      const report = payload.report || {};
      const textStats = report.text_stats || {};
      showResult(payload.text || "", {
        model: payload.model,
        language: payload.language,
        fileSizeHuman: report.file_size_human,
        transcriptionSeconds: toNumber(report.transcription_seconds),
        words: toNumber(textStats.words),
      });
      recordStatus.textContent = "Transcripcion completada";
      return;
    }

    if (payload.status === "failed" || payload.status === "timeout") {
      stopPolling();
      setTranscribingState(false);
      activeJobId = null;
      clearJobUrl();
      showError(payload.message || "No se pudo transcribir el audio.");
      recordStatus.textContent = "Listo para grabar";
    }
  } catch (error) {
    stopPolling();
    setTranscribingState(false);
    activeJobId = null;
    showError("Error de red al consultar el estado del proceso.");
    recordStatus.textContent = "Listo para grabar";
  }
}

function startJobTracking(jobId, estimatedSeconds) {
  stopPolling();
  activeJobId = jobId;
  isTranscribing = true;
  showProgressPanel(jobId, estimatedSeconds);
  setJobUrl(jobId);
  recordStatus.textContent = "Transcribiendo...";
  updateIdleControls();

  pollJob(jobId);
  pollTimer = setInterval(() => {
    pollJob(jobId);
  }, POLL_INTERVAL_MS);
  refreshHistory();
}

async function transcribeBlob(blob, fileNameHint = "recording.webm", model = DEFAULT_MODEL) {
  if (!blob) {
    showError("No hay audio para transcribir.");
    return;
  }
  if (!validateSize(blob)) {
    return;
  }
  if (isTranscribing) {
    return;
  }

  clearResult();
  isTranscribing = true;
  showProgressView();
  recordStatus.textContent = "Subiendo audio...";
  updateIdleControls();

  const formData = new FormData();
  const fileName = blob.name || fileNameHint || `recording.${mimeToExtension(blob.type)}`;
  formData.append("audio", blob, fileName);
  formData.append("model", model);

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok || !payload.success || !payload.job_id) {
      setTranscribingState(false);
      showError(payload.message || "No se pudo iniciar la transcripcion.");
      recordStatus.textContent = "Listo para grabar";
      return;
    }

    startJobTracking(payload.job_id, toNumber(payload.estimated_seconds) || 0);
  } catch (error) {
    setTranscribingState(false);
    showError("Error de red al contactar el servidor.");
    recordStatus.textContent = "Listo para grabar";
  }
}

function mimeToExtension(mime) {
  const map = {
    "audio/webm": "webm",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/mpeg": "mp3",
    "audio/flac": "flac",
  };
  return map[mime] || "webm";
}

function pickSupportedRecordingMime() {
  const options = ["audio/webm", "audio/ogg", "audio/mp4"];
  for (const candidate of options) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return "";
}

async function startRecording() {
  if (isTranscribing || isConfirming) {
    return;
  }
  clearResult();

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showError("Este navegador no soporta grabacion de audio.");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    showError("Permiso de microfono denegado o no disponible.");
    return;
  }

  const mimeType = pickSupportedRecordingMime();
  recordingChunks = [];

  mediaRecorder = mimeType
    ? new MediaRecorder(mediaStream, { mimeType })
    : new MediaRecorder(mediaStream);

  mediaRecorder.ondataavailable = (event) => {
    if (event.data?.size > 0) {
      recordingChunks.push(event.data);
    }
  };

  mediaRecorder.onstop = async () => {
    const type = mediaRecorder.mimeType || "audio/webm";
    const recordedBlob = new Blob(recordingChunks, { type });
    const ext = mimeToExtension(type);
    const fileName = `recording.${ext}`;
    const recordedDurationSec = recordingStartedAt
      ? Math.max(0.1, (Date.now() - recordingStartedAt) / 1000)
      : null;
    recordingStartedAt = null;
    stopTracks();
    isRecording = false;
    recordBtn.classList.remove("recording");
    recordIcon.textContent = "●";
    recordBtn.setAttribute("aria-label", "Iniciar grabacion");
    await openConfirmPanel(recordedBlob, fileName, recordedDurationSec);
  };

  mediaRecorder.start();
  recordingStartedAt = Date.now();
  isRecording = true;
  recordBtn.classList.add("recording");
  recordIcon.textContent = "■";
  recordBtn.setAttribute("aria-label", "Detener grabacion");
  recordStatus.textContent = "Grabando... toca para detener";
}

function stopTracks() {
  if (!mediaStream) {
    return;
  }
  for (const track of mediaStream.getTracks()) {
    track.stop();
  }
  mediaStream = null;
}

function stopRecording() {
  if (!mediaRecorder) {
    return;
  }
  if (mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

recordBtn.addEventListener("click", async () => {
  if (isTranscribing || isConfirming) {
    return;
  }
  if (isRecording) {
    stopRecording();
    return;
  }
  await startRecording();
});

fileInput.addEventListener("change", async () => {
  const selectedFile = fileInput.files?.[0] || null;
  if (!selectedFile) {
    uploadFileName.textContent = "o sube un archivo para transcribir al instante";
    return;
  }
  uploadFileName.textContent = `Archivo: ${selectedFile.name}`;
  await openConfirmPanel(selectedFile, selectedFile.name);
  fileInput.value = "";
});

modelSelect.addEventListener("change", () => {
  refreshConfirmEstimate();
});

confirmCancelBtn.addEventListener("click", closeConfirmPanel);
confirmSubmitBtn.addEventListener("click", submitConfirmPanel);

copyBtn.addEventListener("click", async () => {
  const text = resultText.textContent || "";
  if (!text) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.textContent = "Copiado";
    setTimeout(() => {
      copyBtn.textContent = "Copiar";
    }, 1200);
  } catch (error) {
    showError("No se pudo copiar al portapapeles.");
  }
});

function resumeJobFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const jobId = params.get("job");
  if (!jobId || isTranscribing || isConfirming) {
    return;
  }
  clearResult();
  startJobTracking(jobId, 0);
}

clearResult();
recordStatus.textContent = "Listo para grabar";
updateIdleControls();
refreshHistory();
resumeJobFromUrl();
