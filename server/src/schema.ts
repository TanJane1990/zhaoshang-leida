// 招商雷达 — data model.
//
// signals          投资信号（雷达抓取的待核实候选 + 已确认信号）；已确认信号同时
//                  是「项目」页线索：pipeline_stage 记录它在项目管道里的显式阶段
//                  （用户推进后写入），空 = 按 deal_stage 推导（意向/洽谈→线索、
//                  已签约→签约、已开工→落地、已投产→投产）
// signal_followups 线索跟进记录（挂在信号上，确认后不用转项目就能直接跟进）
// city_profiles    长三角城市产业档案（参考目录，用户可编辑）
// policies         政策库（用户录入的结构化政策）
// projects         项目线索（信号转入后的跟进管道）
// followups        项目跟进记录（时间线）
// refresh_runs     雷达刷新记录
// company_contacts 企业公开联系方式（只存对公渠道：官网总机/年报董秘/招标·环评公示联系人；
//                  私人手机号、私人微信、私人邮箱不入库，服务端校验拦截）

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const signals = sqliteTable("signals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  company: text("company").notNull(),
  industry: text("industry").notNull().default(""),
  signalType: text("signal_type").notNull().default("其他"),
  targetRegion: text("target_region").notNull().default(""),
  investmentText: text("investment_text").notNull().default(""),
  // 投资额（亿元），仅当来源明确写出时才有；null = 来源未披露
  investmentYi: real("investment_yi"),
  summary: text("summary").notNull().default(""),
  sourceName: text("source_name").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  reportedDate: text("reported_date").notNull().default(""),
  // 项目所处阶段：intent 意向 / negotiating 洽谈 / signed 已签约 / building 已开工 / producing 已投产
  // 已签约及之后（signed/building/producing）视为已落地：不再跨市招引，只推配套与二期。
  dealStage: text("deal_stage", {
    enum: ["intent", "negotiating", "signed", "building", "producing"],
  })
    .notNull()
    .default("intent"),
  // 已落地城市（dealStage 为 signed/building/producing 时有意义），如「无锡」
  landedCity: text("landed_city").notNull().default(""),
  // 项目管道阶段（线索视角）：lead 线索 / talking 洽谈 / signed 签约 / landed 落地 /
  // producing 投产 / dropped 搁置。空字符串 = 未显式推进，按 dealStage 推导：
  // intent/negotiating → lead，signed → signed，building → landed，producing → producing。
  pipelineStage: text("pipeline_stage").notNull().default(""),
  status: text("status", {
    enum: ["pending", "confirmed", "dismissed", "converted"],
  })
    .notNull()
    .default("pending"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const cityProfiles = sqliteTable("city_profiles", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  city: text("city").notNull().unique(),
  province: text("province").notNull().default(""),
  // 主导产业，JSON 数组字符串
  industries: text("industries").notNull().default("[]"),
  // 代表园区，JSON 数组字符串
  parks: text("parks").notNull().default("[]"),
  // 用地成本档位：高 / 中高 / 中 / 低 / ""（未录入）
  landCostLevel: text("land_cost_level").notNull().default(""),
  laborCostLevel: text("labor_cost_level").notNull().default(""),
  note: text("note").notNull().default(""),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const policies = sqliteTable("policies", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  city: text("city").notNull(),
  title: text("title").notNull(),
  // 适用产业，JSON 数组字符串；空数组 = 不限产业
  industries: text("industries").notNull().default("[]"),
  benefit: text("benefit").notNull().default(""),
  threshold: text("threshold").notNull().default(""),
  deadline: text("deadline").notNull().default(""),
  sourceUrl: text("source_url").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  company: text("company").notNull(),
  industry: text("industry").notNull().default(""),
  signalId: integer("signal_id"),
  recommendedCity: text("recommended_city").notNull().default(""),
  stage: text("stage", {
    enum: ["lead", "talking", "signed", "landed", "producing", "dropped"],
  })
    .notNull()
    .default("lead"),
  owner: text("owner").notNull().default(""),
  nextStep: text("next_step").notNull().default(""),
  nextStepDate: text("next_step_date").notNull().default(""),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const followups = sqliteTable("followups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id").notNull(),
  kind: text("kind").notNull().default("跟进"),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const companyContacts = sqliteTable("company_contacts", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  // 联系方式挂在信号上（同一企业的不同信号各自带一份，方便从信号详情直接联系）
  signalId: integer("signal_id").notNull(),
  company: text("company").notNull().default(""),
  // 对接入口标签：董事会秘书 / 证券部 / 投资者关系 / 总机 / 投资部 / 招标联系人 / 环评公示联系人 等
  contactLabel: text("contact_label").notNull().default(""),
  // 公开姓名（仅限年报/公告里公开披露的董秘等职务人员，如「朱才伟」；可为空）
  contactName: text("contact_name").notNull().default(""),
  contactTitle: text("contact_title").notNull().default(""),
  // 只允许对公电话：座机（区号-号码，可带分机）、400/800 热线；个人手机号在服务端拦截
  phone: text("phone").notNull().default(""),
  email: text("email").notNull().default(""),
  address: text("address").notNull().default(""),
  sourceName: text("source_name").notNull().default(""),
  // 来源链接：自动采集的联系方式没有来源链接一律不入库
  sourceUrl: text("source_url").notNull().default(""),
  // 来源类型：企业官网 / 年报公告董秘 / 交易所公告 / 招标公告 / 环评公示 / 政府公示 / 手工录入 / 其他公开来源
  sourceType: text("source_type").notNull().default(""),
  // 核实状态：unverified 待核实 / verified 已核实 / stale 已过期
  verifyStatus: text("verify_status", {
    enum: ["unverified", "verified", "stale"],
  })
    .notNull()
    .default("unverified"),
  isManual: integer("is_manual").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const signalFollowups = sqliteTable("signal_followups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  signalId: integer("signal_id").notNull(),
  kind: text("kind").notNull().default("跟进"),
  content: text("content").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const refreshRuns = sqliteTable("refresh_runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  trigger: text("trigger").notNull().default("manual"),
  status: text("status").notNull().default("done"),
  addedCount: integer("added_count").notNull().default(0),
  note: text("note").notNull().default(""),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});
