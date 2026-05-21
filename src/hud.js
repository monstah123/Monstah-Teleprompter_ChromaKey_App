/**
 * Eyeline Calibration HUD Module
 * Manages webcam lens targets and concentric alignment circles.
 */
export class HUDCalibration {
  constructor(overlayElement, svgElement, lensTargetElement) {
    this.overlay = overlayElement;
    this.svg = svgElement;
    this.target = lensTargetElement;
    
    this.isActive = false;
    this.isDraggingTarget = false;

    // Centering coordinates in percentage (50% center, 15% top)
    this.lensX = 50;
    this.lensY = 15;

    this.initInteractiveTarget();
  }

  // Toggle overlay visibility
  setVisible(visible) {
    this.isActive = visible;
    if (visible) {
      this.overlay.classList.add('visible');
    } else {
      this.overlay.classList.remove('visible');
    }
  }

  // 1. Draggable webcam vector target
  initInteractiveTarget() {
    // Add event listeners to the SVG node
    this.target.style.cursor = 'pointer';
    
    const handleDragStart = (clientX, clientY) => {
      const rect = this.svg.getBoundingClientRect();
      const clickX = ((clientX - rect.left) / rect.width) * 100;
      const clickY = ((clientY - rect.top) / rect.height) * 100;

      // Distance checking
      const dist = Math.sqrt((clickX - this.lensX) ** 2 + (clickY - this.lensY) ** 2);
      
      if (dist < 8) { // 8% proximity
        this.isDraggingTarget = true;
        this.svg.style.cursor = 'move';
        return true;
      }
      return false;
    };

    const handleDragMove = (clientX, clientY) => {
      if (!this.isDraggingTarget) return;

      const rect = this.svg.getBoundingClientRect();
      let x = ((clientX - rect.left) / rect.width) * 100;
      let y = ((clientY - rect.top) / rect.height) * 100;

      // Clamp target to reasonable top screen bounds
      x = Math.max(5, Math.min(95, x));
      y = Math.max(2, Math.min(45, y));

      this.updateLensCoordinates(x, y);
    };

    const handleDragEnd = () => {
      if (this.isDraggingTarget) {
        this.isDraggingTarget = false;
        this.svg.style.cursor = 'default';
      }
    };

    // We register mouse handlers on the SVG overlay so dragging is smooth across boundaries
    this.svg.addEventListener('mousedown', (e) => {
      if (handleDragStart(e.clientX, e.clientY)) {
        e.preventDefault();
      }
    });

    window.addEventListener('mousemove', (e) => {
      handleDragMove(e.clientX, e.clientY);
    });

    window.addEventListener('mouseup', () => {
      handleDragEnd();
    });

    // Touch events support for mobile devices
    this.svg.addEventListener('touchstart', (e) => {
      const touch = e.touches[0];
      if (handleDragStart(touch.clientX, touch.clientY)) {
        e.preventDefault();
      }
    });

    window.addEventListener('touchmove', (e) => {
      if (!this.isDraggingTarget) return;
      const touch = e.touches[0];
      handleDragMove(touch.clientX, touch.clientY);
      e.preventDefault();
    }, { passive: false });

    window.addEventListener('touchend', () => {
      handleDragEnd();
    });
  }

  // 2. Center concentric elements around target
  updateLensCoordinates(x, y) {
    this.lensX = x;
    this.lensY = y;

    // Update target circle cx, cy
    this.target.setAttribute('cx', x);
    this.target.setAttribute('cy', y);

    // Update alignment instructions text coordinate
    const txtNode = this.svg.querySelector('.hud-text');
    if (txtNode) {
      txtNode.setAttribute('x', x);
      txtNode.setAttribute('y', y - 4);
    }

    // Shift concentric calibration vectors to center around lens target
    const circles = this.svg.querySelectorAll('.hud-circle');
    circles.forEach(circle => {
      circle.setAttribute('cx', x);
      circle.setAttribute('cy', y);
    });

    // Update horizontal axis line Y coordinate
    const hAxis = this.svg.querySelector('.hud-horizontal');
    if (hAxis) {
      hAxis.setAttribute('y1', y);
      hAxis.setAttribute('y2', y);
    }

    // Update vertical axis line X coordinate
    const vAxis = this.svg.querySelector('.hud-vertical');
    if (vAxis) {
      vAxis.setAttribute('x1', x);
      vAxis.setAttribute('x2', x);
    }
  }
}
