# Mockup Sync · HTML Demo → Figma 轻量反写工具

> 创建：2026-05-07
> 定位：替代 `mockup-kit-plugin/` 那条复杂路线的新主线
> 一句话：**浏览器里一键 capture → 拿到 IR JSON → Figma 插件读 JSON，全量绑 token + 命中的组件实例用 Component Property override 塞 H5 内容**

---

## 0. 为什么重做（和旧插件的区别）

旧的 `mockup-kit-plugin` 想在 Figma sandbox 里同时解决三件事——**解析 HTML + 像素对齐 + 组件命中 + token 绑定**。问题：

- Figma QuickJS 没 DOM、没 fetch、不支持 `??` / `?.`，被迫在 UI iframe 里再开 sandbox iframe 去抓 `getComputedStyle`，层层 postMessage，脆弱且慢
- Hybrid 渲染"像素骨架 + 命中组件"叠加后，**整体是死 frame**，只有命中的 instance 可编辑，可编辑性的收益非常低
- 想做的事太多，每一项都只做到 70 分

**新工具的简化思路**：

| 维度 | 旧插件 | 新工具 |
|---|---|---|
| 入口 | Figma 插件粘贴 HTML | 浏览器里打开 Demo 按一下 capture |
| HTML 解析 | Figma UI iframe 里跑 | 浏览器原生页面直接 `getComputedStyle` / `getBoundingClientRect` |
| 中间产物 | 内存里的 IR | **标准化 IR JSON 文件**（可存、可复用、可人肉改） |
| 像素对齐 | 追求全页 1:1 | **不追求**。只在 component 之间用 Auto Layout，命中不到的地方才退化到绝对坐标 |
| 组件命中 | 命名匹配 + 启发式 | **仅名称匹配**，命中不到就老老实实用 frame + token |
| 组件内容 | variant 试图硬对齐 | **Component Property override** 把 H5 文本/图标直接写进 instance prop |

---

## 1. 能力盘点（现有资产，不要重复造）

| 资产 | 路径 | 在新工具里的角色 |
|---|---|---|
| Mockup Kit 规范样张 | `mockup-kit.html` | AI / 人写 Demo 的唯一参考 |
| Token + 组件 mapping | `mockup-kit.mapping.json` | **新工具的唯一真源**，浏览器端 + Figma 端共读 |
| Figma Library | 用户 Figma 文件 | 已经按 mapping 对齐了 token 和常用组件（Button / Input / Tag ...） |
| Figma 官方 capture.js | `web-to-figma-main/capture.js` | **浏览器侧抓取的技术底座**，不自己写抓取算法 |
| Paidax 扩展壳 | `web-to-figma-main/` 其余文件 | 可参考的 Chrome 扩展 UI / 懒加载滚动 / 跨域图片 fetch 方案 |

---

## 2. 架构（两端 + 一个中间格式）

```
┌────────────────────────────────────────────────────────────────────┐
│  浏览器端（Chrome Extension 或 一段 bookmarklet）                   │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ 1. 用户打开任何 Mockup Kit 规范生成的 H5 Demo                │  │
│  │ 2. 点插件按钮 → 注入 capture.js                              │  │
│  │ 3. capture 阶段：                                            │  │
│  │    · 等 document.fonts.ready                                 │  │
│  │    · 遍历 DOM：抓 tagName / className / textContent          │  │
│  │      + getBoundingClientRect + getComputedStyle              │  │
│  │    · 图片 URL → fetch → base64 内联                          │  │
│  │ 4. 按 mapping.json 预处理：                                  │  │
│  │    · hex → token 名（色彩反查）                              │  │
│  │    · px 字号 → TextStyle 名                                  │  │
│  │    · class="btn btn-danger" → ruleId="button" + variants     │  │
│  │    · 子节点内容（文案/placeholder）提为 prop override 值     │  │
│  │ 5. 产出 IR JSON → 下载 / 复制到剪贴板 / 直接 POST            │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────┬───────────────────────────────────────────┘
                         │
                         ▼  IR JSON（见 §4）
┌────────────────────────────────────────────────────────────────────┐
│  Figma 插件端（仅 300 行级别）                                      │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ 1. UI：textarea 粘 JSON / 拖入 .json 文件                    │  │
│  │ 2. main thread：                                             │  │
│  │    · 按 IR 递归建节点                                        │  │
│  │    · token 字段 → setBoundVariable*                          │  │
│  │    · ruleId 命中 → importComponentByKey + createInstance +   │  │
│  │      setProperties({...override})                            │  │
│  │    · 未命中 → 普通 frame + 样式里凡是能 token 化的都 token   │  │
│  │    · 布局：优先 Auto Layout；IR 明确标 position:absolute     │  │
│  │      或命中不到时才用 x/y/resize                              │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────┘
```

**关键设计哲学**：

- **浏览器扛复杂度**。DOM 解析、字体等待、图片跨域、样式 computed——全在浏览器原生环境解决，不带进 Figma sandbox
- **IR JSON 是合同**。它是可读、可存、可手改的中间产物。抓一次可以 import 无数次；也可以人工改了再 import
- **Figma 插件是哑的**。只干两件事：按 schema 建节点、按名字查组件/变量。没有 DOM 解析、没有跨域、没有 iframe

---

## 3. 核心规则（三条，其他都是展开）

### 规则 A：Token 绑定是 100% 兜底

- 颜色：mapping.colors[*].value 精确 hex 匹配 → 强制 `setBoundVariableForPaint`
- 字号：mapping.typography 匹配到 `figmaTextStyle` → 强制 `textStyleId`
- 间距/圆角：`padding` / `gap` / `cornerRadius` 命中 spacing/radii 表 → 绑变量
- **匹配不到不是错误**，降级到 raw 值但在 IR 里加 `_miss: true` 标记，最后汇总告警

### 规则 B：组件命中 = 根 class 匹配（复用现有规范）

你的 `mockup-kit.html` 和 `mockup-kit.mapping.json` 已经用 class 做了清晰的组件标识：`.btn` / `.tag` / `.inp` / `.card` / `.alert` ...，且 mapping 里 `matchingPolicy.componentDetection = "class-based"` 就是按 class 匹配。**直接复用，不改规范**。

- 每个组件在 mapping.components 里声明自己的**根 class**（如 button → `.btn`，tag → `.tag`）
- Variant 从 class 后缀解析：`btn-primary` → `type=primary`，`btn-lg` → `size=lg`（mapping 里定义前缀和枚举）
- 命中 → 整个子树被"打包"成 instance，不再下钻 render 子节点
- 未命中 → 当作 frame，继续递归 render 子节点
- **未来扩展**：如果某天出现 class 歧义（如 `.btn` 想复用样式但不想被识别为组件），再引入 `data-mk-ignore` 或 `data-mk="xxx"` 做显式覆盖，**现在不做**

### 规则 C：组件内容 = Component Property override

**这是和旧方案最大的不同**。不 detach、不贴叠加层，全走 Figma component property：

```
<button class="btn btn-primary">
  <i class="iconoir-arrow-right"></i>
  提交
</button>
         ↓  IR
{
  "type": "instance",
  "ruleId": "button",
  "variants": { "type": "primary" },
  "props": {
    "label":   { "sourceProp": "Label",   "value": "提交" },
    "icon":    { "sourceProp": "Icon",    "value": { "type": "INSTANCE_SWAP", "componentName": "Icon/arrow-right" } }
  }
}
         ↓  Figma
instance.setProperties({
  "Label#123:0": "提交",
  "Icon#456:0":  iconComponent.id
})
```

**前置条件**（要和 Figma library 对齐）：每个想被命中的组件，必须在 Figma 里把文案/图标/状态都暴露成 component property。mapping.json 里要为每个 component 声明 props 清单，见 §5。

---

## 4. IR Schema v3（精简版）

去掉旧版里 bounds 的强依赖，改成"布局能用 Auto Layout 就用"的递进：

```jsonc
{
  "$schema": "mockup-sync-ir.v3.json",
  "meta": {
    "capturedAt": "2026-05-07T14:00:00Z",
    "sourceUrl": "http://localhost:3000/checkout",
    "viewport": { "w": 375, "h": 812 },
    "mappingVersion": "1.0.0"
  },
  "root": {
    "type": "frame",             // frame | text | instance | image | icon
    "name": "checkout-page",
    "layout": {
      "mode": "VERTICAL",         // NONE | HORIZONTAL | VERTICAL
      "gap":     { "var": "spacing/4" },
      "padding": { "top": { "var": "spacing/6" }, "right": {...}, "bottom": {...}, "left": {...} },
      "align":   "CENTER",
      "sizing":  { "w": "FILL", "h": "HUG" }  // FIXED(n) | FILL | HUG
    },
    "style": {
      "fill":   { "var": "color/surface" },
      "stroke": { "var": "color/border", "weight": 2 },
      "radius": { "var": "radius/default" },
      "shadow": { "effectStyle": "shadow/default" }
    },
    "bounds": null,                 // 仅 layout.mode=NONE 时需要 x/y/w/h
    "children": [ ... ]
  }
}
```

text 节点：

```jsonc
{
  "type": "text",
  "characters": "订单详情",
  "style": {
    "textStyle": "text/lg-bold",              // 命中 → 优先走 textStyleId
    "fill": { "var": "color/ink" },
    "textAlign": "LEFT",
    "_raw": { "fontSize": 18, "weight": 700 }  // 命中不到时的兜底
  }
}
```

instance 节点（命中 mapping.components）：

```jsonc
{
  "type": "instance",
  "ruleId": "button",                 // = mapping.components[*].id
  "componentName": "Button",          // Figma library 里的 name（mapping 里声明）
  "variants": { "type": "primary", "size": "md", "state": "default" },
  "props": {
    "Label": "提交",
    "Icon":  { "swap": "Icon/arrow-right" },
    "ShowIcon": true
  },
  "layout": { "sizing": { "w": "HUG", "h": "HUG" } }
}
```

**IR 的不变式**：
- 任何 node 要么有 `layout`（Auto Layout），要么有 `bounds`（绝对定位），不能都没有
- `instance` 节点的 children 为空——内容全靠 props
- 所有 `{"var": "..."}` 的变量名必须在 mapping.json 里能查到，否则打 `_miss: true`

---

## 5. mapping.json 要补充的字段（v1.1）

现有 mapping 已经定义了 60+ 组件 id 和 variants 规则，缺的是 **component property 的声明**。每个 component 要补：

```jsonc
{
  "id": "button",
  "figmaName": "Button",                // library 里的名字（现在 id 和 name 是否一致？要对）
  "variants": { ... },                  // 现有逻辑
  "properties": [                       // ★ 新增
    {
      "name": "Label",                  // Figma property name
      "type": "TEXT",
      "from": { "source": "text", "selector": ":scope > :not(i)" }
      // source: text | attr | childIcon
      // selector: CSS selector 相对组件根
    },
    {
      "name": "Icon",
      "type": "INSTANCE_SWAP",
      "from": { "source": "childIcon", "selector": "i.iconoir-" }
    },
    {
      "name": "ShowIcon",
      "type": "BOOLEAN",
      "from": { "source": "exists", "selector": "i.iconoir-" }
    }
  ]
}
```

这样浏览器侧 capture 时，按 properties 声明去 DOM 里抽值，塞进 IR 的 `props`，Figma 端直接 `instance.setProperties()`——无须二次解析。

---

## 6. 用户工作流（MVP 目标流程）

```
1. 设计师 / AI 根据 mockup-kit.html 规范写好 H5 Demo
2. 用浏览器打开 Demo（本地 server 或已部署）
3. 点击 Mockup Sync 扩展按钮
    ├── 弹出 popup：选 capture 根节点（默认 body）+ 选视口宽度
    ├── 后台注入 capture.js 执行抓取
    └── 2~5 秒后产出 IR JSON → 自动复制到剪贴板 + 下载一份到本地
4. 打开 Figma，运行 Mockup Sync 插件
5. 粘贴 / 拖入 JSON → 点 "Import"
6. 插件在当前 page 生成一个 frame：
    · 所有颜色/字号/间距都绑在 Figma variable 上
    · 命中的组件都是真 instance，properties 已经 override 成 H5 的内容
    · 未命中的部分是 frame + token，容易手动替换
7. 导入后弹 summary panel：
    · ✅ 绑定了 N 个 token
    · ✅ 命中了 M 个组件实例
    · ⚠️ K 个颜色/字号未命中 token（列出 raw 值）
    · ⚠️ P 个疑似组件位置未命中 mapping（列出 class）
```

---

## 7. 非目标（明确不做）

- ❌ **不追求整页像素 1:1**。像素对齐让位给"Auto Layout 可编辑"
- ❌ **不做非 mockup-kit 网页的通用反向工程**。只服务 mockup-kit 规范的 Demo
- ❌ **不做双向同步**（Figma → HTML）。单向：HTML → Figma
- ❌ **不做组件库自动发布 / 跨文件 key 烘焙**。先跑当前文件 findByName，后续再说
- ❌ **不做响应式断点**。capture 一次 = 一个视口，要多个断点就多 capture 几次

---

## 8. MVP 切片（两周体量，按优先级）

### 🔴 Phase 0 · 规范 & mapping 补齐（1 天）
- [ ] 给 `mockup-kit.html` 每个组件根节点补 `data-mk="<id>"` + variant 用 `data-mk-<key>="<value>"`
- [ ] 给 mapping.json 每个 component 补 `figmaName` + `properties` 清单
- [ ] 和 Figma library 核对：所有要命中的组件必须已声明 component property（Figma 侧）
- [ ] 写一个 `scripts/check-mapping.mjs` 校验 Figma library 里每个组件的 property 和 mapping 声明一致

### 🔴 Phase 1 · 浏览器端 capture（3 天）
形态先用 **bookmarklet + 单文件 capture.js**，扩展化放后面：
- [ ] 基于 Paidax 的 capture.js 改造（或完全自写，结构更可控）
- [ ] 读 mapping.json 做 hex→token 反查 + class→ruleId 命中
- [ ] 按 `properties` 声明从 DOM 抽 prop 值
- [ ] 输出 IR JSON v3（通过 schema 校验）
- [ ] 产物：一段 bookmarklet 脚本 + 一个下载 IR 的按钮

### 🔴 Phase 2 · Figma 插件（3 天）
- [ ] manifest + UI：粘贴 JSON + 导入按钮（抛弃旧插件所有 HTML 解析代码）
- [ ] main thread：
    - [ ] IR schema 校验
    - [ ] 递归渲染 frame / text / instance
    - [ ] token 绑定（颜色 / 字号 / 间距 / 圆角 / 阴影）
    - [ ] Component property 批量 setProperties
- [ ] 导入 summary 面板（命中/未命中列表）

### 🟡 Phase 3 · 打磨（3 天）
- [ ] 图片跨域 fetch（可参 Paidax 的 background.js 方案）
- [ ] Chrome 扩展化封装（取代 bookmarklet）
- [ ] 懒加载图片滚动预加载
- [ ] Empty state / Error UX

### 🟢 Phase 4 · 可选增强
- [ ] capture 时自动替换模拟数据占位（避免把长 mock 数据塞进 Figma prop）
- [ ] 支持增量更新：同名 frame 已存在 → 只替换内容，保留位置
- [ ] AI Prompt 模板：告诉 AI 严格按 mockup-kit.html 规范出 Demo，减少未命中率

---

## 9. 可复用的旧插件资产

旧 `mockup-kit-plugin/` 里值得搬到新项目的部分：

| 文件 | 可复用内容 | 处理方式 |
|---|---|---|
| `mockup-kit.mapping.v2.json` | 组件 id / variants 规则 | **直接合并**到 mockup-kit.mapping.json + 补 properties |
| `scripts/build-plugin.mjs` | 把 mapping 注入模板的思路 | 参考，新插件也要做 mapping 注入 |
| `src/code.template.js` 里 token 绑定段 | setBoundVariable 的正确姿势 + QuickJS 兼容写法 | **抄代码**（避开 `??` / `?.` 的坑） |
| `src/ui.template.html` 的 sandbox iframe 抓取 | ❌ 不用了，新工具在真正浏览器里抓 | 丢弃 |
| Hybrid 像素渲染逻辑 | ❌ 不用了 | 丢弃 |

---

## 10. 风险 & 待讨论

| 风险 | 影响 | 当前打算 |
|---|---|---|
| Figma library 里的 component property 命名不统一 | override 失败 | Phase 0 强制校验一致性 |
| mockup-kit.html 本身覆盖不了的页面（复杂布局 / 表格） | 未命中率高 | 不治；回退 frame + token，人工补 |
| AI 生成的 HTML 偏离规范（乱加 class / inline style） | token 反查命中率低 | 给 AI 的 prompt 里明确约束 + summary 面板暴露问题 |
| `findByName` 在大文件上慢 | 导入卡顿 | 首次加载时缓存 name→node map |
| Component property 的 node id 每个文件不同 | setProperties 要传带 id 的 key（如 `"Label#123:0"`） | 导入前用 `instance.componentProperties` 枚举拿到真实 key，不能写死 |

---

## 11. 已确认决策（全部）

- ✅ **工具形态**：**两端协作** —— 浏览器侧 bookmarklet + Figma 插件，中间用 IR JSON 传递
- ✅ **浏览器侧起步**：bookmarklet（点一下书签执行，无需装扩展），成熟后再包 Chrome 扩展
- ✅ **组件绑定野心**：全量 token 绑定 + 仅显式标记命中的组件才走 instance，不猜
- ✅ **组件内容呈现**：Component Property override（不 detach、不叠加层）
- ✅ **组件命中方式**：**直接用你现有规范的根 class**（`.btn` / `.tag` / `.inp` / `.card` ...），mockup-kit.html 不改。variant 从 class 后缀解析（如 `btn-primary` / `btn-lg`）。未来出现歧义再引入 `data-mk` 显式覆盖
- ✅ **目录结构**：新建 `mockup-sync/`，旧 `mockup-kit-plugin/` 加 `.archived` 后缀保留
- ✅ **mapping 真源**：根目录 `mockup-kit.mapping.json` 继续当唯一真源，两端 build 时各自注入

---

## 12. 即将开工的 Phase 0（纯配置，0.5 天）

1. 重命名旧目录：`mockup-kit-plugin/` → `mockup-kit-plugin.archived/`
2. 新建 `mockup-sync/` 目录骨架
3. 给 `mockup-kit.mapping.json` 每个 component 补两个字段：
   - `rootClass`：根 class 选择器（如 `.btn`、`.card`、`.tag`）——capture 侧用它命中
   - `figmaName`：对应 Figma library 里的组件名
   - `properties`：声明哪些 prop 要从 DOM 抽什么值（参考需求 §5）
4. 写 `mockup-sync/scripts/check-mapping.mjs` 做一致性校验（可选，先手工对）

**mockup-kit.html 不改。**

---

## 13. v1.1 实战修复 & 浏览器扩展规划（2026-05-08）

> 本节记录 bookmarklet + Figma 插件首次跑通后的实战修复，以及把 bookmarklet 升级为 Chrome 扩展的设计要点。

### 13.1 已落地的修复

#### A. Figma 端：图标库统一加 `Icon/` 命名空间 ✅

**问题**：`mockup-sync/figma-plugin/src/code.js` 的 `findIconComponent` 查找链最后一项是 bare 名 `iconName`：

```
'Icon/' + iconName → 'Icons/' + iconName → 'icon/' + iconName
  → 'Icon/<Cap>' → 'Icon/<Titleized>' → 'Icon=' + iconName
  → iconName    ← ❌ 会撞到设计系统里同名的复合组件
```

具体 case：`iconoir-search` 应该匹配一个原子放大镜图标，但前 6 个 lookup 都没命中，落到 bare `search` → 命中了 LootBar 设计系统里一个叫 `search` / `Search` 的搜索框复合组件，结果整个图标被替换成"输入框 + Hint or error message"模板。

**修复**：在 Figma "icon" page（id `4:59`）上对所有 1386 个 ComponentSet 批量加前缀。脚本（用 `figma-mcp` 的 `use_figma` 工具一次性跑完）：

```js
const iconPage = figma.root.children.find(p => p.name === 'icon');
for (const child of iconPage.children) {
  if (child.type !== 'COMPONENT_SET') continue;
  if (child.name.startsWith('Icon/')) continue;  // 幂等
  if (child.name.indexOf('/') !== -1) continue;  // 守卫已分组的
  child.name = 'Icon/' + child.name;
}
```

效果：`iconoir-search` 现在第 1 个 lookup `Icon/search` 就命中，不再被复合组件抢走。

> 历史 mockup-sync 已导入的 Figma 文件里的旧 instance **不会自动更新**，下次重新导入才用新名。

#### B. 浏览器端：补 `<input>` / `<textarea>` 支持 ✅

**问题**：`captureElement()` 走完 `IMG` / icon / `SVG` 分支后直接到 generic frame。`<input>` 是 void element 没有 childNodes，导致 placeholder 和 value 全部丢失，Figma 里只剩一个空黑框。

**修复**：在 `mockup-sync/bookmarklet/src/capture.src.js` 的 generic frame 分支前插入 `INPUT` / `TEXTAREA` 专门处理：

- 读 `value`，回退到 `placeholder`
- `type=password` 且 value 非空 → 用 `•` mask 防止把真实密码塞进 Figma
- 合成一个 text 子节点，bounds 取输入框 padding-box，inherit 父元素字体
- 占位符态尝试读 `::placeholder` 伪元素颜色，否则降级 `rgba(255,255,255,0.4)`
- 跳过 `checkbox` / `radio` / `file` 等无文本类型

构建产物：`mockup-sync/bookmarklet/dist/capture.bundle.js`（52 KB → 仍在 Chrome bookmarklet URL 上限内）。

### 13.2 已知边界（暂不修，记录 workaround）

下面这些是 bookmarklet 的"像素镜像"模型本身的限制，不算 bug，但需要使用方知道并在 HTML 里规避：

| 现象 | 根因 | Workaround |
|---|---|---|
| `border-bottom`/`border-right` 单边边框丢失 | `inferFrameStyle` 只读 `border` 缩写（`borderTopWidth`/`borderTopColor`） | 改用独立 `<hr>` 元素或 `<div class="divider">` |
| 内联 `<strong>` 等元素让父段落文本错位 | text node 取 `getBoundingClientRect()` 时多行包围盒互相重叠，Figma 没"内联流"概念 | 把内联元素拆成块级子节点 |
| 内联 `<svg>` 在 Figma 里是空 frame | `el.tagName === 'SVG'` 分支只生成 placeholder（注释为 "out of scope for the pixel-mirror MVP"） | 改用 iconoir 类（`<i class="iconoir-xxx">`）—— bookmarklet 会从 CSS mask 提取 SVG |
| `rgba(255,255,255,0.06)` 这种极低 alpha 在 Figma 渲染为近全色 | bookmarklet 已正确产出 `paint.opacity=0.06`，Figma SolidPaint 极低 alpha 渲染不可控 | HTML 改为视觉等价的实色 hex |
| `.tag` / 部分组件的 `label` slot 显示空 / 默认占位文本 | mapping `from: ownText` 只读直接 text node，嵌套 `<span>` 内的文本读不到 → 组件按"无 label"渲染默认变体 | 文本直接放在组件根元素，不要嵌套 |
| Mockup Kit 已知组件（如 `.inp` / `.btn` / `.search-wrap`）会被强制映射成 Figma 组件，inline style override 失效 | `componentDetection: "class-based"`，class 命中后整个子树打包成 instance | 不需要组件化的位置不要复用这些 class，写裸 div |

这些边界也提醒我们：**`mockup-kit.html` 规范本身的"组件 class 即组件实例"约定要严格守纪律**，业务页面里"想用样式但不想做成组件"的场景应该有自己的 class，不能蹭组件 class。

### 13.3 Bookmarklet → Chrome 扩展 迁移规划

当前 bookmarklet 形态的**已知痛点**：

1. **每个浏览器要手动装一次**，团队成员上手成本高
2. **必须先起本地 server**（`python3 -m http.server 8765`）才能 fetch bundle，断网/换机器就报"loader: bundle 拉取失败"
3. **没有 popup UI**，capture 选项（视口、根节点、是否 mask password 等）只能改源码
4. **没有持久化**：上次 capture 的 IR JSON 只能依赖剪贴板/下载，无历史记录
5. **跨域图片** capture 拿不到 base64，扩展的 background script 才能绕开 CORS

#### 目标形态（Phase 3 升级版）

```
mockup-sync/
├── bookmarklet/          ← 保留，作为零安装的 fallback
│   └── ... (现状)
├── chrome-extension/     ← ★ 新增
│   ├── manifest.json     (manifest v3)
│   ├── popup/
│   │   ├── popup.html    (capture 选项 + 历史 IR 列表)
│   │   └── popup.js
│   ├── content/
│   │   └── inject.js     (在页面里执行的 capture，复用 bookmarklet/src/capture.src.js)
│   ├── background/
│   │   └── service-worker.js  (跨域图片 fetch / IR 持久化 / 通知)
│   └── shared/
│       └── capture.src.js     (软链 → ../../bookmarklet/src/capture.src.js)
└── figma-plugin/        (现状不变，IR 协议保持 v3)
```

#### 关键设计点

- **复用 capture 内核**：`bookmarklet/src/capture.src.js` 抽出公共代码，扩展和 bookmarklet 都引用同一份。mapping 注入也共用 `scripts/build.mjs`
- **manifest v3**：`activeTab` + `scripting` 权限即可，不需要广泛 host_permissions
- **跨域图片**：在 `service-worker.js` 用 `fetch(url, {credentials: 'omit'})` 绕开页面 CORS，转 base64 回传给 content script
- **IR 历史**：`chrome.storage.local` 存最近 N 条 capture（带预览缩略图 + sourceUrl + 时间戳），方便重新导入
- **快捷键**：`chrome.commands` 注册 `Cmd+Shift+M` 一键 capture
- **不再依赖本地 server**：所有 JS 打进扩展包，安装后断网也能用
- **Popup 选项面板**：
  - capture 根节点选择器（默认 `body`）
  - 视口宽度（用 DevTools 的 emulation 或仅记录当前 innerWidth）
  - 是否 mask password / 是否 inline 图片 base64
  - 输出方式：剪贴板 / 下载 / 两者都要 / POST 到本地 Figma 插件 server（如果未来加）
- **可选：直连 Figma 插件**：扩展 popup 里有一个 "Open in Figma" 按钮，借助 Figma 插件 [websocket dev mode](https://www.figma.com/plugin-docs/api/figma-clientStorage/) 或本地小 HTTP server 直接把 IR 推给 Figma 插件，免去复制粘贴

#### 实现优先级

| 阶段 | 内容 | 工时估计 |
|---|---|---|
| 3.1 | 把 capture 内核抽成共享模块 + manifest v3 + content script 复用 | 0.5 天 |
| 3.2 | popup UI（capture 按钮 + 选项 + 状态展示） | 0.5 天 |
| 3.3 | service-worker 跨域图片 fetch + base64 转换 | 0.5 天 |
| 3.4 | `chrome.storage.local` IR 历史 + 列表渲染 + 重新导出 | 0.5 天 |
| 3.5 | 快捷键 + 通知 + 错误 UX | 0.5 天 |
| 3.6 | 打包发 Chrome 商店 / 内部 .crx 分发 | 0.5 天 |

合计 ≈ 3 天工时（不含 Figma 端任何改动）。

### 13.4 给后续维护者的 checklist

每次新加 mockup-kit 组件 / 改 mapping 时：

- [ ] mapping 里 component 的 `match.selector` 别和 Figma 设计系统里**任何已有组件名**重名（避免 bare-name lookup 冲突）
- [ ] 用 `from: ownText` 的 slot，文档要写清楚"不要再嵌套 span"
- [ ] 用 `from: valueAttr` / `from: placeholderAttr` 的 slot，bookmarklet 必须有对应的 `INPUT` 处理（参见 13.1.B）
- [ ] 新加的 Figma 图标必须放在 "icon" page，命名 `Icon/<name>`，否则 mockup-sync 的图标查找会 miss
- [ ] 改完 capture.src.js 必须 `cd mockup-sync/bookmarklet && node scripts/build.mjs` 重建 bundle
- [ ] 已经导入过的 Figma 文件里的旧节点不会回填新规则，要么手动更新，要么重新 import

