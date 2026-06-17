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
    this.micLevelLastDraw = 0; // Timestamp used to throttle mic level draw rate
    this.countdownTimer = null;
    this.isPreRolling = false;

    // Detect older/mobile hardware to apply performance-friendly settings
    this.isMobileDevice = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

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
  async startWebcam(cameraId = '', portrait = false) {
    // Stop existing camera track if active
    if (this.cameraStream) {
      this.cameraStream.getTracks().forEach(track => track.stop());
    }

    // Request portrait-oriented dimensions on desktop, but on mobile devices (like iOS)
    // request simplified constraints so the system returns the native wide-angle portrait stream
    const vidConstraints = this.isMobileDevice ? (
      cameraId ? { deviceId: { exact: cameraId } } : { facingMode: 'user' }
    ) : (
      cameraId ? {
        deviceId: { exact: cameraId },
        width:  { ideal: portrait ? 720  : 1280 },
        height: { ideal: portrait ? 1280 : 720  },
        aspectRatio: { ideal: portrait ? 0.5625 : 1.777777778 }
      } : {
        facingMode: 'user',
        width:  { ideal: portrait ? 720  : 1280 },
        height: { ideal: portrait ? 1280 : 720  },
        aspectRatio: { ideal: portrait ? 0.5625 : 1.777777778 }
      }
    );

    const constraints = {
      video: vidConstraints,
      audio: false // Handled separately for recording
    };

    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch (err) {
      console.warn('Failed to access camera with preferred constraints, trying fallback:', err);
      try {
        const fallbackConstraints = {
          video: cameraId ? { deviceId: { exact: cameraId } } : { facingMode: 'user' },
          audio: false
        };
        this.cameraStream = await navigator.mediaDevices.getUserMedia(fallbackConstraints);
      } catch (fallbackErr) {
        console.error('Camera fallback failed:', fallbackErr);
        return false;
      }
    }

    try {
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
      console.error('Failed to bind camera stream to video element:', err);
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
      audio: micId ? {
        deviceId: { exact: micId },
        // On mobile (iPhone), enabling iOS audio processing unlocks Apple's
        // built-in gain pipeline, which significantly boosts mic volume.
        // Disabling these was bypassing AGC entirely on iPhone's small mic.
        echoCancellation: this.isMobileDevice,
        noiseSuppression: this.isMobileDevice,
        autoGainControl: true
      } : {
        echoCancellation: this.isMobileDevice,
        noiseSuppression: this.isMobileDevice,
        autoGainControl: true
      }
    };

    try {
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.activeMicId = micId;
      this.startMicMonitor();
      // iOS routes audio output to the earpiece whenever mic capture is active.
      // Playing a silent tone immediately after getUserMedia forces iOS Safari
      // to use the loud speaker route instead of the earpiece.
      this.forceSpeakerOutput();
      return true;
    } catch (err) {
      console.error('Failed to access microphone device:', err);
      return false;
    }
  }

  // iOS Audio Routing Fix: play a near-silent tone through the AudioContext
  // destination immediately after mic capture starts. This signals to iOS
  // Safari's AVAudioSession that speaker output is desired, overriding the
  // default earpiece routing that happens when PlayAndRecord mode is active.
  forceSpeakerOutput() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate); // 1 sample of silence
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
      // Close context after a short delay — it has done its job
      setTimeout(() => ctx.close(), 500);
    } catch (e) {
      // Non-critical: silently ignore if this trick isn't supported
      console.log('Speaker output unlock skipped:', e);
    }
  }

  // Web Audio levels visual feedback
  startMicMonitor() {
    if (!this.micStream) return;

    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.audioContext.createMediaStreamSource(this.micStream);
      this.analyser = this.audioContext.createAnalyser();
      // fftSize 32 is more than sufficient for a simple VU level meter
      // and uses ~8x less CPU than the default 256 — critical for older iPhones
      this.analyser.fftSize = 32;
      source.connect(this.analyser);
      
      this.micMonitorActive = true;
      this.micLevelLastDraw = 0;
      this.drawMicLevel();
    } catch (e) {
      console.log('Web Audio Context initialize deferred or failed:', e);
    }
  }

  stopMicMonitor() {
    this.micMonitorActive = false;
    if (this.audioContext) {
      try {
        this.audioContext.close();
      } catch (e) {}
      this.audioContext = null;
    }
    const indicator = document.getElementById('mic-level-indicator');
    if (indicator) indicator.style.width = '0%';
  }

  drawMicLevel() {
    if (!this.micMonitorActive || !this.analyser) return;

    // Throttle mic level redraws to ~10fps on mobile (saves significant CPU on older iPhones)
    // and ~20fps on desktop — a VU meter needs no more than this to feel responsive
    const now = performance.now();
    const targetInterval = this.isMobileDevice ? 100 : 50; // ms between draws
    if (now - this.micLevelLastDraw >= targetInterval) {
      this.micLevelLastDraw = now;

      const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(dataArray);

      // Calculate volume average
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
    }

    requestAnimationFrame(() => this.drawMicLevel());
  }

  suspendAudioCapture() {
    this.stopMicMonitor();
    if (this.micStream) {
      this.micStream.getTracks().forEach(track => track.stop());
      this.micStream = null;
    }
  }

  async resumeAudioCapture() {
    await this.startMicrophone(this.activeMicId);
  }

  // 4. Pre-Roll countdown utility
  triggerPreRoll(seconds, onFinishedCallback) {
    if (seconds <= 0) {
      onFinishedCallback();
      return;
    }

    this.isPreRolling = true;
    this.countdownOverlay.style.display = 'flex';
    let count = seconds;
    this.countdownNum.textContent = count;
    
    // Play tick for the first displayed number immediately
    this.playCountdownTick();
    
    // Reset SVG radial circle dash offsets
    this.countdownRing.style.strokeDashoffset = '0';

    const interval = 1000;
    const dashLength = 283; // 2 * PI * r (45)

    this.countdownTimer = setInterval(() => {
      count--;
      if (count <= 0) {
        clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.isPreRolling = false;
        this.countdownOverlay.style.display = 'none';
        this.playCountdownGo(); // Final "Action!" sound
        onFinishedCallback();
      } else {
        this.countdownNum.textContent = count;
        // Animates radial countdown track shrink
        const percent = count / seconds;
        const offset = dashLength * (1 - percent);
        this.countdownRing.style.strokeDashoffset = offset;
        this.playCountdownTick(); // Tick for each remaining second
      }
    }, interval);
  }

  // Synthesized countdown tick — sharp high-pitched click (880Hz)
  // Each second of the countdown plays this so it feels like a real studio clock
  playCountdownTick() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // High A note — classic countdown tick

      // Sharp attack, very fast decay — makes it feel like a precise clock tick
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 0.005); // 5ms attack
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12); // 120ms decay

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.12);

      osc.onended = () => ctx.close();
    } catch (e) {
      console.log('Countdown tick audio skipped:', e);
    }
  }

  // Synthesized "Go" chord — deeper, richer two-tone sound for the final action beat
  // Uses 440Hz + 660Hz (A4 + E5 perfect fifth) for a satisfying, professional feel
  playCountdownGo() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();

      const playTone = (freq, volume, duration) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, ctx.currentTime);
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + duration);
      };

      playTone(440, 0.5, 0.5);  // A4 — warm base note
      playTone(660, 0.4, 0.5);  // E5 — perfect fifth harmonic

      // Close context after the chord finishes
      setTimeout(() => ctx.close(), 700);
    } catch (e) {
      console.log('Countdown go audio skipped:', e);
    }
  }

  cancelPreRoll() {
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.isPreRolling = false;
    if (this.countdownOverlay) {
      this.countdownOverlay.style.display = 'none';
    }
  }

  // 5. Canvas Isolated Record start
  startRecording() {
    if (this.isRecording) return;
    
    this.recordedChunks = [];
    
    // Capture canvas isolated compositor frames (excluding teleprompter DOM layers)
    // Use 24fps on mobile to reduce encoder pressure on older chips (iPhone X / A11)
    // 30fps is used on desktop where hardware can handle it without thermal throttling
    const captureRate = this.isMobileDevice ? 24 : 30;
    const canvasStream = this.canvas.captureStream(captureRate); // Matches webcam frame rate to reduce CPU encoding load
    
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
        options = { 
          mimeType: type,
          videoBitsPerSecond: 2500000, // 2.5 Mbps is highly optimal for 720p/1080p real-time encoding
          audioBitsPerSecond: 128000   // 128 kbps pristine audio
        };
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
