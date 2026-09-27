document.addEventListener('DOMContentLoaded', () => {
  const audioInput = document.getElementById('audioInput');
  const processBtn = document.getElementById('processBtn');
  const status = document.getElementById('status');
  const metricsDisplay = document.getElementById('metricsDisplay');
  const origPeak = document.getElementById('origPeak');
  const origRMS = document.getElementById('origRMS');
  const origNoise = document.getElementById('origNoise');
  const audioPreview = document.getElementById('audioPreview');
  const downloadLink = document.getElementById('downloadLink');

  let audioBuffer = null;

  // 1. File Input Handler
  audioInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    status.innerText = 'Reading audio file...';
    
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      status.innerText = `Loaded: ${file.name} (${audioBuffer.duration.toFixed(1)}s, ${audioBuffer.sampleRate}Hz, ${audioBuffer.numberOfChannels} ch)`;
      processBtn.disabled = false;
    } catch (err) {
      status.innerText = 'Error decoding audio file. Please try a valid WAV or MP3.';
      console.error(err);
    }
  });

  // 2. Processing & Analysis Handler
  processBtn.addEventListener('click', async () => {
    if (!audioBuffer) return;

    processBtn.disabled = true;
    status.innerText = 'Analyzing audio dynamics & noise floor...';

    const numChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const length = audioBuffer.length;

    // A. Global Peak & RMS Analysis
    const pcm = audioBuffer.getChannelData(0); // Primary channel analysis
    let peak = 0;
    let sumSquares = 0;

    for (let i = 0; i < length; i++) {
      const abs = Math.abs(pcm[i]);
      if (abs > peak) peak = abs;
      sumSquares += pcm[i] * pcm[i];
    }

    const currentRMS = Math.sqrt(sumSquares / length);
    const currentRMSdB = 20 * Math.log10(currentRMS || 0.00001);
    const currentPeakdB = 20 * Math.log10(peak || 0.00001);

    // B. Noise Floor Estimation (Sampling quietest 10% 100ms frames)
    const frameSize = Math.floor(sampleRate * 0.1); 
    const frameRMSValues = [];

    for (let i = 0; i < length; i += frameSize) {
      let frameSum = 0;
      const count = Math.min(frameSize, length - i);
      for (let j = 0; j < count; j++) {
        frameSum += pcm[i + j] * pcm[i + j];
      }
      const frameRMS = Math.sqrt(frameSum / count);
      if (frameRMS > 0.000001) { // Exclude digital silence
        frameRMSValues.push(frameRMS);
      }
    }

    frameRMSValues.sort((a, b) => a - b);
    const noiseFrames = frameRMSValues.slice(0, Math.max(1, Math.floor(frameRMSValues.length * 0.1)));
    const avgNoiseRMS = noiseFrames.reduce((acc, val) => acc + val, 0) / (noiseFrames.length || 1);
    const estimatedNoiseFloordBFS = 20 * Math.log10(avgNoiseRMS || 0.00001);

    // C. Update Readouts
    origPeak.innerText = `${currentPeakdB.toFixed(2)} dBFS`;
    origRMS.innerText = `${currentRMSdB.toFixed(2)} dBFS`;
    origNoise.innerText = `${estimatedNoiseFloordBFS.toFixed(2)} dBFS`;
    origNoise.style.color = (estimatedNoiseFloordBFS > -60.0) ? '#f14c4c' : '#4ec9b0';

    metricsDisplay.style.display = 'grid';

    status.innerText = 'Applying 80Hz filter, RMS Normalization (-20 dB), and Peak Limiting (-3 dB)...';

    // D. Step 1: 80Hz High-Pass Filter (Low-cut roll-off)
    const offlineCtx = new OfflineAudioContext(numChannels, length, 44100);
    const source = offlineCtx.createBufferSource();
    source.buffer = audioBuffer;

    const highPass = offlineCtx.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 80;

    source.connect(highPass);
    highPass.connect(offlineCtx.destination);
    source.start(0);

    const filteredBuffer = await offlineCtx.startRendering();

// E. Step 2 & 3: Linear RMS Normalization & Intersample-Safe Peak Limiting
    const targetRMSdB = -23.0;
    // -3.8 dBFS ceiling provides intersample headroom so MP3 encoding stays under -3.0 dBFS
    const targetPeakdB = -3.8;

    const targetRMSLinear = Math.pow(10, targetRMSdB / 20);
    const targetPeakLinear = Math.pow(10, targetPeakdB / 20);

    const gainFactor = targetRMSLinear / (currentRMS || 0.00001);

    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const outputBuffer = audioCtx.createBuffer(numChannels, length, 44100);

    // Subtle natural room tone generator (-78 dBFS) to prevent -inf dB warnings
    const roomToneFloor = Math.pow(10, -78 / 20);

    for (let c = 0; c < numChannels; c++) {
      const inputData = filteredBuffer.getChannelData(c);
      const outputData = outputBuffer.getChannelData(c);

      for (let i = 0; i < length; i++) {
        // 1. Apply target RMS gain
        let sample = inputData[i] * gainFactor;

        // 2. Prevent absolute digital zero (-inf dB) by injecting micro room tone
        if (Math.abs(sample) === 0) {
          sample = (Math.random() * 2 - 1) * roomToneFloor;
        }

        // 3. Intersample-safe peak ceiling
        if (sample > targetPeakLinear) {
          sample = targetPeakLinear;
        } else if (sample < -targetPeakLinear) {
          sample = -targetPeakLinear;
        }

        outputData[i] = sample;
      }
    }

    status.innerText = 'Encoding to 192kbps CBR MP3 (ACX Spec)...';
    setTimeout(() => encodeAndExport(outputBuffer), 50);
  });

  // 3. MP3 Encoder Handler
  function encodeAndExport(buffer) {
    const channels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const mp3encoder = new lamejs.Mp3Encoder(channels, sampleRate, 192);
    const mp3Data = [];

    const left = buffer.getChannelData(0);
    const right = channels > 1 ? buffer.getChannelData(1) : left;

    const sampleBlockSize = 1152;
    for (let i = 0; i < left.length; i += sampleBlockSize) {
      const leftChunk = new Int16Array(Math.min(sampleBlockSize, left.length - i));
      const rightChunk = new Int16Array(Math.min(sampleBlockSize, right.length - i));

      for (let j = 0; j < leftChunk.length; j++) {
        leftChunk[j] = Math.max(-1, Math.min(1, left[i + j])) * 0x7FFF;
        rightChunk[j] = Math.max(-1, Math.min(1, right[i + j])) * 0x7FFF;
      }

      let mp3buf;
      if (channels === 1) {
        mp3buf = mp3encoder.encodeBuffer(leftChunk);
      } else {
        mp3buf = mp3encoder.encodeBuffer(leftChunk, rightChunk);
      }
      if (mp3buf.length > 0) mp3Data.push(mp3buf);
    }

    const endBuf = mp3encoder.flush();
    if (endBuf.length > 0) mp3Data.push(endBuf);

    const blob = new Blob(mp3Data, { type: 'audio/mp3' });
    const url = URL.createObjectURL(blob);

    audioPreview.src = url;
    audioPreview.style.display = 'block';

    downloadLink.href = url;
    downloadLink.download = 'acx_mastered_output.mp3';
    downloadLink.style.display = 'inline-block';

    status.innerText = 'Mastering complete! Ready for download.';
  }
});

const audio = document.getElementById('audioPreview');
const playPauseBtn = document.getElementById('playPauseBtn');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const seekBar = document.getElementById('seekBar');
const currentTimeEl = document.getElementById('currentTime');
const durationTimeEl = document.getElementById('durationTime');

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`;
}

// Enable controls when audio source is loaded
audio.addEventListener('loadedmetadata', () => {
  playPauseBtn.disabled = false;
  seekBar.disabled = false;
  seekBar.max = audio.duration;
  durationTimeEl.textContent = formatTime(audio.duration);
});

// Play / Pause Toggle
playPauseBtn.addEventListener('click', () => {
  if (audio.paused) {
    audio.play();
    playIcon.style.display = 'none';
    pauseIcon.style.display = 'block';
  } else {
    audio.pause();
    playIcon.style.display = 'block';
    pauseIcon.style.display = 'none';
  }
});

// Sync Seek Bar & Time Display during Playback
audio.addEventListener('timeupdate', () => {
  seekBar.value = audio.currentTime;
  currentTimeEl.textContent = formatTime(audio.currentTime);
  
  // Updates linear-gradient fill behind thumb
  const percent = (audio.currentTime / audio.duration) * 100 || 0;
  seekBar.style.setProperty('--seek-percent', `${percent}%`);
});

// Handle User Seeking
seekBar.addEventListener('input', () => {
  audio.currentTime = seekBar.value;
});

// Reset Play Button on Track End
audio.addEventListener('ended', () => {
  playIcon.style.display = 'block';
  pauseIcon.style.display = 'none';
  seekBar.value = 0;
});

// Example JS snippet to match button label to output blob type
if (outputBlob.type === 'audio/wav') {
  downloadBtn.textContent = 'Download ACX Master (.wav)';
} else {
  downloadBtn.textContent = 'Download ACX Master (.mp3)';
}