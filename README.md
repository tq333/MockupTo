# Mockup Sync

> HTML Demo → Figma 轻量反写工具。From wireframes to delivery.
> 需求文档：[`./REQUIREMENTS.md`](./REQUIREMENTS.md)
> GitHub：<https://github.com/tq333/mockup-sync>

---

## 一图看懂

```
 ┌──────────────────────┐                    ┌──────────────────────┐
 │  chrome-extension/   │                    │  figma-plugin/       │
 │  (浏览器侧)          │                    │  (Figma 侧)          │
 │                      │  ─── IR JSON ───▶  │                      │
 │  抓 H5 Demo DOM      │   (见 schema/)     │  建节点              │
 │  反查 token          │                    │  绑 token            │
 │  命中组件 → slots    │                    │  塞组件 properties   │
 └──────────────────────┘                    └──────────────────────┘
          │                                            │
          └────────── 共读同一份 mapping ─────────────┘
                ./mockup-kit.mapping.json
```

## 目录结构

```
mockup-sync/
├── README.md                        ← 本文件
├── REQUIREMENTS.md                  ← 需求文档
├── mockup-kit.mapping.json          ← 唯一真源：token + 组件规则，两端共读
├── schema/                          ← IR JSON 合同
│   ├── README.md                    ← 设计动机 + 规则
│   ├── ir.v1.schema.json            ← JSON Schema（校验用）
│   └── ir.v1.example.json           ← 真实 case，一看就懂
├── chrome-extension/                ← 浏览器侧（capture）
│   ├── src/capture.src.js           ← 唯一可维护源
│   ├── lib/capture.bundle.js        ← build 产物
│   └── scripts/build.mjs            ← 把 src + mapping 打成 bundle
├── figma-plugin/                    ← Figma 侧（导入 + 渲染）
│   └── src/
└── captures/                        ← 本地 capture 样本（不入 git）
```

## 当前进度

- [x] **Phase 0** · 归档旧插件、建目录骨架、起草 IR Schema
- [x] **Phase 1** · 浏览器侧 capture（chrome-extension）
- [x] **Phase 2** · figma-plugin（Figma 侧导入）
- [ ] **Phase 3** · 打磨（图片跨域 / 命中率 / 表格 border-collapse / sticky 修正）

## 共用资产

| 文件 | 角色 |
|---|---|
| `./mockup-kit.mapping.json` | 唯一真源。token + 组件规则，两端共读 |
| `../mockup-kit.html` | 规范样张。AI / 人写 Demo 的基准（在仓库外） |
| `../web-to-figma-main/capture.js` | 浏览器侧抓取算法参考（在仓库外） |
| `../mockup-kit-plugin.archived/` | 上一版插件，已归档（在仓库外） |

---
