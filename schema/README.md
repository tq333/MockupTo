# Mockup Sync IR v1 · Contract

This folder defines the **Intermediate Representation** — the single JSON format exchanged between the two halves of Mockup Sync.

```
┌────────────────────────┐       ir.v1.json       ┌────────────────────────┐
│  Producer              │  ──────────────────▶   │  Consumer              │
│  bookmarklet/capture.js│                        │  figma-plugin/code.js  │
│  (browser)             │                        │  (Figma main thread)   │
└────────────────────────┘                        └────────────────────────┘
```

- `ir.v1.schema.json` — JSON Schema (draft-07). Both ends MUST validate against it. Breaking changes bump the `version` field.
- `ir.v1.example.json` — A realistic capture of a `<div class="card">…<button class="btn btn-primary btn-sm">…` fragment, annotated.

---

## Core design rules

### 1. Three node types cover 95% of cases

| `type` | Meaning | Children? | Figma output |
|---|---|---|---|
| `frame` | Generic container (div that didn't match any mapping.components) | Yes | `figma.createFrame()`, Auto Layout if `layout.mode != NONE` |
| `text` | Leaf text | No | `figma.createText()` |
| `instance` | Matched a rule in `mapping.components[*]` | **No** — content lives in `slots` | `component.createInstance()` + `setProperties(slots)` |
| `icon` | Standalone iconoir glyph outside any slot | No | Icon component instance, fallback to text |
| `image` | `<img>` or CSS background-image | No | Image fill on a frame |

### 2. Instance nodes do NOT have `children` — only `slots`

This is the single most important rule. When the capture hits a matched component (e.g. a button), it stops descending into the DOM and packages all contents into the `slots` field, each slot name matching `mapping.components[*].slots`. The Figma plugin then calls `instance.setProperties({...})` with these values.

**Why**: Figma component instances are opaque — their inner nodes are owned by the component definition. We can only override what the component exposes as a Component Property. Trying to emit children would either (a) fail silently or (b) force a detach, losing the point of using components.

### 3. Every value that could bind to a token carries `{ var: "..." }`

All paint / spacing / radius / shadow / text fields prefer a `{ var: "color/ink" }` form. If capture-time reverse lookup fails, it falls back to the literal form (`{ hex: "#..." }` or `{ px: 8 }`) **and sets `_miss: true`**. The Figma plugin aggregates all `_miss` markers into the import summary panel so you see exactly which values failed to bind.

### 4. Layout has two mutually exclusive modes

- `layout.mode != "NONE"` → Auto Layout. Children's `bounds` are ignored.
- `layout` absent or `mode === "NONE"` → children are placed by their `bounds.x/y`. Use this for CSS `position: absolute/fixed` and rare non-flex content.

Prefer Auto Layout — it makes the output editable. Absolute positioning is a fallback, not the default.

### 5. `_miss` flags, not errors

If a color doesn't match any token, we don't throw — we set `_miss: true` and keep the raw hex. The import still succeeds; the summary panel tells you what to fix in the Demo or in the token table.

---

## Minimal "hello world" IR

The smallest valid IR:

```json
{
  "version": "1.0.0",
  "meta": {
    "capturedAt": "2026-05-07T14:00:00Z",
    "viewport":   { "w": 1440, "h": 900 },
    "mappingVersion": "1.0.0"
  },
  "root": {
    "type": "text",
    "characters": "Hello Figma",
    "style": {
      "textStyle": "text/md-regular",
      "fill": { "var": "color/ink" }
    }
  }
}
```

---

## Validation

```bash
# in mockup-sync/ (after npm init; zero deps yet)
npx ajv-cli validate -s schema/ir.v1.schema.json -d schema/ir.v1.example.json
```

Both ends should call this in CI / dev loop.

---

## Non-goals for v1

- No animation / interaction state description.
- No CSS grid semantics (collapsed into frame + bounds).
- No pseudo-elements (`::before`, `::after`) — best-effort inlining.
- No `<svg>` reconstruction — captured as image fallback.
- No responsive breakpoints in a single IR — one capture = one viewport.

These may show up in a future v2 if needed.
