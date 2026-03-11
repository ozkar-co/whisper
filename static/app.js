const MAX_UPLOAD_MB = 25;

const fileInput = document.getElementById("audio-file-input");
const uploadFileName = document.getElementById("upload-file-name");
const recordBtn = document.getElementById("record-btn");
const recordIcon = document.getElementById("record-icon");
const loading = document.getElementById("loading");
const recordStatus = document.getElementById("record-status");
const resultEmpty = document.getElementById("result-empty");
const resultText = document.getElementById("result-text");
const resultMeta = document.getElementById("result-meta");
const resultError = document.getElementById("result-error");
const copyBtn = document.getElementById("copy-btn");

let mediaRecorder = null;
let recordingChunks = [];
let mediaStream = null;
let isRecording = false;
let isTranscribing = false;

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
  if (metadata?.backend) {
    bits.push(`backend: ${metadata.backend}`);
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
  if (typeof metadata?.characters === "number") {
    bits.push(`caracteres: ${metadata.characters}`);
  }
  if (typeof metadata?.lines === "number") {
    bits.push(`lineas: ${metadata.lines}`);
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

async function transcribeBlob(blob, fileNameHint = "recording.webm") {
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
  recordBtn.disabled = true;
  fileInput.disabled = true;
  loading.classList.remove("hidden");
  recordStatus.textContent = "Transcribiendo...";

  const formData = new FormData();
  const fileName = blob.name || fileNameHint || `recording.${mimeToExtension(blob.type)}`;
  formData.append("audio", blob, fileName);

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();
    if (!response.ok || !payload.success) {
      showError(payload.message || "No se pudo transcribir el audio.");
      return;
    }

    showResult(payload.text, {
      backend: payload.backend,
      language: payload.language,
      fileSizeHuman: payload.report?.file_size_human,
      transcriptionSeconds: payload.report?.transcription_seconds,
      words: payload.report?.text_stats?.words,
      characters: payload.report?.text_stats?.characters,
      lines: payload.report?.text_stats?.lines,
    });
    recordStatus.textContent = "Transcripcion completada";
  } catch (error) {
    showError("Error de red al contactar el servidor.");
  } finally {
    isTranscribing = false;
    recordBtn.disabled = false;
    fileInput.disabled = false;
    loading.classList.add("hidden");
    if (!isRecording && !resultError.textContent) {
      recordStatus.textContent = "Listo para grabar";
    }
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
  if (isTranscribing) {
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

  mediaRecorder.onstop = () => {
    const type = mediaRecorder.mimeType || "audio/webm";
    const recordedBlob = new Blob(recordingChunks, { type });
    const ext = mimeToExtension(type);
    const fileName = `recording.${ext}`;
    recordStatus.textContent = `Grabado ${Math.max(1, Math.round(recordedBlob.size / 1024))} KB`;
    stopTracks();
    transcribeBlob(recordedBlob, fileName);
  };

  mediaRecorder.start();
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
  isRecording = false;
  recordBtn.classList.remove("recording");
  recordIcon.textContent = "●";
  recordBtn.setAttribute("aria-label", "Iniciar grabacion");
  recordStatus.textContent = "Procesando audio...";
}

recordBtn.addEventListener("click", async () => {
  if (isTranscribing) {
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
  await transcribeBlob(selectedFile, selectedFile.name);
  fileInput.value = "";
});

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

clearResult();
recordStatus.textContent = "Listo para grabar";
