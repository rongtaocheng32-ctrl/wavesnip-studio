(() => {
  "use strict";

  const STORAGE_KEY = "wavesnip.export-history.v1";
  const MAX_HISTORY_ITEMS = 20;
  const MIN_SELECTION_SECONDS = 0.01;
  const MAX_WAV_DATA_BYTES = 0xffffffff - 36;

  const byId = (id) => document.getElementById(id);

  const elements = {
    dropZone: byId("dropZone"),
    fileInput: byId("fileInput"),
    loadingPanel: byId("loadingPanel"),
    editor: byId("editor"),
    removeFileButton: byId("removeFileButton"),
    statusMessage: byId("statusMessage"),
    statusText: byId("statusText"),
    dismissStatusButton: byId("dismissStatusButton"),
    fileName: byId("file-name"),
    fileDuration: byId("fileDuration"),
    fileSampleRate: byId("fileSampleRate"),
    fileChannels: byId("fileChannels"),
    fileSize: byId("fileSize"),
    waveStage: byId("waveStage"),
    waveformCanvas: byId("waveformCanvas"),
    waveEmpty: byId("waveEmpty"),
    startRange: byId("startRange"),
    endRange: byId("endRange"),
    rangeFill: byId("rangeFill"),
    startTimeInput: byId("startTimeInput"),
    endTimeInput: byId("endTimeInput"),
    startTimeFormatted: byId("startTimeFormatted"),
    endTimeFormatted: byId("endTimeFormatted"),
    selectionDuration: byId("selectionDuration"),
    selectAllButton: byId("selectAllButton"),
    playButton: byId("playButton"),
    stopButton: byId("stopButton"),
    playbackPosition: byId("playbackPosition"),
    playbackEnd: byId("playbackEnd"),
    volumeInput: byId("volumeInput"),
    volumeOutput: byId("volumeOutput"),
    fadeInInput: byId("fadeInInput"),
    fadeOutInput: byId("fadeOutInput"),
    normalizeInput: byId("normalizeInput"),
    exportButton: byId("exportButton"),
    exportButtonLabel: byId("exportButtonLabel"),
    exportProgressWrap: byId("exportProgressWrap"),
    exportProgressText: byId("exportProgressText"),
    exportProgressValue: byId("exportProgressValue"),
    exportProgress: byId("exportProgress"),
    historyEmpty: byId("historyEmpty"),
    historyList: byId("historyList"),
    clearHistoryButton: byId("clearHistoryButton"),
  };

  const state = {
    audioContext: null,
    audioBuffer: null,
    file: null,
    startTime: 0,
    endTime: 0,
    peaks: null,
    peakWidth: 0,
    peakCache: new Map(),
    drag: null,
    source: null,
    gainNode: null,
    playbackContextStart: 0,
    playbackSelectionStart: 0,
    playbackDuration: 0,
    playbackFrame: 0,
    currentPlayhead: null,
    playRequestId: 0,
    loadToken: 0,
    isExporting: false,
    isPreparingPlayback: false,
    objectUrls: new Set(),
    statusTimer: 0,
    resizeFrame: 0,
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function round(value, digits = 3) {
    const factor = 10 ** digits;
    return Math.round((value + Number.EPSILON) * factor) / factor;
  }

  function formatTime(value) {
    const safeValue = Number.isFinite(value) ? Math.max(0, value) : 0;
    const hours = Math.floor(safeValue / 3600);
    const minutes = Math.floor((safeValue % 3600) / 60);
    const seconds = Math.floor(safeValue % 60);
    const milliseconds = Math.floor((safeValue - Math.floor(safeValue)) * 1000 + 0.5);

    const adjustedSeconds = milliseconds === 1000 ? seconds + 1 : seconds;
    const finalMilliseconds = milliseconds === 1000 ? 0 : milliseconds;
    const adjustedMinutes = minutes + Math.floor(adjustedSeconds / 60);
    const finalSeconds = adjustedSeconds % 60;
    const finalHours = hours + Math.floor(adjustedMinutes / 60);
    const finalMinutes = adjustedMinutes % 60;

    const prefix = finalHours > 0 ? `${String(finalHours).padStart(2, "0")}:` : "";
    return `${prefix}${String(finalMinutes).padStart(2, "0")}:${String(finalSeconds).padStart(2, "0")}.${String(finalMilliseconds).padStart(3, "0")}`;
  }

  function formatFileSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return "—";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex += 1;
    }
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
  }

  function nextPaint() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function showStatus(message, type = "info", autoHide = type !== "error") {
    window.clearTimeout(state.statusTimer);
    elements.statusText.textContent = message;
    elements.statusMessage.dataset.type = type;
    elements.statusMessage.hidden = false;

    if (autoHide) {
      state.statusTimer = window.setTimeout(() => {
        elements.statusMessage.hidden = true;
      }, 6000);
    }
  }

  function clearStatus() {
    window.clearTimeout(state.statusTimer);
    elements.statusMessage.hidden = true;
  }

  async function getAudioContext({ resume = false } = {}) {
    if (!state.audioContext || state.audioContext.state === "closed") {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        throw new Error("当前浏览器不支持 Web Audio API。");
      }
      state.audioContext = new AudioContextClass();
    }

    if (resume && state.audioContext.state === "suspended") {
      await state.audioContext.resume();
    }
    return state.audioContext;
  }

  function setLoading(isLoading) {
    elements.loadingPanel.hidden = !isLoading;
    elements.dropZone.hidden = isLoading || Boolean(state.audioBuffer);
    elements.editor.hidden = !state.audioBuffer;
    elements.removeFileButton.hidden = !state.audioBuffer || isLoading;
  }

  function explainDecodeError(error) {
    if (error?.name === "NotSupportedError" || /decode|format|codec/i.test(error?.message || "")) {
      return "无法解码这个文件。请尝试 WAV、MP3、M4A 或当前浏览器支持的其他音频格式。";
    }
    if (error instanceof RangeError || /memory|allocation/i.test(error?.message || "")) {
      return "文件太大，浏览器没有足够内存完成解码。请裁短源文件后再试。";
    }
    return "打开音频失败。文件可能已损坏，或使用了浏览器不支持的编码。";
  }

  async function loadAudioFile(file) {
    if (!file) return;

    const token = ++state.loadToken;
    stopPlayback({ resetPosition: true, redraw: false });
    clearStatus();
    state.audioBuffer = null;
    state.file = null;
    state.peaks = null;
    state.peakCache.clear();
    setLoading(true);

    try {
      const context = await getAudioContext();
      const fileData = await file.arrayBuffer();
      if (token !== state.loadToken) return;

      const decoded = await context.decodeAudioData(fileData);
      if (token !== state.loadToken) return;
      if (!decoded || decoded.length === 0 || !Number.isFinite(decoded.duration)) {
        throw new Error("音频中没有可用的样本。");
      }

      state.audioBuffer = decoded;
      state.file = file;
      state.startTime = 0;
      state.endTime = decoded.duration;

      populateFileDetails();
      configureSelectionControls();
      setLoading(false);
      elements.waveEmpty.hidden = false;

      await nextPaint();
      rebuildWaveform();
      showStatus(`已在本地打开「${file.name}」。`, "success");
    } catch (error) {
      if (token !== state.loadToken) return;
      console.error("WaveSnip decode error:", error);
      state.audioBuffer = null;
      state.file = null;
      state.peaks = null;
      setLoading(false);
      showStatus(explainDecodeError(error), "error", false);
    } finally {
      elements.fileInput.value = "";
    }
  }

  function populateFileDetails() {
    const buffer = state.audioBuffer;
    const file = state.file;
    if (!buffer || !file) return;

    elements.fileName.textContent = file.name;
    elements.fileName.title = file.name;
    elements.fileDuration.textContent = formatTime(buffer.duration);
    elements.fileSampleRate.textContent = `${(buffer.sampleRate / 1000).toFixed(buffer.sampleRate % 1000 === 0 ? 0 : 1)} kHz`;
    elements.fileChannels.textContent = `${buffer.numberOfChannels} 声道`;
    elements.fileSize.textContent = formatFileSize(file.size);
  }

  function configureSelectionControls() {
    if (!state.audioBuffer) return;
    const duration = state.audioBuffer.duration;
    for (const input of [elements.startRange, elements.endRange]) {
      input.max = String(duration);
      input.step = String(Math.max(1 / state.audioBuffer.sampleRate, 0.001));
    }
    elements.startTimeInput.max = String(duration);
    elements.endTimeInput.max = String(duration);
    syncSelectionUI();
  }

  function minimumGap() {
    if (!state.audioBuffer) return MIN_SELECTION_SECONDS;
    return Math.min(MIN_SELECTION_SECONDS, 1 / state.audioBuffer.sampleRate, state.audioBuffer.duration);
  }

  function setSelection(start, end, changed = "program") {
    const buffer = state.audioBuffer;
    if (!buffer) return;

    const duration = buffer.duration;
    const gap = minimumGap();
    let safeStart = clamp(Number(start) || 0, 0, duration);
    let safeEnd = clamp(Number(end) || 0, 0, duration);

    if (changed === "start") {
      safeStart = Math.min(safeStart, Math.max(0, safeEnd - gap));
    } else if (changed === "end") {
      safeEnd = Math.max(safeEnd, Math.min(duration, safeStart + gap));
    } else if (safeEnd < safeStart) {
      [safeStart, safeEnd] = [safeEnd, safeStart];
    }

    if (safeEnd - safeStart < gap) {
      if (safeStart + gap <= duration) {
        safeEnd = safeStart + gap;
      } else {
        safeStart = Math.max(0, safeEnd - gap);
      }
    }

    if (state.source || state.isPreparingPlayback) {
      stopPlayback({ resetPosition: true, redraw: false });
    }

    state.startTime = safeStart;
    state.endTime = safeEnd;
    syncSelectionUI();
    drawWaveform();
  }

  function syncSelectionUI() {
    const buffer = state.audioBuffer;
    if (!buffer) return;

    const duration = buffer.duration || 1;
    const selectedDuration = Math.max(0, state.endTime - state.startTime);
    elements.startRange.value = String(state.startTime);
    elements.endRange.value = String(state.endTime);
    elements.startTimeInput.value = round(state.startTime).toFixed(3);
    elements.endTimeInput.value = round(state.endTime).toFixed(3);
    elements.startTimeFormatted.textContent = formatTime(state.startTime);
    elements.endTimeFormatted.textContent = formatTime(state.endTime);
    elements.selectionDuration.textContent = formatTime(selectedDuration);
    elements.playbackPosition.textContent = formatTime(state.startTime);
    elements.playbackEnd.textContent = formatTime(state.endTime);

    const left = (state.startTime / duration) * 100;
    const right = (state.endTime / duration) * 100;
    elements.rangeFill.style.marginLeft = `${left}%`;
    elements.rangeFill.style.width = `${Math.max(0, right - left)}%`;

    sanitizeFades("selection", false);
  }

  function applyTimeInput(which) {
    const input = which === "start" ? elements.startTimeInput : elements.endTimeInput;
    const parsed = Number(input.value);
    if (!Number.isFinite(parsed)) {
      syncSelectionUI();
      showStatus("请输入有效的秒数。", "error", false);
      return;
    }
    if (which === "start") {
      setSelection(parsed, state.endTime, "start");
    } else {
      setSelection(state.startTime, parsed, "end");
    }
  }

  function sanitizeFades(changed = "selection", notify = true) {
    const duration = Math.max(0, state.endTime - state.startTime);
    let fadeIn = clamp(Number(elements.fadeInInput.value) || 0, 0, duration);
    let fadeOut = clamp(Number(elements.fadeOutInput.value) || 0, 0, duration);
    const originalIn = fadeIn;
    const originalOut = fadeOut;

    if (fadeIn + fadeOut > duration) {
      if (changed === "fadeIn") {
        fadeOut = Math.max(0, duration - fadeIn);
      } else if (changed === "fadeOut") {
        fadeIn = Math.max(0, duration - fadeOut);
      } else {
        fadeOut = Math.max(0, duration - fadeIn);
        if (fadeIn > duration) {
          fadeIn = duration;
          fadeOut = 0;
        }
      }
    }

    elements.fadeInInput.max = String(duration);
    elements.fadeOutInput.max = String(duration);
    elements.fadeInInput.value = String(round(fadeIn));
    elements.fadeOutInput.value = String(round(fadeOut));

    if (notify && (fadeIn !== originalIn || fadeOut !== originalOut)) {
      showStatus("淡入与淡出的总时长不能超过选区，已自动调整。", "info");
    }

    return { fadeIn, fadeOut };
  }

  function rebuildWaveform() {
    const buffer = state.audioBuffer;
    if (!buffer || elements.editor.hidden) return;

    const rect = elements.waveStage.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    const canvas = elements.waveformCanvas;

    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    state.peaks = computePeaks(buffer, width);
    state.peakWidth = width;
    elements.waveEmpty.hidden = true;
    drawWaveform();
  }

  function computePeaks(buffer, width) {
    const peaks = new Float32Array(width * 2);
    const length = buffer.length;
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));

    for (let x = 0; x < width; x += 1) {
      const start = Math.floor((x / width) * length);
      const end = Math.max(start + 1, Math.floor(((x + 1) / width) * length));
      const step = Math.max(1, Math.floor((end - start) / 180));
      let min = 1;
      let max = -1;

      for (const channel of channels) {
        for (let sample = start; sample < end; sample += step) {
          const value = channel[sample] || 0;
          if (value < min) min = value;
          if (value > max) max = value;
        }
      }

      peaks[x * 2] = min;
      peaks[x * 2 + 1] = max;
    }
    return peaks;
  }

  function drawWaveform() {
    const buffer = state.audioBuffer;
    const peaks = state.peaks;
    const canvas = elements.waveformCanvas;
    if (!buffer || !peaks || !canvas.width || !canvas.height) return;

    const context = canvas.getContext("2d");
    const width = canvas.width;
    const height = canvas.height;
    const duration = buffer.duration || 1;
    const startX = (state.startTime / duration) * width;
    const endX = (state.endTime / duration) * width;
    const center = height / 2;
    const amplitude = height * 0.36;

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#13231f";
    context.fillRect(0, 0, width, height);

    context.strokeStyle = "rgba(255,255,255,0.08)";
    context.lineWidth = 1;
    context.fillStyle = "rgba(255,255,255,0.42)";
    context.font = `${Math.max(18, width / 95)}px ui-monospace, monospace`;
    context.textBaseline = "top";
    const gridCount = width < 900 ? 4 : 8;
    for (let index = 0; index <= gridCount; index += 1) {
      const x = (index / gridCount) * width;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
      if (index < gridCount) {
        context.fillText(formatTime((index / gridCount) * duration), x + 8, 10);
      }
    }

    context.fillStyle = "rgba(200,243,106,0.08)";
    context.fillRect(startX, 0, Math.max(1, endX - startX), height);

    const paintPeaks = (color, clipStart = 0, clipEnd = width) => {
      context.save();
      context.beginPath();
      context.rect(clipStart, 0, Math.max(0, clipEnd - clipStart), height);
      context.clip();
      context.strokeStyle = color;
      context.lineWidth = Math.max(1, width / 1200);
      context.beginPath();
      for (let x = 0; x < width; x += 1) {
        const min = peaks[x * 2];
        const max = peaks[x * 2 + 1];
        context.moveTo(x + 0.5, center + min * amplitude);
        context.lineTo(x + 0.5, center + max * amplitude);
      }
      context.stroke();
      context.restore();
    };

    paintPeaks("rgba(255,255,255,0.28)");
    paintPeaks("#c8f36a", startX, endX);

    context.strokeStyle = "rgba(255,255,255,0.14)";
    context.beginPath();
    context.moveTo(0, center + 0.5);
    context.lineTo(width, center + 0.5);
    context.stroke();

    context.strokeStyle = "#e75332";
    context.lineWidth = Math.max(2, width / 700);
    for (const x of [startX, endX]) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
      context.fillStyle = "#e75332";
      context.beginPath();
      context.arc(x, height * 0.5, Math.max(5, width / 240), 0, Math.PI * 2);
      context.fill();
    }

    if (Number.isFinite(state.currentPlayhead)) {
      const playheadX = (state.currentPlayhead / duration) * width;
      context.strokeStyle = "#ffffff";
      context.lineWidth = Math.max(2, width / 800);
      context.beginPath();
      context.moveTo(playheadX, 0);
      context.lineTo(playheadX, height);
      context.stroke();
      context.fillStyle = "#ffffff";
      context.beginPath();
      context.moveTo(playheadX - 6, 0);
      context.lineTo(playheadX + 6, 0);
      context.lineTo(playheadX, 10);
      context.closePath();
      context.fill();
    }

    elements.waveformCanvas.setAttribute(
      "aria-label",
      `音频波形，总时长 ${formatTime(duration)}，当前选区从 ${formatTime(state.startTime)} 到 ${formatTime(state.endTime)}。`,
    );
  }

  function pointerTime(event) {
    const rect = elements.waveformCanvas.getBoundingClientRect();
    const ratio = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    return ratio * (state.audioBuffer?.duration || 0);
  }

  function handlePointerDown(event) {
    if (!state.audioBuffer || state.isExporting) return;
    const time = pointerTime(event);
    state.drag = { anchor: time, startX: event.clientX, moved: false };
    elements.waveformCanvas.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event) {
    if (!state.drag || !state.audioBuffer) return;
    if (Math.abs(event.clientX - state.drag.startX) > 3) state.drag.moved = true;
    if (!state.drag.moved) return;
    const current = pointerTime(event);
    setSelection(Math.min(state.drag.anchor, current), Math.max(state.drag.anchor, current), "drag");
  }

  function handlePointerUp(event) {
    if (!state.drag || !state.audioBuffer) return;
    const drag = state.drag;
    state.drag = null;
    elements.waveformCanvas.releasePointerCapture?.(event.pointerId);

    if (!drag.moved) {
      const time = pointerTime(event);
      const distanceFromStart = Math.abs(time - state.startTime);
      const distanceFromEnd = Math.abs(time - state.endTime);
      if (distanceFromStart <= distanceFromEnd) {
        setSelection(time, state.endTime, "start");
      } else {
        setSelection(state.startTime, time, "end");
      }
    }
  }

  function handlePointerCancel(event) {
    if (!state.drag) return;
    state.drag = null;
    elements.waveformCanvas.releasePointerCapture?.(event.pointerId);
  }

  async function scanSelectionPeak(startFrame, endFrame, onProgress) {
    const buffer = state.audioBuffer;
    if (!buffer) return 0;
    const cacheKey = `${startFrame}:${endFrame}`;
    if (state.peakCache.has(cacheKey)) {
      onProgress?.(1);
      return state.peakCache.get(cacheKey);
    }

    const channels = Array.from({ length: buffer.numberOfChannels }, (_, index) => buffer.getChannelData(index));
    const totalFrames = Math.max(1, endFrame - startFrame);
    const chunkFrames = 250000;
    let peak = 0;

    for (let chunkStart = startFrame; chunkStart < endFrame; chunkStart += chunkFrames) {
      const chunkEnd = Math.min(endFrame, chunkStart + chunkFrames);
      for (const channel of channels) {
        for (let frame = chunkStart; frame < chunkEnd; frame += 1) {
          const absolute = Math.abs(channel[frame] || 0);
          if (absolute > peak) peak = absolute;
        }
      }
      onProgress?.((chunkEnd - startFrame) / totalFrames);
      if (chunkEnd < endFrame) await nextPaint();
    }

    state.peakCache.set(cacheKey, peak);
    return peak;
  }

  async function normalizationGain(startFrame, endFrame, onProgress) {
    if (!elements.normalizeInput.checked) return 1;
    const peak = await scanSelectionPeak(startFrame, endFrame, onProgress);
    if (peak <= Number.EPSILON) return 1;
    return 0.98 / peak;
  }

  async function playSelection() {
    const buffer = state.audioBuffer;
    if (!buffer || state.isExporting || state.isPreparingPlayback) return;
    const duration = state.endTime - state.startTime;
    if (duration <= 0) {
      showStatus("请先选择一段有效音频。", "error", false);
      return;
    }

    state.isPreparingPlayback = true;
    const requestId = ++state.playRequestId;
    const selectionStart = state.startTime;
    const selectionEnd = state.endTime;
    elements.playButton.disabled = true;
    elements.playButton.querySelector("span:last-child").textContent = elements.normalizeInput.checked ? "分析音量…" : "准备试听…";

    try {
      const context = await getAudioContext({ resume: true });
      const startFrame = Math.floor(selectionStart * buffer.sampleRate);
      const endFrame = Math.min(buffer.length, Math.ceil(selectionEnd * buffer.sampleRate));
      const normalizeGain = await normalizationGain(startFrame, endFrame);

      if (requestId !== state.playRequestId || buffer !== state.audioBuffer) return;
      stopPlayback({ resetPosition: false, redraw: false, cancelPreparation: false });

      const { fadeIn, fadeOut } = sanitizeFades("selection", false);
      const volume = Number(elements.volumeInput.value) / 100;
      const finalGain = volume * normalizeGain;
      const source = context.createBufferSource();
      const gainNode = context.createGain();
      const startsAt = context.currentTime + 0.025;
      const endsAt = startsAt + duration;

      source.buffer = buffer;
      source.connect(gainNode);
      gainNode.connect(context.destination);
      gainNode.gain.cancelScheduledValues(startsAt);
      gainNode.gain.setValueAtTime(fadeIn > 0 ? 0 : finalGain, startsAt);
      if (fadeIn > 0) {
        gainNode.gain.linearRampToValueAtTime(finalGain, startsAt + fadeIn);
      }
      if (fadeOut > 0) {
        gainNode.gain.setValueAtTime(finalGain, endsAt - fadeOut);
        gainNode.gain.linearRampToValueAtTime(0, endsAt);
      } else {
        gainNode.gain.setValueAtTime(finalGain, endsAt);
      }

      state.source = source;
      state.gainNode = gainNode;
      state.playbackContextStart = startsAt;
      state.playbackSelectionStart = selectionStart;
      state.playbackDuration = duration;
      state.currentPlayhead = selectionStart;
      source.onended = () => finishPlayback(source);
      source.start(startsAt, selectionStart, duration);

      elements.playButton.disabled = true;
      elements.stopButton.disabled = false;
      updatePlaybackFrame();
    } catch (error) {
      console.error("WaveSnip playback error:", error);
      showStatus("试听失败。请检查浏览器的音频输出设置。", "error", false);
      stopPlayback({ resetPosition: true });
    } finally {
      state.isPreparingPlayback = false;
      elements.playButton.querySelector("span:last-child").textContent = "试听选区";
      if (!state.source) elements.playButton.disabled = false;
    }
  }

  function updatePlaybackFrame() {
    if (!state.source || !state.audioContext) return;
    const elapsed = clamp(state.audioContext.currentTime - state.playbackContextStart, 0, state.playbackDuration);
    const position = state.playbackSelectionStart + elapsed;
    state.currentPlayhead = position;
    elements.playbackPosition.textContent = formatTime(position);
    drawWaveform();
    if (elapsed < state.playbackDuration) {
      state.playbackFrame = requestAnimationFrame(updatePlaybackFrame);
    }
  }

  function finishPlayback(source) {
    if (source !== state.source) return;
    cancelAnimationFrame(state.playbackFrame);
    try { source.disconnect(); } catch (_) { /* already disconnected */ }
    try { state.gainNode?.disconnect(); } catch (_) { /* already disconnected */ }
    state.source = null;
    state.gainNode = null;
    state.currentPlayhead = null;
    elements.playbackPosition.textContent = formatTime(state.endTime);
    elements.playButton.disabled = state.isExporting;
    elements.stopButton.disabled = true;
    drawWaveform();
  }

  function stopPlayback({ resetPosition = true, redraw = true, cancelPreparation = true } = {}) {
    if (cancelPreparation) state.playRequestId += 1;
    cancelAnimationFrame(state.playbackFrame);
    const source = state.source;
    if (source) {
      source.onended = null;
      try { source.stop(); } catch (_) { /* source may already be stopped */ }
      try { source.disconnect(); } catch (_) { /* source may already be disconnected */ }
    }
    try { state.gainNode?.disconnect(); } catch (_) { /* node may already be disconnected */ }
    state.source = null;
    state.gainNode = null;
    state.currentPlayhead = null;
    elements.playButton.disabled = state.isExporting || state.isPreparingPlayback;
    elements.stopButton.disabled = true;
    if (resetPosition) elements.playbackPosition.textContent = formatTime(state.startTime);
    if (redraw) drawWaveform();
  }

  function updateExportProgress(value, label) {
    const safeValue = clamp(Math.round(value), 0, 100);
    elements.exportProgress.value = safeValue;
    elements.exportProgress.textContent = `${safeValue}%`;
    elements.exportProgressValue.textContent = `${safeValue}%`;
    if (label) elements.exportProgressText.textContent = label;
  }

  function setProcessingControlsDisabled(disabled) {
    const controls = [
      elements.startRange,
      elements.endRange,
      elements.startTimeInput,
      elements.endTimeInput,
      elements.volumeInput,
      elements.fadeInInput,
      elements.fadeOutInput,
      elements.normalizeInput,
      elements.selectAllButton,
      elements.removeFileButton,
    ];
    for (const control of controls) control.disabled = disabled;
  }

  function writeAscii(view, offset, value) {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  }

  async function encodeSelectionAsWav() {
    const buffer = state.audioBuffer;
    if (!buffer) throw new Error("没有可导出的音频。");

    const startFrame = clamp(Math.floor(state.startTime * buffer.sampleRate), 0, buffer.length);
    const endFrame = clamp(Math.ceil(state.endTime * buffer.sampleRate), 0, buffer.length);
    const frameCount = endFrame - startFrame;
    const channelCount = buffer.numberOfChannels;
    const bytesPerSample = 2;
    const dataBytes = frameCount * channelCount * bytesPerSample;

    if (frameCount <= 0) throw new Error("选区中没有可导出的样本。");
    if (dataBytes > MAX_WAV_DATA_BYTES) {
      throw new Error("导出结果会超过标准 WAV 的 4 GB 限制，请缩短选区。");
    }

    updateExportProgress(1, elements.normalizeInput.checked ? "正在分析峰值…" : "正在准备编码…");
    const normalizeGain = await normalizationGain(startFrame, endFrame, (progress) => {
      updateExportProgress(progress * 18, "正在分析峰值…");
    });

    let wavBuffer;
    try {
      wavBuffer = new ArrayBuffer(44 + dataBytes);
    } catch (error) {
      throw new Error("浏览器没有足够内存生成这个 WAV，请缩短选区后再试。", { cause: error });
    }

    const view = new DataView(wavBuffer);
    const blockAlign = channelCount * bytesPerSample;
    const byteRate = buffer.sampleRate * blockAlign;

    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, channelCount, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, dataBytes, true);

    const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index));
    const volume = Number(elements.volumeInput.value) / 100;
    const baseGain = volume * normalizeGain;
    const { fadeIn, fadeOut } = sanitizeFades("selection", false);
    const fadeInFrames = Math.round(fadeIn * buffer.sampleRate);
    const fadeOutFrames = Math.round(fadeOut * buffer.sampleRate);
    const chunkFrames = 30000;
    let offset = 44;

    for (let frame = 0; frame < frameCount; frame += 1) {
      let envelope = 1;
      if (fadeInFrames > 0 && frame < fadeInFrames) {
        envelope = Math.min(envelope, frame / fadeInFrames);
      }
      if (fadeOutFrames > 0 && frame >= frameCount - fadeOutFrames) {
        envelope = Math.min(envelope, Math.max(0, (frameCount - 1 - frame) / fadeOutFrames));
      }

      for (let channel = 0; channel < channelCount; channel += 1) {
        const raw = channels[channel][startFrame + frame] || 0;
        const sample = clamp(raw * baseGain * envelope, -1, 1);
        const intValue = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
        view.setInt16(offset, intValue, true);
        offset += 2;
      }

      if (frame > 0 && frame % chunkFrames === 0) {
        updateExportProgress(18 + (frame / frameCount) * 80, "正在编码 16-bit PCM…");
        await nextPaint();
      }
    }

    updateExportProgress(100, "编码完成");
    return {
      blob: new Blob([wavBuffer], { type: "audio/wav" }),
      startFrame,
      endFrame,
      frameCount,
      channelCount,
      sampleRate: buffer.sampleRate,
      normalizeGain,
      fadeIn,
      fadeOut,
      volume,
    };
  }

  function safeBaseName(fileName) {
    const withoutExtension = fileName.replace(/\.[^.]+$/, "");
    const sanitized = withoutExtension
      .replace(/[\\/?%*:|"<>\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return sanitized || "audio";
  }

  function compactTime(value) {
    const totalMilliseconds = Math.round(Math.max(0, value) * 1000);
    const minutes = Math.floor(totalMilliseconds / 60000);
    const seconds = Math.floor((totalMilliseconds % 60000) / 1000);
    const milliseconds = totalMilliseconds % 1000;
    return `${String(minutes).padStart(2, "0")}m${String(seconds).padStart(2, "0")}s${String(milliseconds).padStart(3, "0")}`;
  }

  function buildOutputName() {
    const sourceName = state.file?.name || "audio";
    return `${safeBaseName(sourceName)}-wavesnip-${compactTime(state.startTime)}-${compactTime(state.endTime)}.wav`;
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    state.objectUrls.add(url);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
      state.objectUrls.delete(url);
    }, 1500);
  }

  function readHistory() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
    } catch (_) {
      return [];
    }
  }

  function saveHistory(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_HISTORY_ITEMS)));
      return true;
    } catch (error) {
      console.warn("WaveSnip could not save export history:", error);
      return false;
    }
  }

  function addHistory(outputName, result) {
    const history = readHistory();
    history.unshift({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      sourceName: state.file?.name || "未命名音频",
      outputName,
      start: state.startTime,
      end: state.endTime,
      duration: state.endTime - state.startTime,
      sampleRate: result.sampleRate,
      channels: result.channelCount,
      volume: Math.round(result.volume * 100),
      fadeIn: result.fadeIn,
      fadeOut: result.fadeOut,
      normalized: elements.normalizeInput.checked,
    });
    const saved = saveHistory(history);
    renderHistory();
    return saved;
  }

  function historyDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "未知时间";
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }

  function renderHistory() {
    const history = readHistory();
    elements.historyList.replaceChildren();
    elements.historyEmpty.hidden = history.length > 0;
    elements.historyList.hidden = history.length === 0;
    elements.clearHistoryButton.hidden = history.length === 0;

    history.forEach((item, index) => {
      const row = document.createElement("li");

      const number = document.createElement("span");
      number.className = "history-number";
      number.textContent = String(index + 1).padStart(2, "0");

      const main = document.createElement("div");
      main.className = "history-main";
      const output = document.createElement("strong");
      output.textContent = item.outputName || "未命名.wav";
      output.title = output.textContent;
      const source = document.createElement("small");
      source.textContent = `${item.sourceName || "未知文件"} · ${historyDate(item.createdAt)}`;
      main.append(output, source);

      const time = document.createElement("span");
      time.className = "history-time";
      time.textContent = `${formatTime(item.start)} → ${formatTime(item.end)}`;

      const tags = document.createElement("div");
      tags.className = "history-tags";
      const tagValues = [
        `${formatTime(item.duration)}`,
        `${Math.round((Number(item.sampleRate) || 0) / 1000)} kHz`,
        `${Number(item.channels) || 0} ch`,
        `${Number(item.volume) || 0}%`,
      ];
      if (item.normalized) tagValues.push("已归一化");
      if (Number(item.fadeIn) > 0) tagValues.push(`淡入 ${item.fadeIn}s`);
      if (Number(item.fadeOut) > 0) tagValues.push(`淡出 ${item.fadeOut}s`);
      for (const value of tagValues) {
        const tag = document.createElement("span");
        tag.textContent = value;
        tags.append(tag);
      }

      row.append(number, main, time, tags);
      elements.historyList.append(row);
    });
  }

  async function exportSelection() {
    if (!state.audioBuffer || state.isExporting) return;
    stopPlayback({ resetPosition: true });
    clearStatus();
    state.isExporting = true;
    elements.exportButton.disabled = true;
    elements.playButton.disabled = true;
    setProcessingControlsDisabled(true);
    elements.exportButtonLabel.textContent = "正在生成…";
    elements.exportProgressWrap.hidden = false;
    updateExportProgress(0, "正在准备…");

    try {
      const outputName = buildOutputName();
      const result = await encodeSelectionAsWav();
      downloadBlob(result.blob, outputName);
      const saved = addHistory(outputName, result);
      showStatus(
        saved
          ? `「${outputName}」已导出，参数已保存到本地记录。`
          : `「${outputName}」已导出，但浏览器拒绝保存本地记录。`,
        "success",
      );
    } catch (error) {
      console.error("WaveSnip export error:", error);
      showStatus(error?.message || "导出失败，请缩短选区后再试。", "error", false);
    } finally {
      state.isExporting = false;
      elements.exportButton.disabled = false;
      elements.playButton.disabled = false;
      setProcessingControlsDisabled(false);
      elements.exportButtonLabel.textContent = "导出选区 WAV";
      window.setTimeout(() => {
        if (!state.isExporting) elements.exportProgressWrap.hidden = true;
      }, 900);
    }
  }

  function removeCurrentFile() {
    if (state.isExporting) return;
    ++state.loadToken;
    stopPlayback({ resetPosition: true, redraw: false });
    state.audioBuffer = null;
    state.file = null;
    state.peaks = null;
    state.peakWidth = 0;
    state.peakCache.clear();
    state.startTime = 0;
    state.endTime = 0;
    state.currentPlayhead = null;
    elements.waveEmpty.hidden = false;
    const context = elements.waveformCanvas.getContext("2d");
    context?.clearRect(0, 0, elements.waveformCanvas.width, elements.waveformCanvas.height);
    setLoading(false);
    clearStatus();
    elements.dropZone.focus();
  }

  function clearHistory() {
    if (!window.confirm("确定清空这台浏览器中的所有导出记录吗？已下载的 WAV 不会受影响。")) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {
      // Rendering an empty history still keeps the UI consistent when storage is blocked.
    }
    renderHistory();
    showStatus("本地导出记录已清空。", "success");
  }

  function handleResize() {
    cancelAnimationFrame(state.resizeFrame);
    state.resizeFrame = requestAnimationFrame(() => {
      if (!state.audioBuffer) return;
      const rect = elements.waveStage.getBoundingClientRect();
      const expectedWidth = Math.max(1, Math.round(rect.width * Math.min(window.devicePixelRatio || 1, 2)));
      if (expectedWidth !== state.peakWidth || elements.waveformCanvas.height !== Math.round(rect.height * Math.min(window.devicePixelRatio || 1, 2))) {
        rebuildWaveform();
      } else {
        drawWaveform();
      }
    });
  }

  function attachEvents() {
    elements.dropZone.addEventListener("click", () => elements.fileInput.click());
    elements.dropZone.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        elements.fileInput.click();
      }
    });

    elements.fileInput.addEventListener("change", () => loadAudioFile(elements.fileInput.files?.[0]));

    for (const eventName of ["dragenter", "dragover"]) {
      elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
        elements.dropZone.classList.add("is-dragging");
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.remove("is-dragging");
      });
    }
    elements.dropZone.addEventListener("drop", (event) => loadAudioFile(event.dataTransfer?.files?.[0]));

    elements.dismissStatusButton.addEventListener("click", clearStatus);
    elements.removeFileButton.addEventListener("click", removeCurrentFile);

    elements.startRange.addEventListener("input", () => setSelection(Number(elements.startRange.value), state.endTime, "start"));
    elements.endRange.addEventListener("input", () => setSelection(state.startTime, Number(elements.endRange.value), "end"));

    elements.startTimeInput.addEventListener("change", () => applyTimeInput("start"));
    elements.endTimeInput.addEventListener("change", () => applyTimeInput("end"));
    for (const input of [elements.startTimeInput, elements.endTimeInput]) {
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
      });
    }

    elements.selectAllButton.addEventListener("click", () => {
      if (state.audioBuffer) setSelection(0, state.audioBuffer.duration, "program");
    });

    elements.waveformCanvas.addEventListener("pointerdown", handlePointerDown);
    elements.waveformCanvas.addEventListener("pointermove", handlePointerMove);
    elements.waveformCanvas.addEventListener("pointerup", handlePointerUp);
    elements.waveformCanvas.addEventListener("pointercancel", handlePointerCancel);

    elements.playButton.addEventListener("click", playSelection);
    elements.stopButton.addEventListener("click", () => stopPlayback({ resetPosition: true }));
    elements.volumeInput.addEventListener("input", () => {
      elements.volumeOutput.textContent = `${elements.volumeInput.value}%`;
      if (state.source || state.isPreparingPlayback) stopPlayback({ resetPosition: true });
    });
    elements.fadeInInput.addEventListener("change", () => {
      sanitizeFades("fadeIn");
      if (state.source || state.isPreparingPlayback) stopPlayback({ resetPosition: true });
    });
    elements.fadeOutInput.addEventListener("change", () => {
      sanitizeFades("fadeOut");
      if (state.source || state.isPreparingPlayback) stopPlayback({ resetPosition: true });
    });
    elements.normalizeInput.addEventListener("change", () => {
      if (state.source || state.isPreparingPlayback) stopPlayback({ resetPosition: true });
    });

    elements.exportButton.addEventListener("click", exportSelection);
    elements.clearHistoryButton.addEventListener("click", clearHistory);

    if ("ResizeObserver" in window) {
      const observer = new ResizeObserver(handleResize);
      observer.observe(elements.waveStage);
    } else {
      window.addEventListener("resize", handleResize);
    }

    window.addEventListener("beforeunload", () => {
      ++state.loadToken;
      stopPlayback({ resetPosition: false, redraw: false });
      for (const url of state.objectUrls) URL.revokeObjectURL(url);
      state.objectUrls.clear();
      state.audioContext?.close().catch(() => {});
    });
  }

  attachEvents();
  renderHistory();
  setLoading(false);
})();
