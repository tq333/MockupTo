# Mockup Sync · MockupTo

> HTML Demo → Figma 轻量反写工具。From wireframes to delivery.
> 需求文档：[`./REQUIREMENTS.md`](./REQUIREMENTS.md)
> GitHub：<https://github.com/tq333/MockupTo>

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

## 版本管理（Git / GitHub）

仓库已经托管在 <https://github.com/tq333/MockupTo>，凭证已经存到 macOS 钥匙串，
**日常无需输任何密码**。

### 1. 让 AI 帮我提交（最常用）

直接说："帮我 push 一下" 或 "提交这次的改动"。AI 会：
1. `git status` 看改了哪些
2. 写一句简短的中文提交信息
3. `git add -A && git commit && git push`

### 2. 自己手动提交

打开 **Terminal**（⌘空格 → 输 `terminal` → 回车），复制粘贴：

```bash
cd /Users/tqzhang/Work/提效工具/mockup-sync
git add -A
git commit -m "这里写改动说明"
git push
```

### 3. 看看现在有没有未提交的改动

```bash
cd /Users/tqzhang/Work/提效工具/mockup-sync
git status
```
- `nothing to commit, working tree clean` = 全部已同步
- 一堆红/绿文件名 = 有改动还没 commit

### 4. 回退（让 AI 操作，别自己跑）

| 想做的事 | 让 AI 跑啥 |
|---|---|
| 撤销还没 commit 的改动 | "把 xxx 文件回退到上次提交的版本" |
| 撤销最后一次 commit（保留改动） | "撤销最后一次 commit 但保留改动" |
| 整个目录回到 GitHub 上的版本 | "回退到 GitHub 上最新的状态" |

### 5. Token 失效或换电脑了

如果哪天 push 失败，提示要 Username / Password：
1. 去 <https://github.com/settings/tokens?type=beta> 生成新 Token（Contents = Read and write）
2. Terminal 里跑：
   ```bash
   printf "protocol=https\nhost=github.com\n\n" | git credential-osxkeychain erase
   cd /Users/tqzhang/Work/提效工具/mockup-sync && git push
   ```
3. 它会问 Username（填 `tq333`）和 Password（粘新 Token，**不显示是正常的**）
4. 输完一次后钥匙串会记住，以后又恢复无感

---

## 接力指引

打开新对话时，贴这段给 AI：

> 继续 Mockup Sync / MockupTo 项目。
> 本地：`/Users/tqzhang/Work/提效工具/mockup-sync/`
> GitHub：`https://github.com/tq333/MockupTo`
> 需求：`./REQUIREMENTS.md`
> IR 合同：`./schema/`
> mapping 真源：`./mockup-kit.mapping.json`
> 当前进度：[Phase X]
> 现在要做：[具体任务]
