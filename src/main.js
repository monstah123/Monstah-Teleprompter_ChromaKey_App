import './style.css';
import { WebGLCompositor } from './compositor.js';
import { TeleprompterEngine } from './teleprompter.js';
import { SystemCaptureControl } from './recorder.js';
import { SpeechScrollTracker } from './speech.js';
import { HUDCalibration } from './hud.js';
import { polishScriptWithGemini } from './ai.js';

// Core Application Objects
let compositor;
let teleprompter;
let recorder;
let speechTracker;
let hud;

// Portrait default zoom — fraction of canvas HEIGHT that the webcam occupies.
// 0.75 = person fills 75% of height, background visible in remaining 25%.
// Exposed at module level so adjustCanvasResolution() can apply it on format change.
const PORTRAIT_ZOOM = 0.85;
let _applyZoom = null; // set by initChromaKeyStudio once UI elements exist

// Document Load Init
window.addEventListener('DOMContentLoaded', async () => {
  // 1. Grab DOM Elements
  const canvas = document.getElementById('compositor-canvas');
  const webcam = document.getElementById('webcam-input');
  const bgVideo = document.getElementById('bg-video');

  const card = document.getElementById('teleprompter-card');
  const cardHeader = document.getElementById('teleprompter-drag-header');
  const scrollView = document.getElementById('teleprompter-scroll-view');
  const textContent = document.getElementById('teleprompter-text-content');

  const overlay = document.getElementById('hud-overlay');
  const hudSvg = document.getElementById('hud-vectors');
  const lensTarget = document.getElementById('lens-target');

  // 2. Instantiate Main Controllers
  compositor = new WebGLCompositor(canvas, webcam, bgVideo);
  teleprompter = new TeleprompterEngine(card, cardHeader, scrollView, textContent);
  recorder = new SystemCaptureControl(canvas, webcam);
  speechTracker = new SpeechScrollTracker(teleprompter);
  hud = new HUDCalibration(overlay, hudSvg, lensTarget);

  // 3. Match resolutions and start rendering
  adjustCanvasResolution();
  compositor.startRenderLoop();

  // 4. Initialize Subsystems & Bindings
  initAppNavigation();
  initDeviceManagement();
  initTeleprompterSync();
  initChromaKeyStudio();
  initRecorderControls();
  initGeminiAssistant();

  // Load Lucide Icons
  lucide.createIcons();


});

// Parse the combined format select value (e.g. "1280x720:16:9") into
// canvas dimensions and portrait/landscape mode, then apply everything.
function adjustCanvasResolution() {
  const formatVal = document.getElementById('recording-format')?.value || '1280x720:16:9';
  // Value format: "WxH:AR" e.g. "1080x1920:9:16"
  const parts = formatVal.split(':');
  const [w, h] = parts[0].split('x').map(Number);
  const isVertical = parts[1] === '9' && parts[2] === '16'; // "9:16" → parts[1]=9, parts[2]=16

  if (compositor && compositor.canvas) {
    compositor.canvas.width = w;
    compositor.canvas.height = h;
  }

  // Synchronize dynamic preview container aspect-ratio
  const container = document.getElementById('monitor-container');
  const workspace = container?.closest('.monitor-workspace');
  if (container) {
    container.style.aspectRatio = `${w}/${h}`;
    container.classList.toggle('portrait', isVertical);
  }
  if (workspace) {
    workspace.classList.toggle('portrait-mode', isVertical);
  }

  // Toggle Reels Safe Zone controller row visibility based on active orientation
  const safeZoneRow = document.getElementById('reels-safe-zone-row');
  if (safeZoneRow) {
    safeZoneRow.style.display = isVertical ? 'flex' : 'none';
    if (!isVertical) {
      // Force disable safe zones if switching back to landscape
      const toggle = document.getElementById('reels-safe-zone-toggle');
      if (toggle) toggle.checked = false;
      const overlay = document.getElementById('hud-safe-zones');
      if (overlay) overlay.style.display = 'none';
    }
  }

  // When switching to portrait, force-apply the default portrait framing zoom
  // immediately so the compositor renders the correct framing without waiting
  // for the user to interact with any slider.
  if (isVertical && _applyZoom) {
    _applyZoom(PORTRAIT_ZOOM);
  } else if (isVertical && compositor) {
    // Fallback before initChromaKeyStudio runs
    compositor.setCameraZoom(PORTRAIT_ZOOM);
  }

  return { w, h, isVertical };
}

window.addEventListener('resize', () => {
  // Keep dimensions standard
});

// 1. Sidebar Tab Panel Selection UI
function initAppNavigation() {
  const tabs = document.querySelectorAll('.tab-btn');
  const panels = document.querySelectorAll('.sidebar-tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));

      tab.classList.add('active');
      const targetPanel = document.getElementById(tab.dataset.tab);
      if (targetPanel) targetPanel.classList.add('active');
    });
  });

  // Chroma key Sub-tabs switching
  const subtabs = document.querySelectorAll('.btn-subtab');
  subtabs.forEach(subtab => {
    subtab.addEventListener('click', () => {
      subtabs.forEach(s => s.classList.remove('active'));
      subtab.classList.add('active');

      const activeId = subtab.dataset.subtab;
      document.getElementById('preloaded-tab').style.display = activeId === 'preloaded-tab' ? 'block' : 'none';
      document.getElementById('custom-tab').style.display = activeId === 'custom-tab' ? 'block' : 'none';
    });
  });
}

// 2. Hardware camera and mic controls discovery
async function initDeviceManagement() {
  const camSelect = document.getElementById('video-device-select');
  const micSelect = document.getElementById('audio-device-select');

  // Load hardware options
  const { cameras, microphones } = await recorder.getDevices();

  // Populate Cams select
  camSelect.innerHTML = '';
  if (cameras.length === 0) {
    camSelect.innerHTML = '<option value="">No Camera Found</option>';
  } else {
    cameras.forEach(cam => {
      const opt = document.createElement('option');
      opt.value = cam.deviceId;
      opt.textContent = cam.label || `Camera ${camSelect.length + 1}`;
      camSelect.appendChild(opt);
    });
  }

  // Populate Microphone select
  micSelect.innerHTML = '';
  if (microphones.length === 0) {
    micSelect.innerHTML = '<option value="">No Microphone Found</option>';
  } else {
    microphones.forEach(mic => {
      const opt = document.createElement('option');
      opt.value = mic.deviceId;
      opt.textContent = mic.label || `Microphone ${micSelect.length + 1}`;
      micSelect.appendChild(opt);
    });
  }

  // Camera event selection
  camSelect.addEventListener('change', () => {
    recorder.startWebcam(camSelect.value);
  });

  // Microphone event selection
  micSelect.addEventListener('change', () => {
    recorder.startMicrophone(micSelect.value);
  });


  // Combined Format & Resolution change handler
  // The value encodes everything: "1280x720:16:9" -> width, height, portrait flag
  const formatSelect = document.getElementById('recording-format');
  if (formatSelect) {
    formatSelect.addEventListener('change', () => {
      const { isVertical } = adjustCanvasResolution();

      // Restart webcam with correct orientation constraints for iOS
      const activeCamId = document.getElementById('video-device-select').value;
      recorder.startWebcam(activeCamId, isVertical);
    });
  }

  // Aspect ratio change selection — kept for legacy compatibility but
  // new UI uses #recording-format which handles both at once
  const aspectSelect = document.getElementById('aspect-ratio-select');
  if (aspectSelect) {
    aspectSelect.addEventListener('change', () => {
      const isVertical = aspectSelect.value === '9:16';
      const monitorContainer = document.getElementById('monitor-container');
      if (monitorContainer) {
        monitorContainer.classList.toggle('portrait', isVertical);
      }
    });
  }

  // Auto trigger default devices immediately for rapid feedback
  if (cameras.length > 0) {
    await recorder.startWebcam(cameras[0].deviceId);
  }
  if (microphones.length > 0) {
    await recorder.startMicrophone(microphones[0].deviceId);
  }
}

// 3. Teleprompter Controls Synchronizer
function initTeleprompterSync() {
  const editor = document.getElementById('script-editor');
  const prompterPlayBtn = document.getElementById('btn-prompter-toggle');
  const prompterRewBtn = document.getElementById('btn-prompter-rewind');
  const playIcon = document.getElementById('quick-play-icon');

  const cardPlayBtn = document.getElementById('card-play-btn');
  const cardRewBtn = document.getElementById('card-rewind-btn');

  const speedSlider = document.getElementById('prompter-speed');
  const speedVal = document.getElementById('prompter-speed-val');
  const quickSpeed = document.getElementById('quick-speed-slider');
  const quickSpeedVal = document.getElementById('quick-speed-val');

  const sizeSlider = document.getElementById('font-scale');
  const sizeVal = document.getElementById('font-scale-val');
  const cardFontDecBtn = document.getElementById('card-font-dec-btn');
  const cardFontIncBtn = document.getElementById('card-font-inc-btn');

  const opacitySlider = document.getElementById('card-opacity');
  const opacityVal = document.getElementById('card-opacity-val');

  const paddingSlider = document.getElementById('card-padding');
  const paddingVal = document.getElementById('card-padding-val');

  const fontSelect = document.getElementById('prompter-font-family');
  const alignSelect = document.getElementById('prompter-align');
  
  const eyelineCheckbox = document.getElementById('lock-eyeline-toggle');
  const cardPinBtn = document.getElementById('lock-top-btn');

  const voiceScrollCheckbox = document.getElementById('voice-tracking-toggle');
  const clearScriptBtn = document.getElementById('btn-clear-script');
  const fileUploader = document.getElementById('file-uploader');

  const scrollModeToggle = document.getElementById('scroll-mode-toggle');
  const cardModeToggleBtn = document.getElementById('card-mode-toggle-btn');

  // Input editing synchronization
  editor.addEventListener('input', () => {
    teleprompter.setScriptText(editor.value);
  });

  // Synced clear
  clearScriptBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear the current script?')) {
      editor.value = '';
      teleprompter.setScriptText('');
    }
  });

  // File Upload parsing (.txt / .docx)
  fileUploader.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'docx') {
      reader.onload = (event) => {
        const arrayBuffer = event.target.result;
        teleprompter.importDocx(arrayBuffer, (text) => {
          editor.value = text;
        });
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = (event) => {
        const text = event.target.value || event.target.result;
        teleprompter.importTxt(text);
        editor.value = text;
      };
      reader.readAsText(file);
    }
  });

  // Play Pause synchronization
  const triggerPlayState = (playing) => {
    if (playing) {
      if (prompterPlayBtn) prompterPlayBtn.innerHTML = `<i data-lucide="pause"></i>`;
      if (cardPlayBtn) cardPlayBtn.innerHTML = `<i data-lucide="pause"></i>`;
    } else {
      if (prompterPlayBtn) prompterPlayBtn.innerHTML = `<i data-lucide="play"></i>`;
      if (cardPlayBtn) cardPlayBtn.innerHTML = `<i data-lucide="play"></i>`;
    }
    lucide.createIcons();
  };

  teleprompter.onPlayStateChange = triggerPlayState;

  prompterPlayBtn.addEventListener('click', () => teleprompter.togglePlay());
  cardPlayBtn.addEventListener('click', () => teleprompter.togglePlay());
  
  prompterRewBtn.addEventListener('click', () => teleprompter.resetScroll());
  cardRewBtn.addEventListener('click', () => teleprompter.resetScroll());

  // Listen to keyboard spacebar to toggle script pause/play rapidly
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && document.activeElement !== editor && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      teleprompter.togglePlay();
    }
  });

  // Scroll Speed matching inputs
  speedSlider.addEventListener('input', () => {
    const wpm = parseInt(speedSlider.value, 10);
    teleprompter.setSpeed(wpm);
    speedVal.textContent = `${wpm} WPM`;
    
    quickSpeed.value = wpm;
    quickSpeedVal.textContent = `${wpm} WPM`;
  });

  quickSpeed.addEventListener('input', () => {
    const wpm = parseInt(quickSpeed.value, 10);
    teleprompter.setSpeed(wpm);
    speedSlider.value = wpm;
    speedVal.textContent = `${wpm} WPM`;
    quickSpeedVal.textContent = `${wpm} WPM`;
  });

  // Style slider and card font size controls
  const FONT_MIN = 12, FONT_MAX = 72, FONT_STEP = 2;
  function applyFontSize(val) {
    val = Math.max(FONT_MIN, Math.min(FONT_MAX, parseInt(val, 10)));
    teleprompter.setFontSize(val);
    if (sizeSlider) sizeSlider.value = val;
    if (sizeVal)    sizeVal.textContent = `${val}px`;
  }

  if (sizeSlider) {
    sizeSlider.addEventListener('input', () => applyFontSize(parseInt(sizeSlider.value, 10)));
  }
  if (cardFontDecBtn) {
    cardFontDecBtn.addEventListener('click', () => applyFontSize(teleprompter.fontSize - FONT_STEP));
  }
  if (cardFontIncBtn) {
    cardFontIncBtn.addEventListener('click', () => applyFontSize(teleprompter.fontSize + FONT_STEP));
  }
  
  // Set default initial font size
  applyFontSize(22);

  opacitySlider.addEventListener('input', () => {
    const val = opacitySlider.value;
    teleprompter.setBackdropOpacity(val);
    opacityVal.textContent = `${val}%`;
  });

  paddingSlider.addEventListener('input', () => {
    const val = paddingSlider.value;
    teleprompter.setPadding(val);
    paddingVal.textContent = `${val}px`;
  });

  fontSelect.addEventListener('change', () => {
    teleprompter.setFontFamily(fontSelect.value);
  });

  alignSelect.addEventListener('change', () => {
    teleprompter.setTextAlignment(alignSelect.value);
  });

  // Eyeline Center Top Lock bindings
  const toggleEyelineLock = (locked) => {
    eyelineCheckbox.checked = locked;
    teleprompter.setLockedTop(locked);
  };

  eyelineCheckbox.addEventListener('change', () => toggleEyelineLock(eyelineCheckbox.checked));
  cardPinBtn.addEventListener('click', () => toggleEyelineLock(!teleprompter.isLockedTop));

  // Voice tracking ASR bindings
  voiceScrollCheckbox.addEventListener('change', () => {
    if (voiceScrollCheckbox.checked) {
      speechTracker.start();
      prompterPlayBtn.disabled = true;
      cardPlayBtn.disabled = true;
    } else {
      speechTracker.stop();
      prompterPlayBtn.disabled = false;
      cardPlayBtn.disabled = false;
    }
  });

  // Scroll Mode toggle synchronization
  if (scrollModeToggle) {
    scrollModeToggle.addEventListener('change', () => {
      teleprompter.setScrollMode(scrollModeToggle.checked ? 'manual' : 'auto');
    });
  }

  if (cardModeToggleBtn) {
    cardModeToggleBtn.addEventListener('click', () => {
      teleprompter.setScrollMode(teleprompter.scrollMode === 'manual' ? 'auto' : 'manual');
    });
  }
}

// 4. Chroma Key / WebGL Studio Configurations
function initChromaKeyStudio() {
  const toggle = document.getElementById('chroma-key-toggle');
  const colorPicker = document.getElementById('chroma-color-picker');
  const eyedropperBtn = document.getElementById('btn-eyedropper');
  
  const simSlider = document.getElementById('chroma-similarity');
  const simVal = document.getElementById('chroma-similarity-val');
  
  const smoothSlider = document.getElementById('chroma-smoothness');
  const smoothVal = document.getElementById('chroma-smoothness-val');

  const bgImageUploader = document.getElementById('bg-image-uploader');
  const bgVideoUploader = document.getElementById('bg-video-uploader');
  const preloadedContainer = document.getElementById('preloaded-backgrounds');

  const hudToggle = document.getElementById('hud-guidelines-toggle');

  // Chroma configurations
  toggle.addEventListener('change', () => {
    compositor.setChromaEnabled(toggle.checked);
  });

  colorPicker.addEventListener('input', () => {
    compositor.setKeyColor(colorPicker.value);
  });

  // Eyedropper sampling activator
  eyedropperBtn.addEventListener('click', () => {
    compositor.enableEyedropper((hexColor) => {
      colorPicker.value = hexColor;
      compositor.setKeyColor(hexColor);
    });
  });

  simSlider.addEventListener('input', () => {
    const val = parseFloat(simSlider.value);
    compositor.setSimilarity(val);
    simVal.textContent = val.toFixed(2);
  });

  smoothSlider.addEventListener('input', () => {
    const val = parseFloat(smoothSlider.value);
    compositor.setSmoothness(val);
    smoothVal.textContent = val.toFixed(2);
  });

  // Drag calibration HUD toggling
  hudToggle.addEventListener('change', () => {
    hud.setVisible(hudToggle.checked);
  });

  // Load preset premium studio templates (gradients & office grids)
  const presets = [
    { name: 'Warm Gradient', type: 'gradient', color: '#ff7e5f', style: 'linear-gradient(135deg, #2b1055, #7597de)' },
    { name: 'Cyberpunk Orb', type: 'gradient', color: '#0f2027', style: 'linear-gradient(135deg, #0f2027, #203a43, #2c5364)' },
    { name: 'Virtual Newsroom', type: 'image', url: 'https://images.unsplash.com/photo-1486406146926-c627a92ad1ab?auto=format&fit=crop&w=640&q=80' },
    { name: 'Modern Office Loft', type: 'image', url: 'https://images.unsplash.com/photo-1497366216548-37526070297c?auto=format&fit=crop&w=640&q=80' }
  ];

  presets.forEach((preset, index) => {
    const card = document.createElement('div');
    card.className = `asset-card ${index === 0 ? 'active' : ''}`;
    card.innerHTML = `<span class="asset-card-label">${preset.name}</span>`;

    if (preset.type === 'gradient') {
      const visualPreview = document.createElement('div');
      visualPreview.className = 'asset-card-preview';
      visualPreview.style.background = preset.style;
      visualPreview.style.width = '100%';
      visualPreview.style.height = '100%';
      card.appendChild(visualPreview);
    } else {
      const img = document.createElement('img');
      img.className = 'asset-card-preview';
      img.src = preset.url;
      card.appendChild(img);
    }

    card.addEventListener('click', () => {
      // Deactivate siblings
      preloadedContainer.querySelectorAll('.asset-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');

      if (preset.type === 'gradient') {
        // Draw CSS linear gradient onto a temporary 2D canvas and bind to WebGL texture!
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 256;
        tempCanvas.height = 256;
        const ctx = tempCanvas.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 256, 256);
        // Extract gradient colors for canvas mapping
        if (index === 0) {
          grad.addColorStop(0, '#2b1055');
          grad.addColorStop(1, '#7597de');
        } else {
          grad.addColorStop(0, '#0f2027');
          grad.addColorStop(1, '#2c5364');
        }
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 256, 256);
        compositor.bgType = 'image';
        compositor.bgImage = tempCanvas;
        compositor.bgImageLoaded = true;
        compositor.updateBackgroundTexture();
      } else {
        compositor.setBackgroundImage(preset.url);
      }
    });

    preloadedContainer.appendChild(card);
  });

  // Custom static asset selectors
  bgImageUploader.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    compositor.setBackgroundImage(url);
    
    // Remove presets active states
    preloadedContainer.querySelectorAll('.asset-card').forEach(c => c.classList.remove('active'));
  });

  bgVideoUploader.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    compositor.setBackgroundVideo(url);
    
    // Remove presets active states
    preloadedContainer.querySelectorAll('.asset-card').forEach(c => c.classList.remove('active'));
  });

  // ── Unified zoom handler — keeps pill, sidebar slider, and compositor in sync ──
  const zoomSlider   = document.getElementById('camera-zoom');
  const zoomVal      = document.getElementById('camera-zoom-val');
  const pillSlider   = document.getElementById('zoom-pill-slider');
  const pillLabel    = document.getElementById('zoom-pill-label');
  const zoomInBtn    = document.getElementById('zoom-in-btn');
  const zoomOutBtn   = document.getElementById('zoom-out-btn');
  const ZOOM_MIN = 0.2, ZOOM_MAX = 1.5, ZOOM_STEP = 0.05;

  function applyZoom(val) {
    val = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, parseFloat(val.toFixed(2))));
    compositor.setCameraZoom(val);
    if (zoomSlider) zoomSlider.value = val;
    if (zoomVal)    zoomVal.textContent = `${val.toFixed(2)}x`;
    if (pillSlider) pillSlider.value = val;
    if (pillLabel)  pillLabel.textContent = `${val.toFixed(2)}×`;
  }

  if (zoomSlider) zoomSlider.addEventListener('input', () => applyZoom(parseFloat(zoomSlider.value)));
  if (pillSlider) pillSlider.addEventListener('input', () => applyZoom(parseFloat(pillSlider.value)));
  if (zoomInBtn)  zoomInBtn.addEventListener('click',  () => applyZoom(compositor.cameraZoom + ZOOM_STEP));
  if (zoomOutBtn) zoomOutBtn.addEventListener('click',  () => applyZoom(compositor.cameraZoom - ZOOM_STEP));

  // Expose applyZoom at module level so format-change handler can call it,
  // then immediately force-apply the portrait zoom on startup.
  _applyZoom = applyZoom;
  applyZoom(PORTRAIT_ZOOM); // ← THIS is the missing call that was never happening on load

  // Reels Safe Zone HUD Guidelines toggle listener
  const safeZoneToggle = document.getElementById('reels-safe-zone-toggle');
  const safeZoneOverlay = document.getElementById('hud-safe-zones');
  if (safeZoneToggle && safeZoneOverlay) {
    safeZoneToggle.addEventListener('change', () => {
      const show = safeZoneToggle.checked;
      safeZoneOverlay.style.display = show ? 'block' : 'none';
      if (show) {
        // Automatically make sure calibration HUD is visible too
        const hudToggle = document.getElementById('hud-guidelines-toggle');
        if (hudToggle && !hudToggle.checked) {
          hudToggle.checked = true;
          hud.setVisible(true);
        }
      }
    });
  }

  // Activate default background gradient
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 256;
  tempCanvas.height = 256;
  const ctx = tempCanvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, 256, 256);
  grad.addColorStop(0, '#2b1055');
  grad.addColorStop(1, '#7597de');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 256, 256);
  compositor.bgType = 'image';
  compositor.bgImage = tempCanvas;
  compositor.bgImageLoaded = true;
  compositor.updateBackgroundTexture();
}

// 5. System Capture Control and Recording
function initRecorderControls() {
  const btnRecMain = document.getElementById('btn-record-main');
  const btnRecMainText = document.getElementById('btn-record-main-text');
  const prerollSelect = document.getElementById('preroll-delay');
  
  const exportModal = document.getElementById('export-modal');
  const closeModalBtn = document.getElementById('btn-close-export');
  const previewPlayer = document.getElementById('export-preview-player');
  const downloadLink = document.getElementById('modal-download-link');
  const discardBtn = document.getElementById('btn-discard-take');
  const takesList = document.getElementById('recorded-takes-list');

  // Toggle record cycle
  const handleRecordCycle = () => {
    if (recorder.isRecording) {
      // Stop Recording safely
      try {
        recorder.stopRecording();
      } catch (err) {
        console.error('Error stopping recording:', err);
      }
      try {
        teleprompter.pause();
      } catch (err) {
        console.error('Error pausing teleprompter:', err);
      }
      
      btnRecMain.classList.remove('recording');
      btnRecMainText.textContent = 'Start Recording';
    } else if (recorder.isPreRolling) {
      // Cancel pre-roll countdown
      recorder.cancelPreRoll();
      btnRecMain.classList.remove('recording');
      btnRecMainText.textContent = 'Start Recording';
    } else {
      // Start Recording with pre-roll timers
      const prerollSec = parseInt(prerollSelect.value, 10);
      
      if (prerollSec > 0) {
        btnRecMainText.textContent = 'Cancel Countdown';
      }
      
      recorder.triggerPreRoll(prerollSec, () => {
        try {
          recorder.startRecording();
        } catch (err) {
          console.error('Error starting recording:', err);
          alert('Failed to start recording. Please check that camera and mic inputs are allowed.');
          btnRecMainText.textContent = 'Start Recording';
          return;
        }
        
        teleprompter.resetScroll();
        
        // Wait 500ms after recording begins to start autoscroll for natural pre-talk frame captures
        setTimeout(() => {
          if (recorder.isRecording && teleprompter.scrollMode === 'auto') {
            try {
              teleprompter.play();
            } catch (err) {
              console.error('Error playing teleprompter:', err);
            }
          }
        }, 500);

        btnRecMain.classList.add('recording');
        btnRecMainText.textContent = 'STOP RECORDING';
      });
    }
  };

  btnRecMain.addEventListener('click', handleRecordCycle);

  // Take Captured trigger
  recorder.onTakeRecorded = (take) => {
    // Release active audio capture focus so phone speakers can playback at full volume
    recorder.suspendAudioCapture();

    // 1. Show modal preview
    previewPlayer.src = take.url;
    downloadLink.href = take.url;
    const ext = take.ext || 'webm';
    downloadLink.setAttribute('download', `${take.id}.${ext}`);
    downloadLink.innerHTML = `<i data-lucide="download"></i> Download Composited Video (.${ext})`;
    lucide.createIcons();
    
    exportModal.style.display = 'flex';

    // 2. Refresh recorded takes list
    refreshTakesListUI();
  };

  // Close modals
  closeModalBtn.addEventListener('click', () => {
    exportModal.style.display = 'none';
    previewPlayer.src = '';
    recorder.resumeAudioCapture();
  });

  discardBtn.addEventListener('click', () => {
    if (recorder.recordedTakes.length > 0) {
      const takeId = recorder.recordedTakes[0].id;
      recorder.deleteTake(takeId);
      refreshTakesListUI();
    }
    exportModal.style.display = 'none';
    previewPlayer.src = '';
    recorder.resumeAudioCapture();
  });

  function refreshTakesListUI() {
    takesList.innerHTML = '';
    
    if (recorder.recordedTakes.length === 0) {
      takesList.innerHTML = `<div class="empty-takes-tip">No recordings captured in this session. Recorded takes will appear here for playback and download.</div>`;
      return;
    }

    recorder.recordedTakes.forEach(take => {
      const row = document.createElement('div');
      row.className = 'take-item-row';
      const ext = take.ext || 'webm';
      row.innerHTML = `
        <div class="take-info">
          <span class="take-name">${take.id}</span>
          <span class="take-size">${take.date} • ${take.size}</span>
        </div>
        <div class="take-actions">
          <a href="${take.url}" download="${take.id}.${ext}" class="take-action-btn" title="Download Take">
            <i data-lucide="download"></i>
          </a>
          <button class="take-action-btn take-action-btn-delete" data-id="${take.id}" title="Delete Take">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      `;

      // delete track button
      row.querySelector('.take-action-btn-delete').addEventListener('click', (e) => {
        if (confirm('Delete this recorded take?')) {
          recorder.deleteTake(take.id);
          refreshTakesListUI();
        }
      });

      takesList.appendChild(row);
    });

    lucide.createIcons();
  }
}

// 6. Google Gemini AI integration panel script polishing
function initGeminiAssistant() {
  const toneSelect = document.getElementById('ai-polish-tone');
  const polishBtn = document.getElementById('btn-ai-polish');
  const editor = document.getElementById('script-editor');

  // Call Gemini REST polisher
  polishBtn.addEventListener('click', async () => {
    const key = import.meta.env.VITE_GEMINI_API_KEY || localStorage.getItem('monstah_gemini_key') || '';
    const script = editor.value.trim();
    const tone = toneSelect.value;

    if (!key) {
      alert('Google Gemini API Key is missing! Please configure VITE_GEMINI_API_KEY in your .env.local file or Vercel environment variables.');
      return;
    }

    polishBtn.disabled = true;
    polishBtn.innerHTML = `<i data-lucide="loader" class="pulse"></i> Translating via AI...`;
    lucide.createIcons();

    try {
      const polished = await polishScriptWithGemini(key, script, tone);
      editor.value = polished;
      teleprompter.setScriptText(polished);
      alert('Your teleprompter script has been successfully polished by Gemini!');
    } catch (err) {
      alert(`Script Polisher Failed:\n${err.message}`);
    } finally {
      polishBtn.disabled = false;
      polishBtn.innerHTML = `<i data-lucide="wand-2"></i> Polish Script`;
      lucide.createIcons();
    }
  });
}
