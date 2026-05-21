/**
 * Speech Recognition Scroll Tracker
 * Natively parses vocal streams to dynamically scroll scripts at the user's reading pace.
 */
export class SpeechScrollTracker {
  constructor(teleprompterEngine) {
    this.engine = teleprompterEngine;
    this.recognition = null;
    this.isActive = false;

    // Word tracking states
    this.scriptWords = [];
    this.currentWordIndex = 0;
    this.wordSpansElements = [];

    // sliding search window size (how many words ahead can it match)
    this.slidingWindowSize = 15;

    this.initSpeechRecognition();
  }

  initSpeechRecognition() {
    const SpeechRecognition = window.webkitSpeechRecognition || window.SpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('SpeechRecognition API is not supported in this browser.');
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'en-US';

    this.recognition.onstart = () => {
      this.updateStatusUI(true, 'Listening for speech...');
    };

    this.recognition.onresult = (e) => {
      this.processSpeechTranscript(e);
    };

    this.recognition.onerror = (e) => {
      console.error('Speech recognition error event:', e.error);
      this.updateStatusUI(this.isActive, `Error: ${e.error}`);
    };

    this.recognition.onend = () => {
      if (this.isActive) {
        // Automatically restart if active
        try {
          this.recognition.start();
        } catch (err) {
          console.log('Deferred speech recognition restart:', err);
        }
      } else {
        this.updateStatusUI(false, 'Speech tracking idle');
      }
    };
  }

  // 1. Prepare DOM text wrapped in spans
  prepareScriptSpans() {
    const text = this.engine.getScriptText();
    // Split text into words (removing non-alphanumeric chars for tracking)
    const wordsRaw = text.trim().split(/\s+/);
    
    this.scriptWords = wordsRaw.map(w => w.toLowerCase().replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ""));
    this.currentWordIndex = 0;

    // Rewrite teleprompter DOM with word-level spans so we can locate coordinates
    this.engine.textContent.innerHTML = '';
    this.wordSpansElements = [];

    wordsRaw.forEach((word, index) => {
      const span = document.createElement('span');
      span.className = 'prompter-word-node';
      span.dataset.index = index;
      span.style.transition = 'color 0.2s ease, text-shadow 0.2s ease';
      span.textContent = word + ' ';
      this.engine.textContent.appendChild(span);
      this.wordSpansElements.push(span);
    });
  }

  // Restore DOM text when deactivated
  restoreScriptText() {
    const text = this.engine.getScriptText();
    this.engine.textContent.innerHTML = text;
  }

  // 2. Process Transcripts and Match
  processSpeechTranscript(event) {
    if (!this.isActive) return;

    let phrase = '';
    // Concatenate current result phrase
    for (let i = event.resultIndex; i < event.results.length; i++) {
      phrase += event.results[i][0].transcript;
    }

    const spokenTokens = phrase.toLowerCase().trim().split(/\s+/).map(w => w.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, ""));

    // Iterate through spoken words and try to align indices
    spokenTokens.forEach(spokenWord => {
      if (!spokenWord) return;

      // Search ahead in the sliding window
      const searchEnd = Math.min(this.scriptWords.length, this.currentWordIndex + this.slidingWindowSize);
      
      for (let i = this.currentWordIndex; i < searchEnd; i++) {
        if (this.scriptWords[i] === spokenWord) {
          this.advanceToWordIndex(i);
          break;
        }
      }
    });
  }

  // 3. Coordinate translation and scrolling
  advanceToWordIndex(index) {
    // Un-highlight previous matched nodes
    for (let i = 0; i <= index; i++) {
      if (this.wordSpansElements[i]) {
        this.wordSpansElements[i].style.color = '#06b6d4'; // Active blue-cyan highlight
        this.wordSpansElements[i].style.textShadow = '0 0 6px rgba(6, 182, 212, 0.4)';
      }
    }
    
    this.currentWordIndex = index;
    const activeSpan = this.wordSpansElements[index];

    if (activeSpan) {
      // Find the visual scroll position
      const spanTop = activeSpan.offsetTop;
      const viewHeight = this.engine.scrollView.offsetHeight;
      
      // Calculate scroll location centered on guides
      const scrollTarget = spanTop - (viewHeight / 2) + 30; // 30 is offset height
      
      // Smoothly update translate on teleprompter engine
      this.engine.scrollPosition = Math.max(0, scrollTarget);
      this.engine.textContent.style.transform = `translateY(-${this.engine.scrollPosition}px)`;
    }
  }

  start() {
    if (!this.recognition) return;
    this.isActive = true;
    this.prepareScriptSpans();
    try {
      this.recognition.start();
    } catch (e) {
      console.log('Speech recognition already active.');
    }
  }

  stop() {
    this.isActive = false;
    if (this.recognition) {
      this.recognition.stop();
    }
    this.restoreScriptText();
    this.updateStatusUI(false, 'Speech tracking disabled');
  }

  updateStatusUI(active, text) {
    const block = document.getElementById('voice-status-block');
    const label = document.getElementById('voice-status-text');
    if (block && label) {
      block.style.display = active ? 'flex' : 'none';
      label.textContent = text;
    }
  }
}
