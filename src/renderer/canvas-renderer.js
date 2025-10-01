export class CanvasRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.textWidthCache = new Map();
    this.lineLayouts = new Map();
    this.imageLayouts = new Map();
    this.lineTops = new Map();
    this.lineHeights = new Map();
    this.imageLayoutsCache = new Map();
    this.typography = {
      spaceWidth: 0,
      ascent: 0,
      descent: 0,
      glyphHeight: 0,
      baselineOffset: 0,
      paddingTop: 0,
      paddingBottom: 0,
      cursorHeight: 0,
    };
  }

  updateTypographyMetrics() {
    this.ctx.font = this.state.view.font;
    this.textWidthCache.clear();
    this.lineLayouts.clear();
    const previousLineHeight = this.state.view.lineHeight;
    const fontSize = this.getFontPixelSize();
    const spaceMetrics = this.ctx.measureText(" ");
    const probeMetrics = this.ctx.measureText("Ｍ");
    const ascent = probeMetrics.actualBoundingBoxAscent ?? fontSize * 0.8;
    const descent = probeMetrics.actualBoundingBoxDescent ?? fontSize * 0.2;
    const glyphHeight = Math.ceil(ascent + descent);
    const minimumPadding = Math.ceil(fontSize * 0.1);
    const computedLineHeight = Math.max(
      glyphHeight + minimumPadding * 2,
      previousLineHeight
    );
    const availablePadding = Math.max(0, computedLineHeight - glyphHeight);
    const paddingTop = Math.floor(availablePadding / 2);
    const paddingBottom = availablePadding - paddingTop;
    const boundingWidth =
      spaceMetrics.actualBoundingBoxLeft !== undefined &&
      spaceMetrics.actualBoundingBoxRight !== undefined
        ? Math.abs(spaceMetrics.actualBoundingBoxRight) +
          Math.abs(spaceMetrics.actualBoundingBoxLeft)
        : 0;
    const spaceAdvance = Math.max(spaceMetrics.width ?? 0, boundingWidth);
    const spaceWidthFallback = fontSize * 0.5;
    const spaceWidth = spaceAdvance > 0 ? spaceAdvance : spaceWidthFallback;
    this.typography = {
      spaceWidth,
      ascent,
      descent,
      glyphHeight,
      baselineOffset: paddingTop + ascent,
      paddingTop,
      paddingBottom,
      cursorHeight: glyphHeight,
    };
    this.state.view.lineHeight = computedLineHeight;
    const indentMinimum = Math.max(spaceWidth * 2, fontSize * 0.9);
    this.state.view.indentWidth = Math.max(Math.round(indentMinimum), 4);
    if (this.textarea) {
      this.textarea.style.font = this.state.view.font;
      this.textarea.style.lineHeight = `${Math.round(this.typography.cursorHeight)}px`;
      const minHeight = Math.max(1, Math.round(this.typography.cursorHeight));
      this.textarea.dataset.minHeight = `${minHeight}`;
      this.textarea.style.minHeight = `${minHeight}px`;
      this.textarea.style.height = "auto";
      const minWidth = 320;
      const dynamicWidth = Math.round(this.typography.cursorHeight * 12);
      this.textarea.style.width = `${Math.max(minWidth, dynamicWidth)}px`;
      this.textarea.style.minWidth = `${minWidth}px`;
    }
    if (this.canvas && this.config) {
      const availableHeight = Math.max(
        1,
        this.canvas.height - this.config.padding * 2
      );
      this.visibleLineCapacity = Math.max(
        1,
        Math.floor(availableHeight / Math.max(1, this.state.view.lineHeight))
      );
    }
  }

  renderLoop(timestamp) {
    if (
      this.search &&
      this.search.isOpen &&
      (this.search.needsUpdate ||
        this.search.lastEvaluatedVersion !== this.documentVersion)
    ) {
      this.updateSearchResults({ preserveActive: true });
    }
    this.updateCursorBlink(timestamp);
    this.render();
    this.updateTextareaPosition();
    requestAnimationFrame(this.renderLoop.bind(this));
  }

  render() {
    this.ctx.fillStyle = this.config.colors.background;
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.save();
    this.ctx.translate(
      -this.state.view.scrollLeft,
      -this.state.view.scrollTop
    );

    this.lineLayouts.clear();
    this.imageLayouts.clear();
    this.lineTops.clear();
    this.lineHeights.clear();

    const visibleLines = this.getVisibleLines();
    let currentY = this.config.padding;
    const viewportTop = this.state.view.scrollTop - this.config.padding;
    const viewportBottom =
      this.state.view.scrollTop + this.canvas.height + this.config.padding;

    visibleLines.forEach((lineIndex) => {
      const line = this.state.lines[lineIndex];
      const lineHeight = this.getLineDisplayHeight(line);
      const lineBottom = currentY + lineHeight;
      this.lineTops.set(lineIndex, currentY);
      this.lineHeights.set(lineIndex, lineHeight);

      if (lineBottom >= viewportTop && currentY <= viewportBottom) {
        this.renderLine(line, lineIndex, currentY, lineHeight);
      }

      currentY += lineHeight;
    });

    this.renderCursor();

    if (this.isFocused && this.isComposing) {
      this.renderCompositionText();
    }

    this.ctx.restore();
  }

  renderLine(line, lineIndex, y, lineHeight) {
    this.renderIndentBackground(line, y, lineHeight);
    this.renderSearchHighlights(lineIndex, y, lineHeight);
    this.renderSelection(lineIndex, y, lineHeight);
    this.renderCollapseIcon(line, lineIndex, y, lineHeight);
    if (this.isImageLine && this.isImageLine(line)) {
      this.renderImageLine(line, lineIndex, y, lineHeight);
    } else {
      this.renderLineText(line, lineIndex, y);
    }
  }

  renderIndentBackground(line, y, lineHeight) {
    const indentWidth = this.state.view.indentWidth;
    for (let level = 0; level < line.indent; level += 1) {
      const x = this.config.padding + level * indentWidth;
      this.ctx.fillStyle = this.config.colors.indentation;
      this.ctx.fillRect(
        x,
        y,
        Math.max(1, indentWidth - 4),
        lineHeight
      );
    }
  }

  renderSearchHighlights(lineIndex, y, lineHeight) {
    const search = this.search;
    if (!search || !search.isOpen || search.matchesByLine.size === 0) return;
    const lineMatches = search.matchesByLine.get(lineIndex);
    if (!lineMatches || lineMatches.length === 0) return;
    const line = this.state.lines[lineIndex];
    if (this.isImageLine && this.isImageLine(line)) return;
    if (!line) return;
    const indentWidth = this.state.view.indentWidth;
    const indentX = this.config.padding + line.indent * indentWidth;
    const text = line.text;
    lineMatches.forEach((entry) => {
      const startX = indentX + this.measureText(text.slice(0, entry.start));
      const endX = indentX + this.measureText(text.slice(0, entry.end));
      const width = Math.max(2, endX - startX);
      const isActive = entry.index === search.activeIndex;
      this.ctx.fillStyle = isActive
        ? this.config.colors.searchActiveMatch
        : this.config.colors.searchMatch;
      this.ctx.fillRect(startX, y, width, lineHeight);
    });
  }

  renderSelection(lineIndex, y, lineHeight) {
    const selection = this.getNormalizedSelection();
    if (!selection) return;
    const { start, end } = selection;
    if (lineIndex < start.lineIndex || lineIndex > end.lineIndex) return;

    const line = this.state.lines[lineIndex];
    const indentX =
      this.config.padding + line.indent * this.state.view.indentWidth;
    let selectionStartX = indentX;
    let selectionEndX = indentX;

    const startIndex =
      lineIndex === start.lineIndex ? start.charIndex : 0;
    const endIndex =
      lineIndex === end.lineIndex ? end.charIndex : this.getLineLength(line);

    if (this.isImageLine && this.isImageLine(line)) {
      const imageWidth = line.image?.width ?? 0;
      if (startIndex === 0 && endIndex === 1) {
        selectionEndX = indentX + imageWidth;
      } else if (startIndex === 1 && endIndex === 1) {
        selectionStartX = indentX + imageWidth;
        selectionEndX = selectionStartX;
      }
    } else {
      const text = line.text;
      if (startIndex === endIndex && startIndex === 0 && lineIndex !== end.lineIndex) {
        selectionEndX = indentX + this.measureText(text);
      } else {
        selectionStartX =
          indentX + this.measureText(text.slice(0, startIndex));
        selectionEndX =
          indentX + this.measureText(text.slice(0, endIndex));
      }
    }

    this.ctx.fillStyle = this.config.colors.selection;
    this.ctx.fillRect(
      selectionStartX,
      y,
      Math.max(2, selectionEndX - selectionStartX),
      lineHeight
    );
  }

  renderCollapseIcon(line, lineIndex, y, lineHeight) {
    if (!this.hasChildren(lineIndex)) return;
    const indentWidth = this.state.view.indentWidth;
    const iconX =
      this.config.padding +
      line.indent * indentWidth -
      indentWidth * 0.7;
    const iconBaseline = y + this.typography.baselineOffset;
    this.ctx.fillStyle = this.config.colors.text;
    const icon = line.collapsed ? "▶" : "▼";
    this.ctx.fillText(icon, iconX, iconBaseline);
  }

  renderLineText(line, lineIndex, y) {
    const indentWidth = this.state.view.indentWidth;
    const indentX =
      this.config.padding + line.indent * indentWidth;
    const baseline = y + this.typography.baselineOffset;
    const segments = this.getRenderedSegments(line, lineIndex);
    let cursorX = indentX;
    const clickableSegments = [];

    segments.forEach((segment) => {
      const startX = cursorX;
      const segmentWidth = this.measureText(segment.displayText);
      this.ctx.fillStyle = this.getSegmentColor(segment);
      this.ctx.fillText(segment.displayText, startX, baseline);
      if (segment.target && (segment.isLink || segment.isRelativeLink)) {
        clickableSegments.push({
          startX,
          endX: startX + segmentWidth,
          target: segment.target,
          type: segment.isLink ? "absolute" : "relative",
        });
      }
      cursorX += segmentWidth;
    });

    if (clickableSegments.length > 0) {
      this.lineLayouts.set(lineIndex, clickableSegments);
    } else {
      this.lineLayouts.delete(lineIndex);
    }
  }

  renderImageLine(line, lineIndex, y, lineHeight) {
    const indentWidth = this.state.view.indentWidth;
    const indentX = this.config.padding + line.indent * indentWidth;
    const imageData = line.image ?? {};
    const width = imageData.width ?? this.state.view.lineHeight;
    const height = imageData.height ?? lineHeight;
    const imageTop = y;
    const imageLeft = indentX;

    const cacheEntry = this.getCachedImage(line);
    if (cacheEntry?.status === "loaded" && cacheEntry.image) {
      this.ctx.drawImage(cacheEntry.image, imageLeft, imageTop, width, height);
    } else {
      this.ctx.fillStyle = this.config.colors.selection;
      this.ctx.fillRect(imageLeft, imageTop, Math.max(32, width || 64), Math.max(32, height || 64));
      this.ctx.fillStyle = this.config.colors.background;
      this.ctx.fillText("画像", imageLeft + 8, imageTop + this.typography.baselineOffset);
    }

    this.imageLayouts.set(lineIndex, {
      x: imageLeft,
      y: imageTop,
      width,
      height,
    });

    if (this.state && this.state.cursor && this.state.cursor.lineIndex === lineIndex && this.isFocused) {
      this.ctx.save();
      this.ctx.strokeStyle = this.config.colors.cursor;
      this.ctx.lineWidth = 2;
      this.ctx.strokeRect(imageLeft - 1, imageTop - 1, width + 2, height + 2);
      const handleSize = 10;
      const handleX = imageLeft + width;
      const handleY = imageTop + height;
      this.ctx.fillStyle = this.config.colors.cursor;
      this.ctx.fillRect(handleX - handleSize / 2, handleY - handleSize / 2, handleSize, handleSize);
      this.ctx.restore();
    }
  }

  getCachedImage(line) {
    if (!line || !line.image || !line.image.src) {
      return null;
    }
    const key = line.id;
    let entry = this.imageLayoutsCache?.get(key);
    if (!entry) {
      const image = new Image();
      entry = { status: "loading", image };
      if (!this.imageLayoutsCache) {
        this.imageLayoutsCache = new Map();
      }
      this.imageLayoutsCache.set(key, entry);
      image.onload = () => {
        entry.status = "loaded";
        entry.width = image.naturalWidth;
        entry.height = image.naturalHeight;
        if (line.image) {
          if (!line.image.width) {
            line.image.width = image.naturalWidth;
          }
          if (!line.image.height) {
            line.image.height = image.naturalHeight;
          }
          if (!line.image.naturalWidth) {
            line.image.naturalWidth = image.naturalWidth;
          }
          if (!line.image.naturalHeight) {
            line.image.naturalHeight = image.naturalHeight;
          }
        }
        this.invalidateLayout();
      };
      image.onerror = () => {
        entry.status = "error";
      };
      image.src = line.image.src;
    }
    return entry;
  }

  renderCursor() {
    if (!this.isFocused || this.isComposing) return;
    const { x, worldLineTop, line } = this.getCursorCoords();
    if (!line) return;
    if (this.cursorBlinkState) {
      this.ctx.fillStyle = this.config.colors.cursor;
      this.ctx.fillRect(
        x,
        worldLineTop,
        2,
        this.getLineDisplayHeight(line)
      );
    }
  }

  renderCompositionText() {
    const { x, worldCursorTop, worldBaseline } = this.getCursorCoords();
    const glyphHeight = Math.max(2, this.typography.cursorHeight);
    this.ctx.fillStyle = this.config.colors.text;
    this.ctx.fillText(this.compositionText, x, worldBaseline);
    const width = this.measureText(this.compositionText);
    this.ctx.strokeStyle = this.config.colors.imeUnderline;
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    const underlineY = worldCursorTop + glyphHeight + Math.max(0, this.typography.paddingBottom - 2);
    this.ctx.moveTo(x, underlineY);
    this.ctx.lineTo(x + width, underlineY);
    this.ctx.stroke();
  }

  measureText(text) {
    if (text.length === 0) {
      return 0;
    }
    const cachedWidth = this.textWidthCache.get(text);
    if (cachedWidth !== undefined) {
      return cachedWidth;
    }
    const width = this.ctx.measureText(text).width;
    if (this.textWidthCache.size > 10000) {
      this.textWidthCache.clear();
    }
    this.textWidthCache.set(text, width);
    return width;
  }
}

export default CanvasRenderer;
