# 招商雷达 — 完整源码包说明

本包是「招商雷达」的完整应用源码，涵盖前端、后端、数据库结构与迁移、定时刷新配置与部署/本地运行说明。打包时间与文件清单见包内 `MANIFEST.json`。

## GitHub 仓库与自动打包发布

- 仓库：https://github.com/TanJane1990/zhaoshang-leida.git — 把本包内容解压后推到该仓库的 `main` 分支即可（仓库根目录就是本包根目录，不要再套一层目录）。
- 自动打包发布：仓库内含 `.github/workflows/release.yml`——推送 `v*` 标签（如 `v1.0.0`）后，GitHub Actions 会自动把源码打成 `招商雷达-<版本号>.zip` 并发布到 GitHub Releases；也可以在仓库的 Actions 页手动运行该 workflow，只打包不发布（产物在 Artifacts 里下载），或勾选发布并填标签名直接发 Release。
- `.gitignore` 已排除运行时数据库 `app.db`、依赖与构建产物，推代码不会把本地数据和 `node_modules` 带上仓库。

## 包里包含什么

### 前端（client/）
- `client/src/App.tsx` — 全部界面与交互（五个 Tab：雷达、比选、项目、政策、我的）
- `client/src/main.tsx` — 入口，挂载 React 与 QueryClient
- `client/src/api.ts` — 类型化 RPC 客户端（类型直接来自后端 actions）
- `client/src/theme.css` — 设计令牌与深/浅色主题（深海军蓝 #0B2C4A + #1677FF）
- `client/src/globals.d.ts` — 样式模块类型声明
- `client/index.html`、`client/build.mjs`、`client/tsconfig.json`

### 后端（server/）
- `server/src/actions.ts` — 全部服务端动作：信号雷达刷新（13 路公开数据源）、候选回写、评分装配、政策采集/回写、线索管道、联系方式（含对公校验红线）、数据导出（`exportAllData` / `getExportInfo`）等
- `server/src/schema.ts` — 数据库结构定义（Drizzle / SQLite）：`signals`、`signal_followups`、`city_profiles`、`policies`、`projects`、`followups`、`company_contacts`、`refresh_runs`
- `server/src/scoring.ts` — 确定性落地评分模型：硬过滤 + 六维评分（产业契合 30 / 投资规模 20 / 产业链 15 / 用地载体 15 / 政策收益 10 / 风险 10），已签约及之后阶段的降级规则、阶段推导
- `server/tsconfig.json`

### 数据库结构与迁移（drizzle/）
- `drizzle/0001_initial.sql` ~ `drizzle/0005_signal_leads_followups.sql` — 按顺序执行的全部迁移
- `drizzle/meta/_journal.json` — 迁移登记

### 配置与定时刷新
- `space.json` — 应用元数据（名称「招商雷达」）与**定时刷新声明**（`managedCronJobs`）：每天 08:00、13:00、18:00（Asia/Shanghai）各调用一次 `refreshSignals` 动作做全量刷新；也可在雷达页手动点「全量刷新（13 路）」
- `package.json`、`bunfig.toml`、`tsconfig.base.json`
- `DATA-PLAN.md` — 数据来源、口径与历次变更记录（ provenance ）
- `.github/workflows/release.yml` — GitHub 自动打包并发布 Release 的 workflow；`.gitignore` — 排除运行时数据与构建产物

## 包里是否包含现有库里的数据？——不包含

**不包含。** 本源码包只有代码、结构与配置，不含运行时数据库 `app.db`，因此不含现有库里的：

- 投资信号（待核实 / 已确认 / 已忽略，含已落地阶段与落地城市）
- 政策库条目
- 城市产业档案（9 个城市的成本档位等——注：代码里有一份种子档案 `SEED_CITIES`，是空库首次启动时写入的参考目录，不等于你库里已编辑过的档案）
- 项目与线索、项目跟进记录（`followups`）、线索跟进记录（`signal_followups`）
- 企业公开联系方式（`company_contacts`）、刷新记录（`refresh_runs`）

原因：数据是运行时由使用者与刷新任务持续写入的用户数据，与源码分开管理；把某一时刻的数据库塞进源码包会让代码与数据版本互相污染。

## 如何导出数据

（2026-11-11 更新：按用户要求，「我的」页的「源码包与数据导出」区已从界面下线，应用内不再提供一键下载入口。后端动作 `exportAllData` / `getExportInfo` 仍保留，需要导出时可由维护方直接调用该动作取得全量快照。）

`exportAllData` 返回当前库全部 8 张表的完整快照（字段与数据库一致，时间转 ISO 字符串），适合备份与迁移。

导入/恢复：在新的运行环境里先按下面步骤把应用跑起来（迁移会自动建空库，种子档案自动写入），再把 `export.json` 里各表的行按表名逐表写回对应表即可；或直接在「我的 / 政策 / 雷达」界面用现有的录入与刷新功能重新积累。源码包内 `server/src/actions.ts` 的 `exportAllData` 实现就是导出逻辑的权威定义，字段以它为准。

## 运行环境与本地运行说明（如实说明）

这是一个 **Muse TypeScript Space（全栈 Web Artifact）**：前端 React 19 + TanStack Query，后端是类型化 Server Actions（`@hatch/space-sdk`），数据库是每应用一份的 SQLite（Drizzle），定时刷新由平台按 `space.json` 的 `managedCronJobs` 调度，雷达/政策采集由服务端动作派发研究任务（`ctx.agent.spawnTask`）去公开网络检索后回写。这些能力（`ctx.db`、`ctx.agent`、动作 RPC 路由、blob 存储）由 Muse 运行时提供，**不是一个可以脱离 Muse、用普通 Node/VPS 直接 `npm start` 跑起来的独立项目**。

因此本地/部署的正确姿势是：

### 方式一：在 Muse 里恢复/继续运行（推荐，功能完整）
1. 把本包解压到 `~/workspace/ts-spaces/chang-san-jiao-zhao-shang-lei-da/`（目录名即 slug，不要改）。
2. 在该目录运行依赖安装与构建（运行时基线见 `package.json` 的 `packageManager: bun@1.3.10`）：
   - `bun install`
   - `bun run build`（分别构建 server actions 与 client bundle）
3. 由 Muse 平台加载该 space：数据库迁移按 `drizzle/` 顺序自动应用，种子城市档案在首次读取时自动写入，定时刷新按 `space.json` 的三个时间点恢复。
4. 如需带上旧数据：按上一节导出 `export.json`，在新库里逐表写回。

### 方式二：脱离 Muse 自行部署（需要改造，工作量说明）
源码的业务逻辑（评分模型 `scoring.ts`、数据结构 `schema.ts`、13 路采集提示词与回写校验在 `actions.ts`）都是标准 TypeScript，可迁移，但必须自行替换三处平台能力：
- `ctx.db` → 自建 SQLite（可直接用 `drizzle/` 迁移建表）+ 一个 HTTP RPC 层替换动作调用；
- `ctx.agent.spawnTask` + `ctx.tool.web_search` → 自行接入搜索/抓取服务，并按 `actions.ts` 中 `refreshSignals` / `refreshPolicies` 的提示词与 `saveSignalCandidates` / `savePolicyCandidates` 的校验规则回写；
- `space.json` 的 `managedCronJobs` → 系统 cron / 定时任务，每天 08:00、13:00、18:00 调用刷新入口。

本包不对方式二提供一键脚本；如按方式二部署，评分与数据口径请以 `server/src/scoring.ts`、`server/src/schema.ts` 为准逐项对照。

## 功能速览

- 雷达：13 路公开数据源全量刷新（财经新闻、企业官网、上市公司公告、政府新闻、招投标、土地出让、园区官网、招商平台、股市聚合、融资、招聘扩张、专利产业化、环评/能评公示），候选先待核实、人工确认后才入库
- 线索管道：确认信号即「项目」线索，可推进 线索→洽谈→签约→落地→投产→搁置；已签约/开工/投产自动降级，只推配套、以商招商与二期扩产
- 比选与报告：9 城落地评分对比与一页纸落地报告；已落地项目生成配套与二期报告
- 政策库：按城市维护结构化政策，自动参与落地评分匹配
- 联系方式：只收对公公开渠道（官网总机/年报董秘/招标·环评公示联系人），个人手机号/私人微信/私人邮箱在服务端拦截不入库
