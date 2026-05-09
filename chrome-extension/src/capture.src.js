/**
 * Mockup Sync · Bookmarklet Capture v2 (pixel-mirror mode)
 *
 * Philosophy:
 *   - 100% pixel-perfect reproduction. Every node carries absolute bounds
 *     {x, y, w, h} relative to its direct parent (or to the capture root for
 *     the root node).
 *   - NO auto-layout inference, NO component detection. The Figma plugin
 *     places everything by absolute position. Auto-layout / componentization
 *     can be added back later as a Phase 2 enhancement.
 *   - Token reverse lookup is the only "smart" behavior we keep:
 *       · color hex   → variable name from mapping.tokens.colors
 *       · font size+weight → text style name from mapping.tokens.typography
 *     The Figma side will bind by name if a same-named variable / text style
 *     exists in the current file; otherwise it falls back to a raw fill /
 *     fontSize and the design still reads correctly.
 *
 * Build-time: scripts/build.mjs replaces the marker comment with the JSON
 * contents of mockup-kit.mapping.json. In DevTools (paste this file by hand)
 * we fall back to window.__mkMapping.
 */
(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────────────
  // 1. Configuration & mapping
  // ────────────────────────────────────────────────────────────────────────

  const MAPPING_INJECTED = /* @inject:mapping */ null;
  const MAPPING = MAPPING_INJECTED
    || (typeof window !== 'undefined' && window.__mkMapping)
    || null;

  if (!MAPPING) {
    console.error('[mockup-sync] mapping not found. Either run via built bookmarklet or set window.__mkMapping.');
    return;
  }

  const SCHEMA_VERSION = '2.0.0';
  const ICON_PREFIX =
    (MAPPING.spec && MAPPING.spec.iconLibrary && MAPPING.spec.iconLibrary.classPrefix)
      || 'iconoir-';

  const stats = {
    nodesTotal: 0,
    framesEmitted: 0,
    textsEmitted: 0,
    imagesEmitted: 0,
    framesCollapsed: 0,
    framesFlattened: 0,
    iconsFallback: 0,
    tokensBoundColor: 0,
    tokensBoundText: 0,
    unmapped: new Map(),
  };

  // ────────────────────────────────────────────────────────────────────────
  // 2. Helpers
  // ────────────────────────────────────────────────────────────────────────

  /** rgb(...) / rgba(...) → { hex, opacity? } | null (transparent → null) */
  function rgbToHex(rgb) {
    if (!rgb || rgb === 'transparent') return null;
    const m = rgb.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((s) => s.trim());
    const r = +parts[0], g = +parts[1], b = +parts[2];
    const a = parts[3] != null ? +parts[3] : 1;
    if (a === 0) return null;
    const hex = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
    return a < 1 ? { hex, opacity: a } : { hex };
  }

  function parsePx(v) {
    if (!v) return 0;
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  }

  function reportUnmapped(category, value, traceEl) {
    const key = category + '|' + value;
    const prev = stats.unmapped.get(key);
    if (prev) { prev.count++; return; }
    stats.unmapped.set(key, {
      category,
      value: String(value),
      count: 1,
      example: {
        tag: traceEl.tagName ? traceEl.tagName.toLowerCase() : '?',
        classList: traceEl.classList ? Array.from(traceEl.classList) : [],
      },
    });
  }

  // ────────────────────────────────────────────────────────────────────────
  // 3. Token reverse lookups (hex → variable, fontSize+weight → text style)
  // ────────────────────────────────────────────────────────────────────────

  const COLOR_BY_HEX = new Map();   // "#1a1a1a" → "color/ink"
  const TEXTSTYLE_INDEX = [];       // [{ fontSize, weight, figmaTextStyle }]

  (function buildTokenIndex() {
    const t = MAPPING.tokens || {};
    for (const c of t.colors || []) {
      if (c.value && c.figmaVariable) {
        COLOR_BY_HEX.set(String(c.value).toLowerCase(), c.figmaVariable);
      }
    }
    for (const ty of t.typography || []) {
      if (ty.figmaTextStyle && ty.fontSize != null) {
        TEXTSTYLE_INDEX.push({
          fontSize: Number(ty.fontSize),
          weight:   Number(ty.weight || 400),
          figmaTextStyle: ty.figmaTextStyle,
        });
      }
    }
  })();

  /** Returns a Paint value: { var } if matched, { hex } otherwise, null if transparent. */
  function paintFromRgb(rgbString, traceEl) {
    const parsed = rgbToHex(rgbString);
    if (!parsed) return null;
    const lowered = parsed.hex.toLowerCase();
    const varName = COLOR_BY_HEX.get(lowered);
    if (varName) {
      stats.tokensBoundColor++;
      const out = { var: varName };
      if (parsed.opacity != null) out.opacity = parsed.opacity;
      return out;
    }
    reportUnmapped('unmapped-color', lowered, traceEl);
    const out = { hex: lowered };
    if (parsed.opacity != null) out.opacity = parsed.opacity;
    return out;
  }

  /** Pick the closest typography entry: exact (size,weight) → ±1px same weight → exact size any weight. */
  function matchTextStyle(fontSizePx, weight) {
    const s = Number(fontSizePx);
    const w = Number(weight) || 400;
    let exact = TEXTSTYLE_INDEX.find((t) => t.fontSize === s && t.weight === w);
    if (exact) return exact.figmaTextStyle;
    let close = TEXTSTYLE_INDEX.find((t) => Math.abs(t.fontSize - s) <= 1 && t.weight === w);
    if (close) return close.figmaTextStyle;
    let fallback = TEXTSTYLE_INDEX.find((t) => t.fontSize === s);
    return fallback ? fallback.figmaTextStyle : null;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 4. Style inference (frame visual chrome + text)
  // ────────────────────────────────────────────────────────────────────────

  /**
   * Decide whether `el` lives inside a `border-collapse: collapse` table cell
   * and, if so, which sides should still draw a border. Browsers merge the
   * shared edges of adjacent cells into one painted line, so if we naively
   * give every cell its full 4-side stroke we end up doubling every internal
   * grid line and tripling the outer frame (table border + row border +
   * cell border all overlap).
   *
   * Strategy: when inside a collapsed table, every cell only paints its
   * RIGHT and BOTTOM sides. The TABLE element itself keeps drawing its full
   * border so the left/top edges of the first column/row are still covered.
   * This produces the same visual grid as the HTML without per-edge bookkeeping.
   *
   * Returns `null` when no special handling is needed (caller falls back to
   * the existing uniform-border branch).
   */
  function collapsedCellSides(el, cs) {
    const tag = el.tagName;
    if (tag !== 'TD' && tag !== 'TH' && tag !== 'TR' &&
        tag !== 'THEAD' && tag !== 'TBODY' && tag !== 'TFOOT') return null;
    // Walk up to the nearest <table>.
    let table = el.parentElement;
    while (table && table.tagName !== 'TABLE') table = table.parentElement;
    if (!table) return null;
    let tcs;
    try { tcs = getComputedStyle(table); } catch (_) { return null; }
    if ((tcs.borderCollapse || '') !== 'collapse') return null;

    const rightW  = parsePx(cs.borderRightWidth);
    const bottomW = parsePx(cs.borderBottomWidth);
    if (rightW <= 0 && bottomW <= 0) return null;

    // Borrow whichever side actually has a paint as the canonical color —
    // browsers resolve cell color from the side being painted.
    const paint = paintFromRgb(cs.borderRightColor, el)
               || paintFromRgb(cs.borderBottomColor, el);
    if (!paint) return null;

    return {
      paint,
      top: 0,
      right: rightW,
      bottom: bottomW,
      left: 0,
    };
  }

  function inferFrameStyle(el) {
    const cs = getComputedStyle(el);
    const style = {};
    const fill = paintFromRgb(cs.backgroundColor, el);
    if (fill) style.fill = fill;

    // Border-collapse–aware path for table cells/rows/sections — only emits
    // the right/bottom sides so shared edges aren't drawn twice.
    const sides = collapsedCellSides(el, cs);
    if (sides) {
      style.strokeSides = sides;
    } else {
      // Border: only emit if width > 0 on at least one side. We use the top
      // side as the canonical value (consistent with HTML where most borders
      // are uniform).
      const borderW = parsePx(cs.borderTopWidth);
      if (borderW > 0) {
        const stroke = paintFromRgb(cs.borderTopColor, el);
        if (stroke) {
          style.stroke = { paint: stroke, weight: borderW, align: 'INSIDE' };
        }
      }
    }

    // Border radius: take top-left as canonical. Express percent radius as a
    // separate flag so Figma side can convert to half-of-min(w,h).
    const rTL = cs.borderTopLeftRadius || '';
    if (rTL.indexOf('%') !== -1) {
      const pct = parseFloat(rTL);
      if (Number.isFinite(pct) && pct > 0) {
        style.radius = { percent: pct };
      }
    } else {
      const rPx = parsePx(rTL);
      if (rPx > 0) style.radius = { px: rPx };
    }

    // Box shadow: pass through raw CSS string; Figma side parses on import.
    if (cs.boxShadow && cs.boxShadow !== 'none') {
      style.boxShadow = cs.boxShadow;
    }

    // Opacity (only when not 1)
    const op = parseFloat(cs.opacity);
    if (Number.isFinite(op) && op < 1) style.opacity = op;

    return Object.keys(style).length ? style : undefined;
  }

  /**
   * Normalize a #text node's raw `textContent` so that it matches what the
   * browser actually paints, before we hand it to Figma.
   *
   * Why: HTML source typically wraps inline text across multiple lines with
   * indentation, e.g. `<a>\n      Games\n    </a>`. The browser collapses
   * those newlines + tabs to a single space (and trims at line edges) per
   * CSS white-space rules, so the user sees just `Games`. Figma's text
   * engine, however, renders every character literally — newlines become
   * real line breaks, tabs become wide gaps, and the "Games" glyph drifts
   * far below or to the right of where the Range API said it would render.
   *
   * Strategy:
   *   - When `white-space` is `pre`, `pre-wrap` or `break-spaces`, the browser
   *     preserves whitespace, so we must too. Return the raw string.
   *   - When it's `pre-line`, runs of spaces/tabs collapse but newlines are
   *     kept; we mirror that.
   *   - Otherwise (`normal` / `nowrap`): collapse any whitespace run
   *     (spaces, tabs, newlines) to a single space, then trim leading and
   *     trailing whitespace. This matches the Range API's measured rect:
   *     leading/trailing whitespace at line edges contributes 0 width, so
   *     the rect is positioned around just the visible glyphs — emitting
   *     trimmed characters keeps the text aligned with that rect.
   */
  function normalizeTextContent(raw, parentEl) {
    if (!raw) return raw;
    var ws = 'normal';
    try { ws = getComputedStyle(parentEl).whiteSpace || 'normal'; } catch (_) {}
    if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') {
      return raw;
    }
    if (ws === 'pre-line') {
      // Collapse spaces/tabs but preserve explicit newlines.
      return raw.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n');
    }
    return raw.replace(/\s+/g, ' ').replace(/^ | $/g, '');
  }

  function inferTextStyle(el) {
    const cs = getComputedStyle(el);
    const fontSize = parsePx(cs.fontSize);
    const weight = parseFloat(cs.fontWeight) || 400;
    const fontFamily = (cs.fontFamily || '').split(',')[0].trim().replace(/^["']|["']$/g, '');

    const style = {
      fontFamily,
      fontSize,
      fontWeight: weight,
      lineHeight: cs.lineHeight,                    // raw CSS string ("normal" | "24px" | "1.5")
      letterSpacing: parsePx(cs.letterSpacing),
    };

    const matched = matchTextStyle(fontSize, weight);
    if (matched) {
      style.textStyle = matched;
      stats.tokensBoundText++;
    } else {
      reportUnmapped('unmapped-textstyle', fontSize + '/' + weight, el);
    }

    const fill = paintFromRgb(cs.color, el);
    if (fill) style.fill = fill;

    const ta = cs.textAlign;
    if (ta === 'center') style.textAlign = 'CENTER';
    else if (ta === 'right') style.textAlign = 'RIGHT';
    else if (ta === 'justify') style.textAlign = 'JUSTIFIED';
    else style.textAlign = 'LEFT';

    const td = cs.textDecorationLine;
    if (td && td.indexOf('underline') !== -1) style.textDecoration = 'UNDERLINE';
    else if (td && td.indexOf('line-through') !== -1) style.textDecoration = 'STRIKETHROUGH';

    return style;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 5. Walker
  // ────────────────────────────────────────────────────────────────────────

  function isIconElement(el) {
    if (el.tagName !== 'I' && el.tagName !== 'SPAN') return false;
    for (const c of el.classList) {
      if (c.indexOf(ICON_PREFIX) === 0) return true;
    }
    return false;
  }

  function getIconName(el) {
    for (const c of el.classList) {
      if (c.indexOf(ICON_PREFIX) === 0) return c.slice(ICON_PREFIX.length);
    }
    return 'icon';
  }

  /**
   * Pull an embedded SVG out of a CSS `mask` / `mask-image` data-URI.
   * Returns the SVG source string (with currentColor still as currentColor)
   * or null if no inline SVG was found.
   */
  function extractMaskSvg(maskValue) {
    if (!maskValue || maskValue === 'none') return null;
    // mask-image looks like: url("data:image/svg+xml;charset=utf-8,<svg ...>...</svg>") ...
    // The SVG is URL-encoded. We extract the data URI body and decode it.
    const m = maskValue.match(/url\((['"]?)data:image\/svg\+xml(?:;[^,]*)?,([\s\S]*?)\1\)/i);
    if (!m) return null;
    let body = m[2];
    try {
      // Some browsers double-encode; try decode chain
      body = decodeURIComponent(body);
    } catch (_) { /* already decoded */ }
    // CSS string escapes: \" → ", \' → ', \\ → \
    body = body.replace(/\\(["'\\])/g, '$1');
    if (body.indexOf('<svg') === -1) return null;
    return body;
  }

  /**
   * Look at the element + its ::before / ::after for an icon-bearing CSS mask.
   * Returns { svg, color } or null.
   */
  function findIconSvg(el) {
    const candidates = [
      { ps: null,        cs: getComputedStyle(el) },
      { ps: '::before',  cs: getComputedStyle(el, '::before') },
      { ps: '::after',   cs: getComputedStyle(el, '::after') },
    ];
    for (const c of candidates) {
      // CSS shorthand `mask` may include URL; standalone `maskImage` is most reliable.
      const svg = extractMaskSvg(c.cs.maskImage) || extractMaskSvg(c.cs.mask);
      if (svg) {
        // Color usually comes from `background-color` (currentColor → element's color)
        const color = c.cs.backgroundColor && c.cs.backgroundColor !== 'rgba(0, 0, 0, 0)'
          ? c.cs.backgroundColor
          : c.cs.color;
        return { svg, color };
      }
    }
    return null;
  }

  function buildIconNode(el, bounds) {
    const found = findIconSvg(el);
    if (!found) {
      reportUnmapped('unmapped-icon', getIconName(el), el);
      return null;
    }
    const fill = paintFromRgb(found.color, el);
    // Replace currentColor in the SVG with a concrete colour token marker so
    // the Figma side doesn't have to introspect SVG attrs.
    const fillHex = fill && fill.hex ? fill.hex : (fill && fill.var ? '#1a1a1a' : '#1a1a1a');
    const svg = found.svg.split('currentColor').join(fillHex);
    stats.nodesTotal++;
    stats.imagesEmitted++; // count as image-like
    return {
      type: 'svg',
      name: 'icon·' + getIconName(el),
      bounds,
      svg: svg,
      // Optional fill metadata so Figma side can rebind to a variable later
      fill: fill || undefined,
      _icon: { name: getIconName(el), prefix: ICON_PREFIX },
    };
  }

  function shouldSkipElement(el) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK' || tag === 'META' || tag === 'HEAD' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return true;
    return false;
  }

  function prettyName(prefix, el) {
    const cls = Array.from(el.classList).slice(0, 2).join('.');
    return cls ? prefix + '·' + cls : (el.id ? prefix + '#' + el.id : prefix);
  }

  /** Get bounding rect of a #text node via Range API. Returns null if zero-area. */
  function textNodeRect(textNode) {
    try {
      const range = document.createRange();
      range.selectNodeContents(textNode);
      const r = range.getBoundingClientRect();
      range.detach && range.detach();
      if (!r || (r.width === 0 && r.height === 0)) return null;
      return r;
    } catch (_) {
      return null;
    }
  }

  /** Convert an element's getBoundingClientRect into bounds relative to a parent rect. */
  function relBounds(rect, parentRect) {
    return {
      x: Math.round(rect.left - parentRect.left),
      y: Math.round(rect.top  - parentRect.top),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  }

  /**
   * Recursively walk a subtree gathering every text leaf, with bounds
   * accumulated relative to the *original parent frame* of the wrapper
   * passed in (NOT relative to the wrapper itself). Returns null the moment
   * the walk hits any of:
   *   - a non-text leaf (image / svg / icon-fallback)
   *   - a frame carrying visual chrome (style truthy)
   *   - an empty frame
   *
   * Note on coordinate accumulation:
   *   When called from `flattenTextWrappers(parent)` with `(wrapper, 0, 0)`,
   *   the recursion adds `node.bounds.x` (the current node's offset in its
   *   own parent) at each step. Net effect: a text leaf at depth N comes
   *   back with bounds = (text in immediate parent) + Σ(ancestors' bounds.x)
   *   = the text's position in `parent`'s coordinate space. So the caller
   *   must NOT shift again by `wrapper.bounds.x` — that would double-count.
   *   See the matching comment in `flattenTextWrappers` below.
   */
  function collectTextLeaves(node, offsetX, offsetY) {
    if (!node) return null;
    if (node.type === 'text') {
      return [{
        type: 'text',
        name: node.name,
        bounds: {
          x: node.bounds.x + offsetX,
          y: node.bounds.y + offsetY,
          w: node.bounds.w,
          h: node.bounds.h,
        },
        characters: node.characters,
        style: node.style,
      }];
    }
    if (node.type !== 'frame') return null;
    if (node.style || node._isSvg || node._iconFallback) return null;
    if (!node.children || node.children.length === 0) return null;
    const out = [];
    for (const child of node.children) {
      const leaves = collectTextLeaves(
        child,
        offsetX + node.bounds.x,
        offsetY + node.bounds.y
      );
      if (!leaves || leaves.length === 0) return null;
      for (const l of leaves) out.push(l);
    }
    return out;
  }

  /** Count `frame` nodes (including self) in a subtree. Used to keep stats honest. */
  function countFrameDescendants(node) {
    if (!node || node.type !== 'frame') return 0;
    let n = 1;
    if (node.children) {
      for (const c of node.children) n += countFrameDescendants(c);
    }
    return n;
  }

  /**
   * Optimization 2 — flatten pure-text wrapper subtrees.
   *
   * For each child of `parent` that is a styleless frame whose entire subtree
   * boils down to text leaves, hoist those leaves directly under `parent` and
   * drop the wrapper frames. This kills the kind of nesting that generic
   * single-child collapse can't reach: e.g. `<button><span class="icon-wrap">
   * <span>→</span></span><span>Buy now</span></button>` — `<button>` has style
   * so it stays, but its two `<span>` branches each flatten to a single text
   * leaf, going from 5 nodes → 3.
   *
   * Style is preserved automatically: text leaves were built via
   * `inferTextStyle(directParent)` which uses `getComputedStyle`, so CSS
   * inheritance (color/font-size) was already resolved against the wrappers.
   */
  function flattenTextWrappers(parent) {
    if (!parent || !parent.children || parent.children.length === 0) return;
    const next = [];
    let changed = false;
    for (const child of parent.children) {
      if (
        child.type === 'frame' &&
        !child.style &&
        !child._isSvg &&
        !child._iconFallback &&
        child.children && child.children.length > 0
      ) {
        const leaves = collectTextLeaves(child, 0, 0);
        if (leaves && leaves.length > 0) {
          // NOTE: collectTextLeaves accumulates `node.bounds.x/y` as it
          // recurses, so the leaves come back already in `parent`'s
          // coordinate system (NOT local to `child`). Pushing them as-is
          // is correct; an additional `+= child.bounds.x` shift here would
          // double-count the wrapper's offset and cause every label inside
          // wrappers (e.g. spans inside .btn / .tag / .breadcrumb) to drift
          // by exactly the wrapper's position.
          for (const leaf of leaves) {
            next.push(leaf);
          }
          // Reverse the bookkeeping for every frame we just dissolved.
          const removed = countFrameDescendants(child);
          stats.framesEmitted -= removed;
          stats.nodesTotal   -= removed;
          stats.framesFlattened = (stats.framesFlattened || 0) + removed;
          changed = true;
          continue;
        }
      }
      next.push(child);
    }
    if (changed) parent.children = next;
  }

  /**
   * Decide if a frame node is a "transparent wrapper" — no visual styling, a
   * single child, and the child fully covers the wrapper (within ±2 px). When
   * true we drop the wrapper and lift the child up into its slot.
   *
   * Why: many real-world layouts wrap every component in 3–5 layout-only
   * `<div>`s (flex shells, motion containers, alignment helpers …). They have
   * no `background`, `border`, `border-radius` or `box-shadow`, so a 1:1 DOM
   * mirror produces a deeply-nested tower of empty Figma frames. `web-to-figma`
   * collapses these aggressively; this is our equivalent.
   *
   * Operates bottom-up via natural recursion in `captureElement`: each frame
   * is collapsed once when first built, so a chain of 5 wrappers around one
   * leaf collapses through 5 successive returns.
   */
  function maybeCollapse(node) {
    if (!node || node.type !== 'frame') return node;
    if (node._isSvg) return node;             // keep SVG placeholder intact
    if (node._iconFallback) return node;      // keep icon placeholders intact
    if (node.style) return node;              // any visual chrome → keep
    if (!node.children || node.children.length !== 1) return node;
    const child = node.children[0];
    if (!child || !child.bounds || !node.bounds) return node;

    const TOL = 2;
    if (Math.abs(child.bounds.x) > TOL) return node;
    if (Math.abs(child.bounds.y) > TOL) return node;
    if (Math.abs(child.bounds.w - node.bounds.w) > TOL) return node;
    if (Math.abs(child.bounds.h - node.bounds.h) > TOL) return node;

    // Lift child into the wrapper's slot in the grandparent's coordinate space.
    child.bounds = {
      x: node.bounds.x + child.bounds.x,
      y: node.bounds.y + child.bounds.y,
      w: child.bounds.w,
      h: child.bounds.h,
    };

    // Preserve the naming chain so the trace shows what was folded away.
    if (node.name && child.name && node.name !== child.name) {
      child.name = node.name + '/' + child.name;
    } else if (node.name && !child.name) {
      child.name = node.name;
    }

    // The wrapper frame was already counted; reverse the bookkeeping.
    stats.framesEmitted--;
    stats.nodesTotal--;
    stats.framesCollapsed++;

    return child;
  }

  /**
   * Walk an element, return one IR node (or null if skipped).
   * `parentRect` is the bounding rect of the parent IR frame, used to compute
   * relative bounds. For the root call, pass a rect with left=0, top=0.
   */
  function captureElement(el, parentRect) {
    if (shouldSkipElement(el)) return null;

    // <br> has line-box height but no visible content. Browser uses it only as
    // a layout hint (force line break inside text). The text nodes around it
    // were already captured at their actual rendered y positions via Range API,
    // so we don't lose anything by dropping the <br> itself; keeping it would
    // pollute the IR with zero-width frames between text leaves.
    if (el.tagName === 'BR') return null;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null; // zero-size nodes are noise

    const bounds = relBounds(rect, parentRect);

    // <img> → image node
    if (el.tagName === 'IMG') {
      stats.nodesTotal++;
      stats.imagesEmitted++;
      return {
        type: 'image',
        name: prettyName('img', el),
        bounds,
        alt: el.alt || '',
        src: el.currentSrc || el.src || '',
        natural: { w: el.naturalWidth || 0, h: el.naturalHeight || 0 },
      };
    }

    // Icon-font glyph (e.g. <i class="iconoir-plus">) → extract underlying
    // SVG from CSS mask data-URI and emit as a vector node. Works for any
    // mask-based icon library (iconoir 7+, Material Symbols when used via
    // mask, etc.), not just iconoir.
    if (isIconElement(el)) {
      const iconNode = buildIconNode(el, bounds);
      if (iconNode) return iconNode;
      // Mask extraction failed (e.g. icon font using ::before with content,
      // SVG sprite, or unsupported library). Stop probing — descending into
      // the icon's internal DOM rarely yields useful nodes and instead
      // produces a tower of empty frames + stray pseudo-text like "Italic
      // Text". Emit a fixed-size placeholder so Figma can highlight it for
      // manual fix-up.
      stats.nodesTotal++;
      stats.framesEmitted++;
      stats.iconsFallback = (stats.iconsFallback || 0) + 1;
      return {
        type: 'frame',
        name: 'icon-fallback·' + getIconName(el),
        bounds,
        // No style → maybeCollapse won't touch it (we set _iconFallback so
        // collapse explicitly skips), and Figma side highlights via the flag.
        children: [],
        _iconFallback: true,
        _icon: { name: getIconName(el), prefix: ICON_PREFIX },
      };
    }

    // SVG → leave as a frame placeholder for now. Inline SVG vector handling is
    // out of scope for the pixel-mirror MVP.
    if (el.tagName === 'svg' || el.tagName === 'SVG') {
      stats.nodesTotal++;
      stats.framesEmitted++;
      return {
        type: 'frame',
        name: prettyName('svg', el),
        bounds,
        style: inferFrameStyle(el),
        children: [],
        _isSvg: true,
      };
    }

    // <input> / <textarea> → frame + synthetic text child for placeholder/value
    // Without this, void <input> elements have no childNodes and render as empty
    // boxes in Figma. We extract `value` (filled) or `placeholder` (empty) and
    // emit it as a text node so the mockup carries the visible content.
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const isInput = el.tagName === 'INPUT';
      const type = isInput ? (el.type || 'text').toLowerCase() : 'textarea';
      // Skip non-text inputs (checkbox/radio/file/...) that have no textual content.
      const TEXTUAL = ['text', 'email', 'tel', 'number', 'password', 'search', 'url', 'textarea'];
      if (TEXTUAL.indexOf(type) !== -1) {
        const value = isInput ? (el.value || '') : (el.value || el.textContent || '');
        const placeholder = el.getAttribute('placeholder') || '';
        const visibleText = value || placeholder;
        const isPlaceholder = !value && !!placeholder;
        // Mask password chars so we don't leak credentials to Figma
        const characters = (type === 'password' && value)
          ? '•'.repeat(value.length)
          : visibleText;

        const textChildren = [];
        if (characters) {
          // Inherit font from the input itself; placeholder uses muted color.
          const cs = getComputedStyle(el);
          const placeholderColor = isPlaceholder ? 'rgba(255,255,255,0.4)' : null;
          // Try to read placeholder color from ::placeholder pseudo if present.
          let phColor = placeholderColor;
          if (isPlaceholder) {
            try {
              const phCs = getComputedStyle(el, '::placeholder');
              if (phCs && phCs.color) phColor = phCs.color;
            } catch (_) {}
          }
          const baseStyle = inferTextStyle(el);
          const style = baseStyle ? Object.assign({}, baseStyle) : {};
          if (isPlaceholder && phColor) {
            const ph = paintFromRgb(phColor, el);
            if (ph) style.fill = ph;
          }
          // Position the synthetic text inside the input padding box.
          const padL = parsePx(cs.paddingLeft);
          const padT = parsePx(cs.paddingTop);
          const padR = parsePx(cs.paddingRight);
          const padB = parsePx(cs.paddingBottom);
          textChildren.push({
            type: 'text',
            name: isPlaceholder ? 'placeholder' : 'value',
            bounds: {
              x: padL,
              y: padT,
              w: Math.max(0, rect.width - padL - padR),
              h: Math.max(0, rect.height - padT - padB),
            },
            characters: characters,
            style: style,
          });
          stats.nodesTotal++;
          stats.textsEmitted++;
        }
        const node = {
          type: 'frame',
          name: prettyName('frame', el),
          bounds,
          style: inferFrameStyle(el),
          children: textChildren,
        };
        stats.nodesTotal++;
        stats.framesEmitted++;
        return node;
      }
    }

    // Generic element → frame, recurse into childNodes (both elements + text)
    const node = {
      type: 'frame',
      name: prettyName('frame', el),
      bounds,
      style: inferFrameStyle(el),
      children: walkChildren(el, rect),
    };
    stats.nodesTotal++;
    stats.framesEmitted++;
    if (DEBUG_TRACE) {
      node.source = {
        tag: el.tagName.toLowerCase(),
        classList: Array.from(el.classList),
        id: el.id || undefined,
      };
    }
    flattenTextWrappers(node);
    return maybeCollapse(node);
  }

  /** Walk child *nodes* of an element: produce IR nodes for elements and #text. */
  function walkChildren(el, parentRect) {
    const out = [];
    for (const child of el.childNodes) {
      if (child.nodeType === 1) {
        const n = captureElement(child, parentRect);
        if (n) out.push(n);
      } else if (child.nodeType === 3) {
        const raw = child.textContent;
        if (!raw || !raw.trim()) continue;
        const r = textNodeRect(child);
        if (!r) continue;
        const bounds = relBounds(r, parentRect);
        // Inherit text styling from the parent element.
        const style = inferTextStyle(el);
        // Collapse whitespace the same way the browser does, so Figma renders
        // the same glyph string the user saw on the page (no leading newline /
        // tab indentation pushing the text down or to the right).
        const characters = normalizeTextContent(raw, el);
        if (!characters) continue;
        out.push({
          type: 'text',
          name: 'text',
          bounds,
          characters,
          style,
        });
        stats.nodesTotal++;
        stats.textsEmitted++;
      }
      // ignore comments, processing instructions, etc.
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 6. Output (clipboard + download + toast)
  // ────────────────────────────────────────────────────────────────────────

  function buildEnvelope(rootNode) {
    return {
      version: SCHEMA_VERSION,
      meta: {
        capturedAt: new Date().toISOString(),
        sourceUrl: location.href,
        title: document.title,
        viewport: {
          w: window.innerWidth,
          h: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
        },
        mappingVersion: (MAPPING.spec && MAPPING.spec.version) || 'unknown',
        stats: {
          nodesTotal: stats.nodesTotal,
          framesEmitted: stats.framesEmitted,
          textsEmitted: stats.textsEmitted,
          imagesEmitted: stats.imagesEmitted,
          framesCollapsed: stats.framesCollapsed,
          framesFlattened: stats.framesFlattened,
          iconsFallback: stats.iconsFallback,
          tokensBoundColor: stats.tokensBoundColor,
          tokensBoundText: stats.tokensBoundText,
          unmapped: Array.from(stats.unmapped.values()).slice(0, 50),
        },
      },
      root: rootNode,
    };
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    }
    return fallbackCopy(text);
  }
  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (_) {}
    ta.remove();
  }

  function download(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function toast(msg, kind) {
    const el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText = [
      'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
      'z-index:2147483647', 'padding:12px 18px',
      'background:' + (kind === 'err' ? '#cc3300' : '#1a1a1a'), 'color:#fff',
      'font:600 13px/1.4 system-ui,sans-serif',
      'border-radius:6px', 'box-shadow:0 4px 12px rgba(0,0,0,.25)',
      'max-width:80vw', 'white-space:pre-wrap',
    ].join(';');
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }

  // ────────────────────────────────────────────────────────────────────────
  // 7. Entry
  // ────────────────────────────────────────────────────────────────────────

  const DEBUG_TRACE = (typeof window !== 'undefined' && window.__mkDebug) === true;

  async function run() {
    console.log('[mockup-sync] run() start (v2 pixel-mirror)');
    try {
      if (document.fonts && document.fonts.ready) {
        await Promise.race([
          document.fonts.ready,
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      }
    } catch (_) {}
    console.log('[mockup-sync] walking DOM');

    const rootEl = document.body;
    const rootRect = rootEl.getBoundingClientRect();
    // Root node's bounds are relative to itself: x=0, y=0, w=rootRect.w, h=rootRect.h
    const rootParent = { left: rootRect.left, top: rootRect.top };
    const rootNode = captureElement(rootEl, rootParent);
    if (!rootNode) {
      toast('[mockup-sync] nothing captured', 'err');
      return null;
    }

    const envelope = buildEnvelope(rootNode);
    const json = JSON.stringify(envelope, null, 2);
    console.log('[mockup-sync] IR built,', json.length, 'chars');

    // Hosts that don't want clipboard side-effects (e.g. Chrome extension popup
    // handles clipboard/history itself) can set window.__mkSkipClipboard = true.
    if (!(typeof window !== 'undefined' && window.__mkSkipClipboard)) {
      await copyToClipboard(json).catch(() => {});
    }
    if (!(typeof window !== 'undefined' && window.__mkSkipToast)) {
      const s = envelope.meta.stats;
      toast(
        '✓ Mockup Sync captured\n' +
        s.nodesTotal + ' nodes (' + s.framesEmitted + ' frames · ' + s.textsEmitted + ' texts · ' + s.imagesEmitted + ' images)\n' +
        (s.framesCollapsed ? '↺ ' + s.framesCollapsed + ' wrapper frames collapsed\n' : '') +
        (s.framesFlattened ? '⇡ ' + s.framesFlattened + ' text wrappers flattened\n' : '') +
        (s.iconsFallback ? '◇ ' + s.iconsFallback + ' icon placeholders\n' : '') +
        s.tokensBoundColor + ' colors bound · ' + s.tokensBoundText + ' text-styles bound\n' +
        (s.unmapped.length ? '⚠ ' + s.unmapped.length + ' unmapped (see meta.stats.unmapped)\n' : '') +
        'JSON copied to clipboard'
      );
    }
    window.__mkLastCapture = envelope;
    try { window.dispatchEvent(new CustomEvent('mockup-sync:done', { detail: envelope })); } catch (_) {}
    console.log('[mockup-sync] done. stats =', JSON.stringify(envelope.meta.stats));
    return envelope;
  }

  // Expose run() so embedders (Chrome extension) can invoke it explicitly and
  // receive the envelope as a return value.
  if (typeof window !== 'undefined') {
    window.__mkRun = run;
  }

  // Auto-run on injection (preserves bookmarklet behavior). Hosts that prefer
  // to call __mkRun() themselves can set window.__mkSkipAutoRun = true BEFORE
  // injecting this bundle.
  if (typeof window === 'undefined' || window.__mkSkipAutoRun !== true) {
    run();
  }
})();
