/**
 * WebGL Live Video Compositor
 * Performs real-time chroma-key extraction on GPU at 60 FPS
 * and blends webcam with customizable static or video backgrounds.
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

    // Chroma-Key Shader using YUV Color Space distance (Advanced lighting and shadow tolerant)
    const fsSource = `
      precision mediump float;
      varying vec2 vTexCoord;
      
      uniform sampler2D uForegroundTexture;
      uniform sampler2D uBackgroundTexture;
      
      uniform vec3 uKeyColor;
      uniform float uSimilarity;
      uniform float uSmoothness;
      uniform bool uChromaKeyEnabled;
      uniform bool uFgContain;   // Contain mode: show background outside video bounds (letterbox/pillarbox)
      uniform int uBgType;       // 0=Solid Color, 1=Image Texture, 2=Video Texture
      uniform vec4 uSolidColor;  // Solid background color normalized
      uniform vec2 uFgScale;
      uniform vec2 uBgScale;

      // Convert RGB to YUV for distance calculation
      vec3 rgb2yuv(vec3 rgb) {
        float y = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
        float u = -0.14713 * rgb.r - 0.28886 * rgb.g + 0.436 * rgb.b;
        float v = 0.615 * rgb.r - 0.51499 * rgb.g - 0.10001 * rgb.b;
        return vec3(y, u, v);
      }

      void main() {
        // 1. Always compute background color first — needed for contain gaps and chroma blending
        vec4 bgColor;
        if (uBgType == 0) {
          bgColor = uSolidColor;
        } else {
          // Standard mapping for backgrounds (not mirrored, centered and scaled to cover aspect ratio)
          vec2 bgCoord = (vTexCoord - 0.5) * uBgScale + 0.5;
          bgColor = texture2D(uBackgroundTexture, bgCoord);
        }

        // 2. Compute foreground texture coordinate (mirrored horizontally for natural presenting feel)
        vec2 fgCoord = vec2(1.0 - vTexCoord.x, vTexCoord.y);
        fgCoord = (fgCoord - 0.5) * uFgScale + 0.5;

        // 3. Contain mode: when the canvas and video aspect ratios differ significantly
        //    (e.g. portrait canvas + landscape webcam), texture coordinates go outside [0,1].
        //    Instead of clamping to edge pixels (which looks wrong), output pure background.
        //    This is the letterbox/pillarbox behavior used by TikTok and Reels.
        if (uFgContain && (fgCoord.x < 0.0 || fgCoord.x > 1.0 || fgCoord.y < 0.0 || fgCoord.y > 1.0)) {
          gl_FragColor = bgColor;
          return;
        }

        // 4. Sample foreground camera texture
        vec4 fgColor = texture2D(uForegroundTexture, clamp(fgCoord, 0.0, 1.0));

        // 5. Without chroma key: output foreground directly
        if (!uChromaKeyEnabled) {
          gl_FragColor = fgColor;
          return;
        }

        // 6. Chroma Key: distance in Chrominance (U,V) space — isolates color from shadows/luminance
        vec3 fgYuv = rgb2yuv(fgColor.rgb);
        vec3 keyYuv = rgb2yuv(uKeyColor);
        float chromaDist = distance(fgYuv.yz, keyYuv.yz);

        // Compute alpha mask threshold with smoothstep softening
        float mask = smoothstep(uSimilarity, uSimilarity + uSmoothness, chromaDist);

        // Mix foreground over background based on chroma mask
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
    // getUniformLocation/getAttribLocation are expensive GPU driver calls;
    // calling them inside the render loop at 60fps wastes significant CPU,
    // especially on older mobile chips like the iPhone X A11.
    gl.useProgram(this.program);
    this.attribs.aPosition  = gl.getAttribLocation(this.program, 'aPosition');
    this.attribs.aTexCoord  = gl.getAttribLocation(this.program, 'aTexCoord');
    this.uniforms.uForegroundTexture = gl.getUniformLocation(this.program, 'uForegroundTexture');
    this.uniforms.uBackgroundTexture = gl.getUniformLocation(this.program, 'uBackgroundTexture');
    this.uniforms.uChromaKeyEnabled  = gl.getUniformLocation(this.program, 'uChromaKeyEnabled');
    this.uniforms.uFgContain         = gl.getUniformLocation(this.program, 'uFgContain');
    this.uniforms.uKeyColor          = gl.getUniformLocation(this.program, 'uKeyColor');
    this.uniforms.uSimilarity        = gl.getUniformLocation(this.program, 'uSimilarity');
    this.uniforms.uSmoothness        = gl.getUniformLocation(this.program, 'uSmoothness');
    this.uniforms.uBgType            = gl.getUniformLocation(this.program, 'uBgType');
    this.uniforms.uSolidColor        = gl.getUniformLocation(this.program, 'uSolidColor');
    this.uniforms.uFgScale           = gl.getUniformLocation(this.program, 'uFgScale');
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
    const u = this.uniforms; // Cached uniform locations — no per-frame driver lookups
    const a = this.attribs;  // Cached attribute locations

    // Set Viewport and Clear
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Load Program
    gl.useProgram(this.program);

    // Bind Position buffer
    gl.enableVertexAttribArray(a.aPosition);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
    gl.vertexAttribPointer(a.aPosition, 2, gl.FLOAT, false, 0, 0);

    // Bind TexCoord buffer
    gl.enableVertexAttribArray(a.aTexCoord);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.texCoord);
    gl.vertexAttribPointer(a.aTexCoord, 2, gl.FLOAT, false, 0, 0);

    // Bind Foreground Texture (Webcam feed)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.textures.foreground);
    if (this.video.readyState >= this.video.HAVE_CURRENT_DATA) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
    }
    gl.uniform1i(u.uForegroundTexture, 0);

    // Bind Background Texture
    let typeVal = 0; // Solid Color
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

    // Set Uniform Parameters
    gl.uniform1i(u.uBgType, typeVal);
    
    // Normalize Solid Color
    const solidNorm = [
      this.bgSolidColor[0] / 255,
      this.bgSolidColor[1] / 255,
      this.bgSolidColor[2] / 255,
      this.bgSolidColor[3] / 255,
    ];
    gl.uniform4fv(u.uSolidColor, solidNorm);

    // Calculate foreground scale and contain mode.
    // "Cover" is used when aspect ratios are similar (fills canvas, crops excess).
    // "Contain" is used when they differ significantly — e.g. portrait canvas + landscape webcam
    // would produce 3.16x cover zoom which looks way too close. Contain fits the video to the
    // canvas width and lets the background fill the letterbox gaps, matching TikTok/Reels behavior.
    let fgContain = false;
    let fgScaleX = 1.0;
    let fgScaleY = 1.0;

    if (this.video.videoWidth > 0 && this.video.videoHeight > 0) {
      const canvasAspect = this.canvas.width / this.canvas.height;
      const videoAspect = this.video.videoWidth / this.video.videoHeight;
      // Compute how much zoom cover would produce
      const coverZoom = canvasAspect > videoAspect
        ? canvasAspect / videoAspect
        : videoAspect / canvasAspect;

      if (coverZoom > 1.8) {
        // Aspect ratios differ too much — switch to contain mode
        fgContain = true;
        if (canvasAspect > videoAspect) {
          // Landscape canvas + portrait video → pillarbox (background fills sides)
          fgScaleX = canvasAspect / videoAspect;
          fgScaleY = 1.0;
        } else {
          // Portrait canvas + landscape video → letterbox (background fills top/bottom)
          fgScaleX = 1.0;
          fgScaleY = videoAspect / canvasAspect;
        }
      } else {
        // Standard cover: fills canvas completely, crops excess on one axis
        if (canvasAspect > videoAspect) {
          fgScaleY = videoAspect / canvasAspect;
        } else {
          fgScaleX = canvasAspect / videoAspect;
        }
      }
    }

    gl.uniform1i(u.uFgContain, fgContain ? 1 : 0);
    gl.uniform2f(u.uFgScale, fgScaleX, fgScaleY);

    let bgScaleX = 1.0;
    let bgScaleY = 1.0;
    if (this.bgType === 'image' && this.bgImage && this.bgImage.width > 0 && this.bgImage.height > 0) {
      const canvasAspect = this.canvas.width / this.canvas.height;
      const imageAspect = this.bgImage.width / this.bgImage.height;
      if (canvasAspect > imageAspect) {
        // Crop vertically
        bgScaleY = imageAspect / canvasAspect;
      } else {
        // Crop horizontally
        bgScaleX = canvasAspect / imageAspect;
      }
    } else if (this.bgType === 'video' && this.bgVideo && this.bgVideo.videoWidth > 0 && this.bgVideo.videoHeight > 0) {
      const canvasAspect = this.canvas.width / this.canvas.height;
      const bgVideoAspect = this.bgVideo.videoWidth / this.bgVideo.videoHeight;
      if (canvasAspect > bgVideoAspect) {
        // Crop vertically
        bgScaleY = bgVideoAspect / canvasAspect;
      } else {
        // Crop horizontally
        bgScaleX = canvasAspect / bgVideoAspect;
      }
    }
    gl.uniform2f(u.uBgScale, bgScaleX, bgScaleY);

    // Chroma Uniforms
    gl.uniform1i(u.uChromaKeyEnabled, this.chromaKeyEnabled ? 1 : 0);
    gl.uniform3fv(u.uKeyColor, this.keyColor);
    gl.uniform1f(u.uSimilarity, this.similarity);
    gl.uniform1f(u.uSmoothness, this.smoothness);

    // Draw full-screen Quad
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
