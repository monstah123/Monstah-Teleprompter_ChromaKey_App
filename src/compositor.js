/**
 * WebGL Live Video Compositor
 * Performs real-time chroma-key extraction on GPU at 60 FPS
 * and blends webcam with customizable static or video backgrounds.
 *
 * Webcam Framing Architecture:
 * The webcam is drawn onto a 2D "framing canvas" at the desired size and
 * position (using cameraZoom + cameraPanY), then uploaded to WebGL as a
 * texture. This bypasses fragile shader-based scale math that behaves
 * differently across iOS/Android cameras (portrait vs landscape pixels).
 */
export class WebGLCompositor {
  constructor(canvasElement, webcamVideoElement, backgroundVideoElement) {
    this.canvas = canvasElement;
    this.video = webcamVideoElement;
    this.bgVideo = backgroundVideoElement;
    this.gl = this.canvas.getContext('webgl', { 
      alpha: true, 
      premultipliedAlpha: false,
      preserveDrawingBuffer: true // Required for eyedropper gl.readPixels
    });

    if (!this.gl) {
      console.error('WebGL is not supported in this browser.');
      return;
    }

    // Default Compositor Parameters
    this.chromaKeyEnabled = true;
    this.keyColor = [0.0, 1.0, 0.0]; // Normal Green [R, G, B] normalized 0-1
    this.similarity = 0.35;
    this.smoothness = 0.15;

    // Framing: cameraZoom = fraction of canvas HEIGHT the webcam fills (0.75 = 75%).
    // cameraPanY = vertical position within remaining space: 0=top, 0.5=center, 1=bottom.
    this.cameraZoom  = 0.48;  // Person fills 48% of canvas height
    this.cameraPanY  = 0.20;  // 20% into the remaining space → ~5% top margin

    // 2D framing canvas — webcam is drawn here at the right scale/position,
    // then uploaded to WebGL. Avoids all shader-based scale complexity.
    this.framingCanvas = document.createElement('canvas');
    this.framingCtx    = this.framingCanvas.getContext('2d');

    // Background State
    this.bgType = 'color'; // 'color', 'image', 'video'
    this.bgSolidColor = [15, 15, 23, 255]; // RGBA
    this.bgImage = null; // HTMLImageElement
    this.bgImageLoaded = false;
    
    // WebGL Resources
    this.program = null;
    this.buffers = {};
    this.textures = {};
    this.uniforms = {}; // Cached uniform locations (avoid per-frame driver lookups)
    this.attribs = {};  // Cached attribute locations
    this.isRendering = false;

    // Eyedropper State
    this.isEyedropperActive = false;
    this.onColorSampledCallback = null;

    this.initWebGL();
    this.setupEyedropper();

    // Dynamically activate the WebGL status badge to show hardware graphics acceleration is active
    const badge = document.getElementById('webgl-badge');
    if (badge) {
      badge.classList.add('active');
    }
  }

  // Set chroma parameters
  setChromaEnabled(enabled) {
    this.chromaKeyEnabled = enabled;
  }

  setKeyColor(hexColor) {
    // Convert Hex (#00ff00) to Normalized RGB
    const r = parseInt(hexColor.slice(1, 3), 16) / 255;
    const g = parseInt(hexColor.slice(3, 5), 16) / 255;
    const b = parseInt(hexColor.slice(5, 7), 16) / 255;
    this.keyColor = [r, g, b];
  }

  setSimilarity(val) {
    this.similarity = val;
  }

  setSmoothness(val) {
    this.smoothness = val;
  }

  setCameraZoom(val) {
    this.cameraZoom = Math.max(0.1, Math.min(2.0, val));
  }

  /**
   * Draw the webcam onto the 2D framing canvas at the desired scale/position.
   * This runs every render frame before uploading to WebGL.
   *
   * cameraZoom  = fraction of canvas HEIGHT the webcam occupies (e.g. 0.75 = 75%)
   * cameraPanY  = where vertically the webcam sits in the remaining space
   *               (0 = pushed to top, 0.5 = centered, 1 = pushed to bottom)
   *
   * Width: the webcam is always centered horizontally. If the video is wider
   * than the canvas (e.g. landscape webcam in portrait canvas), it is cropped
   * symmetrically on the sides — matching TikTok's cover-fill behaviour.
   */
  drawFramedWebcam() {
    const fc  = this.framingCanvas;
    const ctx = this.framingCtx;
    const cw  = this.canvas.width;
    const ch  = this.canvas.height;

    // Keep framing canvas in sync with the main WebGL canvas dimensions
    if (fc.width !== cw || fc.height !== ch) {
      fc.width  = cw;
      fc.height = ch;
    }

    // Always clear first — transparent areas tell WebGL shader to show background
    ctx.clearRect(0, 0, cw, ch);

    if (!this.video || this.video.readyState < this.video.HAVE_CURRENT_DATA) return;
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh) return;

    const canvasAspect = cw / ch;
    const videoAspect  = vw / vh;

    // 1. Crop the source video to match the EXACT aspect ratio of the canvas (e.g. 9:16)
    let srcX = 0, srcY = 0, srcW = vw, srcH = vh;
    if (videoAspect > canvasAspect) {
      // Webcam is wider than canvas (landscape webcam in portrait canvas) -> crop width
      srcW = vh * canvasAspect;
      srcX = (vw - srcW) / 2;
    } else {
      // Webcam is narrower than canvas (portrait webcam in landscape canvas) -> crop height
      srcH = vw / canvasAspect;
      srcY = (vh - srcH) / 2;
    }

    // 2. Scale the destination bounds proportionally based on cameraZoom
    const dstW = cw * this.cameraZoom;
    const dstH = ch * this.cameraZoom;

    // 3. Center horizontally and pan vertically
    const dstX = (cw - dstW) / 2;
    const dstY = (ch - dstH) * this.cameraPanY;

    // 4. Mirror horizontally (natural selfie/teleprompter feel)
    ctx.save();
    ctx.translate(cw, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(this.video, srcX, srcY, srcW, srcH,
                  cw - dstX - dstW, dstY, dstW, dstH);
    ctx.restore();
  }

  // Load custom background image
  setBackgroundImage(url) {
    this.bgType = 'image';
    this.bgImageLoaded = false;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      this.bgImage = img;
      this.bgImageLoaded = true;
      this.updateBackgroundTexture();
    };
    img.src = url;
  }

  // Load custom background video
  setBackgroundVideo(urlOrFile) {
    this.bgType = 'video';
    this.bgVideo.src = urlOrFile;
    this.bgVideo.play().catch(e => console.log('Autoplay blocked or video loading:', e));
  }

  // Solid Color or Gradient helper
  setBackgroundSolidColor(hexColor) {
    this.bgType = 'color';
    const r = parseInt(hexColor.slice(1, 3), 16);
    const g = parseInt(hexColor.slice(3, 5), 16);
    const b = parseInt(hexColor.slice(5, 7), 16);
    this.bgSolidColor = [r, g, b, 255];
  }

  initWebGL() {
    const gl = this.gl;

    // 1. Shaders Definitions
    const vsSource = `
      attribute vec2 aPosition;
      attribute vec2 aTexCoord;
      varying vec2 vTexCoord;
      void main() {
        gl_Position = vec4(aPosition, 0.0, 1.0);
        vTexCoord = aTexCoord;
      }
    `;

    // Chroma-Key Shader — foreground is pre-framed by the 2D canvas;
    // alpha=0 areas in the framing canvas are transparent, shader shows background there.
    const fsSource = `
      precision mediump float;
      varying vec2 vTexCoord;
      
      uniform sampler2D uForegroundTexture;
      uniform sampler2D uBackgroundTexture;
      
      uniform vec3 uKeyColor;
      uniform float uSimilarity;
      uniform float uSmoothness;
      uniform bool uChromaKeyEnabled;
      uniform int uBgType;       // 0=Solid Color, 1=Image Texture, 2=Video Texture
      uniform vec4 uSolidColor;  // Solid background color normalized
      uniform vec2 uBgScale;

      // Convert RGB to YUV for chroma distance (shadows/luminance tolerant)
      vec3 rgb2yuv(vec3 rgb) {
        float y = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
        float u = -0.14713 * rgb.r - 0.28886 * rgb.g + 0.436 * rgb.b;
        float v = 0.615 * rgb.r - 0.51499 * rgb.g - 0.10001 * rgb.b;
        return vec3(y, u, v);
      }

      void main() {
        // 1. Background color (solid or texture)
        vec4 bgColor;
        if (uBgType == 0) {
          bgColor = uSolidColor;
        } else {
          vec2 bgCoord = (vTexCoord - 0.5) * uBgScale + 0.5;
          bgColor = texture2D(uBackgroundTexture, bgCoord);
        }

        // 2. Sample foreground — already framed and mirrored by 2D canvas
        vec4 fgColor = texture2D(uForegroundTexture, vTexCoord);

        // 3. Transparent areas in the 2D framing canvas = show background
        //    (these are the letterbox/pillarbox bands outside the webcam area)
        if (fgColor.a < 0.01) {
          gl_FragColor = bgColor;
          return;
        }

        // 4. Without chroma key: output foreground directly
        if (!uChromaKeyEnabled) {
          gl_FragColor = fgColor;
          return;
        }

        // 5. Chroma Key in YUV space (colour distance, shadow tolerant)
        vec3 fgYuv  = rgb2yuv(fgColor.rgb);
        vec3 keyYuv = rgb2yuv(uKeyColor);
        float chromaDist = distance(fgYuv.yz, keyYuv.yz);
        float mask = smoothstep(uSimilarity, uSimilarity + uSmoothness, chromaDist);
        gl_FragColor = mix(bgColor, fgColor, mask);
      }
    `;

    // 2. Build Shader Program
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);

    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      console.error('Shader linking failed:', gl.getProgramInfoLog(this.program));
      return;
    }

    // 3. Setup Geometry Vertices (Full Viewport Quad)
    const positionData = new Float32Array([
      -1.0, -1.0,   1.0, -1.0,  -1.0,  1.0,
      -1.0,  1.0,   1.0, -1.0,   1.0,  1.0,
    ]);

    const texCoordData = new Float32Array([
       0.0,  1.0,   1.0,  1.0,   0.0,  0.0,
       0.0,  0.0,   1.0,  1.0,   1.0,  0.0,
    ]);

    this.buffers.position = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
    gl.bufferData(gl.ARRAY_BUFFER, positionData, gl.STATIC_DRAW);

    this.buffers.texCoord = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.texCoord);
    gl.bufferData(gl.ARRAY_BUFFER, texCoordData, gl.STATIC_DRAW);

    // 4. Setup Textures
    this.textures.foreground = this.createTexture();
    this.textures.background = this.createTexture();

    // 5. Cache all uniform and attribute locations once after program link.
    gl.useProgram(this.program);
    this.attribs.aPosition  = gl.getAttribLocation(this.program, 'aPosition');
    this.attribs.aTexCoord  = gl.getAttribLocation(this.program, 'aTexCoord');
    this.uniforms.uForegroundTexture = gl.getUniformLocation(this.program, 'uForegroundTexture');
    this.uniforms.uBackgroundTexture = gl.getUniformLocation(this.program, 'uBackgroundTexture');
    this.uniforms.uChromaKeyEnabled  = gl.getUniformLocation(this.program, 'uChromaKeyEnabled');
    this.uniforms.uKeyColor          = gl.getUniformLocation(this.program, 'uKeyColor');
    this.uniforms.uSimilarity        = gl.getUniformLocation(this.program, 'uSimilarity');
    this.uniforms.uSmoothness        = gl.getUniformLocation(this.program, 'uSmoothness');
    this.uniforms.uBgType            = gl.getUniformLocation(this.program, 'uBgType');
    this.uniforms.uSolidColor        = gl.getUniformLocation(this.program, 'uSolidColor');
    this.uniforms.uBgScale           = gl.getUniformLocation(this.program, 'uBgScale');
  }

  compileShader(type, source) {
    const gl = this.gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
      gl.deleteShader(shader);
      return null;
    }
    return shader;
  }

  createTexture() {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return tex;
  }

  updateBackgroundTexture() {
    const gl = this.gl;
    if (this.bgType === 'image' && this.bgImageLoaded && this.bgImage) {
      gl.bindTexture(gl.TEXTURE_2D, this.textures.background);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.bgImage);
    }
  }

  startRenderLoop() {
    if (this.isRendering) return;
    this.isRendering = true;
    this.render();
  }

  stopRenderLoop() {
    this.isRendering = false;
  }

  render() {
    if (!this.isRendering) return;

    const gl = this.gl;
    const u = this.uniforms;
    const a = this.attribs;

    // Set Viewport and Clear
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.useProgram(this.program);

    // Bind Position buffer
    gl.enableVertexAttribArray(a.aPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
    gl.vertexAttribPointer(a.aPosition, 2, gl.FLOAT, false, 0, 0);

    // Bind TexCoord buffer
    gl.enableVertexAttribArray(a.aTexCoord);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.texCoord);
    gl.vertexAttribPointer(a.aTexCoord, 2, gl.FLOAT, false, 0, 0);

    // ── Foreground: draw webcam to 2D framing canvas, then upload to GPU ──────
    // The 2D canvas handles all zoom/pan/crop logic; WebGL just samples it.
    this.drawFramedWebcam();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.foreground);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.framingCanvas);
    gl.uniform1i(u.uForegroundTexture, 0);

    // ── Background Texture ────────────────────────────────────────────────────
    let typeVal = 0;
    if (this.bgType === 'image' && this.bgImageLoaded && this.bgImage) {
      typeVal = 1;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.background);
      gl.uniform1i(u.uBackgroundTexture, 1);
    } else if (this.bgType === 'video' && this.bgVideo.readyState >= this.bgVideo.HAVE_CURRENT_DATA) {
      typeVal = 2;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.textures.background);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.bgVideo);
      gl.uniform1i(u.uBackgroundTexture, 1);
    }

    gl.uniform1i(u.uBgType, typeVal);

    const solidNorm = [
      this.bgSolidColor[0] / 255,
      this.bgSolidColor[1] / 255,
      this.bgSolidColor[2] / 255,
      this.bgSolidColor[3] / 255,
    ];
    gl.uniform4fv(u.uSolidColor, solidNorm);

    // ── Background scale (cover-fill background image/video to canvas) ────────
    let bgScaleX = 1.0, bgScaleY = 1.0;
    if (this.bgType === 'image' && this.bgImage?.width > 0 && this.bgImage?.height > 0) {
      const ca = this.canvas.width / this.canvas.height;
      const ia = this.bgImage.width / this.bgImage.height;
      if (ca > ia) { bgScaleY = ia / ca; } else { bgScaleX = ca / ia; }
    } else if (this.bgType === 'video' && this.bgVideo?.videoWidth > 0 && this.bgVideo?.videoHeight > 0) {
      const ca = this.canvas.width / this.canvas.height;
      const va = this.bgVideo.videoWidth / this.bgVideo.videoHeight;
      if (ca > va) { bgScaleY = va / ca; } else { bgScaleX = ca / va; }
    }
    gl.uniform2f(u.uBgScale, bgScaleX, bgScaleY);

    // ── Chroma uniforms ───────────────────────────────────────────────────────
    gl.uniform1i(u.uChromaKeyEnabled, this.chromaKeyEnabled ? 1 : 0);
    gl.uniform3fv(u.uKeyColor, this.keyColor);
    gl.uniform1f(u.uSimilarity, this.similarity);
    gl.uniform1f(u.uSmoothness, this.smoothness);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    requestAnimationFrame(() => this.render());
  }

  // Setup Eyedropper interactions
  setupEyedropper() {
    const handleSample = (clientX, clientY) => {
      if (!this.isEyedropperActive) return;

      const rect = this.canvas.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * this.canvas.width;
      
      // Canvas pixels coordinate space starts at bottom-left in WebGL, so flip Y axis
      const y = this.canvas.height - (((clientY - rect.top) / rect.height) * this.canvas.height);

      const pixels = new Uint8Array(4);
      this.gl.readPixels(x, y, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);

      // Convert sampled pixel RGB array to Hex
      const rHex = pixels[0].toString(16).padStart(2, '0');
      const gHex = pixels[1].toString(16).padStart(2, '0');
      const bHex = pixels[2].toString(16).padStart(2, '0');
      const hexColor = `#${rHex}${gHex}${bHex}`;

      if (this.onColorSampledCallback) {
        this.onColorSampledCallback(hexColor);
      }

      this.disableEyedropper();
    };

    this.canvas.addEventListener('mousedown', (e) => {
      handleSample(e.clientX, e.clientY);
    });

    // Touch support for mobile canvas tap color selection
    this.canvas.addEventListener('touchstart', (e) => {
      if (this.isEyedropperActive && e.touches.length > 0) {
        const touch = e.touches[0];
        handleSample(touch.clientX, touch.clientY);
        e.preventDefault(); // Prevent standard browser gestures while sampling
      }
    }, { passive: false });
  }

  enableEyedropper(onSampleCallback) {
    this.isEyedropperActive = true;
    this.canvas.style.cursor = 'cell';
    this.onColorSampledCallback = onSampleCallback;

    // Visual pointer HUD element setup
    const pointer = document.getElementById('eyedropper-pointer');
    
    const moveListener = (e) => {
      if (!this.isEyedropperActive) {
        window.removeEventListener('mousemove', moveListener);
        return;
      }
      pointer.style.left = `${e.clientX}px`;
      pointer.style.top = `${e.clientY}px`;
    };

    // Touchmove visual cursor feedback mapping
    const touchMoveListener = (e) => {
      if (!this.isEyedropperActive) {
        window.removeEventListener('touchmove', touchMoveListener);
        return;
      }
      if (e.touches.length > 0) {
        const touch = e.touches[0];
        pointer.style.left = `${touch.clientX}px`;
        pointer.style.top = `${touch.clientY}px`;
      }
    };
    
    pointer.style.display = 'block';
    window.addEventListener('mousemove', moveListener);
    window.addEventListener('touchmove', touchMoveListener, { passive: true });

    // Store listeners so they can be cleaned up cleanly on disable
    this._moveListener = moveListener;
    this._touchMoveListener = touchMoveListener;
  }

  disableEyedropper() {
    this.isEyedropperActive = false;
    this.canvas.style.cursor = 'default';
    const pointer = document.getElementById('eyedropper-pointer');
    if (pointer) pointer.style.display = 'none';

    // Remove window event listeners dynamically to prevent memory leaks
    if (this._moveListener) {
      window.removeEventListener('mousemove', this._moveListener);
      this._moveListener = null;
    }
    if (this._touchMoveListener) {
      window.removeEventListener('touchmove', this._touchMoveListener);
      this._touchMoveListener = null;
    }
  }
}
