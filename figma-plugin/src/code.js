/*
 * Mockup Sync · Figma plugin main thread (v2 pixel-mirror)
 *
 * Sandbox notes (Figma QuickJS):
 *   - NO  optional chaining (?.), NO nullish coalescing (??)
 *   - NO  DOM, NO fetch
 *   - YES classes, async/await, Promise, Map/Set, async iterators
 *
 * Pipeline:
 *   UI sends { type:'import', ir }
 *     → preload local variables + text styles + indexed by name
 *     → preload all fonts referenced in the IR
 *     → render the tree: every node is absolutely positioned (layoutMode=NONE),
 *       children are appended with x/y/resize taken straight from IR.bounds
 *     → bind colors / text styles by exact-or-fuzzy name match if found,
 *       otherwise fall back to raw values
 *   Reply { type:'done', stats } | { type:'error', message }
 */

figma.showUI(__html__, { width: 420, height: 560, themeColors: true });

figma.ui.onmessage = async (msg) => {
  try {
    if (msg && msg.type === 'import') {
      const stats = await runImport(msg.ir);
      figma.ui.postMessage({ type: 'done', stats: stats });
    }
  } catch (err) {
    console.error(err);
    figma.ui.postMessage({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
};

// ─────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────

const state = freshState();

function freshState() {
  return {
    varByName:        new Map(),    // multiple keys per variable (raw, lower, normalized)
    textStyleByName:  new Map(),
    componentByName:  new Map(),    // for icon lookup; multiple keys per component
    fontsLoaded:      new Set(),    // "Family|Style"
    stats: {
      framesRendered:    0,
      textsRendered:     0,
      imagesRendered:    0,
      iconsAsInstance:   0,
      iconsAsSvg:        0,
      colorsBoundToVar:  0,
      colorsRaw:         0,
      textStylesBound:   0,
      textStylesRaw:     0,
      fontsMissing:      [],
      varsMissing:       [],
      componentsMissing: [],
    },
  };
}

function resetState() { Object.assign(state, freshState()); }

// ─────────────────────────────────────────────────────────────────────────
// Entry
// ─────────────────────────────────────────────────────────────────────────

async function runImport(ir) {
  resetState();
  assertShape(ir);

  log('Preloading local variables + text styles…');
  await preload();

  log('Preloading fonts…');
  const fontSet = collectFonts(ir.root);
  for (const f of fontSet) {
    try { await figma.loadFontAsync(f); state.fontsLoaded.add(keyFont(f)); }
    catch (_) {
      const k = keyFont(f);
      if (state.stats.fontsMissing.indexOf(k) === -1) state.stats.fontsMissing.push(k);
    }
  }
  // Always have the safe default loaded so we can fall back without races.
  try { await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }); state.fontsLoaded.add('Inter|Regular'); } catch (_) {}

  log('Rendering tree…');
  const outerFrame = figma.createFrame();
  outerFrame.name = buildRootName(ir);
  outerFrame.layoutMode = 'NONE';
  outerFrame.clipsContent = false;
  outerFrame.fills = [];
  figma.currentPage.appendChild(outerFrame);

  const w = (ir.root && ir.root.bounds && ir.root.bounds.w) || 1440;
  const h = (ir.root && ir.root.bounds && ir.root.bounds.h) || 900;
  outerFrame.resize(Math.max(w, 1), Math.max(h, 1));

  // Root node is rendered as the outer frame's contents.
  await renderNode(ir.root, outerFrame, /*isRoot*/ true);

  positionAtFreeSpot(outerFrame);
  figma.currentPage.selection = [outerFrame];
  figma.viewport.scrollAndZoomIntoView([outerFrame]);

  log('Done.');
  if (state.stats.fontsMissing.length) {
    const list = state.stats.fontsMissing.slice(0, 5).join(', ');
    figma.notify(
      'Missing fonts (text wrapped to fallback): ' + list +
      (state.stats.fontsMissing.length > 5 ? ` +${state.stats.fontsMissing.length - 5}` : ''),
      { timeout: 8000, error: true }
    );
  }
  if (state.stats.iconsAsSvg > 0) {
    const sample = state.stats.componentsMissing.slice(0, 3).join(', ');
    figma.notify(
      'Icons fell back to SVG: ' + state.stats.iconsAsSvg +
      (state.stats.iconsAsInstance > 0 ? ` (instance hits: ${state.stats.iconsAsInstance})` : '') +
      (sample ? ' · missing: ' + sample + (state.stats.componentsMissing.length > 3 ? '…' : '') : ''),
      { timeout: 8000 }
    );
  }
  return state.stats;
}

function buildRootName(ir) {
  // Use the page's <title> verbatim so the Figma frame matches the source —
  // e.g. "Game Key Detail · Mockup". Falls back to a generic name only when
  // the capture didn't include a title (older bundles or non-HTML inputs).
  const title = ir.meta && ir.meta.title ? String(ir.meta.title).trim() : '';
  return title || 'Mockup Sync';
}

function positionAtFreeSpot(frame) {
  const vp = figma.viewport.center;
  frame.x = Math.round(vp.x + 100);
  frame.y = Math.round(vp.y - frame.height / 2);
}

function assertShape(ir) {
  if (!ir || typeof ir !== 'object') throw new Error('IR is not an object');
  if (!ir.version) throw new Error('IR missing "version"');
  if (!ir.root)    throw new Error('IR missing "root"');
  if (!ir.root.type) throw new Error('IR root missing "type"');
  if (!ir.root.bounds) throw new Error('IR root missing "bounds" (capture v2 required)');
}

// ─────────────────────────────────────────────────────────────────────────
// Preload: variables + text styles
// ─────────────────────────────────────────────────────────────────────────

async function preload() {
  try {
    const vars = await figma.variables.getLocalVariablesAsync();
    for (const v of vars) indexVar(v);
    log('variables · local=' + vars.length);
  } catch (e) { log('getLocalVariablesAsync failed: ' + e.message); }

  // Best-effort: pull library variables too (so library-mode files work)
  try {
    if (figma.teamLibrary && figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync) {
      const cols = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
      for (const col of cols) {
        const libVars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(col.key);
        for (const lv of libVars) {
          try {
            const imported = await figma.variables.importVariableByKeyAsync(lv.key);
            indexVar(imported);
          } catch (_) {}
        }
      }
    }
  } catch (e) { log('library variables probe failed: ' + e.message); }

  try {
    const styles = await figma.getLocalTextStylesAsync();
    for (const s of styles) indexTextStyle(s);
    log('textStyles · local=' + styles.length);
  } catch (e) { log('getLocalTextStylesAsync failed: ' + e.message); }

  // Components (icon lookup). In dynamic-page mode we must load all pages
  // before findAllWithCriteria works.
  try {
    if (figma.loadAllPagesAsync) await figma.loadAllPagesAsync();
  } catch (e) { log('loadAllPagesAsync failed: ' + e.message); }
  try {
    const comps = figma.root.findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
    for (const c of comps) indexComponent(c);
    log('components · indexed=' + comps.length);
  } catch (e) { log('component scan failed: ' + e.message); }
}

function normalizeKey(name) {
  if (!name) return '';
  return String(name).toLowerCase().replace(/\s+/g, '').replace(/[-_]/g, '/');
}

function indexVar(v) {
  if (!v) return;
  state.varByName.set(v.name, v);
  state.varByName.set(v.name.toLowerCase(), v);
  state.varByName.set(normalizeKey(v.name), v);
}

function indexTextStyle(s) {
  if (!s) return;
  state.textStyleByName.set(s.name, s);
  state.textStyleByName.set(s.name.toLowerCase(), s);
  state.textStyleByName.set(normalizeKey(s.name), s);
}

function indexComponent(c) {
  if (!c) return;
  state.componentByName.set(c.name, c);
  state.componentByName.set(c.name.toLowerCase(), c);
  state.componentByName.set(normalizeKey(c.name), c);
}

function findVar(name) {
  if (!name) return null;
  return state.varByName.get(name)
      || state.varByName.get(String(name).toLowerCase())
      || state.varByName.get(normalizeKey(name))
      || null;
}

function findTextStyle(name) {
  if (!name) return null;
  return state.textStyleByName.get(name)
      || state.textStyleByName.get(String(name).toLowerCase())
      || state.textStyleByName.get(normalizeKey(name))
      || null;
}

function findComponent(name) {
  if (!name) return null;
  return state.componentByName.get(name)
      || state.componentByName.get(String(name).toLowerCase())
      || state.componentByName.get(normalizeKey(name))
      || null;
}

/**
 * Try to resolve an iconoir-XXX style name to a Figma component in the file.
 * Tries common naming patterns: "Icon/plus", "icon/plus", "Plus", etc.
 * Returns ComponentNode | ComponentSetNode | null.
 */
function findIconComponent(iconName) {
  if (!iconName) return null;
  const cap = iconName.charAt(0).toUpperCase() + iconName.slice(1);
  const titleized = iconName.split('-')
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(' ');
  const candidates = [
    'Icon/' + iconName,
    'Icons/' + iconName,
    'icon/' + iconName,
    'Icon/' + cap,
    'Icons/' + cap,
    'Icon/' + titleized,
    'Icons/' + titleized,
    'Icon=' + iconName,        // ComponentSet variant style
    iconName,
    cap,
    titleized,
  ];
  for (const cand of candidates) {
    const found = findComponent(cand);
    if (found) return found;
  }
  return null;
}

function recordVarMiss(name) {
  if (state.stats.varsMissing.indexOf(name) === -1) state.stats.varsMissing.push(name);
}

// ─────────────────────────────────────────────────────────────────────────
// Font collection (walk IR, dedupe Family|Style requests)
// ─────────────────────────────────────────────────────────────────────────

function collectFonts(node) {
  const set = new Map();
  function walk(n) {
    if (!n) return;
    if (n.type === 'text' && n.style) {
      const fam = n.style.fontFamily || 'Inter';
      const style = weightToStyle(n.style.fontWeight, false /* italic detection later */);
      const key = fam + '|' + style;
      if (!set.has(key)) set.set(key, { family: fam, style: style });
    }
    if (n.children) for (const c of n.children) walk(c);
  }
  walk(node);
  return Array.from(set.values());
}

function keyFont(f) { return f.family + '|' + f.style; }

function weightToStyle(weight, italic) {
  const w = Number(weight) || 400;
  let base;
  if (w <= 100) base = 'Thin';
  else if (w <= 200) base = 'ExtraLight';
  else if (w <= 300) base = 'Light';
  else if (w <= 400) base = 'Regular';
  else if (w <= 500) base = 'Medium';
  else if (w <= 600) base = 'SemiBold';
  else if (w <= 700) base = 'Bold';
  else if (w <= 800) base = 'ExtraBold';
  else base = 'Black';
  if (italic) base = (base === 'Regular') ? 'Italic' : (base + ' Italic');
  return base;
}

// ─────────────────────────────────────────────────────────────────────────
// Render
// ─────────────────────────────────────────────────────────────────────────

async function renderNode(ir, parent, isRoot) {
  if (!ir || !ir.type) return null;

  // Icon-fallback: route to a dedicated renderer that instantiates the
  // canonical placeholder component ("Icon/fallback·ticket") instead of
  // letting the empty frame fall through. This keeps the canvas tidy and
  // gives the designer a single visual cue to swap in the real icon.
  if (ir._iconFallback) return renderIconFallback(ir, parent);

  if (ir.type === 'frame')  return renderFrame(ir, parent, isRoot);
  if (ir.type === 'text')   return renderText(ir, parent);
  if (ir.type === 'image')  return renderImage(ir, parent);
  if (ir.type === 'svg')    return renderSvg(ir, parent);
  return null;
}

// Canonical placeholder component used when the browser side flagged a node
// as `_iconFallback` (mask extraction failed). Designers swap this for the
// real icon by reading the node name (which preserves the original icon name
// like "icon-fallback·plus").
const ICON_FALLBACK_COMPONENT = 'Icon/fallback·ticket';

/**
 * Render an icon-fallback IR node. Tries to instantiate the canonical
 * `Icon/fallback·ticket` component from the current file. If the component
 * is missing, falls back to an amber dashed-outline frame so the slot is
 * still visible and clickable for manual fix-up.
 */
async function renderIconFallback(ir, parent) {
  const b = ir.bounds || { x: 0, y: 0, w: 16, h: 16 };
  const comp = findComponent(ICON_FALLBACK_COMPONENT);
  let node = null;

  if (comp) {
    const target = comp.type === 'COMPONENT_SET'
      ? (comp.defaultVariant || comp.children[0])
      : comp;
    try { node = target.createInstance(); } catch (_) { node = null; }
  } else {
    if (state.stats.componentsMissing.indexOf(ICON_FALLBACK_COMPONENT) === -1) {
      state.stats.componentsMissing.push(ICON_FALLBACK_COMPONENT);
    }
  }

  // Fallback path: amber dashed placeholder frame (only if component missing).
  if (!node) {
    node = figma.createFrame();
    node.layoutMode = 'NONE';
    node.clipsContent = false;
    try {
      node.fills  = [{ type: 'SOLID', color: { r: 0.95, g: 0.85, b: 0.4 }, opacity: 0.18 }];
      node.strokes = [{ type: 'SOLID', color: { r: 0.85, g: 0.55, b: 0.1 } }];
      node.strokeWeight = 1;
      node.dashPattern = [3, 2];
    } catch (_) {}
  }

  parent.appendChild(node);
  node.name = ir.name || 'icon-fallback';
  node.x = b.x; node.y = b.y;
  try { node.resize(Math.max(b.w, 1), Math.max(b.h, 1)); } catch (_) {}

  state.stats.iconsFallback = (state.stats.iconsFallback || 0) + 1;
  return node;
}

async function renderFrame(ir, parent, isRoot) {
  let frame;
  if (isRoot) {
    // Root reuses the outer frame, just sets style on it
    frame = parent;
  } else {
    frame = figma.createFrame();
    frame.layoutMode = 'NONE';
    frame.clipsContent = false;
    frame.fills = [];
    parent.appendChild(frame);
  }
  frame.name = ir.name || 'frame';

  if (!isRoot) {
    const b = ir.bounds || { x: 0, y: 0, w: 1, h: 1 };
    frame.x = b.x; frame.y = b.y;
    frame.resize(Math.max(b.w, 1), Math.max(b.h, 1));
  }

  applyFrameStyle(frame, ir.style, ir.bounds);
  state.stats.framesRendered++;

  if (ir.children && ir.children.length) {
    for (const c of ir.children) {
      await renderNode(c, frame, false);
    }
  }
  return frame;
}

async function renderText(ir, parent) {
  const t = figma.createText();
  parent.appendChild(t);
  t.name = ir.name || 'text';

  const style = ir.style || {};
  // Resolve font + load if not preloaded
  const family = style.fontFamily || 'Inter';
  let fontStyle = weightToStyle(style.fontWeight, false);
  let fontName  = { family: family, style: fontStyle };
  if (!state.fontsLoaded.has(keyFont(fontName))) {
    try { await figma.loadFontAsync(fontName); state.fontsLoaded.add(keyFont(fontName)); }
    catch (_) {
      fontName = { family: 'Inter', style: 'Regular' };
      try { await figma.loadFontAsync(fontName); } catch (_) {}
    }
  }
  try { t.fontName = fontName; } catch (_) {}
  try { t.characters = ir.characters || ''; } catch (_) { /* font may not support chars */ }

  // Bind text style if a same-named one exists
  let bound = false;
  if (style.textStyle) {
    const ts = findTextStyle(style.textStyle);
    if (ts) {
      try { await t.setTextStyleIdAsync(ts.id); bound = true; state.stats.textStylesBound++; } catch (_) {}
    }
    if (!bound) recordVarMiss('textStyle:' + style.textStyle);
  }
  if (!bound) {
    state.stats.textStylesRaw++;
    if (style.fontSize) try { t.fontSize = style.fontSize; } catch (_) {}
    if (style.lineHeight && style.lineHeight !== 'normal') {
      try { t.lineHeight = parseLineHeight(style.lineHeight, style.fontSize); } catch (_) {}
    }
    if (style.letterSpacing) {
      try { t.letterSpacing = { unit: 'PIXELS', value: style.letterSpacing }; } catch (_) {}
    }
  }

  // Color fill (always — even when text style is bound, the IR color is per-instance)
  if (style.fill) applyTextFill(t, style.fill);

  if (style.textAlign) try { t.textAlignHorizontal = style.textAlign; } catch (_) {}
  if (style.textDecoration) try { t.textDecoration = style.textDecoration; } catch (_) {}

  // Position + size.
  //
  // The captured `bounds` come from the browser's Range API on the original
  // font. If the Figma file is missing that exact font (e.g. "Balsamiq Sans"
  // not installed → silently falls back to Inter), the same string will
  // measure WIDER and wrap to a new line if we pin width=bounds.w.
  //
  // Heuristic: if the source rendered single-line (bounds.h <= ~1.5×fontSize),
  // let Figma auto-size width too — preserves "New Item" as one line even
  // when the font fell back. For paragraphs we keep the original wrapping
  // by pinning width.
  const b = ir.bounds || { x: 0, y: 0, w: 1, h: 1 };
  const fs = (style.fontSize || 12);
  const looksSingleLine = b.h <= fs * 1.6;
  try {
    if (looksSingleLine) {
      t.textAutoResize = 'WIDTH_AND_HEIGHT';
    } else {
      t.textAutoResize = 'HEIGHT';
      t.resize(Math.max(b.w, 1), t.height);
    }
  } catch (_) {}
  t.x = b.x; t.y = b.y;

  state.stats.textsRendered++;
  return t;
}

async function renderImage(ir, parent) {
  // Phase 1 capture doesn't fetch dataUrl yet; render a labeled placeholder.
  const f = figma.createFrame();
  parent.appendChild(f);
  f.name = ir.name || 'image';
  const b = ir.bounds || { x: 0, y: 0, w: 100, h: 100 };
  f.x = b.x; f.y = b.y;
  f.resize(Math.max(b.w, 1), Math.max(b.h, 1));
  f.layoutMode = 'NONE';
  f.fills = [{ type: 'SOLID', color: { r: 0.93, g: 0.93, b: 0.93 } }];
  f.strokes = [{ type: 'SOLID', color: { r: 0.7, g: 0.7, b: 0.7 } }];
  f.strokeWeight = 1;
  f.dashPattern = [4, 3];
  // Add an alt-text label inside if there's room
  if (b.w >= 60 && b.h >= 20 && (ir.alt || ir.src)) {
    try {
      await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
      const t = figma.createText();
      f.appendChild(t);
      t.fontName = { family: 'Inter', style: 'Regular' };
      t.fontSize = 10;
      t.characters = ir.alt || basenameOf(ir.src);
      t.fills = [{ type: 'SOLID', color: { r: 0.4, g: 0.4, b: 0.4 } }];
      t.x = 6; t.y = 6;
    } catch (_) {}
  }
  state.stats.imagesRendered++;
  return f;
}

function basenameOf(url) {
  if (!url) return 'image';
  try {
    const noQuery = url.split('?')[0];
    const parts = noQuery.split('/');
    return parts[parts.length - 1] || 'image';
  } catch (_) { return 'image'; }
}

/**
 * Vector icon rendering.
 *
 * Lookup order:
 *   1. If the IR carries `_icon.name` (e.g. "plus"), try to find a matching
 *      component in the current file ("Icon/plus", "Plus", etc.) and create
 *      an instance. This way the user's curated icon library wins.
 *   2. Otherwise (or if no match), fall back to embedding the captured SVG
 *      via `createNodeFromSvg()` so the layout slot is still filled.
 *
 * Either way we set bounds and re-apply the token-bound colour.
 */
async function renderSvg(ir, parent) {
  const b = ir.bounds || { x: 0, y: 0, w: 16, h: 16 };
  const iconName = ir._icon && ir._icon.name;
  let node = null;
  let viaInstance = false;

  if (iconName) {
    const comp = findIconComponent(iconName);
    if (comp) {
      const target = comp.type === 'COMPONENT_SET'
        ? (comp.defaultVariant || comp.children[0])
        : comp;
      try {
        node = target.createInstance();
        viaInstance = true;
      } catch (_) {
        node = null;
      }
    } else {
      if (state.stats.componentsMissing.indexOf('Icon/' + iconName) === -1) {
        state.stats.componentsMissing.push('Icon/' + iconName);
      }
    }
  }

  // Fallback: render captured SVG inline (vector subtree)
  if (!node) {
    try {
      node = figma.createNodeFromSvg(ir.svg || '');
    } catch (_) {
      node = figma.createFrame();
      node.fills = [{ type: 'SOLID', color: { r: 0.85, g: 0.85, b: 0.85 } }];
    }
  }

  parent.appendChild(node);
  node.name = ir.name || 'icon';
  node.x = b.x; node.y = b.y;
  try { node.resize(Math.max(b.w, 1), Math.max(b.h, 1)); } catch (_) {}

  // Re-apply the token-bound colour. For instances this targets fill overrides
  // on vector children (skipped if the component has no editable color).
  if (ir.fill) {
    const paint = paintFromIr(ir.fill);
    if (paint) applyFillToVectors(node, paint);
  }

  if (viaInstance) state.stats.iconsAsInstance++;
  else             state.stats.iconsAsSvg++;
  state.stats.imagesRendered++;
  return node;
}

/**
 * Re-apply a token-bound colour to all vector descendants.
 *
 * Only update channels that already exist:
 *   - if a vector has visible fills → swap fill colour
 *   - if a vector has visible strokes → swap stroke colour
 *   - if it has neither (rare) → leave alone
 *
 * This preserves outline-style icons (stroke only) — without this gate we
 * were filling the inside of every shape solid black.
 */
function applyFillToVectors(node, paint) {
  if (!node) return;
  const isVectorish =
    node.type === 'VECTOR' || node.type === 'BOOLEAN_OPERATION' ||
    node.type === 'STAR'   || node.type === 'POLYGON' ||
    node.type === 'ELLIPSE'|| node.type === 'RECTANGLE' || node.type === 'LINE';
  if (isVectorish) {
    if (hasVisibleSolid(node.fills)) {
      try { node.fills = [paint]; } catch (_) {}
    }
    if (hasVisibleSolid(node.strokes)) {
      try { node.strokes = [paint]; } catch (_) {}
    }
  }
  if (node.children && node.children.length) {
    for (const c of node.children) applyFillToVectors(c, paint);
  }
}

function hasVisibleSolid(paints) {
  if (!paints) return false;
  if (paints === figma.mixed) return true; // mixed → assume something to recolor
  if (!Array.isArray(paints) || paints.length === 0) return false;
  for (const p of paints) {
    if (!p) continue;
    if (p.visible === false) continue;
    if (p.type === 'SOLID' || p.type === 'IMAGE' || p.type && p.type.indexOf('GRADIENT') === 0) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────
// Style application
// ─────────────────────────────────────────────────────────────────────────

function applyFrameStyle(frame, style, bounds) {
  if (!style) { frame.fills = []; return; }

  // Fill
  if (style.fill) {
    const paint = paintFromIr(style.fill);
    if (paint) frame.fills = [paint];
    else frame.fills = [];
  } else {
    frame.fills = [];
  }

  // Stroke
  if (style.stroke && style.stroke.paint) {
    const sp = paintFromIr(style.stroke.paint);
    if (sp) {
      frame.strokes = [sp];
      if (style.stroke.weight) try { frame.strokeWeight = style.stroke.weight; } catch (_) {}
      if (style.stroke.align)  try { frame.strokeAlign  = style.stroke.align;  } catch (_) {}
    }
  } else if (style.strokeSides && style.strokeSides.paint) {
    // Per-side stroke widths — used for tabs (no bottom border so the active
    // tab merges with the panel) and for cells inside a border-collapse table
    // (so we don't double-paint shared edges).
    const sp = paintFromIr(style.strokeSides.paint);
    if (sp) {
      frame.strokes = [sp];
      try { frame.strokeAlign = 'INSIDE'; } catch (_) {}
      const sides = style.strokeSides;
      // Set the canonical weight to the largest side so Figma's "single
      // weight" fallback (older API) still draws something visible.
      const max = Math.max(sides.top || 0, sides.right || 0, sides.bottom || 0, sides.left || 0);
      if (max > 0) try { frame.strokeWeight = max; } catch (_) {}
      try { frame.strokeTopWeight    = sides.top    || 0; } catch (_) {}
      try { frame.strokeRightWeight  = sides.right  || 0; } catch (_) {}
      try { frame.strokeBottomWeight = sides.bottom || 0; } catch (_) {}
      try { frame.strokeLeftWeight   = sides.left   || 0; } catch (_) {}
    }
  }

  // Dashed / dotted border textures
  if (style.dashPattern && Array.isArray(style.dashPattern)) {
    try { frame.dashPattern = style.dashPattern; } catch (_) {}
  }

  // Radius (px / percent / per-corner)
  if (style.radius) {
    if (style.radius.percent != null && bounds) {
      const half = Math.min(bounds.w, bounds.h) * (style.radius.percent / 100);
      try { frame.cornerRadius = half; } catch (_) {}
    } else if (style.radius.px != null) {
      try { frame.cornerRadius = style.radius.px; } catch (_) {}
    } else if (style.radius.corners) {
      // Tabs and other directional shapes round only some corners.
      const c = style.radius.corners;
      try { frame.topLeftRadius     = c.tl || 0; } catch (_) {}
      try { frame.topRightRadius    = c.tr || 0; } catch (_) {}
      try { frame.bottomRightRadius = c.br || 0; } catch (_) {}
      try { frame.bottomLeftRadius  = c.bl || 0; } catch (_) {}
    }
  }

  // Opacity
  if (style.opacity != null) try { frame.opacity = style.opacity; } catch (_) {}

  // Box shadow → effects
  if (style.boxShadow) {
    const effects = parseBoxShadow(style.boxShadow);
    if (effects.length) try { frame.effects = effects; } catch (_) {}
  }
}

function applyTextFill(t, fillIr) {
  const paint = paintFromIr(fillIr);
  if (!paint) return;
  try { t.fills = [paint]; } catch (_) {}
}

/** Convert an IR paint ({var, hex, opacity}) into a Figma SolidPaint, binding the variable if present. */
function paintFromIr(ir) {
  if (!ir) return null;
  let paint;
  if (ir.hex) {
    paint = { type: 'SOLID', color: hexToRgb(ir.hex) };
    if (ir.opacity != null) paint.opacity = ir.opacity;
  } else {
    paint = { type: 'SOLID', color: { r: 0.5, g: 0.5, b: 0.5 } };
    if (ir.opacity != null) paint.opacity = ir.opacity;
  }
  // Skip the variable binding when the paint is semi-transparent. Figma
  // variables only carry RGB; binding here would either lose the alpha (Figma
  // resets opacity when the bound color resolves) or, if the variable can't
  // be found in this file, leave us on the gray fallback above. New captures
  // already withhold `var` in this case, but old IRs in clipboards / files
  // still have it — handle them defensively here.
  const hasAlpha = ir.opacity != null && ir.opacity < 1;
  if (ir.var && !hasAlpha) {
    const v = findVar(ir.var);
    if (v) {
      try {
        paint = figma.variables.setBoundVariableForPaint(paint, 'color', v);
        state.stats.colorsBoundToVar++;
        return paint;
      } catch (_) { /* fall through to raw */ }
    } else {
      recordVarMiss(ir.var);
    }
  }
  state.stats.colorsRaw++;
  return paint;
}

function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  const v = (h.length === 3) ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  return { r: r, g: g, b: b };
}

function parseLineHeight(raw, fontSizePx) {
  // CSS values: "normal" | "<n>px" | "<n>" (unitless multiplier)
  if (!raw || raw === 'normal') return { unit: 'AUTO' };
  const s = String(raw).trim();
  if (/px$/.test(s)) return { unit: 'PIXELS', value: parseFloat(s) };
  const n = parseFloat(s);
  if (Number.isFinite(n) && fontSizePx) return { unit: 'PIXELS', value: n * fontSizePx };
  return { unit: 'AUTO' };
}

/**
 * Minimal CSS box-shadow parser.
 * Handles: "Xpx Ypx Zpx [Wpx] rgb[a](...)". Supports comma-separated multiple
 * shadows. Inset, currentColor, and other esoteric forms are skipped.
 */
function parseBoxShadow(raw) {
  if (!raw || raw === 'none') return [];
  // Split on top-level commas (commas inside rgb(...) must be ignored)
  const parts = [];
  let depth = 0, buf = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(buf); buf = ''; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf);

  const effects = [];
  for (const p of parts) {
    const txt = p.trim();
    if (!txt || /\binset\b/.test(txt)) continue;
    // Pull out rgb/rgba(...)
    const cm = txt.match(/rgba?\(([^)]+)\)/);
    if (!cm) continue;
    const rest = txt.replace(cm[0], '').trim();
    const nums = rest.match(/-?\d+(\.\d+)?(px)?/g) || [];
    if (nums.length < 2) continue;
    const x = parseFloat(nums[0]) || 0;
    const y = parseFloat(nums[1]) || 0;
    const blur = nums[2] ? parseFloat(nums[2]) : 0;
    // nums[3] would be spread; Figma supports it
    const spread = nums[3] ? parseFloat(nums[3]) : 0;
    const rgb = cm[1].split(',').map((s) => s.trim());
    const r = (parseInt(rgb[0], 10) || 0) / 255;
    const g = (parseInt(rgb[1], 10) || 0) / 255;
    const b = (parseInt(rgb[2], 10) || 0) / 255;
    const a = rgb[3] != null ? parseFloat(rgb[3]) : 1;
    effects.push({
      type: 'DROP_SHADOW',
      offset: { x: x, y: y },
      radius: blur,
      spread: spread,
      color: { r: r, g: g, b: b, a: a },
      blendMode: 'NORMAL',
      visible: true,
    });
  }
  return effects;
}

// ─────────────────────────────────────────────────────────────────────────
// Logging
// ─────────────────────────────────────────────────────────────────────────

function log(msg) {
  console.log('[mockup-sync] ' + msg);
  try { figma.ui.postMessage({ type: 'log', message: msg }); } catch (_) {}
}
