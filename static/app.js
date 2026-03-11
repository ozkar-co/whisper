const MAX_UPLOAD_MB = 25;

const modeUploadBtn = document.getElementById("mode-upload");
const modeRecordBtn = document.getElementById("mode-record");
const uploadSection = document.getElementById("upload-section");
const recordSection = document.getElementById("record-section");
const fileInput = document.getElementById("audio-file-input");
const uploadFileName = document.getElementById("upload-file-name");
const transcribeBtn = document.getElementById("transcribe-btn");
const loading = document.getElementById("loading");
const startRecordBtn = document.getElementById("start-record");
const stopRecordBtn = document.getElementById("stop-record");
const recordStatus = document.getElementById("record-status");
const resultEmpty = document.getElementById("result-empty");
const resultText = document.getElementById("result-text");
const resultMeta = document.getElementById("result-meta");
const resultError = document.getElementById("result-error");

let mode = "upload";
let selectedFile = null;
let recordedBlob = null;
let mediaRecorder = null;
let recordingChunks = [];
let mediaStream = null;

function setMode(next) {
  mode = next;
  const uploadActive = next === "upload";

  modeUploadBtn.classList.toggle("active", uploadActive);
  modeRecordBtn.classList.toggle("active", !uploadActive);
  uploadSection.classList.toggle("active", uploadActive);
  recordSection.classList.toggle("active", !uploadActive);

  updateTranscribeEnabled();
}

function clearResult() {
  resultError.classList.add("hidden");
  resultError.textContent = "";
  resultText.classList.add("hidden");
  resultText.textContent = "";
  resultMeta.classList.add("hidden");
  resultMeta.textContent = "";
  resultEmpty.classList.remove("hidden");
}

function showError(message) {
  resultEmpty.classList.add("hidden");
  resultText.classList.add("hidden");
  resultMeta.classList.add("hidden");
  resultError.classList.remove("hidden");
  resultError.textContent = message;
}

function showResult(text, metadata) {
  resultEmpty.classList.add("hidden");
  resultError.classList.add("hidden");
  resultText.classList.remove("hidden");
  resultText.textContent = text;

  const bits = [];
  if (metadata?.backend) {
    bits.push(`backend: ${metadata.backend}`);
  }
  if (metadata?.language) {
    bits.push(`language: ${metadata.language}`);
  }

  if (bits.length > 0) {
    resultMeta.classList.remove("hidden");
    resultMeta.textContent = bits.join(" | ");
  } else {
    resultMeta.classList.add("hidden");
  }
}

function updateTranscribeEnabled() {
  if (mode === "upload") {
    transcribeBtn.disabled = !selectedFile;
  } else {
    transcribeBtn.disabled = !recordedBlob;
  }
}

function activeBlob() {
  if (mode === "upload" && selectedFile) {
    return selectedFile;
  }
  if (mode === "record" && recordedBlob) {
    return recordedBlob;
  }
  return null;
}

function validateSize(blob) {
  const maxBytes = MAX_UPLOAD_MB * 1024 * 1024;
  if (blob.size > maxBytes) {
    showError(`File too large. Max ${MAX_UPLOAD_MB} MB.`);
    return false;
  }
  return true;
}

async function sendForTranscription() {
  clearResult();
  const blob = activeBlob();
  if (!blob) {
    showError("Select or record audio first.");
    return;
  }
  if (!validateSize(blob)) {
    return;
  }

  transcribeBtn.disabled = true;
  loading.classList.remove("hidden");

  const formData = new FormData();
  const fileName = blob.name || `recording.${mimeToExtension(blob.type)}`;
  formData.append("audio", blob, fileName);

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      body: formData,
    });

    const payload = await response.json();

    if (!response.ok || !payload.success) {
      showError(payload.message || "Transcription failed.");
      return;
    }

    showResult(payload.text, {
      backend: payload.backend,
      language: payload.language,
    });
  } catch (error) {
    showError("Network error while contacting server.");
  } finally {
    loading.classList.add("hidden");
    updateTranscribeEnabled();
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
  clearResult();
  recordedBlob = null;
  updateTranscribeEnabled();

  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showError("This browser does not support audio recording.");
    return;
  }

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    showError("Microphone permission denied or unavailable.");
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
    recordedBlob = new Blob(recordingChunks, { type });
    recordStatus.textContent = `Recorded ${Math.max(1, Math.round(recordedBlob.size / 1024))} KB`;
    stopTracks();
    updateTranscribeEnabled();
  };

  mediaRecorder.start();
  recordStatus.textContent = "Recording...";
  startRecordBtn.disabled = true;
  stopRecordBtn.disabled = false;
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
  startRecordBtn.disabled = false;
  stopRecordBtn.disabled = true;
}

modeUploadBtn.addEventListener("click", () => setMode("upload"));
modeRecordBtn.addEventListener("click", () => setMode("record"));

fileInput.addEventListener("change", () => {
  selectedFile = fileInput.files?.[0] || null;
  recordedBlob = null;
  if (selectedFile) {
    uploadFileName.textContent = `${selectedFile.name} (${Math.round(selectedFile.size / 1024)} KB)`;
  } else {
    uploadFileName.textContent = "No file selected";
  }
  updateTranscribeEnabled();
});

startRecordBtn.addEventListener("click", startRecording);
stopRecordBtn.addEventListener("click", stopRecording);
transcribeBtn.addEventListener("click", sendForTranscription);

clearResult();
updateTranscribeEnabled();
