---
doc_id: architecture.windows-sandbox-w2-plan
title: "Windows 沙箱 W2 实施计划"
language: zh-CN
source_language: zh-CN
implementation_status: planned
document_status: draft
owners:
  - fork-local
---
<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Windows 沙箱 W2 实施计划

## 目录

- [0. 范围与前提](#0-范围与前提)
- [1. 起点：W0/W1 已经交付了什么](#1-起点w0w1-已经交付了什么)
- [2. 五个缺口](#2-五个缺口)
- [3. 三条先行约束](#3-三条先行约束)
- [4. 实施顺序](#4-实施顺序)
- [5. 验证](#5-验证)
- [6. 与 RFC 的对应关系](#6-与-rfc-的对应关系)
- [7. 自用范围下明确不做的](#7-自用范围下明确不做的)
- [8. 参考](#8-参考)

---

## 0. 范围与前提

本文是 [Windows sandbox RFC v1](./windows-sandbox-rfc-v1.zh-CN.md) 中 **W2 切片**的实施计划。
RFC 定义威胁模型、选型与交付门禁；本文只回答"W2 这五条具体改哪些文件、按什么顺序、怎么验"。

### 0.1 这是一份 fork 本地的计划

**范围被裁剪过，裁剪依据是"自用"，不是上游的支持标准。**

上游 maka 的 Windows 目标是对外宣称支持，因此 RFC 的 W2/W3 里包含 Authenticode 签名、
发布阻断矩阵和独立人工安全审查。本文服务的是单人自用场景：**没有分发，没有对外支持声明，
威胁模型里没有"拿到安装包的第三方"**。

因此本文**不包含**签名与外部审查相关的工作（完整列表见 [§7](#7-自用范围下明确不做的)）。

> 这不是说那些工作不重要，是说在自用前提下它们不解决任何实际风险。
> 任何时候若本仓库要对外分发构建产物，本文的裁剪立即失效，必须回到 RFC 的完整 W2/W3。

### 0.2 本文的证据来源

全部结论来自阅读代码，**没有在真实 Windows 主机上执行过任何一条**。
每一条落地前都必须在 Windows 11 x64 上复现，尤其是 [§4.3](#43-p2pe-依赖闭包--通用命令) 的
DLL 初始化假设。

---

## 1. 起点：W0/W1 已经交付了什么

### 1.1 W0 是一次带否决的选型

W0 不是可行性调研。它用 Windows 2025 真机证据**否决**了当前用户受限令牌（restricted token）方案：
`CreateProcessWithTokenW` 能创建受限子进程，但子进程和 `cmd.exe /d /c exit 0` 都无法在
30 秒安全线内完成初始化。

被否的原型仍保留在 [experiments/windows-sandbox/launcher/](../../experiments/windows-sandbox/launcher/)，
作为**有界负面证据**：CI 把"这个确切的、fail-closed 的失败"当作通过条件，任何其他失败方式仍判 job 失败。

选中的是 AppContainer，理由是同一个 runner 上证明了默认拒绝、准入根访问、网络拒绝和原子 Job 归属，
且不需要提权。

### 1.2 W1 交付的实际边界

Windows 沙箱目前**只承载 filesystem worker**，不承载任意 shell。在沙箱内：

| 操作 | 状态 |
|---|---|
| `Read`、`Glob` | 可用 |
| 对**已存在**目标的 `Write`、`Edit`、`FormatJson`、`apply_patch` 更新 | 可用 |
| 对**不存在**目标的 `Write`、`apply_patch` 的 create/delete | fail closed |
| `Grep` | fail closed（`grep_unavailable`） |
| Bash / 任意命令 | 完全不进沙箱 |

Bash 的情况需要单独说清楚：不是"沙箱里跑不了"，是
[builtin-tools.ts:797](../../packages/runtime/src/builtin-tools.ts) 把 win32 归入
"command sandbox unavailable"——**profile 要求沙箱则 fail closed，否则直接用宿主 shell 无沙箱执行**。

---

## 2. 五个缺口

| # | 缺口 | 代码位置 | 失败方式 |
|---|---|---|---|
| 1 | `protectedMetadata` 完全没接入 | [windows-profile.ts:29-34](../../packages/runtime/src/sandbox/windows-profile.ts)（类型无此字段）、`compileWindowsSandboxPolicy` 不读 `profile.fileSystem.protectedMetadata` | **静默** |
| 2 | `deny` 条目未实现 | [windows-profile.ts:54](../../packages/runtime/src/sandbox/windows-profile.ts) | `throw`（裸 Error，非 typed failure） |
| 3 | 父目录精确写授权无法表达 | [windows-profile.ts:83](../../packages/runtime/src/sandbox/windows-profile.ts) | `throw` |
| 4 | 可执行依赖闭包为空 | [builtin-tools.ts:855](../../packages/runtime/src/builtin-tools.ts)：win32 分支只省掉 `slashTmp`，从不填 `executableRoots` | 静默为空 |
| 5 | ripgrep 依赖解析非 darwin 返回空 | [launch-spec.ts:258](../../packages/runtime/src/filesystem-worker/launch-spec.ts) | 下游 fail closed |

### 2.1 为什么第 1 条要单独拎出来

其余四条都**响亮地失败**——要么抛异常，要么返回 typed 错误。只有第 1 条是安静的：
profile 声明了 `protectedMetadata: { access: 'deny_write', names: ['.git', '.agents', '.codex'] }`，
Windows 编译器直接无视，policy 照常生成，启动照常成功。

后果可复现：`workspace-write` profile 下 `:workspace_roots` 是 write，ACL 递归授在工作区根上，
`.git/config` 是已存在文件——**Windows 沙箱内可以改写它，macOS 和 Linux 都拒绝**。

这条策略的执行点全仓库只有两处：macOS 的 SBPL 正则
（[macos-seatbelt.ts:550](../../packages/runtime/src/sandbox/macos-seatbelt.ts)）和 Linux 的
`--ro-bind-try`（[linux-sandbox.ts:394](../../packages/runtime/src/sandbox/linux-sandbox.ts)）。
filesystem worker 自身没有任何按名字的保护。

**在修好之前，[sandbox/README.md](../../packages/runtime/src/sandbox/README.md) 的能力表不应让三平台看起来等价。**

---

## 3. 三条先行约束

这三条是设计输入，不是任务。先写在任务前面，因为它们决定方案长什么样。

### 3.1 path-free run-trace

[run-trace.ts](../../packages/runtime/src/run-trace.ts) 有独立的 `'sandbox'` phase，并且 import 了
`redactSecrets`。RFC 要求 "preserve path-free run-trace enforcement evidence"——
**沙箱执行的证据要进 trace，路径本身不能进。**

本条对应 RFC W2 第 5 条。它直接约束 [§4.1](#41-p0protectedmetadata-接入)：新增的 deny 根是一串用户真实路径。
设计时就要确保它只进 manifest（临时文件，用后即删），**不顺着执行链进 run trace**。
证据应表达为"拒绝了 N 条，摘要为 `<digest>`"，而不是路径列表。

### 3.2 manifest 的 `profileDigest` 演进规则

`WindowsBrokerManifest` 带 `profileDigest`，broker 端会重算并强制校验。
[windows-sandbox.ts](../../packages/runtime/src/sandbox/windows-sandbox.ts) 的 `timeoutMs` 已经踩过这个坑，
注释写明：

> Serialized last so manifests without it keep their historical digest.

**任何新字段必须序列化在最后。** 这条对 `denyRoots` 同样适用。

### 3.3 不得静默降级

RFC §3 的收尾契约：

> Missing binaries, invalid paths, unsupported profiles, malformed manifests, failed ACL recovery,
> or launch failures remain typed fail-closed outcomes; **there is no unsandboxed retry**。

缺口 2 现在抛裸 `Error`，穿过一个契约是 typed failure 的边界；Linux 对同一情况返回
`invalid_request`。**这一条应在任何功能工作之前对齐**，否则后续每个带 deny 的 profile
在 Windows 上都是未分类崩溃。工作量约半天。

---

## 4. 实施顺序

```
P-1  统一失败形状                半天    纯契约对齐，无功能
P0   protectedMetadata 接入      1-2 周  唯一静默弱化；需 RFC 修订
P1   父目录精确写授权             设计先行 有任务无方案
P2   PE 依赖闭包 → 通用命令       3-5 周  最贵；管道已通、源头未接
P3   Grep                       ~0      验证 P2 是否顺带解决
```

### 4.0 P-1：统一失败形状

把 [windows-profile.ts:54](../../packages/runtime/src/sandbox/windows-profile.ts) 和
[:133](../../packages/runtime/src/sandbox/windows-profile.ts) 的裸 `throw` 改成与 Linux 一致的
typed `invalid_request`。对齐目标是 [linux-sandbox.ts:558](../../packages/runtime/src/sandbox/linux-sandbox.ts)。

### 4.1 P0：`protectedMetadata` 接入

> ⚠️ **本节方案 RFC 未设计过，落地前需要修订 RFC。**
> RFC §3 只列了 "AppContainer ACEs for **only the compiled read/write roots**"——只有 grant，没有 deny。
> 下面提的 deny ACE 不与 §3 冲突，且复用现有 ledger，但它是新机制，应走 RFC 修订而非直接开 PR。

**为什么 Windows 做这件事比另外两个平台容易。**
[acl_ledger.rs:603](../../experiments/windows-sandbox/launcher/src/acl_ledger.rs) 现在是：

```
icacls <path> /grant *<SID>:(OI)(CI)<access> /L /Q [/T]
```

清理是 `icacls <path> /remove *<SID>`——**按 principal 删**。代码注释说明了为什么这样就够：

> The broker's only ACL mutation is adding grants for its own per-app SID,
> so targeted removal restores the prior state while preserving every pre-existing ACE.

加 deny 几乎不需要新机器：

1. `icacls /deny *<SID>:<access>` 打的是**同一个 SID** 的 DENY ACE；
2. Windows DACL 求值中 DENY 优先于 ALLOW，icacls 会把 deny ACE 排在前面；
3. 现有的 `/remove *<SID>` **天生同时清掉 grant 和 deny**；
4. ledger 的记录、过期重建、SID quarantine 全部复用。

对比：macOS 需要正则编译器，Linux 压根没有机制（bubblewrap 是白名单 bind 模型）。
**只有 Windows 的 ACL 有一等公民的显式 deny 和明确的优先级。**

**改动清单：**

| 位置 | 改什么 |
|---|---|
| `WindowsSandboxPolicy` | 新增 `denyRoots: readonly string[]` |
| `WindowsBrokerManifest.launch` | 新增 `denyRoots`，**序列化在最后**（见 [§3.2](#32-manifest-的-profiledigest-演进规则)） |
| `compileWindowsSandboxPolicy` | 读 `profile.fileSystem.protectedMetadata`，枚举可写根下的嵌套命中路径 |
| `acl_ledger.rs` | `grant()` 旁边加 `deny()`；ledger 记录 deny 根 |
| run-trace | 只记数量与摘要，不记路径（见 [§3.1](#31-path-free-run-trace)） |

**枚举策略照抄 Linux。**
[linux-sandbox.ts:664](../../packages/runtime/src/sandbox/linux-sandbox.ts) 的
`discoverNestedProtectedMetadataPaths` 是有界递归，深度上限 `MAX_PROTECTED_SCAN_DEPTH = 64`。
Windows 直接复用同一策略即可。

> **必须记录的强度差异：** 枚举是**启动前**的。启动后新建的 `.git` 目录不在策略里。
> macOS 的 SBPL 正则是**运行时**匹配，没有这个窗口。
> 同一条 profile 在两个平台上强度不同，这必须写进 profile 的文档契约，
> 而不是让两个后端各自安静地尽力而为。

**扩展性红利：** 这条路一旦通了，往 Windows 加 `**/*.env` 这类读禁止，
就只是往同一个 deny 列表里多塞几条——**不用再动 schema，不用再碰 `profileDigest`**。

### 4.2 P1：父目录精确写授权

[windows-profile.ts:76-88](../../packages/runtime/src/sandbox/windows-profile.ts) 的注释把问题说得很准：

> a write whose target does not exist yet … can only be represented here as recursive Modify on the
> existing parent, a kernel boundary broader than the approved exact operation

所以它 fail closed。后果是 **Windows 沙箱内 agent 写不了新文件**，apply_patch 的 create/delete 也不行。
这是可用性硬伤，不是安全边界问题。

**不要去放宽 ACL**——那正是这段注释拒绝做的事，做了就把 exact 写变成父目录递归写。

**建议方向：broker 代建。** broker 以自身身份创建空文件，对该文件授 exact 写权给 child SID，
再交给 child。父目录写权始终留在 broker 侧，child 拿到的仍然是精确授权。

RFC 把这条列在 W2 第 1 条（"enforce write roots"）里，**有任务，无方案**——
那句 "precise parent-entry authority is follow-up work" 在代码注释里，不在 RFC 里。
本节也只给方向，落地前需要单独出设计。

### 4.3 P2：PE 依赖闭包 → 通用命令

**根因。** [windows_launcher.rs:350](../../experiments/windows-sandbox/launcher/src/windows_launcher.rs)
和 [:1151](../../experiments/windows-sandbox/launcher/src/windows_launcher.rs) 都是
`Capabilities: null_mut()`——零 capability 的 AppContainer。
`cmd.exe` / `pwsh` 在其中 DLL 初始化失败（`STATUS_DLL_INIT_FAILED`，`0xC0000142`）。

**RFC 给的方向是 "exact executable discovery without ambient PATH/startup scripts"——
不是放宽 capability，是精确授予目标可执行文件需要的那些根。**

对应的代码缺口非常具体。[builtin-tools.ts:855](../../packages/runtime/src/builtin-tools.ts)：

```ts
...(platform === 'win32' ? {} : { slashTmp: '/tmp' }),
...(platform === 'darwin' ? { executableRoots: macosRuntimeExecutableRoots(...) } : {}),
...(platform === 'linux'  ? { minimalRoots:    linuxExecutableRoots({...})       } : {}),
```

win32 那一行**唯一做的事是省掉 `slashTmp`**。于是 `pathContext.executableRoots` 在 Windows 上永远为空，
`compileWindowsSandboxPolicy` 里那个把 `executableRoots` 并入 `readRoots` 的循环永远空转。

**管道是通的，源头没接。** 而且有两份现成参考：

- [macos-executable-dependencies.ts](../../packages/runtime/src/filesystem-worker/macos-executable-dependencies.ts)
  ——解析 Mach-O 的动态库闭包，160 行；
- Linux 那份基于 PATH 的 `linuxExecutableRoots`。

Windows 要的是同一件事的 PE 版本：**解析 import table 得到 DLL 依赖闭包**，
把那些目录授成 read + execute。

> ⚠️ **这里有一个必须在真机上验证的假设。**
> "补齐 DLL 依赖根就能让 `cmd.exe`/`pwsh` 在零 capability AppContainer 里初始化成功"
> 是从 RFC 的措辞推出来的，**不是已验证的事实**。
> DLL 初始化失败也可能来自 base named objects、CSRSS 连接或 window station 侧。
> 第一步应当是一个最小复现：在 AppContainer 里逐步加根，定位 `0xC0000142` 的真实来源。
> 这一步做完之前，3-5 周的估算只是 RFC 的估算，不是本计划的承诺。

### 4.4 P3：Grep

[operations.ts:389-396](../../packages/runtime/src/filesystem-worker/operations.ts) fail closed 的理由是正当的——
保住 ripgrep 的 pattern dialect / gitignore / truncation 契约，不自己糊一个搜索引擎。

但真正的阻塞可能比看上去小。
[launch-spec.ts:258](../../packages/runtime/src/filesystem-worker/launch-spec.ts)：

```ts
if (platform !== 'darwin') {
  return { executable, runtimeReadableRoots: [], executableRoots: [] };
}
```

**ripgrep 的依赖解析在非 macOS 上直接返回空。** 即便 `rg.exe` 在 PATH 里，沙箱也没给它任何可执行根。

P2 的 PE 依赖解析器做出来之后，这条大概率顺带解决。
**不要单独排期，挂在 P2 之后验证。**

> 本条不在 RFC 的 W2 列表里——RFC 全文没有出现 `Grep`。这是本计划新增的观察，需真机验证。

---

## 5. 验证

RFC §10 的判据不因自用而放松：

> Generated flags and unit tests are necessary but **are not security evidence**.
> A passing test must show that the denied operation fails in a real child and that
> no process or unknown durable authorization remains.

新增能力的证据加在 [experiments/windows-sandbox/](../../experiments/windows-sandbox/)，
那里已有 11 个 PowerShell smoke 和 5407 行 Rust。对抗矩阵在 `adversarial-matrix-smoke.ps1`。

| 任务 | 最低证据 |
|---|---|
| P-1 | 单测：不支持的 profile 返回 typed `invalid_request`，不抛裸 Error |
| P0 | 真子进程中对 `<workspace>/.git/config` 的写**失败**；退出后 deny ACE 已移除；ledger 无残留 |
| P1 | 真子进程中新建文件**成功**；父目录未获得递归写权（读回 DACL 断言） |
| P2 | `cmd.exe`、`pwsh`、`git.exe` 在沙箱内成功初始化并退出；越界读写仍被拒 |
| P3 | 沙箱内 `Grep` 返回与宿主一致的结果（同 pattern、同 gitignore 行为） |

每条都必须是**真子进程**中的观察，不是编译期断言。

---

## 6. 与 RFC 的对应关系

| 本文 | RFC W2 | 性质 |
|---|---|---|
| P-1 统一失败形状 | —— | 新增（契约对齐，RFC §3 已隐含要求） |
| P0 `protectedMetadata` | 第 1 条前半 "nested protected metadata" | **任务原有，方案新增**（deny ACE 需修订 RFC） |
| P1 父目录写授权 | 第 1 条后半 "enforce write roots" | 任务原有，**RFC 无方案** |
| P2 PE 依赖闭包 | 第 2 条 + 第 3 条 | 任务原有，本文补代码定位 |
| P3 Grep | —— | **新增**，RFC 未提及 |
| §3.1 path-free run-trace | 第 5 条 | 任务原有，本文降级为**约束**而非任务 |
| —— | 第 4 条 setup/升级/回滚/卸载 + 签名 | **自用范围裁剪**（见 §7） |

**顺序一致性：** 本文的 P0 → P1 → P2 与 RFC W2 的 bullet 1 → 2 → 3 顺序相同。
本文是从代码里的 `throw` 和空分支倒推的，RFC 是从设计推的，两条路径落到同一顺序。

---

## 7. 自用范围下明确不做的

**显式列出，避免日后误以为 W2 已经完成。**

| 项 | 属于 | 为什么在自用下不做 |
|---|---|---|
| Authenticode 签名 | W2 第 4 条 / Phase 3 | 无分发即无第三方分发面；证书采购有外部前置周期 |
| broker 校验 launcher 签名与版本 | RFC §6.5 deferred | 被上一条堵着 |
| 安装/升级/回滚/卸载门禁 | W2 第 4 条 | 自用从源码跑，不经 NSIS 路径 |
| 全支持版本/文件系统的发布阻断矩阵 | W3 第 1 条 | 只需覆盖自己那台机器的配置 |
| **独立人工安全审查** | W3 第 2 条 | 无对外支持声明 |
| 对外支持声明 | W3 第 4 条 | 不适用 |
| no-Win32k、独立 window station、剪贴板隔离 | RFC §6.5 deferred | 纵深防御，非边界本身；RFC 本就 deferred |
| Credential Manager / DPAPI 直探证据 | RFC §6.5 deferred | 同上 |
| UDP / DNS / SMB、入站监听强制 | RFC §6.5 deferred | 同上 |

### 7.1 裁剪失效的条件

**若本仓库开始对外分发任何 Windows 构建产物，本节全部裁剪立即失效**，
必须回到 [RFC](./windows-sandbox-rfc-v1.zh-CN.md) 的完整 W2/W3，
包括那条不因自动化全绿而豁免的独立人工审查。

### 7.2 不因自用而放松的

- [§3.3](#33-不得静默降级) 的 fail-closed 契约——它保护的是使用者自己；
- [§5](#5-验证) 的"真子进程证据"判据；
- [§4.1](#41-p0protectedmetadata-接入) 记录的跨平台强度差异——写进契约，不要让后端各自尽力而为。

---

## 8. 参考

- [Windows sandbox RFC v1](./windows-sandbox-rfc-v1.zh-CN.md) — 威胁模型、选型、W0–W3 门禁
- [Windows 支持基线](../windows-support.md) — 当前能力边界与实测基线
- [Windows 测试跳过清单](../windows-test-inventory.md) — 100 条，分 `platform-contract` / `windows-backend-gap` / `portable-candidate`
- [runtime sandbox README](../../packages/runtime/src/sandbox/README.md) — 三平台产品覆盖表
- [experiments/windows-sandbox](../../experiments/windows-sandbox/) — 原生证据工具与被否决的原型
- [apache/maka#2142](https://github.com/apache/maka/issues/2142) — Phase 4 跟踪
