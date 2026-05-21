/**
 * System Capture Control Module
 * Manages webcam/mic hardware inputs, pre-roll timers,
 * hardware microphone AV synchronization, and canvas MediaRecorder exporting.
 */
export class SystemCaptureControl {
  constructor(canvasElement, compositorVideoElement) {
    this.canvas = canvasElement;
    this.video = compositorVideoElement;

    // Hardwares state
    this.activeCameraId = '';
    this.activeMicId = '';
    this.cameraStream = null;
    this.micStream = null;

    // MediaRecorder AV capture state
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.recordedTakes = []; // Array of { id, url, size, date }
    this.recordingStartTime = 0;
    this.recordingDurationInterval = null;
    this.isRecording = false;

    // Countdown and AudioContext
    this.audioContext = null;
    this.analyser = null;
    this.micMonitorActive = false;
    this.countdownTimer = null;

    // DOM Elements
    this.countdownOverlay = document.getElementById('countdown-overlay');
    this.countdownNum = document.getElementById('countdown-number');
    this.countdownRing = document.getElementById('countdown-active-ring');

    this.onTakeRecorded = null; // Callback when a new take is finished
  }

  // 1. Discover devices
  async getDevices() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const cameras = devices.filter(d => d.kind === 'videoinput');
      const microphones = devices.filter(d => d.kind === 'audioinput');
      return { cameras, microphones };
    } catch (e) {
      console.error('Error listing hardware devices:', e);
      return { cameras: [], microphones: [] };
    }
  }

  // 2. Start hardware webcam streams
  async startWebcam(cameraId = '') {
    // Stop existing camera track if active
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(track => track.stop());
    }

    const constraints = {
      video: cameraId ? { 
        deviceId: { exact: cameraId },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        aspectRatio: { ideal: 1.777777778 }
      } : {
        facingMode: "user",
        width: { ideal: 1280 },
        height: { ideal: 720 },
        aspectRatio: { ideal: 1.777777778 }
      },
      audio: false // Handled separately for recording
    };

    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.video.srcObject = this.cameraStream;
      
      // Explicitly play the video element to guarantee frames flow and readyState is satisfied across all browsers (especially Safari/Chrome on macOS)
      try {
        await this.video.play();
      } catch (playErr) {
        console.warn('Webcam play deferred or failed:', playErr);
      }
      
      this.activeCameraId = cameraId;
      
      const badge = document.getElementById('camera-badge');
      if (badge) {
        badge.classList.add('active');
        badge.innerHTML = `<span class="dot"></span> Camera: Active`;
      }
      return true;
    } catch (err) {
      console.error('Failed to access camera device:', err);
      return false;
    }
  }

  // 3. Microphone streaming and level monitoring
  async startMicrophone(micId = '') {
    if (this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop());
      this.stopMicMonitor();
    }

    const constraints = {
      audio: micId ? { deviceId: { exact: micId } } : true
    };

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.activeMicId = micId;
      this.startMicMonitor();
      return true;
    } catch (err) {
      console.error('Failed to access microphone device:', err);
      return false;
    }
  }

  // Web Audio levels visual feedback
  startMicMonitor() {
    if (!this.micStream) return;

    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(this.micStream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 256;
      source.connect(this.analyser);
      
      this.micMonitorActive = true;
      this.drawMicLevel();
    } catch (e) {
      console.log('Web Audio Context initialize deferred or failed:', e);
    }
  }

  stopMicMonitor() {
    this.micMonitorActive = false;
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    const indicator = document.getElementById('mic-level-indicator');
    if (indicator) indicator.style.width = '0%';
  }

  drawMicLevel() {
    if (!this.micMonitorActive || !this.analyser) return;

    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(dataArray);

    // Calculate volume sum
    let total = 0;
    for (let i = 0; i < dataArray.length; i++) {
      total += dataArray[i];
    }
    const average = total / dataArray.length;
    // Map scale to percentage width (gain booster)
    const percentage = Math.min(100, Math.round((average / 128) * 100));

    const indicator = document.getElementById('mic-level-indicator');
    if (indicator) {
      indicator.style.width = `${percentage}%`;
    }

    requestAnimationFrame(() => this.drawMicLevel());
  }

  // 4. Pre-Roll countdown utility
  triggerPreRoll(seconds, onFinishedCallback) {
    if (seconds <= 0) {
      onFinishedCallback();
      return;
    }

    this.countdownOverlay.style.display = 'flex';
    let count = seconds;
    this.countdownNum.textContent = count;
    
    // Reset SVG radial circle dash offsets
    this.countdownRing.style.strokeDashoffset = '0';

    const interval = 1000;
    const dashLength = 283; // 2 * PI * r (45)

    this.countdownTimer = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(this.countdownTimer);
        this.countdownOverlay.style.display = 'none';
        onFinishedCallback();
      } else {
        this.countdownNum.textContent = count;
        // Animates radial countdown track shrink
        const percent = count / seconds;
        const offset = dashLength * (1 - percent);
        this.countdownRing.style.strokeDashoffset = offset;
      }
    }, interval);
  }

  // 5. Canvas Isolated Record start
  startRecording() {
    if (this.isRecording) return;
    
    this.recordedChunks = [];
    
    // Capture canvas isolated compositor frames (excluding teleprompter DOM layers)
    const canvasStream = this.canvas.captureStream(60); // 60fps stream
    
    // hard-lock camera frames with microphone tracks into a synchronized stream
    const combinedTracks = [];
    canvasStream.getVideoTracks().forEach(t => combinedTracks.push(t));

    if (this.micStream) {
      this.micStream.getAudioTracks().forEach(t => combinedTracks.push(t));
    }

    const outputStream = new MediaStream(combinedTracks);

    // MediaRecorder mime types matching - supports WebM on Chrome/Firefox and native MP4 on iOS/Safari
    let options = {};
    
    // Check Chrome / Firefox vs Safari compatibility to avoid encoder starvation/crash (e.g. Chrome lacking AAC encoder)
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const candidateTypes = [];
    
    if (isSafari) {
      candidateTypes.push(
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4;codecs=avc1',
        'video/mp4'
      );
    } else {
      // Chrome/Firefox supports H.264 with Opus in an MP4 container stably
      candidateTypes.push(
        'video/mp4;codecs=avc1,opus',
        'video/mp4;codecs=h264,opus',
        'video/mp4;codecs=avc1',
        'video/mp4'
      );
    }
    
    // WebM fallbacks
    candidateTypes.push(
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    );
    
    for (const type of candidateTypes) {
      if (MediaRecorder.isTypeSupported(type)) {
        options = { mimeType: type };
        break;
      }
    }

    try {
      this.mediaRecorder = new MediaRecorder(outputStream, options);
    } catch (e) {
      console.warn('Failed to build complex media recorder, falling back to browser default container:', e);
      this.mediaRecorder = new MediaRecorder(outputStream);
    }

    this.mediaRecorder.onerror = (e) => {
      console.error('MediaRecorder error during capture:', e);
    };

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        this.recordedChunks.push(e.data);
      }
    };

    this.mediaRecorder.onstop = () => {
      this.processExportedBlob();
    };

    // Begin Recording
    this.mediaRecorder.start();
    this.isRecording = true;
    this.recordingStartTime = performance.now();

    // Adjust badge layouts
    const recBadge = document.getElementById('rec-badge');
    if (recBadge) recBadge.style.display = 'flex';
  }

  stopRecording() {
    if (!this.isRecording) return;
    
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch (err) {
        console.error('Error stopping MediaRecorder:', err);
      }
    }
    
    this.isRecording = false;

    const recBadge = document.getElementById('rec-badge');
    if (recBadge) recBadge.style.display = 'none';
  }

  // File blob processor
  processExportedBlob() {
    const type = this.mediaRecorder?.mimeType || 'video/webm';
    const blob = new Blob(this.recordedChunks, { type: type });
    const videoUrl = URL.createObjectURL(blob);
    const sizeMB = (blob.size / (1024 * 1024)).toFixed(2);
    const ext = type.includes('mp4') ? 'mp4' : 'webm';
    
    const take = {
      id: `Take_${Date.now()}`,
      url: videoUrl,
      size: `${sizeMB} MB`,
      date: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      ext: ext
    };

    this.recordedTakes.unshift(take); // Push to list

    if (this.onTakeRecorded) {
      this.onTakeRecorded(take);
    }
  }

  deleteTake(id) {
    this.recordedTakes = this.recordedTakes.filter(t => t.id !== id);
  }
}
