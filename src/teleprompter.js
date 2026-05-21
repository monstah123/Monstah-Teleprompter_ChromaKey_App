/**
 * Teleprompter Engine Module
 * Manages text scrolling, custom typography rendering, dragging, 
 * resizable cards, and local file import parser.
 */
export class TeleprompterEngine {
  constructor(cardElement, dragHeaderElement, scrollViewElement, textContentElement) {
    this.card = cardElement;
    this.header = dragHeaderElement;
    this.scrollView = scrollViewElement;
    this.textContent = textContentElement;

    // Autoscroll Core State
    this.isPlaying = false;
    this.wpmSpeed = 120; // default Words Per Minute
    this.scrollPosition = 0; // Current TranslateY value
    this.lastFrameTime = 0;

    // Typography Settings
    this.fontSize = 28;
    this.padding = 24;
    this.backdropOpacity = 0.65;
    this.fontFamily = "'Outfit', sans-serif";
    this.textAlignment = 'center';

    // Drag / Resize Position State
    this.isDragging = false;
    this.dragStart = { x: 0, y: 0 };
    this.cardStart = { x: 0, y: 0 };
    this.isLockedTop = false;

    // Callbacks
    this.onPlayStateChange = null;

    this.initDraggable();
    this.initResizable();
    this.applyStyles();
  }

  // Set WPM Speed
  setSpeed(wpm) {
    this.wpmSpeed = wpm;
    const indicator = document.getElementById('card-speed-indicator');
    if (indicator) indicator.textContent = `WPM: ${wpm}`;
  }

  // Text contents synchronization
  setScriptText(text) {
    // Sanitize input
    const sanitized = text.replace(/<[^>]*>/g, '').trim();
    this.textContent.textContent = sanitized || 'Write or paste your script content here...';
    this.resetScroll();
  }

  getScriptText() {
    return this.textContent.textContent;
  }

  // UI styling settings setters
  setFontSize(px) {
    this.fontSize = px;
    this.applyStyles();
  }

  setPadding(px) {
    this.padding = px;
    this.applyStyles();
  }

  setBackdropOpacity(percentage) {
    this.backdropOpacity = percentage / 100;
    this.applyStyles();
  }

  setFontFamily(family) {
    this.fontFamily = family;
    this.applyStyles();
  }

  setTextAlignment(align) {
    this.textAlignment = align;
    this.applyStyles();
  }

  applyStyles() {
    this.textContent.style.fontSize = `${this.fontSize}px`;
    this.textContent.style.paddingLeft = `${this.padding}px`;
    this.textContent.style.paddingRight = `${this.padding}px`;
    this.textContent.style.fontFamily = this.fontFamily;
    this.textContent.style.textAlign = this.textAlignment;
    this.card.style.backgroundColor = `rgba(15, 15, 23, ${this.backdropOpacity})`;
  }

  // Eyeline Center Top Locking
  setLockedTop(locked) {
    this.isLockedTop = locked;
    if (locked) {
      this.card.classList.add('locked-top');
      this.card.style.top = '15px';
      this.card.style.left = `calc(50% - ${this.card.offsetWidth / 2}px)`;
      const pinBtn = document.getElementById('lock-top-btn');
      if (pinBtn) pinBtn.classList.add('active');
    } else {
      this.card.classList.remove('locked-top');
      const pinBtn = document.getElementById('lock-top-btn');
      if (pinBtn) pinBtn.classList.remove('active');
    }
  }

  // 1. Draggable overlay routines
  initDraggable() {
    const handleDragStart = (clientX, clientY) => {
      if (this.isLockedTop) return;
      this.isDragging = true;
      this.card.classList.add('dragging');
      this.dragStart = { x: clientX, y: clientY };
      
      const style = window.getComputedStyle(this.card);
      this.cardStart = {
        x: parseInt(style.left, 10) || 0,
        y: parseInt(style.top, 10) || 0
      };
    };

    const handleDragMove = (clientX, clientY) => {
      if (!this.isDragging) return;
      
      const dx = clientX - this.dragStart.x;
      const dy = clientY - this.dragStart.y;
      
      this.card.style.left = `${this.cardStart.x + dx}px`;
      this.card.style.top = `${this.cardStart.y + dy}px`;
    };

    const handleDragEnd = () => {
      if (this.isDragging) {
        this.isDragging = false;
        this.card.classList.remove('dragging');
      }
    };

    // Mouse Events
    this.header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.lock-top-btn')) return;
      handleDragStart(e.clientX, e.clientY);
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      handleDragMove(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', () => {
      handleDragEnd();
    });

    // Touch Events for mobile drag
    this.header.addEventListener('touchstart', (e) => {
      if (e.target.closest('.lock-top-btn')) return;
      const touch = e.touches[0];
      handleDragStart(touch.clientX, touch.clientY);
    });

    window.addEventListener('touchmove', (e) => {
      if (!this.isDragging) return;
      const touch = e.touches[0];
      handleDragMove(touch.clientX, touch.clientY);
      e.preventDefault(); // Stop screen scrolling while dragging card
    }, { passive: false });

    window.addEventListener('touchend', () => {
      handleDragEnd();
    });
  }

  // 2. Resizable borders routines
  initResizable() {
    const handles = this.card.querySelectorAll('.resize-handle');
    
    handles.forEach(handle => {
      const handleResizeStart = (clientX, clientY) => {
        let isResizing = true;
        const isRight = handle.classList.contains('rh-bottom-right');
        
        const startWidth = this.card.offsetWidth;
        const startHeight = this.card.offsetHeight;
        const startX = clientX;
        const startY = clientY;
        const startLeft = this.card.offsetLeft;

        const resizeMove = (evClientX, evClientY) => {
          if (!isResizing) return;
          
          const dy = evClientY - startY;
          const newHeight = Math.max(150, startHeight + dy);
          this.card.style.height = `${newHeight}px`;

          if (isRight) {
            const dx = evClientX - startX;
            const newWidth = Math.max(300, startWidth + dx);
            this.card.style.width = `${newWidth}px`;
          } else {
            const dx = evClientX - startX;
            const newWidth = Math.max(300, startWidth - dx);
            this.card.style.width = `${newWidth}px`;
            this.card.style.left = `${startLeft + dx}px`;
          }

          // If top-locked, keep it horizontally centered after resizing
          if (this.isLockedTop) {
            this.card.style.left = `calc(50% - ${this.card.offsetWidth / 2}px)`;
          }
        };

        const resizeMoveMouse = (ev) => resizeMove(ev.clientX, ev.clientY);
        const resizeMoveTouch = (ev) => {
          const touch = ev.touches[0];
          resizeMove(touch.clientX, touch.clientY);
          ev.preventDefault(); // Disable general scrolling
        };

        const resizeUp = () => {
          isResizing = false;
          window.removeEventListener('mousemove', resizeMoveMouse);
          window.removeEventListener('mouseup', resizeUp);
          window.removeEventListener('touchmove', resizeMoveTouch);
          window.removeEventListener('touchend', resizeUp);
        };

        window.addEventListener('mousemove', resizeMoveMouse);
        window.addEventListener('mouseup', resizeUp);
        window.addEventListener('touchmove', resizeMoveTouch, { passive: false });
        window.addEventListener('touchend', resizeUp);
      };

      // Mouse drag handlers
      handle.addEventListener('mousedown', (e) => {
        handleResizeStart(e.clientX, e.clientY);
        e.preventDefault();
        e.stopPropagation();
      });

      // Touch drag handlers
      handle.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        handleResizeStart(touch.clientX, touch.clientY);
        e.stopPropagation();
      });
    });
  }

  // 3. Autoscrolling Mathematical Engine
  togglePlay() {
    this.isPlaying = !this.isPlaying;
    
    if (this.isPlaying) {
      this.lastFrameTime = performance.now();
      requestAnimationFrame((t) => this.scrollLoop(t));
    }

    if (this.onPlayStateChange) {
      this.onPlayStateChange(this.isPlaying);
    }
  }

  play() {
    if (this.isPlaying) return;
    this.togglePlay();
  }

  pause() {
    if (!this.isPlaying) return;
    this.togglePlay();
  }

  resetScroll() {
    this.scrollPosition = 0;
    this.textContent.style.transform = `translateY(0px)`;
  }

  scrollLoop(currentTime) {
    if (!this.isPlaying) return;

    const deltaTime = (currentTime - this.lastFrameTime) / 1000; // in seconds
    this.lastFrameTime = currentTime;

    // Robust pixels scrolled per second calculation based on WPM:
    // Speed (px/s) = (Total Text Height / Total Words) * (WPM / 60)
    const textHeight = this.textContent.scrollHeight;
    
    // Fallback if empty or unloaded
    const wordCount = this.getWordCount() || 1;
    const speedPxPerSec = (textHeight / wordCount) * (this.wpmSpeed / 60);

    // Calculate position
    this.scrollPosition += speedPxPerSec * deltaTime;

    // View boundaries: center viewport guides
    const viewHeight = this.scrollView.offsetHeight;
    const maxScroll = textHeight - (viewHeight / 2);

    if (this.scrollPosition > maxScroll) {
      this.scrollPosition = maxScroll;
      this.pause();
    }

    // Apply smooth transform translation (inverse direction)
    this.textContent.style.transform = `translateY(-${this.scrollPosition}px)`;

    requestAnimationFrame((t) => this.scrollLoop(t));
  }

  getWordCount() {
    const text = this.textContent.textContent || '';
    const clean = text.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "");
    const words = clean.trim().split(/\s+/);
    return words[0] === '' ? 0 : words.length;
  }

  // 4. File importers
  importTxt(content) {
    this.setScriptText(content);
  }

  importDocx(arrayBuffer, onCompleteCallback) {
    // Using Mammoth CDN library loaded in index.html to read Word documents client-side
    if (!window.mammoth) {
      console.error('Mammoth.js library failed to load.');
      return;
    }

    window.mammoth.extractRawText({ arrayBuffer: arrayBuffer })
      .then((result) => {
        const text = result.value;
        this.setScriptText(text);
        if (onCompleteCallback) onCompleteCallback(text);
      })
      .catch((err) => {
        console.error('Mammoth extraction failed:', err);
      });
  }
}
