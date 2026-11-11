// 招商雷达 — server actions.
//
// 数据流只有一条：refreshSignals 派一个研究任务去公开网络找真实的企业
// 投资/扩产信号，研究任务通过 saveSignalCandidates 回写候选（状态=待核实），
// 用户确认后才进入正式信号库。评分全部由 scoring.ts 的确定性模型算出。

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import {
  DEAL_STAGE_LABELS,
  effectiveDealStage,
  isLandedStage,
  landedOpportunities,
  parseIndustries,
  resolveLandedCity,
  scoreCity,
  type CityScore,
  type DealStage,
} from "./scoring";

// ---------- 城市名规范化 ----------
// 规范名以城市档案为准：上海 / 苏州 / 杭州 / 合肥 / 宁波 / 南京 / 无锡 / 常州 /
// 宣城市。两类历史写法要在这里统一掉：
// 1. 「宣城」是简称，别名映射到规范名「宣城市」（宣城市本身带「市」，不能削）；
// 2. 政策采集常把城市写成全称「上海市 / 苏州市 / 杭州市 / 宁波市」，而档案与
//    评分按简称精确比对城市名，带「市」的政策进了库也永远匹配不上、筛不出来。
//    因此写库时统一去掉末尾的「市」，对齐档案名。
// 所有城市字段在写入口、读出口都过一遍规范化，比选与评分只认规范名；
// 存量由 dedupeXuanchengCities / repairPolicies 回填。

export const CANONICAL_CITY = "宣城市";
const CITY_ALIASES: Record<string, string> = { 宣城: CANONICAL_CITY };

export function normalizeCityName(raw: string): string {
  const t = (raw ?? "").trim();
  if (t === CANONICAL_CITY) return t;
  if (CITY_ALIASES[t]) return CITY_ALIASES[t];
  if (t.length > 1 && t.endsWith("市")) {
    const stripped = t.slice(0, -1);
    return CITY_ALIASES[stripped] ?? stripped;
  }
  return t;
}

// ---------- 政策去重键 ----------
// 回写与修复共用两把键，任一命中都算重复：
// 1. 原文链接键：链接逐字比对（去首尾空白、统一小写、去掉末尾斜杠）；
// 2. 标题键：去掉《》等书名号与全部标点、空白后再比对——同一份文件被采集两次时
//    标题常一次带《》一次不带，只按原文标题比对会漏。
// 这样 18:00 定时刷新再采到同一份文件也写不进来，政策分不会被重复条数抬高。

export function policyUrlKey(url: string): string {
  return (url ?? "").trim().toLowerCase().replace(/\/+$/, "");
}

export function policyTitleKey(title: string): string {
  return (title ?? "")
    .replace(/[《》「」『』【】〈〉]/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}

// ---------- 信号候选去重：公司名规范化 + 事件键 ----------
// 旧去重只按「公司名原文 + 来源链接」：同一事件被不同来源转述时，公司名写法
// 常不同（「胜科纳米」vs「胜科纳米（苏州）股份有限公司」、「福莱新材」vs
// 「浙江福莱新材料股份有限公司」），来源链接也不同，两把键都对不上就重复入库。
// 回写入库前先把公司名规范化成核心名，再按「核心名 + 信号类型 + 报道日期」
// 判事件重复；原文的「公司名 + 来源链接」键保留作兜底。

const COMPANY_SUFFIXES = [
  "集团股份有限公司",
  "科技股份有限公司",
  "股份有限公司",
  "集团有限公司",
  "科技有限公司",
  "有限责任公司",
  "有限公司",
  "股份公司",
  "集团公司",
  "公司",
];

const COMPANY_REGION_PREFIXES = [
  "广西壮族自治区",
  "内蒙古自治区",
  "新疆维吾尔自治区",
  "宁夏回族自治区",
  "西藏自治区",
  "江苏省",
  "浙江省",
  "安徽省",
  "广东省",
  "山东省",
  "福建省",
  "四川省",
  "湖北省",
  "湖南省",
  "河北省",
  "河南省",
  "江西省",
  "辽宁省",
  "陕西省",
  "山西省",
  "云南省",
  "贵州省",
  "黑龙江省",
  "吉林省",
  "甘肃省",
  "青海省",
  "海南省",
  "台湾省",
  "上海市",
  "北京市",
  "天津市",
  "重庆市",
  "江苏",
  "浙江",
  "安徽",
  "广东",
  "山东",
  "福建",
  "四川",
  "湖北",
  "湖南",
  "河北",
  "河南",
  "江西",
  "辽宁",
  "陕西",
  "山西",
  "云南",
  "贵州",
  "黑龙江",
  "吉林",
  "甘肃",
  "青海",
  "海南",
  "上海",
  "北京",
  "天津",
  "重庆",
  "广西",
  "内蒙古",
  "新疆",
  "宁夏",
  "西藏",
];

/**
 * 公司名 → 核心名：去掉括号里的地名简称等括注、反复剥离工商后缀
 * （股份有限公司 / 有限公司 / 科技有限公司…）、剥离省级行政区前缀，
 * 并把行业全称「新材料」与简称「新材」视为同名。
 * 例：「胜科纳米（苏州）股份有限公司」→「胜科纳米」；
 * 「浙江福莱新材料股份有限公司」→「福莱新材」（与「福莱新材」同名）。
 */
export function normalizeCompanyName(raw: string): string {
  let s = (raw ?? "").trim().replace(/\s+/g, "");
  if (s === "") return "";
  s = s.replace(/（[^）]*）/g, "").replace(/\([^)]*\)/g, "");
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suf of COMPANY_SUFFIXES) {
      if (s.length > suf.length + 1 && s.endsWith(suf)) {
        s = s.slice(0, s.length - suf.length);
        stripped = true;
        break;
      }
    }
  }
  for (const p of COMPANY_REGION_PREFIXES) {
    if (s.length > p.length + 1 && s.startsWith(p)) {
      s = s.slice(p.length);
      break;
    }
  }
  if (s.length > 3 && s.endsWith("新材料")) s = `${s.slice(0, s.length - 3)}新材`;
  return s;
}

/** 信号事件键：规范化核心名 + 信号类型 + 报道日期。同事件换写法、换来源也同键。 */
export function signalEventKey(
  company: string,
  signalType: string,
  reportedDate: string,
): string {
  return `${normalizeCompanyName(company)}|${(signalType ?? "").trim()}|${(reportedDate ?? "").trim()}`;
}

/** 城市名列表规范化 + 去重（保持首次出现顺序）。 */
export function canonicalCityNames(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const c = normalizeCityName(n);
    if (c !== "" && !out.includes(c)) out.push(c);
  }
  return out;
}

function mergeStringLists(lists: string[][]): string[] {
  const out: string[] = [];
  for (const list of lists) {
    for (const v of list) {
      if (v !== "" && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

// ---------- shared output shapes ----------

const signalOut = z.object({
  id: z.number(),
  company: z.string(),
  industry: z.string(),
  signalType: z.string(),
  targetRegion: z.string(),
  investmentText: z.string(),
  investmentYi: z.number().nullable(),
  summary: z.string(),
  sourceName: z.string(),
  sourceUrl: z.string(),
  reportedDate: z.string(),
  status: z.string(),
  // 阶段：intent 意向 / negotiating 洽谈 / signed 已签约 / building 已开工 / producing 已投产
  dealStage: z.string(),
  dealStageLabel: z.string(),
  // 已签约及之后 = 已落地，不再跨市招引
  isLanded: z.boolean(),
  landedCity: z.string(),
  // 已落地时剩下的可跟进机会（配套 / 二期 / 以商招商）；可招引时为空数组
  opportunities: z.array(z.string()),
  // 在项目管道里的阶段（线索视角）：lead 线索 / talking 洽谈 / signed 签约 / landed 落地 / producing 投产 / dropped 搁置
  pipelineStage: z.string(),
  // 已入库的公开联系方式条数（对公渠道，见 company_contacts）
  contactCount: z.number(),
  createdAt: z.string(),
});
type SignalOut = z.infer<typeof signalOut>;

const cityProfileOut = z.object({
  id: z.number(),
  city: z.string(),
  province: z.string(),
  industries: z.array(z.string()),
  parks: z.array(z.string()),
  landCostLevel: z.string(),
  laborCostLevel: z.string(),
  note: z.string(),
  updatedAt: z.string(),
});

const policyOut = z.object({
  id: z.number(),
  city: z.string(),
  title: z.string(),
  industries: z.array(z.string()),
  benefit: z.string(),
  threshold: z.string(),
  deadline: z.string(),
  sourceUrl: z.string(),
  createdAt: z.string(),
});
type PolicyOut = z.infer<typeof policyOut>;

const cityScoreOut = z.object({
  city: z.string(),
  total: z.number(),
  verdict: z.string(),
  hardBlocked: z.boolean(),
  dealStage: z.string(),
  isLanded: z.boolean(),
  landedCity: z.string(),
  parts: z.object({
    industryFit: z.number(),
    scale: z.number(),
    chain: z.number(),
    carrier: z.number(),
    policy: z.number(),
    risk: z.number(),
  }),
  reasons: z.array(z.string()),
  gaps: z.array(z.string()),
  matchedPolicies: z.array(policyOut),
});

const projectOut = z.object({
  id: z.number(),
  company: z.string(),
  industry: z.string(),
  signalId: z.number().nullable(),
  recommendedCity: z.string(),
  stage: z.string(),
  owner: z.string(),
  nextStep: z.string(),
  nextStepDate: z.string(),
  note: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  followupCount: z.number(),
});

// 线索 = 已确认信号在「项目」管道里的形态：带最佳落地评分与管道阶段，
// 可直接跟进（signal_followups）与推进阶段（setSignalStage），不必先转项目。
const leadOut = signalOut.extend({
  bestCity: z.string(),
  bestScore: z.number(),
  verdict: z.string(),
  // 项目管道阶段：lead 线索 / talking 洽谈 / signed 签约 / landed 落地 / producing 投产
  pipelineStage: z.string(),
  followupCount: z.number(),
});
type LeadOut = z.infer<typeof leadOut>;

export const PIPELINE_STAGES = ["lead", "talking", "signed", "landed", "producing", "dropped"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** dealStage → 管道阶段的默认映射：签约前（意向/洽谈）都是线索第一阶段。 */
export function pipelineStageForDealStage(dealStage: string): PipelineStage {
  switch (dealStage) {
    case "signed":
      return "signed";
    case "building":
      return "landed";
    case "producing":
      return "producing";
    default:
      return "lead";
  }
}

/** 信号的有效管道阶段：用户显式推进过（pipeline_stage 非空）以它为准，否则按 dealStage 推导。 */
export function effectivePipelineStage(storedPipeline: string, dealStage: string): PipelineStage {
  if ((PIPELINE_STAGES as readonly string[]).includes(storedPipeline)) {
    return storedPipeline as PipelineStage;
  }
  return pipelineStageForDealStage(dealStage);
}

const contactOut = z.object({
  id: z.number(),
  signalId: z.number(),
  company: z.string(),
  contactLabel: z.string(),
  contactName: z.string(),
  contactTitle: z.string(),
  phone: z.string(),
  email: z.string(),
  address: z.string(),
  sourceName: z.string(),
  sourceUrl: z.string(),
  sourceType: z.string(),
  verifyStatus: z.string(),
  isManual: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
type ContactOut = z.infer<typeof contactOut>;

const contactCandidate = z.object({
  contactLabel: z.string().default(""),
  contactName: z.string().default(""),
  contactTitle: z.string().default(""),
  phone: z.string().default(""),
  email: z.string().default(""),
  address: z.string().default(""),
  sourceName: z.string().default(""),
  sourceUrl: z.string().default(""),
  sourceType: z.string().default(""),
});
type ContactCandidate = z.infer<typeof contactCandidate>;

// ---------- 联系方式隐私红线校验 ----------
// 只存对公公开联系方式（企业总机/董秘/证券部/IR/招标·环评公示联系人）：
// 个人手机号（1 开头 11 位）、私人微信、私人邮箱域名一律拦截，不入库、不展示。

const PERSONAL_EMAIL_DOMAINS = new Set([
  "qq.com", "163.com", "126.com", "yeah.net", "foxmail.com",
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com",
  "sina.com", "sina.cn", "sohu.com", "139.com", "189.cn", "aliyun.com",
  "icloud.com", "me.com", "yahoo.com", "yahoo.cn", "protonmail.com", "vip.qq.com",
]);

/** 是不是对公电话：座机（区号+号码，可带分机/转接）或 400/800 服务热线。 */
export function isPublicPhone(raw: string): boolean {
  // 分隔符（空格、连字符、括号）先全部去掉，各种书写格式归一后再判定
  let p = raw.trim().replace(/[\s()\-]/g, "");
  if (p === "") return false;
  // 国际格式 +86 前缀剥掉后按国内座机判定
  p = p.replace(/^\+86/, "").replace(/^86(?=0\d)/, "");
  // 分机部分（转612688 / 分机123 / ext123 / #123）单独剥离
  const extMatch = p.match(/^(.*?)(转|分机|ext\.?|#)(\d{1,8})$/i);
  const main = extMatch?.[1] ?? p;
  if (/^0\d{2,3}\d{7,8}$/.test(main)) return true; // 座机
  // +86-760-22363333 这类国际写法：剥掉国家码后区号不带 0（760 而非 0760），补回 0 再判定
  if (!main.startsWith("0") && /^0\d{2,3}\d{7,8}$/.test(`0${main}`)) return true;
  if (/^[48]00\d{3}\d{4}$/.test(main) || /^[48]00\d{7}$/.test(main)) return true; // 400/800
  return false;
}

/** 校验一条联系方式是否触碰隐私红线或格式不对；返回 "" = 通过，否则返回拦截原因。 */
export function contactRejectionReason(c: {
  contactLabel?: string;
  contactName?: string;
  phone?: string;
  email?: string;
}): string {
  const phone = (c.phone ?? "").trim();
  const email = (c.email ?? "").trim();
  const textBlob = `${c.contactLabel ?? ""} ${c.contactName ?? ""} ${phone} ${email}`;
  if (/微信|wechat|weixin/i.test(textBlob)) {
    return "包含微信等私人联系方式，按红线不入库";
  }
  if (phone !== "") {
    const digits = phone.replace(/[^0-9]/g, "");
    // 带 +86 国家码的手机号也要识别出来（8613800138000 → 13800138000）
    const domestic =
      digits.length === 13 && digits.startsWith("86") ? digits.slice(2) : digits;
    if (
      /(?:^|[^0-9])1[3-9]\d{9}(?:[^0-9]|$)/.test(phone) ||
      /^1[3-9]\d{9}$/.test(digits) ||
      /^1[3-9]\d{9}$/.test(domestic)
    ) {
      return "电话是个人手机号，只收企业座机 / 400·800 热线等对公电话";
    }
    if (!isPublicPhone(phone)) {
      return "电话格式不是可识别的对公电话（座机需带区号，或 400/800 热线）";
    }
  }
  if (email !== "") {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "邮箱格式不对";
    const domain = (email.split("@")[1] ?? "").toLowerCase();
    if (PERSONAL_EMAIL_DOMAINS.has(domain)) {
      return "邮箱是私人邮箱域名，只收企业官方域名邮箱（如董秘办/IR 邮箱）";
    }
  }
  return "";
}

const okOut = z.object({ ok: z.literal(true) });

const deleteSignalOut = z.object({
  ok: z.boolean(),
  deleted: z.boolean(),
  reason: z.string(),
  linkedProjectIds: z.array(z.number()),
});

const mergeDuplicateSignalsOut = z.object({
  ok: z.literal(true),
  signalsBefore: z.number(),
  signalsAfter: z.number(),
  pendingBefore: z.number(),
  pendingAfter: z.number(),
  merges: z.array(
    z.object({
      core: z.string(),
      keptId: z.number(),
      removedId: z.number(),
      keptCompany: z.string(),
      removedCompany: z.string(),
      mergedNote: z.string(),
    }),
  ),
  skippedPairs: z.array(z.object({ core: z.string(), reason: z.string() })),
  remainingByCore: z.array(z.object({ core: z.string(), count: z.number() })),
});

// ---------- row mappers ----------

type SignalRow = typeof schema.signals.$inferSelect;
type CityRow = typeof schema.cityProfiles.$inferSelect;
type PolicyRowT = typeof schema.policies.$inferSelect;
type ProjectRow = typeof schema.projects.$inferSelect;

/** 信号的有效阶段与落地城市：存量阶段与来源证据取更靠后者，证据说已签约就按已落地处理。 */
function stageContext(r: SignalRow, knownCities: string[]) {
  const cities = canonicalCityNames(knownCities);
  const dealStage: DealStage = effectiveDealStage(r.dealStage, r.signalType, r.summary);
  const landed = isLandedStage(dealStage);
  const landedCity = landed
    ? normalizeCityName(resolveLandedCity(r.landedCity, r.targetRegion, r.summary, cities))
    : "";
  return { dealStage, landed, landedCity };
}

export interface ParsedCityProfile {
  id: number;
  city: string;
  province: string;
  industries: string[];
  parks: string[];
  landCostLevel: string;
  laborCostLevel: string;
  note: string;
  updatedAt: Date;
}

/**
 * 城市档案读出口的合并视图：按规范名分组，宣城市/宣城只出一行。
 * 保留行 = 规范名本身的那条（没有则取 id 最小的一条）；产业/园区取并集，
 * 成本档位与备注在保留行为空时从被合并行补齐。只影响读取展示，
 * 存量行的真正删除由 dedupeXuanchengCities 完成。
 */
export function dedupeCityProfiles(rows: CityRow[]): ParsedCityProfile[] {
  const groups = new Map<string, CityRow[]>();
  for (const r of rows) {
    const key = normalizeCityName(r.city);
    const g = groups.get(key);
    if (g) g.push(r);
    else groups.set(key, [r]);
  }
  const out: ParsedCityProfile[] = [];
  for (const [city, g] of groups) {
    const sorted = [...g].sort((a, b) => a.id - b.id);
    const keeper = sorted.find((r) => r.city === city) ?? sorted[0];
    if (!keeper) continue;
    const others = sorted.filter((r) => r.id !== keeper.id);
    out.push({
      id: keeper.id,
      city,
      province: keeper.province || (others.find((r) => r.province !== "")?.province ?? ""),
      industries: mergeStringLists(sorted.map((r) => parseIndustries(r.industries))),
      parks: mergeStringLists(sorted.map((r) => parseIndustries(r.parks))),
      landCostLevel:
        keeper.landCostLevel || (others.find((r) => r.landCostLevel !== "")?.landCostLevel ?? ""),
      laborCostLevel:
        keeper.laborCostLevel || (others.find((r) => r.laborCostLevel !== "")?.laborCostLevel ?? ""),
      note: keeper.note || (others.find((r) => r.note !== "")?.note ?? ""),
      updatedAt: sorted.reduce(
        (max, r) => (r.updatedAt > max ? r.updatedAt : max),
        keeper.updatedAt,
      ),
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

/** 给评分模型用的城市档案视图（已按规范名去重）。 */
function profileRowsForScoring(rows: CityRow[]) {
  return dedupeCityProfiles(rows).map((p) => ({
    city: p.city,
    province: p.province,
    industries: p.industries,
    parks: p.parks,
    landCostLevel: p.landCostLevel,
    laborCostLevel: p.laborCostLevel,
  }));
}

type ContactRow = typeof schema.companyContacts.$inferSelect;

function toContact(r: ContactRow): ContactOut {
  return {
    id: r.id,
    signalId: r.signalId,
    company: r.company,
    contactLabel: r.contactLabel,
    contactName: r.contactName,
    contactTitle: r.contactTitle,
    phone: r.phone,
    email: r.email,
    address: r.address,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl,
    sourceType: r.sourceType,
    verifyStatus: r.verifyStatus,
    isManual: r.isManual === 1,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

async function contactCountMap(ctx: Ctx): Promise<Map<number, number>> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select({ signalId: schema.companyContacts.signalId })
    .from(schema.companyContacts);
  const map = new Map<number, number>();
  for (const r of rows) map.set(r.signalId, (map.get(r.signalId) ?? 0) + 1);
  return map;
}

/**
 * 把联系方式候选写入库：没有来源链接的不收、触碰隐私红线的不收、
 * 电话/邮箱/地址全空的不收、与已有记录重复（同信号+电话+邮箱+入口）的不重复写。
 * 返回真正入库数、跳过数与逐条拦截原因，供回写动作如实报告。
 */
async function insertContacts(
  ctx: Ctx,
  signalId: number,
  company: string,
  candidates: ContactCandidate[],
  isManual: boolean,
): Promise<{ added: number; skipped: number; rejected: string[] }> {
  const db = ctx.db<typeof schema>();
  const existing = await db
    .select({
      phone: schema.companyContacts.phone,
      email: schema.companyContacts.email,
      contactLabel: schema.companyContacts.contactLabel,
    })
    .from(schema.companyContacts)
    .where(eq(schema.companyContacts.signalId, signalId));
  const seen = new Set(existing.map((e) => `${e.contactLabel}|${e.phone}|${e.email}`));
  let added = 0;
  let skipped = 0;
  const rejected: string[] = [];
  for (const c of candidates) {
    const label = c.contactLabel.trim() || "对公联系方式";
    if (!isManual && c.sourceUrl.trim() === "") {
      rejected.push(`${label}：没有来源链接，未入库（联系方式必须有公开出处）`);
      skipped++;
      continue;
    }
    const reason = contactRejectionReason(c);
    if (reason !== "") {
      rejected.push(`${label}：${reason}`);
      skipped++;
      continue;
    }
    if (c.phone.trim() === "" && c.email.trim() === "" && c.address.trim() === "") {
      rejected.push(`${label}：电话、邮箱、地址全为空，未入库`);
      skipped++;
      continue;
    }
    const key = `${label}|${c.phone.trim()}|${c.email.trim()}`;
    if (seen.has(key)) {
      skipped++;
      continue;
    }
    seen.add(key);
    await db.insert(schema.companyContacts).values({
      signalId,
      company,
      contactLabel: label,
      contactName: c.contactName.trim(),
      contactTitle: c.contactTitle.trim(),
      phone: c.phone.trim(),
      email: c.email.trim(),
      address: c.address.trim(),
      sourceName: c.sourceName.trim(),
      sourceUrl: c.sourceUrl.trim(),
      sourceType: c.sourceType.trim() || (isManual ? "手工录入" : "其他公开来源"),
      verifyStatus: "unverified",
      isManual: isManual ? 1 : 0,
    });
    added++;
  }
  return { added, skipped, rejected };
}

function toSignal(
  r: SignalRow,
  knownCities: string[] = SEED_CITIES.map((c) => c.city),
  contactCount = 0,
): SignalOut {
  const { dealStage, landed, landedCity } = stageContext(r, knownCities);
  return {
    id: r.id,
    company: r.company,
    industry: r.industry,
    signalType: r.signalType,
    targetRegion: r.targetRegion,
    investmentText: r.investmentText,
    investmentYi: r.investmentYi,
    summary: r.summary,
    sourceName: r.sourceName,
    sourceUrl: r.sourceUrl,
    reportedDate: r.reportedDate,
    status: r.status,
    dealStage,
    dealStageLabel: DEAL_STAGE_LABELS[dealStage],
    isLanded: landed,
    landedCity,
    opportunities: landed ? landedOpportunities(r.industry, landedCity) : [],
    pipelineStage: effectivePipelineStage(r.pipelineStage, dealStage),
    contactCount,
    createdAt: r.createdAt.toISOString(),
  };
}

/** 给评分模型用的信号视图：带上有效阶段，已落地的不会再拿到招引结论。 */
function signalForScoring(r: SignalRow, knownCities: string[]) {
  const { dealStage, landedCity } = stageContext(r, knownCities);
  return {
    company: r.company,
    industry: r.industry,
    signalType: r.signalType,
    investmentYi: r.investmentYi,
    dealStage,
    landedCity,
    targetRegion: r.targetRegion,
    summary: r.summary,
  };
}

/** 已确认信号 → 项目页线索：算最佳落地评分、管道阶段与线索跟进数。已落地的沿用降级口径（评分 0、只看配套/二期）。 */
async function buildLeads(ctx: Ctx, rows: SignalRow[]): Promise<LeadOut[]> {
  const db = ctx.db<typeof schema>();
  const confirmed = rows.filter((r) => r.status === "confirmed");
  if (confirmed.length === 0) return [];
  const profiles = profileRowsForScoring(await db.select().from(schema.cityProfiles));
  const policies = (await db.select().from(schema.policies)).map(toPolicy);
  const cityNames = profiles.map((p) => p.city);
  const counts = await contactCountMap(ctx);
  const fuRows = await db
    .select({ signalId: schema.signalFollowups.signalId })
    .from(schema.signalFollowups);
  const fuCounts = new Map<number, number>();
  for (const f of fuRows) fuCounts.set(f.signalId, (fuCounts.get(f.signalId) ?? 0) + 1);
  return confirmed.map((s) => {
    const out = toSignal(s, cityNames, counts.get(s.id) ?? 0);
    const pipelineStage = effectivePipelineStage(s.pipelineStage, out.dealStage);
    if (out.isLanded) {
      return {
        ...out,
        bestCity: out.landedCity,
        bestScore: 0,
        verdict: "已落地 · 看配套/二期",
        pipelineStage,
        followupCount: fuCounts.get(s.id) ?? 0,
      };
    }
    const best = profiles
      .map((pr) => scoreCity(signalForScoring(s, cityNames), pr, policies))
      .sort((a, b) => b.total - a.total)[0];
    return {
      ...out,
      bestCity: best?.city ?? "",
      bestScore: best?.total ?? 0,
      verdict: best?.verdict ?? "",
      pipelineStage,
      followupCount: fuCounts.get(s.id) ?? 0,
    };
  });
}

function toPolicy(r: PolicyRowT): PolicyOut {
  return {
    id: r.id,
    city: normalizeCityName(r.city),
    title: r.title,
    industries: parseIndustries(r.industries),
    benefit: r.benefit,
    threshold: r.threshold,
    deadline: r.deadline,
    sourceUrl: r.sourceUrl,
    createdAt: r.createdAt.toISOString(),
  };
}

function toScore(s: CityScore): z.infer<typeof cityScoreOut> {
  return {
    city: s.city,
    total: s.total,
    verdict: s.verdict,
    hardBlocked: s.hardBlocked,
    dealStage: s.dealStage,
    isLanded: s.isLanded,
    landedCity: s.landedCity,
    parts: s.parts,
    reasons: s.reasons,
    gaps: s.gaps,
    matchedPolicies: s.matchedPolicies,
  };
}

// 首次打开时写入长三角城市产业档案（参考目录，来自已确认的规划；
// 成本档位未定的留空，用户可在「我的」里补录/修改，之后不再被覆盖）。
const SEED_CITIES: Array<{
  city: string;
  province: string;
  industries: string[];
  parks: string[];
  landCostLevel: string;
  laborCostLevel: string;
  note: string;
}> = [
  // 成本档位为定性参考档（来自已确认规划中的城市描述：上海成本高、合肥成本低、
  // 常州成本适中，其余按长三角一般梯队定档），不含具体价格，用户可在档案里改。
  { city: "上海", province: "上海市", industries: ["集成电路", "生物医药", "人工智能"], parks: ["临港新片区", "张江高科技园区"], landCostLevel: "高", laborCostLevel: "高", note: "总部与研发高地，用地与人力成本高" },
  { city: "苏州", province: "江苏省", industries: ["电子信息", "生物医药", "纳米技术"], parks: ["苏州工业园区", "昆山开发区"], landCostLevel: "中高", laborCostLevel: "中高", note: "外资制造集聚，产业链配套完整" },
  { city: "杭州", province: "浙江省", industries: ["数字经济", "生物医药"], parks: ["钱塘新区", "萧山经济技术开发区"], landCostLevel: "中高", laborCostLevel: "高", note: "数字经济强，电商与软件生态突出" },
  { city: "合肥", province: "安徽省", industries: ["新能源汽车", "集成电路", "人工智能"], parks: ["合肥高新区", "新站高新区"], landCostLevel: "低", laborCostLevel: "中", note: "成本相对低，新兴产业增速快" },
  { city: "宁波", province: "浙江省", industries: ["新材料", "石化", "智能家电"], parks: ["宁波高新区", "前湾新区"], landCostLevel: "中", laborCostLevel: "中", note: "港口优势，材料与制造基础强" },
  { city: "南京", province: "江苏省", industries: ["软件", "集成电路", "新能源汽车"], parks: ["江北新区", "南京经开区"], landCostLevel: "中", laborCostLevel: "中高", note: "科教资源密集，软件产业突出" },
  { city: "无锡", province: "江苏省", industries: ["物联网", "集成电路", "生物医药"], parks: ["无锡高新区", "锡山经开区"], landCostLevel: "中", laborCostLevel: "中", note: "物联网与集成电路封测强" },
  { city: "常州", province: "江苏省", industries: ["动力电池", "新能源汽车", "装备制造"], parks: ["常州高新区", "武进高新区"], landCostLevel: "中", laborCostLevel: "中", note: "动力电池产业链完整，成本适中" },
  { city: "宣城市", province: "安徽省", industries: ["新能源", "新能源汽车", "汽车零部件", "高端装备制造", "装备制造"], parks: ["宣城经开区", "宣城高新区"], landCostLevel: "低", laborCostLevel: "中", note: "皖苏浙交界，汽车零部件与新能源集聚，用地成本低" },
];

// 全部公开可抓数据源目录（用户 2026-11-10 要求「全部都干」后整合）。
// 分两组：已接入 = 无需登录、无需绕验证码、可通过公开网页搜索稳定获取；
// 暂不直爬 = 有验证码/登录/强反爬，不做欺骗式抓取，后续走官方 API。
export const DATA_SOURCE_CATALOG: Array<{
  id: string;
  category: string;
  channel: string;
  examples: string;
  signalTypes: string;
  strength: string;
  status: "active" | "excluded";
  note: string;
}> = [
  { id: "finance-news", category: "财经新闻", channel: "公开新闻搜索", examples: "新浪财经、财联社、36氪、界面新闻、澎湃新闻、证券时报、上海证券报、中国证券报", signalTypes: "签约落户 / 增资扩产 / 投产 / 战略合作", strength: "中", status: "active", note: "量最大、更新最快，需剔除推介通稿，只留具体企业+具体动作" },
  { id: "company-site", category: "企业官网", channel: "企业官网新闻中心", examples: "上市公司与外企官网新闻中心（如阿斯利康、巴斯夫官网）", signalTypes: "签约落户 / 增资扩产 / 投产", strength: "强", status: "active", note: "企业一手发布，准确性最高" },
  { id: "listed-announce", category: "上市公司公告", channel: "交易所与巨潮公告", examples: "巨潮资讯网、上交所、深交所、北交所", signalTypes: "新设子公司 / 增资扩产 / 项目备案 / 其他", strength: "强", status: "active", note: "公告首发，含投资额与子公司信息，权威性最高" },
  { id: "gov-news", category: "地方政府新闻", channel: "各市政府官网", examples: "上海/苏州/杭州/合肥/宁波/南京/无锡/常州/宣城市政府网及招商局、发改委、经信局栏目", signalTypes: "签约落户 / 投产 / 项目备案", strength: "强", status: "active", note: "官方确认的签约、开工、投产消息" },
  { id: "bidding", category: "招投标", channel: "公共资源交易", examples: "中国招标投标公共服务平台、全国公共资源交易平台、苏浙皖沪各省公共资源交易中心", signalTypes: "建厂招标 / 施工许可", strength: "强", status: "active", note: "建厂招标与中标公告，含项目名、投资额、中标企业，是已进入实施阶段的强信号" },
  { id: "land", category: "土地出让", channel: "土地市场与自然资源局", examples: "中国土地市场网、各地自然资源和规划局土地出让公告", signalTypes: "拿地", strength: "最强", status: "active", note: "企业拿地是最强建厂信号，含地块、面积、成交价；各市格式不一，按公告原文提取" },
  { id: "park-site", category: "园区官网", channel: "园区官网动态", examples: "苏州工业园区、合肥高新区、钱塘新区、前湾新区、临港新片区、张江、宣城经开区、宣城高新区等", signalTypes: "签约落户 / 投产", strength: "中", status: "active", note: "园区一手签约入驻动态，量小但落地指向明确" },
  { id: "invest-platform", category: "招商平台", channel: "招商信息平台", examples: "中国招商引资信息网、投资中国网、长三角一体化示范区官网", signalTypes: "签约落户 / 其他", strength: "弱-中", status: "active", note: "含推介稿，必须过滤：没有具体企业全名的不收" },
  { id: "stock-market", category: "股市聚合", channel: "同花顺 / 东方财富聚合（源头回巨潮·交易所）", examples: "同花顺 F10 项目投资表、东方财富公告大全（data.eastmoney.com）；聚合只作检索与交叉核对，最终来源以巨潮资讯/上交所/深交所/北交所公告原文为准，不直爬同花顺/东方财富网页", signalTypes: "定增募投 / 互动易问答 / 调研纪要 / 在建工程", strength: "中-强（定增）·弱（问答/调研）", status: "active", note: "专补签约前的意向信号：定增募投有董事会决议+募资金额+投向，最实；互动易/e互动与调研纪要是意向表述，必须过滤「暂无应披露事项」类空答复；年报在建工程是存量科目，地点进度需回原文核实。四类都按意向/洽谈处理，原文没写已签约就不标已落地" },
  { id: "financing", category: "融资动态", channel: "创投融资公开报道", examples: "IT桔子、企名片、36氪融资首发", signalTypes: "融资", strength: "弱-中", status: "active", note: "刚完成融资的企业下一步常扩产/设区域总部，但融资本身不等于选址；只收金额、轮次与资金用途写清、且用途指向长三角制造/研发扩张的" },
  { id: "recruitment", category: "招聘扩张", channel: "招聘平台公开职位（经公开搜索）", examples: "BOSS直聘、猎聘公开职位页", signalTypes: "招聘扩张", strength: "弱", status: "active", note: "诚实边界：多数职位不披露新厂地点与人数，只有搜索结果明确写出工作地点（长三角城市）+岗位类别（生产/研发/厂务）或招聘规模的才收；单条招聘不能单独作为落地依据，必须与公告/新闻交叉验证" },
  { id: "patent", category: "专利产业化", channel: "国家知识产权局专利公告", examples: "国家知识产权局专利公布公告、地方知识产权局产业化/成果转化报道", signalTypes: "专利产业化", strength: "最弱", status: "active", note: "诚实边界：专利只证明技术储备，不证明要建厂；只收原文同时写明产业化、成果转化、中试/量产线或新建产线的，单纯的专利授权公告不收，仅作长期跟踪线索" },
  { id: "eia", category: "环评/能评公示", channel: "各地生态环境局公示栏目", examples: "沪苏浙皖各级生态环境局建设项目环境影响评价公示、节能审查（能评）公示", signalTypes: "环评公示", strength: "最强", status: "active", note: "环评公示意味着选址已定、项目进入审批，是签约前最硬的落地证据之一：阶段按已签约（已落地）处理、公示地点即落地城市。此路只取生态环境局公开公示栏目，与暂不直爬的投资项目在线审批监管平台是两回事" },
  { id: "credit-system", category: "企业信用公示", channel: "国家企业信用信息公示系统", examples: "国家企业信用信息公示系统", signalTypes: "新设子公司", strength: "强", status: "excluded", note: "有验证码，批量直爬不稳定，暂不直爬；后续如需，走合规数据服务" },
  { id: "approval-platform", category: "项目备案平台", channel: "投资项目在线审批监管平台", examples: "投资项目在线审批监管平台", signalTypes: "项目备案", strength: "最强", status: "excluded", note: "有验证限制，暂不直爬；备案类信号先由公告、政府新闻、招投标三路交叉覆盖" },
  { id: "commercial-web", category: "商业数据库网页版", channel: "天眼查 / 企查查 / 启信宝网页版", examples: "天眼查、企查查、启信宝网页版", signalTypes: "新设子公司 / 增资扩产", strength: "强", status: "excluded", note: "登录+验证码+强反爬，不做欺骗式抓取；用户已明确先不走 API，此路暂缓" },
];

async function ensureSeedCities(ctx: Ctx) {
  const db = ctx.db<typeof schema>();
  const existing = await db.select({ id: schema.cityProfiles.id }).from(schema.cityProfiles).limit(1);
  if (existing.length > 0) return;
  await db.insert(schema.cityProfiles).values(
    SEED_CITIES.map((c) => ({
      city: c.city,
      province: c.province,
      industries: JSON.stringify(c.industries),
      parks: JSON.stringify(c.parks),
      landCostLevel: c.landCostLevel,
      laborCostLevel: c.laborCostLevel,
      note: c.note,
    })),
  );
}

// ---------- 联系方式获取任务 ----------
// 已由人工从公开来源核对过的对接入口（年报/官网公开披露）：作为研究任务的
// 定位锚点，帮助任务快速定位到原文页面；任务仍必须在实际打开的页面里找到
// 并带回那一页的完整链接，saveSignalContacts 才会入库——锚点本身不是来源。
const KNOWN_CONTACT_ANCHORS: Array<{ match: string; anchor: string }> = [
  {
    match: "晶合集成",
    anchor:
      "已核对锚点（请在年报/公告原文里定位并带回原文链接）：董事会秘书朱才伟，电话 0551-62637000转612688，邮箱 stock@nexchip.com.cn，地址合肥新站区西淝河路88号",
  },
  {
    match: "微导纳米",
    anchor:
      "已核对锚点（请在年报/公告原文里定位并带回原文链接）：董事会秘书龙文，电话 0510-81975986，邮箱 security@leadmicro.com，地址无锡新吴区长江南路27号",
  },
  {
    match: "皇冠新材",
    anchor:
      "已核对锚点（请在企业官网/年报原文里定位并带回原文链接）：总机 +86-760-22363333，邮箱 ir@crown.com.cn；江苏子公司电话 0512-53378881，地址太仓双凤镇新湖湖滨路5号",
  },
];

/** 派一个联系方式研究任务。dedupeKey 由调用方给出：重试必须换新键，否则会一直恢复旧任务。 */
async function startContactLookup(
  ctx: Ctx,
  sig: SignalRow,
  dedupeKey: string,
): Promise<{ ok: boolean; message: string }> {
  const anchor = KNOWN_CONTACT_ANCHORS.find((a) => sig.company.includes(a.match))?.anchor;
  const message = [
    `你是招商雷达的联系方式研究员。请用网页搜索，为企业「${sig.company}」查找可公开核实的工作联系方式。这家企业的已知背景：${sig.industry ? `所属产业 ${sig.industry}；` : ""}信号类型 ${sig.signalType}；${sig.summary ? `信号摘要：${sig.summary}；` : ""}${sig.sourceUrl ? `信号原始来源：${sig.sourceUrl}（可先从这篇原文及其出处页找起）` : ""}`,
    ...(anchor ? [anchor] : []),
    "只查这五类公开对公渠道，按优先级找：(1) 企业官网的「联系我们 / 投资者关系」页面——总机、传真、IR 邮箱、公司地址；(2) 年报、半年报、招股书、上市公司公告里披露的董事会秘书、证券事务代表、证券部——姓名、职务、联系电话（座机）、传真、电子信箱、办公地址，这是最优先的对接入口；(3) 交易所公告（巨潮资讯/上交所/深交所/北交所）里项目联系人信息；(4) 招标公告、中标公告里公开的招标人/代理机构联系人与座机；(5) 环评公示、政府公示里公开的建设单位联系人与座机。",
    "每条联系方式必须给出：入口标签 contactLabel（如 董事会秘书 / 证券部 / 投资者关系 / 总机 / 招标联系人 / 环评公示联系人）、公开姓名 contactName（只有年报/公告里公开披露了姓名的董秘等职务人员才写，其他留空）、职务 contactTitle（如 董事会秘书）、电话 phone、邮箱 email、企业地址 address、来源名称 sourceName（写实际页面出处，如「微导纳米 2024 年年度报告」「企业官网联系我们」）、来源链接 sourceUrl（必须是你实际打开的页面完整链接，逐字复制，不要拼造）、来源类型 sourceType（从 企业官网 / 年报公告董秘 / 交易所公告 / 招标公告 / 环评公示 / 政府公示 里选）。",
    "【隐私红线·必须遵守】只收对公联系方式：座机（带区号，可带分机）、400/800 热线、企业官方域名邮箱。个人手机号（1 开头 11 位）、私人微信号、私人邮箱（qq.com、163.com、126.com、gmail.com、outlook.com、sina.com 等个人域名）一律不提交，哪怕在原文里看到也不提交。不要去天眼查/企查查/启信宝等需要登录的商业数据库网页找联系方式（有登录与反爬），不要提交任何需要登录才能看到的号码。",
    "目标 1–4 条最有用的对接入口，优先董秘/证券部/IR，其次总机与投资相关部门，再次招标/环评公示联系人。确实找不到带公开来源链接的对公联系方式时，提交空数组并在 note 里说明查了哪些渠道、为什么没有，不要硬凑、不要编造号码。",
    "完成后通过指定的回写动作一次性提交，note 里写明每条联系方式的出处渠道。",
  ].join("\n");
  const res = await ctx.agent.spawnTask(message, {
    expectsAction: "saveSignalContacts",
    dedupeKey,
  });
  if (!res.ok) {
    return { ok: false, message: `联系方式获取任务未能启动：${res.error}` };
  }
  return {
    ok: true,
    message: `已启动为「${sig.company}」查找公开联系方式（官网 / 年报董秘 / 公告 / 招标 / 环评公示），约 1–3 分钟后结果会出现在下方；只收对公电话与官方邮箱，私人手机号、微信、私人邮箱不会入库。`,
  };
}

export const Actions = {
  getOverview: defineAction({
    description: "雷达首页概览：待核实数、待核实里可招引（意向/洽谈）的条数、已确认信号数、跟进中项目数、今日待办、最佳信号（只取已确认）与最近刷新记录。",
    request: z.object({}),
    response: z.object({
      pendingCount: z.number(),
      // 待核实候选里可招引（意向/洽谈、未落地）的条数：与已确认口径分开单列，
      // 免得「已确认 0 条」被误读成「雷达没抓到可招引的」
      pendingRecruitableCount: z.number(),
      confirmedCount: z.number(),
      recruitableCount: z.number(),
      landedSignalCount: z.number(),
      activeProjectCount: z.number(),
      landedCount: z.number(),
      policyCount: z.number(),
      cityCostComplete: z.number(),
      cityTotal: z.number(),
      stageCounts: z.array(z.object({ stage: z.string(), count: z.number() })),
      industryCounts: z.array(z.object({ industry: z.string(), count: z.number() })),
      dueToday: z.array(projectOut),
      topSignals: z.array(
        signalOut.extend({ bestCity: z.string(), bestScore: z.number(), verdict: z.string() }),
      ),
      lastRun: z
        .object({
          createdAt: z.string(),
          addedCount: z.number(),
          status: z.string(),
          note: z.string(),
          trigger: z.string(),
        })
        .nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);
      const allSignals = await db.select().from(schema.signals).orderBy(desc(schema.signals.id));
      const projects = await db.select().from(schema.projects);
      const profiles = await db.select().from(schema.cityProfiles);
      const policies = (await db.select().from(schema.policies)).map(toPolicy);
      const runs = await db
        .select()
        .from(schema.refreshRuns)
        .orderBy(desc(schema.refreshRuns.id))
        .limit(1);

      const today = new Date().toISOString().slice(0, 10);
      const followupCounts = new Map<number, number>();
      const fus = await db.select().from(schema.followups);
      for (const f of fus) followupCounts.set(f.projectId, (followupCounts.get(f.projectId) ?? 0) + 1);
      const toProject = (p: ProjectRow): z.infer<typeof projectOut> => ({
        id: p.id,
        company: p.company,
        industry: p.industry,
        signalId: p.signalId,
        recommendedCity: normalizeCityName(p.recommendedCity),
        stage: p.stage,
        owner: p.owner,
        nextStep: p.nextStep,
        nextStepDate: p.nextStepDate,
        note: p.note,
        createdAt: p.createdAt.toISOString(),
        updatedAt: p.updatedAt.toISOString(),
        followupCount: followupCounts.get(p.id) ?? 0,
      });

      const dedupedProfiles = dedupeCityProfiles(profiles);
      const profileRows = profileRowsForScoring(profiles);

      const cityNames = profileRows.map((p) => p.city);
      const counts = await contactCountMap(ctx);
      const enriched = allSignals.map((s) => toSignal(s, cityNames, counts.get(s.id) ?? 0));
      // 首页最佳信号只推可招引的（意向/洽谈）：已签约的项目城市已定，推了也是误导
      const topSignals = allSignals
        .filter((s) => s.status === "confirmed")
        .map((s) => ({ row: s, out: toSignal(s, cityNames, counts.get(s.id) ?? 0) }))
        .filter((x) => !x.out.isLanded)
        .map(({ row: s, out }) => {
          const scores = profileRows.map((pr) => scoreCity(signalForScoring(s, cityNames), pr, policies));
          const best = scores.sort((a, b) => b.total - a.total)[0];
          return {
            ...out,
            bestCity: best?.city ?? "",
            bestScore: best?.total ?? 0,
            verdict: best?.verdict ?? "",
          };
        })
        .sort((a, b) => b.bestScore - a.bestScore)
        .slice(0, 3);

      // 管道计数 = 项目行 + 线索（已确认信号）：线索按有效管道阶段计入对应阶段，
      // 这样雷达头部的管道总览与「项目」页看到的是同一条管道。
      const stageOrder = ["lead", "talking", "signed", "landed", "producing", "dropped"];
      const leadStageCounts = new Map<string, number>();
      for (const r of allSignals) {
        if (r.status !== "confirmed") continue;
        const { dealStage } = stageContext(r, cityNames);
        const ps = effectivePipelineStage(r.pipelineStage, dealStage);
        leadStageCounts.set(ps, (leadStageCounts.get(ps) ?? 0) + 1);
      }
      const stageCounts = stageOrder.map((stage) => ({
        stage,
        count:
          projects.filter((p) => p.stage === stage).length + (leadStageCounts.get(stage) ?? 0),
      }));
      const indMap = new Map<string, number>();
      for (const s of allSignals) {
        if ((s.status === "confirmed" || s.status === "converted") && s.industry !== "") {
          indMap.set(s.industry, (indMap.get(s.industry) ?? 0) + 1);
        }
      }
      const industryCounts = [...indMap.entries()]
        .map(([industry, count]) => ({ industry, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      const last = runs[0];
      const liveSignals = enriched.filter(
        (s) => s.status === "confirmed" || s.status === "converted",
      );
      return {
        pendingCount: allSignals.filter((s) => s.status === "pending").length,
        pendingRecruitableCount: enriched.filter(
          (s) => s.status === "pending" && !s.isLanded,
        ).length,
        confirmedCount: allSignals.filter((s) => s.status === "confirmed").length,
        recruitableCount: liveSignals.filter((s) => !s.isLanded).length,
        landedSignalCount: liveSignals.filter((s) => s.isLanded).length,
        activeProjectCount: projects.filter((p) => !["landed", "producing", "dropped"].includes(p.stage)).length,
        landedCount: projects.filter((p) => ["landed", "producing"].includes(p.stage)).length,
        policyCount: policies.length,
        cityCostComplete: dedupedProfiles.filter((p) => p.landCostLevel !== "" && p.laborCostLevel !== "").length,
        cityTotal: dedupedProfiles.length,
        stageCounts,
        industryCounts,
        dueToday: projects
          .filter((p) => p.nextStepDate !== "" && p.nextStepDate <= today && !["landed", "producing", "dropped"].includes(p.stage))
          .map(toProject),
        topSignals,
        lastRun: last
          ? {
              createdAt: last.createdAt.toISOString(),
              addedCount: last.addedCount,
              status: last.status,
              note: last.note,
              trigger: last.trigger,
            }
          : null,
      };
    },
  }),

  listSignals: defineAction({
    description: "按状态列出投资信号（pending 待核实 / confirmed 已确认 / converted 已转项目 / dismissed 已忽略），最新在前，附各信号的最佳落地城市与评分。",
    request: z.object({
      status: z.enum(["pending", "confirmed", "dismissed", "converted", "all"]).default("all"),
      limit: z.number().int().positive().max(200).default(100),
    }),
    response: z.object({
      signals: z.array(
        signalOut.extend({ bestCity: z.string(), bestScore: z.number(), verdict: z.string() }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);
      const rows = await db
        .select()
        .from(schema.signals)
        .orderBy(desc(schema.signals.id))
        .limit(args.limit);
      const profiles = profileRowsForScoring(await db.select().from(schema.cityProfiles));
      const policies = (await db.select().from(schema.policies)).map(toPolicy);
      const cityNames = profiles.map((p) => p.city);
      const counts = await contactCountMap(ctx);
      const filtered =
        args.status === "all" ? rows : rows.filter((r) => r.status === args.status);
      const mapped = filtered.map((s) => {
        const out = toSignal(s, cityNames, counts.get(s.id) ?? 0);
        if (out.isLanded) {
          // 已落地：不再算「最佳落地城市」，只标注已定城市，评分仅供参考
          return {
            ...out,
            bestCity: out.landedCity,
            bestScore: 0,
            verdict: "已落地 · 看配套/二期",
          };
        }
        const best = profiles
          .map((pr) => scoreCity(signalForScoring(s, cityNames), pr, policies))
          .sort((a, b) => b.total - a.total)[0];
        return {
          ...out,
          bestCity: best?.city ?? "",
          bestScore: best?.total ?? 0,
          verdict: best?.verdict ?? "",
        };
      });
      // 降级排序：可招引的排前面，已落地的沉到列表后部（同组内仍按最新在前）
      mapped.sort((a, b) => Number(a.isLanded) - Number(b.isLanded));
      return { signals: mapped };
    },
  }),

  refreshSignals: defineAction({
    description: "触发一次全量雷达刷新：派研究任务到全部公开可抓数据源（财经新闻、企业官网、上市公司公告、政府新闻、招投标、土地出让、园区官网、招商平台、股市聚合、融资动态、招聘扩张、专利产业化、环评/能评公示）搜索长三角最新企业投资/扩产信号，结果以待核实候选回写。",
    request: z.object({
      trigger: z.enum(["manual", "scheduled"]).default("manual"),
    }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const today = new Date().toISOString().slice(0, 10);
      const message = [
        "你是招商雷达的研究员。请用网页搜索，查找最近 30 天内真实发生的、企业有意向或已经在长三角（上海、江苏、浙江、安徽，含宣城）投资、建厂、扩产、增资、拿地、签约落户的公开信息。本次是全量刷新，必须把下面 13 路公开数据源都搜一遍，每路至少跑 1–2 组关键词，不要只搜新闻就收工。其中 I–M 五路是这次新增的：股市聚合专补签约之前的意向信号，环评公示则是选址已定的硬证据，两头都要认真搜。",
        "【A 财经新闻】新浪财经、财联社、36氪、界面新闻、澎湃新闻、证券时报、上海证券报、中国证券报。关键词例：「长三角 企业 投资 建厂 签约」「苏州 合肥 杭州 宁波 南京 无锡 常州 宣城 企业 扩产 落户」「新能源汽车 集成电路 生物医药 装备制造 企业 新建工厂 长三角」。",
        "【B 企业官网】上市公司与外企官网新闻中心的一手投资动态。关键词例：「企业 官网 宣布 投资 长三角 新建工厂」「跨国公司 官网 中国 增资 扩产 苏州 无锡 合肥」。",
        "【C 上市公司公告】巨潮资讯网、上交所、深交所、北交所公告。关键词例：「巨潮资讯 投资设立子公司 长三角」「上市公司公告 对外投资 新建项目 合肥 苏州 宁波」「公告 增资扩产 设立全资子公司 江苏 浙江 安徽」；这类候选 signalType 优先填 新设子公司/增资扩产/项目备案，sourceName 写「巨潮资讯网」或对应交易所。",
        "【D 地方政府新闻】各市政府官网及招商局/发改委/经信局栏目。关键词例：「site:gov.cn 长三角 企业 签约 落户 投产」「合肥市政府 企业 投资 签约」「宣城市政府 招商 签约 项目」「苏州市政府 重大项目 开工 投产」；sourceName 写明具体政府站名。",
        "【E 招投标】中国招标投标公共服务平台、全国公共资源交易平台、各省公共资源交易中心。关键词例：「公共资源交易 建厂 招标 长三角」「厂房建设项目 招标公告 企业 江苏 浙江 安徽」「新建工厂 施工 招标 中标公告」；必须有具体建设单位/中标企业全名，signalType 填 建厂招标 或 施工许可，摘要里写清项目名称与地点。",
        "【F 土地出让】中国土地市场网、各地自然资源和规划局土地出让公告——这是最强信号，务必认真搜。关键词例：「中国土地市场网 工业用地 成交 企业」「自然资源局 国有建设用地使用权出让 成交 工业」「企业 竞得 工业用地 长三角 建厂」；signalType 填 拿地，摘要里写清地块位置、面积或成交价（原文有才写），sourceName 写「中国土地市场网」或对应自然资源局。",
        "【G 园区官网】苏州工业园区、合肥高新区、钱塘新区、前湾新区、临港新片区、张江、宣城经开区、宣城高新区等园区官网动态。关键词例：「苏州工业园区 企业 签约 入驻」「合肥高新区 项目 签约 落地」「宣城经开区 企业 签约 投产」「园区官网 企业 新工厂 投产」。",
        "【H 招商平台】中国招商引资信息网、投资中国网、长三角一体化示范区官网。关键词例：「中国招商引资信息网 企业 投资项目 长三角」「长三角一体化示范区 企业 签约 项目」；这一路推介稿多，只有写得出具体企业全名+具体投资动作的才收。",
        "【I 股市聚合·意向信号】同花顺、东方财富只作聚合搜索与交叉核对入口（如同花顺 F10 的项目投资/募投项目表、东方财富公告大全 data.eastmoney.com），不直爬它们的网页；每条候选的 sourceUrl 必须落到源头原文——巨潮资讯网/上交所/深交所/北交所的公告或互动平台页面，sourceName 写源头（如「巨潮资讯网」），摘要里注明经同花顺/东方财富聚合检索。这一路只抓四类签约前信号：(1) 定增募投——上市公司公告拟向特定对象发行/定增募资用于扩产、新建项目，signalType 填 定增募投，关键词例：「上市公司 定增 募集资金 扩产项目 公告」「向特定对象发行股票 募投项目 新建产能 长三角」「巨潮 定增募投 扩产」；(2) 互动易问答——深交所互动易、上证 e 互动上董秘亲口确认的扩产/建厂/选址意向，signalType 填 互动易问答，关键词例：「互动易 公司 回复 扩产 产能 新建」「e互动 董秘 回复 建厂 选址」；必须过滤空答复：回复是「暂无应披露事项」「请关注定期报告」「感谢关注」这类没有实质内容的，一律不收；(3) 调研纪要——投资者关系活动记录/业绩说明会中管理层披露的产能规划与新增产线计划，signalType 填 调研纪要，关键词例：「投资者关系活动记录表 产能 利用率 新增产线」「业绩说明会 产能布局 扩产 计划」；(4) 年报在建工程——年报/半年报披露的在建工程、固定资产投资计划、新设子公司，signalType 填 在建工程，关键词例：「年报 在建工程 新建项目 投资计划」「半年报 在建工程 募投项目 进度」。这四类全部是签约前信号：dealStage 只能填 intent 或 negotiating，landedCity 留空——除非原文明确写了项目已签约并定址某市。注意「在建工程」只是年报会计科目，不要因为这四个字就填 building。",
        "【J 融资动态】IT桔子、企名片、36氪的融资首发报道。关键词例：「IT桔子 融资 新能源 制造 企业」「36氪 首发 融资 工厂 扩产」「企业 完成 亿元融资 新建工厂 长三角」；signalType 填 融资，只收写清融资金额/轮次且资金用途指向扩产、建厂、设研发中心或区域总部的；纯软件、纯消费类融资与长三角制造/研发无关的不收。dealStage 填 intent，landedCity 留空。",
        "【K 招聘扩张】BOSS直聘、猎聘的公开职位（经公开搜索结果页获取，不直爬平台）。关键词例：「BOSS直聘 招聘 生产 苏州 合肥 工厂」「猎聘 厂长 工艺工程师 招聘 长三角 新工厂」；signalType 填 招聘扩张。诚实边界：多数职位不披露新厂地点与人数——只有搜索结果明确写出工作地点是长三角某城市、且岗位是成批的生产/研发/厂务类（或写明招聘人数/新基地筹建）的才收，并在摘要里注明「招聘信号仅为扩张前兆，需交叉验证」；零星一两个普通职位不收。dealStage 填 intent，landedCity 留空。",
        "【L 专利产业化】国家知识产权局专利公布公告与地方知识产权局的产业化/成果转化报道。关键词例：「国家知识产权局 专利 产业化 企业」「专利 成果转化 中试 量产 新建产线」「企业 专利 产业化项目 长三角」；signalType 填 专利产业化。诚实边界：单纯的专利授权公告绝不收——只有原文同时写明该专利/技术要产业化、建中试或量产线、或配套新建产线的才收，并在摘要里写清产业化表述。dealStage 填 intent，landedCity 留空；这一路宁可为空，不要硬凑。",
        "【M 环评/能评公示】沪苏浙皖各级生态环境局官网的建设项目环评公示、节能审查公示栏目（注意：这是生态环境局的公开公示，不是投资项目在线审批监管平台，不要去碰后者）。关键词例：「生态环境局 建设项目 环境影响评价 公示 企业 新建」「市生态环境局 环评公示 年产 项目」「节能审查 公示 企业 新建项目 长三角」；signalType 填 环评公示，摘要写清项目名称、建设单位、建设地点与规模。环评公示意味着选址已定：dealStage 填 signed，landedCity 填公示中的建设地点城市（如「常州」）。",
        "筛选标准：必须是具体企业（写得出企业全名）的具体投资动作；剔除政府招商推介会通稿、园区宣传、纯政策新闻、没有具体企业的汇总报道、与长三角无关的内容。同一企业同一事件在多路出现的，只提交一条，优先保留权威性最高的来源（土地公告/环评公示/上市公司公告/政府官网 > 企业官网 > 财经新闻 > 融资/招聘/专利），并在摘要里注明另有哪路也报道了。宁缺毋滥，但 13 路都搜完后目标 16–26 条高质量候选（其中 I 路股市意向信号尽量给到 3–6 条，K/L 两路弱信号没有合格的就如实为空，不许硬凑）；某一路确实没有合格结果的，在回写 note 里逐路说明搜了什么、为何为空。",
        "【阶段判定·重要】每条候选必须判定项目阶段 dealStage，只能填 intent（意向）/ negotiating（洽谈）/ signed（已签约）/ building（已开工）/ producing（已投产）之一，并填 landedCity（已签约及之后填项目实际落地的城市，只写城市名如「无锡」；意向/洽谈阶段留空）。判定只看原文事实：原文写了已签约、签约落户、拿地、项目备案、环评公示，就填 signed；写了开工、施工、建厂招标中标，就填 building（注意：年报里的「在建工程」科目不算开工证据）；写了已投产、正式投产，就填 producing；只有考察、洽谈、对接、意向、拟投资、选址表述的填 negotiating；只有融资、战略合作、增资意向等早期信号的填 intent。新增五路的阶段口径：I 路（定增募投/互动易问答/调研纪要/在建工程）、J 路（融资）、K 路（招聘扩张）、L 路（专利产业化）一律是签约前信号，只填 intent 或 negotiating、landedCity 留空，原文明确写已签约并定址的除外；M 路（环评公示）选址已定，填 signed 并填 landedCity。注意：类型是「增资扩产」但原文写了已签约的，必须填 signed，不要因为类型标签就标成可招引。已签约及之后的项目不要剔除——它们对配套招商和二期扩产有价值——但必须如实标阶段，系统会把它们降级处理、不再跨市推荐。",
        "【联系方式·顺带回填】如果候选的来源原文（上市公司公告、年报、招标公告、环评公示、企业官网）里同时公开了该企业的对公联系方式，就在该候选的 contacts 数组里一并回填（没有就给空数组，不要为找联系方式单独编造来源）。只收对公渠道：企业总机/服务热线（座机带区号，可带分机，或 400/800）、董事会秘书/证券部/投资者关系的官方电话与企业域名邮箱、招标公告与环评公示里的公示联系人电话（座机）、企业注册/办公地址。红线：个人手机号（1 开头 11 位）、私人微信、私人邮箱（qq.com/163.com/gmail.com 等个人域名）一律不收，哪怕原文里有也不回填；每条联系方式必须带它出现的那一页的完整链接 sourceUrl 和来源类型 sourceType（企业官网/年报公告董秘/交易所公告/招标公告/环评公示/政府公示 之一），contactLabel 写入口（如 董事会秘书/证券部/总机/招标联系人/环评公示联系人），年报里公开了姓名的董秘可写 contactName 与 contactTitle。",
        "明确不要碰：国家企业信用信息公示系统、投资项目在线审批监管平台（有验证码）、天眼查/企查查/启信宝网页版（登录+反爬）——不绕验证、不伪装抓取，这三路不在本次范围。",
        "每条候选必须给出：企业全名 company、所属产业 industry（从 新能源汽车/集成电路/生物医药/电子信息/数字经济/新材料/装备制造/动力电池/人工智能/软件/物联网/智能家电/石化/汽车零部件/纳米技术 里选最贴切的一个，实在归不了类就留空字符串）、信号类型 signalType（从 拿地/环评公示/项目备案/施工许可/建厂招标/增资扩产/新设子公司/签约落户/投产/定增募投/互动易问答/调研纪要/在建工程/招聘扩张/专利产业化/融资/战略合作/其他 里选）、意向或落地区域 targetRegion（如「合肥」「长三角」）、投资额原文 investmentText（如「总投资50亿元」，来源没写就留空）、投资额数字 investmentYi（亿元为单位的数字，仅当来源明确写出总额时才填，没写就填 null，绝不估算）、一句话摘要 summary（只写来源里有的事实，并带上来源路别，如「土地出让公告显示…」「据巨潮公告…」）、来源名称 sourceName（写实际来源，如「中国土地市场网」「巨潮资讯网」「新浪财经」「合肥市人民政府」）、来源链接 sourceUrl（必须是你实际打开或搜索结果里给出的完整链接，逐字复制，不要拼造）、报道日期 reportedDate（YYYY-MM-DD，不确定就留空）、阶段 dealStage 与落地城市 landedCity（按上面的阶段判定规则填）。",
        `今天是 ${today}。完成后把候选通过指定的回写动作一次性提交，并在 note 里按 A–M 逐路写明每路提交了几条；如果确实没找到合格的新信号，就提交空数组并在 note 里说明。`,
      ].join("\n");
      const res = await ctx.agent.spawnTask(message, {
        expectsAction: "saveSignalCandidates",
        dedupeKey: "radar-refresh",
      });
      if (!res.ok) {
        return { ok: false, message: `刷新任务未能启动：${res.error}` };
      }
      return {
        ok: true,
        message:
          args.trigger === "scheduled"
            ? "定时全量刷新已启动（13 路公开数据源），新信号稍后出现在待核实列表。"
            : "全量刷新已启动，正在并行搜索 13 路公开数据源：财经新闻、企业官网、上市公司公告、政府新闻、招投标、土地出让、园区官网、招商平台、股市聚合（定增/互动易/调研/年报）、融资、招聘、专利、环评公示，约 2–4 分钟后新候选会出现在待核实列表。",
      };
    },
  }),

  saveSignalCandidates: defineAction({
    description: "回写雷达刷新找到的信号候选：双键去重——公司名先规范化成核心名（去括注、工商后缀、省级前缀），再按「核心名+信号类型+报道日期」判事件重复（同核心名同类型、报道日期相差≤3天也算同事件，因不同来源对同一事件的标日期常差几天），「企业名+来源链接」保留作兜底；新候选以待核实状态入库。",
    request: z.object({
      trigger: z.enum(["manual", "scheduled"]).default("manual"),
      note: z.string().default(""),
      candidates: z.array(
        z.object({
          company: z.string().min(1),
          industry: z.string().default(""),
          signalType: z.string().default("其他"),
          targetRegion: z.string().default(""),
          investmentText: z.string().default(""),
          investmentYi: z.number().nullable().default(null),
          summary: z.string().default(""),
          sourceName: z.string().default(""),
          sourceUrl: z.string().default(""),
          reportedDate: z.string().default(""),
          dealStage: z
            .enum(["intent", "negotiating", "signed", "building", "producing"])
            .default("intent"),
          landedCity: z.string().default(""),
          // 来源原文顺带公开的对公联系方式（可为空）；入库时逐条过隐私红线校验
          contacts: z.array(contactCandidate).default([]),
        }),
      ),
    }),
    response: z.object({ added: z.number(), skipped: z.number(), contactsAdded: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({
          id: schema.signals.id,
          company: schema.signals.company,
          sourceUrl: schema.signals.sourceUrl,
          signalType: schema.signals.signalType,
          reportedDate: schema.signals.reportedDate,
        })
        .from(schema.signals);
      const seen = new Set(existing.map((e) => `${e.company}|${e.sourceUrl}`));
      const idByKey = new Map(existing.map((e) => [`${e.company}|${e.sourceUrl}`, e.id]));
      // 事件键 → 已有信号 id：同事件换个公司名写法、换个来源也命中。
      // 报道日期为空时事件键不参与判重（缺日期的候选只走原文链接键，避免误杀）。
      const idByEvent = new Map<string, number>();
      // 事件键的日期近邻兜底：同一事件被不同来源转述时，报道日期常差几天
      // （胜科纳米定增：金融界标 10-19、巨潮原文标 10-17），只认同日会漏。
      // 核心名 + 类型相同且日期相差 ≤3 天，视为同一事件。
      interface EventRef {
        id: number;
        core: string;
        type: string;
        day: number;
      }
      const eventRefs: EventRef[] = [];
      const dayNum = (d: string): number => {
        const t = Date.parse(`${d.trim()}T00:00:00Z`);
        return Number.isNaN(t) ? Number.NaN : Math.floor(t / 86400000);
      };
      for (const e of existing) {
        if (e.reportedDate.trim() === "") continue;
        const k = signalEventKey(e.company, e.signalType, e.reportedDate);
        if (!idByEvent.has(k)) idByEvent.set(k, e.id);
        const day = dayNum(e.reportedDate);
        if (!Number.isNaN(day)) {
          eventRefs.push({
            id: e.id,
            core: normalizeCompanyName(e.company),
            type: e.signalType.trim(),
            day,
          });
        }
      }
      let added = 0;
      let skipped = 0;
      let contactsAdded = 0;
      for (const c of args.candidates) {
        const key = `${c.company}|${c.sourceUrl}`;
        const eventKey =
          c.reportedDate.trim() !== ""
            ? signalEventKey(c.company, c.signalType, c.reportedDate)
            : "";
        let existingId =
          idByKey.get(key) ?? (eventKey !== "" ? idByEvent.get(eventKey) : undefined);
        if (existingId == null && c.reportedDate.trim() !== "") {
          const core = normalizeCompanyName(c.company);
          const day = dayNum(c.reportedDate);
          if (core !== "" && !Number.isNaN(day)) {
            const near = eventRefs.find(
              (r) =>
                r.core === core &&
                r.type === c.signalType.trim() &&
                Math.abs(r.day - day) <= 3,
            );
            if (near) existingId = near.id;
          }
        }
        if (seen.has(key) || existingId != null) {
          skipped++;
          // 信号已在库：原文顺带带回的联系方式仍可挂到已有信号上
          if (existingId != null && c.contacts.length > 0) {
            const r = await insertContacts(ctx, existingId, c.company, c.contacts, false);
            contactsAdded += r.added;
          }
          continue;
        }
        seen.add(key);
        // 阶段以来源证据为准：摘要写了已签约/开工/投产的，阶段只会往后纠正，不会被类型标签拉回可招引
        const dealStage = effectiveDealStage(c.dealStage, c.signalType, c.summary);
        const inserted = await db
          .insert(schema.signals)
          .values({
            company: c.company,
            industry: c.industry,
            signalType: c.signalType,
            targetRegion: c.targetRegion,
            investmentText: c.investmentText,
            investmentYi: c.investmentYi,
            summary: c.summary,
            sourceName: c.sourceName,
            sourceUrl: c.sourceUrl,
            reportedDate: c.reportedDate,
            dealStage,
            landedCity: isLandedStage(dealStage) ? normalizeCityName(c.landedCity) : "",
            status: "pending",
          })
          .returning({ id: schema.signals.id });
        const newId = inserted[0]?.id;
        // 同一批回写内部也要防重：刚入库的候选立刻登记事件键与近邻参照
        if (newId != null && eventKey !== "") {
          idByEvent.set(eventKey, newId);
          const day = dayNum(c.reportedDate);
          if (!Number.isNaN(day)) {
            eventRefs.push({
              id: newId,
              core: normalizeCompanyName(c.company),
              type: c.signalType.trim(),
              day,
            });
          }
        }
        if (newId != null && c.contacts.length > 0) {
          const r = await insertContacts(ctx, newId, c.company, c.contacts, false);
          contactsAdded += r.added;
        }
        added++;
      }
      await db.insert(schema.refreshRuns).values({
        trigger: args.trigger,
        status: "done",
        addedCount: added,
        note: args.note,
      });
      ctx.invalidateQueries();
      return { added, skipped, contactsAdded };
    },
  }),

  setSignalStatus: defineAction({
    description: "确认或忽略一条信号（待核实 → 已确认 / 已忽略；已忽略可恢复为已确认）。",
    request: z.object({
      id: z.number().int().positive(),
      status: z.enum(["confirmed", "dismissed", "pending"]),
    }),
    response: okOut,
    handler: async (ctx, args): Promise<z.infer<typeof okOut>> => {
      const db = ctx.db<typeof schema>();
      if (args.status === "confirmed") {
        // 从「搁置/已忽略」恢复成线索时，清掉残留的 dropped 管道阶段，
        // 让阶段回到按 dealStage 推导（意向/洽谈→线索、已签约→签约……）
        const rows = await db
          .select({ pipelineStage: schema.signals.pipelineStage })
          .from(schema.signals)
          .where(eq(schema.signals.id, args.id));
        const patch: { status: "confirmed"; pipelineStage?: string } = { status: "confirmed" };
        if (rows[0]?.pipelineStage === "dropped") patch.pipelineStage = "";
        await db.update(schema.signals).set(patch).where(eq(schema.signals.id, args.id));
      } else {
        await db
          .update(schema.signals)
          .set({ status: args.status })
          .where(eq(schema.signals.id, args.id));
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deleteSignal: defineAction({
    description: "删除一条投资信号（彻底删除，不可恢复）；已转成项目的信号会被拦截、不删除，并返回关联项目编号，避免项目失去来源记录。",
    request: z.object({ id: z.number().int().positive() }),
    response: deleteSignalOut,
    handler: async (ctx, args): Promise<z.infer<typeof deleteSignalOut>> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.signals)
        .where(eq(schema.signals.id, args.id));
      const sig = rows[0];
      if (!sig) {
        return {
          ok: false,
          deleted: false,
          reason: "这条信号不存在，可能已经被删除。",
          linkedProjectIds: [],
        };
      }
      const linked = await db
        .select({ id: schema.projects.id })
        .from(schema.projects)
        .where(eq(schema.projects.signalId, args.id));
      const linkedProjectIds = linked.map((p) => p.id);
      if (sig.status === "converted" || linkedProjectIds.length > 0) {
        return {
          ok: false,
          deleted: false,
          reason:
            "这条信号已经转成项目在跟进，不能直接删除，否则项目会失去来源记录。项目本身不受影响，请到「项目」里继续跟进或改为搁置；信号会保留在信号流中并标注「已转项目」。",
          linkedProjectIds,
        };
      }
      await db.delete(schema.signals).where(eq(schema.signals.id, args.id));
      // 线索跟进记录与联系方式随信号一并删除，避免留下孤儿行
      await db
        .delete(schema.signalFollowups)
        .where(eq(schema.signalFollowups.signalId, args.id));
      await db
        .delete(schema.companyContacts)
        .where(eq(schema.companyContacts.signalId, args.id));
      ctx.invalidateQueries();
      return { ok: true, deleted: true, reason: "", linkedProjectIds: [] };
    },
  }),

  listSignalContacts: defineAction({
    description: "列出一条信号已入库的企业公开联系方式（对公渠道：官网总机、年报董秘/证券部、招标/环评公示联系人等），最新在前。",
    request: z.object({ signalId: z.number().int().positive() }),
    response: z.object({ contacts: z.array(contactOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.companyContacts)
        .where(eq(schema.companyContacts.signalId, args.signalId))
        .orderBy(desc(schema.companyContacts.id));
      return { contacts: rows.map(toContact) };
    },
  }),

  lookupSignalContacts: defineAction({
    description: "为一条信号获取企业公开联系方式：派研究任务只查公开对公渠道（企业官网、年报/公告董秘与证券部、交易所公告、招标公告、环评公示、政府公示），结果经 saveSignalContacts 回写，私人手机号/微信/私人邮箱一律不收。每次触发都用新任务键开新任务，不复用旧任务。",
    request: z.object({ signalId: z.number().int().positive() }),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.signals)
        .where(eq(schema.signals.id, args.signalId));
      const sig = rows[0];
      if (!sig) return { ok: false, message: "这条信号不存在，可能已被删除。" };
      // 每次点击都开一个全新任务（键带时间戳）：旧的固定键会让重试一直「恢复」
      // 同一个已结束的任务，研究根本不会重跑——三家联系方式长期为 0 的原因之一。
      return startContactLookup(ctx, sig, `contact-lookup-${args.signalId}-${Date.now()}`);
    },
  }),

  repairSignalContacts: defineAction({
    description: "为指定企业（默认晶合集成、微导纳米、皇冠新材）的信号重新触发公开联系方式获取：按企业名找到信号后逐个用全新任务键开新的研究任务（不复用之前可能已失效的固定键任务），任务带已公开核对过的对接入口做定位锚点，结果仍必须带原文链接经 saveSignalContacts 回写并过隐私红线校验。返回每家信号当前的联系方式条数与启动结果。",
    request: z.object({
      companies: z
        .array(z.string().min(1))
        .default(["晶合集成", "微导纳米", "皇冠新材"]),
    }),
    response: z.object({
      results: z.array(
        z.object({
          signalId: z.number(),
          company: z.string(),
          existingContacts: z.number(),
          started: z.boolean(),
          message: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.signals).orderBy(asc(schema.signals.id));
      const counts = await contactCountMap(ctx);
      const results: Array<{
        signalId: number;
        company: string;
        existingContacts: number;
        started: boolean;
        message: string;
      }> = [];
      for (const want of args.companies) {
        const sig = rows.find((r) => r.company.includes(want));
        if (!sig) continue;
        const r = await startContactLookup(
          ctx,
          sig,
          `contact-repair-${sig.id}-${Date.now()}`,
        );
        results.push({
          signalId: sig.id,
          company: sig.company,
          existingContacts: counts.get(sig.id) ?? 0,
          started: r.ok,
          message: r.message,
        });
      }
      return { results };
    },
  }),

  saveSignalContacts: defineAction({
    description: "回写联系方式获取任务找到的公开联系方式：没有来源链接的、个人手机号/私人微信/私人邮箱的会被拦截并逐条报告原因，合格的挂到对应信号上。",
    request: z.object({
      signalId: z.number().int().positive(),
      note: z.string().default(""),
      candidates: z.array(contactCandidate),
    }),
    response: z.object({
      added: z.number(),
      skipped: z.number(),
      rejected: z.array(z.string()),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select({ company: schema.signals.company })
        .from(schema.signals)
        .where(eq(schema.signals.id, args.signalId));
      const sig = rows[0];
      if (!sig) return { added: 0, skipped: args.candidates.length, rejected: ["信号不存在"] };
      const r = await insertContacts(ctx, args.signalId, sig.company, args.candidates, false);
      ctx.invalidateQueries();
      return r;
    },
  }),

  upsertContact: defineAction({
    description: "手工新增或编辑一条企业联系方式（如线下名片、拜访获知）；同样过隐私红线校验：个人手机号、私人微信、私人邮箱会被拒绝并返回原因。",
    request: z.object({
      id: z.number().int().positive().nullable().default(null),
      signalId: z.number().int().positive(),
      contactLabel: z.string().default(""),
      contactName: z.string().default(""),
      contactTitle: z.string().default(""),
      phone: z.string().default(""),
      email: z.string().default(""),
      address: z.string().default(""),
      sourceName: z.string().default(""),
      sourceUrl: z.string().default(""),
      sourceType: z.string().default("手工录入"),
    }),
    response: z.object({ ok: z.boolean(), id: z.number().nullable(), error: z.string() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const reason = contactRejectionReason(args);
      if (reason !== "") return { ok: false, id: null, error: reason };
      if (
        args.phone.trim() === "" &&
        args.email.trim() === "" &&
        args.address.trim() === ""
      ) {
        return { ok: false, id: null, error: "电话、邮箱、地址至少填一项" };
      }
      const label = args.contactLabel.trim() || "对公联系方式";
      if (args.id != null) {
        await db
          .update(schema.companyContacts)
          .set({
            contactLabel: label,
            contactName: args.contactName.trim(),
            contactTitle: args.contactTitle.trim(),
            phone: args.phone.trim(),
            email: args.email.trim(),
            address: args.address.trim(),
            sourceName: args.sourceName.trim(),
            sourceUrl: args.sourceUrl.trim(),
            sourceType: args.sourceType.trim() || "手工录入",
            updatedAt: new Date(),
          })
          .where(eq(schema.companyContacts.id, args.id));
        ctx.invalidateQueries();
        return { ok: true, id: args.id, error: "" };
      }
      const sigRows = await db
        .select({ company: schema.signals.company })
        .from(schema.signals)
        .where(eq(schema.signals.id, args.signalId));
      const sig = sigRows[0];
      if (!sig) return { ok: false, id: null, error: "信号不存在" };
      const rows = await db
        .insert(schema.companyContacts)
        .values({
          signalId: args.signalId,
          company: sig.company,
          contactLabel: label,
          contactName: args.contactName.trim(),
          contactTitle: args.contactTitle.trim(),
          phone: args.phone.trim(),
          email: args.email.trim(),
          address: args.address.trim(),
          sourceName: args.sourceName.trim(),
          sourceUrl: args.sourceUrl.trim(),
          sourceType: args.sourceType.trim() || "手工录入",
          verifyStatus: "unverified",
          isManual: 1,
        })
        .returning({ id: schema.companyContacts.id });
      ctx.invalidateQueries();
      return { ok: true, id: rows[0]?.id ?? null, error: "" };
    },
  }),

  deleteContact: defineAction({
    description: "删除一条企业联系方式记录。",
    request: z.object({ id: z.number().int().positive() }),
    response: okOut,
    handler: async (ctx, args): Promise<z.infer<typeof okOut>> => {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.companyContacts)
        .where(eq(schema.companyContacts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setContactVerifyStatus: defineAction({
    description: "更新一条联系方式的核实状态：unverified 待核实 / verified 已核实 / stale 已过期（打不通或已变更时标过期）。",
    request: z.object({
      id: z.number().int().positive(),
      verifyStatus: z.enum(["unverified", "verified", "stale"]),
    }),
    response: okOut,
    handler: async (ctx, args): Promise<z.infer<typeof okOut>> => {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.companyContacts)
        .set({ verifyStatus: args.verifyStatus, updatedAt: new Date() })
        .where(eq(schema.companyContacts.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setSignalDealStage: defineAction({
    description: "修正一条信号的项目阶段（意向/洽谈/已签约/已开工/已投产）与已落地城市；标为已签约及之后后，该信号会被降级为配套/二期跟进，不再跨市推荐。",
    request: z.object({
      id: z.number().int().positive(),
      dealStage: z.enum(["intent", "negotiating", "signed", "building", "producing"]),
      landedCity: z.string().default(""),
    }),
    response: okOut,
    handler: async (ctx, args): Promise<z.infer<typeof okOut>> => {
      const db = ctx.db<typeof schema>();
      await db
        .update(schema.signals)
        .set({
          dealStage: args.dealStage,
          landedCity: isLandedStage(args.dealStage) ? normalizeCityName(args.landedCity) : "",
          // 阶段修正后，项目管道阶段回到按 dealStage 推导，避免线索还停在旧的显式阶段上
          pipelineStage: "",
        })
        .where(eq(schema.signals.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  reclassifySignals: defineAction({
    description: "按来源证据重新判定全部存量信号的阶段与落地城市：摘要/类型写明已签约、拿地、开工、投产的存量信号会被标为已落地并降级，只纠正阶段字段，不改动其他内容。",
    request: z.object({}),
    response: z.object({ updated: z.number(), landed: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);
      const profiles = await db.select().from(schema.cityProfiles);
      const cityNames = canonicalCityNames(profiles.map((p) => p.city));
      const rows = await db.select().from(schema.signals);
      let updated = 0;
      let landed = 0;
      for (const r of rows) {
        const { dealStage, landed: isL, landedCity } = stageContext(r, cityNames);
        if (isL) landed++;
        if (r.dealStage !== dealStage || r.landedCity !== landedCity) {
          await db
            .update(schema.signals)
            .set({ dealStage, landedCity })
            .where(eq(schema.signals.id, r.id));
          updated++;
        }
      }
      ctx.invalidateQueries();
      return { updated, landed };
    },
  }),

  addSignal: defineAction({
    description: "手工录入一条投资信号（如线下获知的企业投资意向），直接进入已确认列表；可同时标注项目阶段与已落地城市。",
    request: z.object({
      company: z.string().min(1),
      industry: z.string().default(""),
      signalType: z.string().default("其他"),
      targetRegion: z.string().default("长三角"),
      investmentText: z.string().default(""),
      investmentYi: z.number().nullable().default(null),
      summary: z.string().default(""),
      sourceName: z.string().default("手工录入"),
      dealStage: z
        .enum(["intent", "negotiating", "signed", "building", "producing"])
        .default("intent"),
      landedCity: z.string().default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .insert(schema.signals)
        .values({ ...args, landedCity: normalizeCityName(args.landedCity), status: "confirmed" })
        .returning({ id: schema.signals.id });
      const row = rows[0];
      if (!row) throw new Error("addSignal: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  getSignalAssessment: defineAction({
    description: "对一条信号做多城市落地评估：返回各城市六维评分、结论、理由、缺口与可匹配政策。",
    request: z.object({ signalId: z.number().int().positive() }),
    response: z.object({
      signal: signalOut,
      scores: z.array(cityScoreOut),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);
      const sigRows = await db
        .select()
        .from(schema.signals)
        .where(eq(schema.signals.id, args.signalId));
      const sig = sigRows[0];
      if (!sig) throw new Error("信号不存在");
      const profiles = dedupeCityProfiles(
        await db.select().from(schema.cityProfiles).orderBy(asc(schema.cityProfiles.id)),
      );
      const policies = (await db.select().from(schema.policies)).map(toPolicy);
      const cityNames = profiles.map((p) => p.city);
      const counts = await contactCountMap(ctx);
      const out = toSignal(sig, cityNames, counts.get(sig.id) ?? 0);
      const view = signalForScoring(sig, cityNames);
      const scores = profiles
        .map((p) =>
          scoreCity(
            view,
            {
              city: p.city,
              province: p.province,
              industries: p.industries,
              parks: p.parks,
              landCostLevel: p.landCostLevel,
              laborCostLevel: p.laborCostLevel,
            },
            policies,
          ),
        )
        // 已落地信号不按分数排「最佳城市」，保持城市档案顺序展示，避免读出推荐意味
        .sort((a, b) => (out.isLanded ? 0 : b.total - a.total));
      return { signal: out, scores: scores.map(toScore) };
    },
  }),

  getReport: defineAction({
    description: "生成一页纸落地报告：某条信号在指定城市的结论、评分拆解、理由、缺口、匹配政策与建议下一步。",
    request: z.object({
      signalId: z.number().int().positive(),
      city: z.string().min(1),
    }),
    response: z.object({
      signal: signalOut,
      score: cityScoreOut,
      profile: z.object({
        city: z.string(),
        province: z.string(),
        parks: z.array(z.string()),
        landCostLevel: z.string(),
        laborCostLevel: z.string(),
        note: z.string(),
      }),
      generatedAt: z.string(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);
      const sigRows = await db
        .select()
        .from(schema.signals)
        .where(eq(schema.signals.id, args.signalId));
      const sig = sigRows[0];
      if (!sig) throw new Error("信号不存在");
      const wanted = normalizeCityName(args.city);
      const allProfiles = dedupeCityProfiles(await db.select().from(schema.cityProfiles));
      const prof = allProfiles.find((p) => p.city === wanted);
      if (!prof) throw new Error("城市档案不存在");
      const policies = (await db.select().from(schema.policies)).map(toPolicy);
      const cityNames = allProfiles.map((p) => p.city);
      const score = scoreCity(
        signalForScoring(sig, cityNames),
        {
          city: prof.city,
          province: prof.province,
          industries: prof.industries,
          parks: prof.parks,
          landCostLevel: prof.landCostLevel,
          laborCostLevel: prof.laborCostLevel,
        },
        policies,
      );
      const counts = await contactCountMap(ctx);
      return {
        signal: toSignal(sig, cityNames, counts.get(sig.id) ?? 0),
        score: toScore(score),
        profile: {
          city: prof.city,
          province: prof.province,
          parks: prof.parks,
          landCostLevel: prof.landCostLevel,
          laborCostLevel: prof.laborCostLevel,
          note: prof.note,
        },
        generatedAt: new Date().toISOString(),
      };
    },
  }),

  listCityProfiles: defineAction({
    description: "列出长三角城市产业档案（参考目录，可编辑）。",
    request: z.object({}),
    response: z.object({ cities: z.array(cityProfileOut) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);
      const rows = await db.select().from(schema.cityProfiles).orderBy(asc(schema.cityProfiles.id));
      return {
        cities: dedupeCityProfiles(rows).map((r) => ({
          id: r.id,
          city: r.city,
          province: r.province,
          industries: r.industries,
          parks: r.parks,
          landCostLevel: r.landCostLevel,
          laborCostLevel: r.laborCostLevel,
          note: r.note,
          updatedAt: r.updatedAt.toISOString(),
        })),
      };
    },
  }),

  upsertCityProfile: defineAction({
    description: "新增或更新一个城市的产业档案（主导产业、代表园区、用地/人力成本档位）。",
    request: z.object({
      city: z.string().min(1),
      province: z.string().default(""),
      industries: z.array(z.string()).default([]),
      parks: z.array(z.string()).default([]),
      landCostLevel: z.string().default(""),
      laborCostLevel: z.string().default(""),
      note: z.string().default(""),
    }),
    response: okOut,
    handler: async (ctx, args): Promise<z.infer<typeof okOut>> => {
      const db = ctx.db<typeof schema>();
      const city = normalizeCityName(args.city);
      const values = {
        city,
        province: args.province,
        industries: JSON.stringify(args.industries),
        parks: JSON.stringify(args.parks),
        landCostLevel: args.landCostLevel,
        laborCostLevel: args.laborCostLevel,
        note: args.note,
        updatedAt: new Date(),
      };
      // 按规范名找已有行：编辑「宣城」也只会更新「宣城市」那一条，不再新建重复行；
      // 若历史上已有两条同城行，一并删掉多余的，只留被更新的这一条。
      const all = await db.select().from(schema.cityProfiles);
      const same = all
        .filter((r) => normalizeCityName(r.city) === city)
        .sort((a, b) => a.id - b.id);
      const keeper = same.find((r) => r.city === city) ?? same[0];
      if (keeper) {
        await db.update(schema.cityProfiles).set(values).where(eq(schema.cityProfiles.id, keeper.id));
        for (const extra of same) {
          if (extra.id !== keeper.id) {
            await db.delete(schema.cityProfiles).where(eq(schema.cityProfiles.id, extra.id));
          }
        }
      } else {
        await db.insert(schema.cityProfiles).values(values);
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listPolicies: defineAction({
    description: "列出政策库全部政策，可按城市过滤。",
    request: z.object({ city: z.string().default("") }),
    response: z.object({ policies: z.array(policyOut) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.policies).orderBy(desc(schema.policies.id));
      const wanted = normalizeCityName(args.city);
      const filtered = args.city ? rows.filter((r) => normalizeCityName(r.city) === wanted) : rows;
      return { policies: filtered.map(toPolicy) };
    },
  }),

  upsertPolicy: defineAction({
    description: "新增或更新一条结构化政策（城市、名称、适用产业、扶持内容、门槛、截止时间、原文链接）。",
    request: z.object({
      id: z.number().int().positive().nullable().default(null),
      city: z.string().min(1),
      title: z.string().min(1),
      industries: z.array(z.string()).default([]),
      benefit: z.string().default(""),
      threshold: z.string().default(""),
      deadline: z.string().default(""),
      sourceUrl: z.string().default(""),
    }),
    response: okOut,
    handler: async (ctx, args): Promise<z.infer<typeof okOut>> => {
      const db = ctx.db<typeof schema>();
      const values = {
        city: normalizeCityName(args.city),
        title: args.title,
        industries: JSON.stringify(args.industries),
        benefit: args.benefit,
        threshold: args.threshold,
        deadline: args.deadline,
        sourceUrl: args.sourceUrl,
      };
      if (args.id != null) {
        await db.update(schema.policies).set(values).where(eq(schema.policies.id, args.id));
      } else {
        await db.insert(schema.policies).values(values);
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  deletePolicy: defineAction({
    description: "删除一条政策。",
    request: z.object({ id: z.number().int().positive() }),
    response: okOut,
    handler: async (ctx, args): Promise<z.infer<typeof okOut>> => {
      const db = ctx.db<typeof schema>();
      await db.delete(schema.policies).where(eq(schema.policies.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listProjects: defineAction({
    description: "列出项目管道：项目行（各阶段）+ 线索（已确认信号，带落地评分、管道阶段与线索跟进数）。线索排在管道第一阶段，后面依次洽谈、签约、落地、投产；已落地信号按其阶段落在签约/落地/投产位置，只做配套与二期。",
    request: z.object({}),
    response: z.object({ projects: z.array(projectOut), leads: z.array(leadOut) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);
      const rows = await db.select().from(schema.projects).orderBy(desc(schema.projects.updatedAt));
      const fus = await db.select({ projectId: schema.followups.projectId }).from(schema.followups);
      const counts = new Map<number, number>();
      for (const f of fus) counts.set(f.projectId, (counts.get(f.projectId) ?? 0) + 1);
      const signalRows = await db
        .select()
        .from(schema.signals)
        .orderBy(desc(schema.signals.id));
      const leads = await buildLeads(ctx, signalRows);
      return {
        projects: rows.map((p) => ({
          id: p.id,
          company: p.company,
          industry: p.industry,
          signalId: p.signalId,
          recommendedCity: normalizeCityName(p.recommendedCity),
          stage: p.stage,
          owner: p.owner,
          nextStep: p.nextStep,
          nextStepDate: p.nextStepDate,
          note: p.note,
          createdAt: p.createdAt.toISOString(),
          updatedAt: p.updatedAt.toISOString(),
          followupCount: counts.get(p.id) ?? 0,
        })),
        leads,
      };
    },
  }),

  setSignalStage: defineAction({
    description: "推进或回退一条线索（已确认信号）在项目管道里的阶段：线索/洽谈/签约/落地/投产/搁置。同步修正信号的项目阶段：洽谈→negotiating、签约→signed、落地→building、投产→producing、线索→回到意向/洽谈（已落地的退回意向并清落地城市）；搁置=信号转已忽略（可从雷达已忽略里恢复）。签约及之后需给落地城市，留空时沿用信号已有的落地城市。",
    request: z.object({
      signalId: z.number().int().positive(),
      stage: z.enum(["lead", "talking", "signed", "landed", "producing", "dropped"]),
      landedCity: z.string().default(""),
    }),
    response: z.object({
      ok: z.literal(true),
      pipelineStage: z.string(),
      dealStage: z.string(),
      isLanded: z.boolean(),
      landedCity: z.string(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: true;
      pipelineStage: string;
      dealStage: string;
      isLanded: boolean;
      landedCity: string;
    }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.signals)
        .where(eq(schema.signals.id, args.signalId));
      const sig = rows[0];
      if (!sig) throw new Error("信号不存在");
      if (sig.status !== "confirmed") {
        throw new Error("只有已确认的信号（线索）可以推进阶段");
      }
      if (args.stage === "dropped") {
        await db
          .update(schema.signals)
          .set({ status: "dismissed", pipelineStage: "dropped" })
          .where(eq(schema.signals.id, sig.id));
        ctx.invalidateQueries();
        return { ok: true, pipelineStage: "dropped", dealStage: sig.dealStage, isLanded: isLandedStage(sig.dealStage as DealStage), landedCity: sig.landedCity };
      }
      const dealStageByStage: Record<string, DealStage> = {
        lead: "intent",
        talking: "negotiating",
        signed: "signed",
        landed: "building",
        producing: "producing",
      };
      const dealStage = dealStageByStage[args.stage] ?? "intent";
      const landed = isLandedStage(dealStage);
      const landedCity = landed
        ? normalizeCityName(args.landedCity.trim() !== "" ? args.landedCity : sig.landedCity)
        : "";
      await db
        .update(schema.signals)
        .set({ pipelineStage: args.stage, dealStage, landedCity })
        .where(eq(schema.signals.id, sig.id));
      ctx.invalidateQueries();
      return { ok: true, pipelineStage: args.stage, dealStage, isLanded: landed, landedCity };
    },
  }),

  listSignalFollowups: defineAction({
    description: "列出一条线索（已确认信号）的跟进记录时间线，最新在前。跟进直接记在信号上，不需要先转项目。",
    request: z.object({ signalId: z.number().int().positive() }),
    response: z.object({
      followups: z.array(
        z.object({
          id: z.number(),
          kind: z.string(),
          content: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.signalFollowups)
        .where(eq(schema.signalFollowups.signalId, args.signalId))
        .orderBy(desc(schema.signalFollowups.id));
      return {
        followups: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addSignalFollowup: defineAction({
    description: "给一条线索（已确认信号）加一条跟进记录（跟进/拜访/电话/会议/材料/考察等），线索留在项目管道里继续推进，不生成项目行。",
    request: z.object({
      signalId: z.number().int().positive(),
      kind: z.string().default("跟进"),
      content: z.string().min(1),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const sigRows = await db
        .select({ id: schema.signals.id, status: schema.signals.status })
        .from(schema.signals)
        .where(eq(schema.signals.id, args.signalId));
      const sig = sigRows[0];
      if (!sig) throw new Error("信号不存在");
      if (sig.status !== "confirmed") throw new Error("只有已确认的信号（线索）可以记跟进");
      const rows = await db
        .insert(schema.signalFollowups)
        .values(args)
        .returning({ id: schema.signalFollowups.id });
      const row = rows[0];
      if (!row) throw new Error("addSignalFollowup: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  convertSignalToProject: defineAction({
    description: "把一条已确认信号转成项目跟进：可招引信号按推荐城市转成线索；已落地信号只能按配套/二期模式转入（落地城市已定，项目阶段直接置为已签约，跟进内容为配套招商与二期扩产）。",
    request: z.object({
      signalId: z.number().int().positive(),
      recommendedCity: z.string().default(""),
      owner: z.string().default(""),
      followMode: z.enum(["recruit", "landed"]).default("recruit"),
    }),
    response: z.object({ projectId: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);
      const sigRows = await db
        .select()
        .from(schema.signals)
        .where(eq(schema.signals.id, args.signalId));
      const sig = sigRows[0];
      if (!sig) throw new Error("信号不存在");
      const profiles = await db.select().from(schema.cityProfiles);
      const cityNames = canonicalCityNames(profiles.map((p) => p.city));
      const out = toSignal(sig, cityNames);
      const landedMode = out.isLanded || args.followMode === "landed";
      const city = normalizeCityName(
        landedMode ? out.landedCity || args.recommendedCity : args.recommendedCity,
      );
      const rows = await db
        .insert(schema.projects)
        .values({
          company: sig.company,
          industry: sig.industry,
          signalId: sig.id,
          recommendedCity: city,
          owner: args.owner,
          // 已落地项目本身已签约，转入的是配套/二期跟进，不是招引线索
          stage: landedMode ? "signed" : "lead",
          note: landedMode
            ? `已落地项目（${out.dealStageLabel}${out.landedCity ? ` · ${out.landedCity}` : ""}）的配套/二期跟进：不做跨市招引，只跟配套招商、以商招商与二期扩产。`
            : "",
        })
        .returning({ id: schema.projects.id });
      const row = rows[0];
      if (!row) throw new Error("convertSignalToProject: insert returned no rows");
      await db
        .update(schema.signals)
        .set({ status: "converted" })
        .where(eq(schema.signals.id, sig.id));
      await db.insert(schema.followups).values({
        projectId: row.id,
        kind: "转入",
        content: landedMode
          ? `由已落地信号转入配套/二期跟进（项目已${out.dealStageLabel}，落地城市：${city || "已定"}）。下一步：${landedOpportunities(sig.industry, out.landedCity).join("；")}。信号：${sig.summary || sig.signalType}`
          : `由投资信号转入${city ? `，推荐落地城市：${city}` : ""}。信号：${sig.summary || sig.signalType}`,
      });
      ctx.invalidateQueries();
      return { projectId: row.id };
    },
  }),

  createProject: defineAction({
    description: "手工新建一个招商项目（不来自信号）。",
    request: z.object({
      company: z.string().min(1),
      industry: z.string().default(""),
      recommendedCity: z.string().default(""),
      owner: z.string().default(""),
      note: z.string().default(""),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .insert(schema.projects)
        .values({ ...args, recommendedCity: normalizeCityName(args.recommendedCity), stage: "lead" })
        .returning({ id: schema.projects.id });
      const row = rows[0];
      if (!row) throw new Error("createProject: insert returned no rows");
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  updateProject: defineAction({
    description: "更新项目的阶段、负责人、下一步动作与日期、备注。",
    request: z.object({
      id: z.number().int().positive(),
      stage: z.enum(["lead", "talking", "signed", "landed", "producing", "dropped"]).optional(),
      owner: z.string().optional(),
      recommendedCity: z.string().optional(),
      nextStep: z.string().optional(),
      nextStepDate: z.string().optional(),
      note: z.string().optional(),
    }),
    response: okOut,
    handler: async (ctx, args): Promise<z.infer<typeof okOut>> => {
      const db = ctx.db<typeof schema>();
      const { id, ...rest } = args;
      if (rest.recommendedCity !== undefined) {
        rest.recommendedCity = normalizeCityName(rest.recommendedCity);
      }
      await db
        .update(schema.projects)
        .set({ ...rest, updatedAt: new Date() })
        .where(eq(schema.projects.id, id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  listFollowups: defineAction({
    description: "列出某个项目的跟进记录时间线，最新在前。",
    request: z.object({ projectId: z.number().int().positive() }),
    response: z.object({
      followups: z.array(
        z.object({
          id: z.number(),
          kind: z.string(),
          content: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.followups)
        .where(eq(schema.followups.projectId, args.projectId))
        .orderBy(desc(schema.followups.id));
      return {
        followups: rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          content: r.content,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  addFollowup: defineAction({
    description: "给项目加一条跟进记录（拜访/电话/会议/材料等）。",
    request: z.object({
      projectId: z.number().int().positive(),
      kind: z.string().default("跟进"),
      content: z.string().min(1),
    }),
    response: z.object({ id: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .insert(schema.followups)
        .values(args)
        .returning({ id: schema.followups.id });
      const row = rows[0];
      if (!row) throw new Error("addFollowup: insert returned no rows");
      await db
        .update(schema.projects)
        .set({ updatedAt: new Date() })
        .where(eq(schema.projects.id, args.projectId));
      ctx.invalidateQueries();
      return { id: row.id };
    },
  }),

  listDataSources: defineAction({
    description: "列出雷达已整合的全部公开数据源目录（13 路已接入 + 3 路暂不直爬），并统计每类信号在库中的实际条数。",
    request: z.object({}),
    response: z.object({
      sources: z.array(
        z.object({
          id: z.string(),
          category: z.string(),
          channel: z.string(),
          examples: z.string(),
          signalTypes: z.string(),
          strength: z.string(),
          status: z.string(),
          note: z.string(),
        }),
      ),
      activeCount: z.number(),
      totalSignals: z.number(),
      bySignalType: z.array(z.object({ signalType: z.string(), count: z.number() })),
      bySourceName: z.array(z.object({ sourceName: z.string(), count: z.number() })),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select({ signalType: schema.signals.signalType, sourceName: schema.signals.sourceName }).from(schema.signals);
      const typeMap = new Map<string, number>();
      const nameMap = new Map<string, number>();
      for (const r of rows) {
        typeMap.set(r.signalType, (typeMap.get(r.signalType) ?? 0) + 1);
        const n = r.sourceName.trim() === "" ? "未标注来源" : r.sourceName;
        nameMap.set(n, (nameMap.get(n) ?? 0) + 1);
      }
      return {
        sources: DATA_SOURCE_CATALOG.map((s) => ({ ...s })),
        activeCount: DATA_SOURCE_CATALOG.filter((s) => s.status === "active").length,
        totalSignals: rows.length,
        bySignalType: [...typeMap.entries()].map(([signalType, count]) => ({ signalType, count })).sort((a, b) => b.count - a.count),
        bySourceName: [...nameMap.entries()].map(([sourceName, count]) => ({ sourceName, count })).sort((a, b) => b.count - a.count).slice(0, 12),
      };
    },
  }),

  listRefreshRuns: defineAction({
    description: "列出最近的雷达刷新记录。",
    request: z.object({ limit: z.number().int().positive().max(50).default(10) }),
    response: z.object({
      runs: z.array(
        z.object({
          id: z.number(),
          trigger: z.string(),
          status: z.string(),
          addedCount: z.number(),
          note: z.string(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.refreshRuns)
        .orderBy(desc(schema.refreshRuns.id))
        .limit(args.limit);
      return {
        runs: rows.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          status: r.status,
          addedCount: r.addedCount,
          note: r.note,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),

  completeReferenceData: defineAction({
    description: "补全城市产业档案里缺失的参考数据：只填空缺的用地/人力成本档位（定性参考档），不覆盖用户已改过的值；缺失的种子城市会补建。",
    request: z.object({}),
    response: z.object({ updated: z.number(), inserted: z.number() }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);
      let updated = 0;
      let inserted = 0;
      const allProfiles = await db.select().from(schema.cityProfiles);
      for (const seed of SEED_CITIES) {
        // 按规范名匹配：库里只剩简称「宣城」时认它就是宣城市，不再补建第二条
        const row = allProfiles
          .filter((r) => normalizeCityName(r.city) === seed.city)
          .sort((a, b) => a.id - b.id)[0];
        if (!row) {
          await db.insert(schema.cityProfiles).values({
            city: seed.city,
            province: seed.province,
            industries: JSON.stringify(seed.industries),
            parks: JSON.stringify(seed.parks),
            landCostLevel: seed.landCostLevel,
            laborCostLevel: seed.laborCostLevel,
            note: seed.note,
          });
          inserted++;
          continue;
        }
        const patch: { landCostLevel?: string; laborCostLevel?: string; updatedAt: Date } = {
          updatedAt: new Date(),
        };
        if (row.landCostLevel === "" && seed.landCostLevel !== "") patch.landCostLevel = seed.landCostLevel;
        if (row.laborCostLevel === "" && seed.laborCostLevel !== "") patch.laborCostLevel = seed.laborCostLevel;
        if (patch.landCostLevel !== undefined || patch.laborCostLevel !== undefined) {
          await db.update(schema.cityProfiles).set(patch).where(eq(schema.cityProfiles.id, row.id));
          updated++;
        }
      }
      ctx.invalidateQueries();
      return { updated, inserted };
    },
  }),

  refreshPolicies: defineAction({
    description: "触发一次政策采集：派研究任务到公开网络查找长三角各市（含宣城市）现行产业扶持/招商政策（须带政府官网原文链接），结果回写政策库。",
    request: z.object({}),
    response: z.object({ ok: z.boolean(), message: z.string() }),
    async handler(ctx) {
      const message = [
        "你是招商雷达的政策研究员。请用网页搜索，查找长三角 9 个城市（上海、苏州、杭州、合肥、宁波、南京、无锡、常州、宣城市）现行有效的产业扶持 / 招商引资政策原文，优先政府官网（gov.cn 域名）、发改委、经信局、招商局发布的正式文件。",
        "搜索方向（多换几组关键词）：「合肥 新能源汽车 产业扶持政策」「苏州 集成电路 扶持政策」「上海 集成电路 生物医药 扶持办法」「杭州 数字经济 扶持政策」「常州 动力电池 新能源 政策」「宁波 新材料 扶持」「南京 软件 集成电路 政策」「无锡 物联网 集成电路 政策」「宣城 新能源 汽车零部件 招商 扶持政策」「宣城 技改 制造业 政策」。",
        "筛选标准：必须是具体政策文件或官方政策解读，写得出政策名称和发布机关；剔除新闻评论、二手转载里没有原文出处的、已明确失效的。目标 9–18 条，尽量覆盖多个城市与产业。",
        "每条必须给出：城市 city（上面 9 个城市之一，必须用全称，宣城市的 city 填「宣城市」，不要填简称「宣城」）、政策名称 title（文件全名或官方标题）、适用产业 industries（数组，从 新能源汽车/集成电路/生物医药/电子信息/数字经济/新材料/装备制造/动力电池/人工智能/软件/物联网/智能家电/石化/纳米技术/汽车零部件 里选，可多选；面向所有产业的综合政策给空数组）、扶持内容 benefit（只写原文里明确写的扶持方式与力度，如补贴比例、上限金额，原文没写数字就只写扶持方式，绝不估算补数字）、申报门槛 threshold（原文写了才填，没写留空）、截止/有效期 deadline（原文写了才填，如「有效期至2027年12月31日」，没写留空）、原文链接 sourceUrl（必须是你实际打开的政府官网页面完整链接，逐字复制，不要拼造；没有原文链接的条目不要提交）。",
        "完成后把结果通过指定的回写动作一次性提交；确实找不到带原文链接的合格政策时提交空数组并在 note 里说明。",
      ].join("\n");
      const res = await ctx.agent.spawnTask(message, {
        expectsAction: "savePolicyCandidates",
        dedupeKey: "policy-refresh",
      });
      if (!res.ok) {
        return { ok: false, message: `政策采集任务未能启动：${res.error}` };
      }
      return {
        ok: true,
        message: "政策采集已启动，正在查找各市现行扶持政策原文，约 1–3 分钟后新政策会出现在政策库。",
      };
    },
  }),

  savePolicyCandidates: defineAction({
    description: "回写政策采集找到的政策：城市名先规范化到城市档案名（上海市→上海，宣城→宣城市）；再按两把去重键拦截重复——原文链接相同，或同城且去掉《》与标点后的标题相同，任一命中都跳过；没有原文链接的候选也会被跳过。合格的直接进政策库参与匹配计分。",
    request: z.object({
      note: z.string().default(""),
      candidates: z.array(
        z.object({
          city: z.string().min(1),
          title: z.string().min(1),
          industries: z.array(z.string()).default([]),
          benefit: z.string().default(""),
          threshold: z.string().default(""),
          deadline: z.string().default(""),
          sourceUrl: z.string().default(""),
        }),
      ),
    }),
    response: z.object({ added: z.number(), skipped: z.number() }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const existing = await db
        .select({
          city: schema.policies.city,
          title: schema.policies.title,
          sourceUrl: schema.policies.sourceUrl,
        })
        .from(schema.policies);
      // 两把去重键：原文链接（全局）+ 同城规范化标题，任一命中即重复
      const seenUrls = new Set(
        existing.map((e) => policyUrlKey(e.sourceUrl)).filter((k) => k !== ""),
      );
      const seenTitles = new Set(
        existing.map((e) => `${normalizeCityName(e.city)}|${policyTitleKey(e.title)}`),
      );
      let added = 0;
      let skipped = 0;
      for (const c of args.candidates) {
        const city = normalizeCityName(c.city);
        const urlKey = policyUrlKey(c.sourceUrl);
        const titleKey = `${city}|${policyTitleKey(c.title)}`;
        if (
          c.sourceUrl.trim() === "" ||
          (urlKey !== "" && seenUrls.has(urlKey)) ||
          seenTitles.has(titleKey)
        ) {
          skipped++;
          continue;
        }
        if (urlKey !== "") seenUrls.add(urlKey);
        seenTitles.add(titleKey);
        await db.insert(schema.policies).values({
          city,
          title: c.title,
          industries: JSON.stringify(c.industries),
          benefit: c.benefit,
          threshold: c.threshold,
          deadline: c.deadline,
          sourceUrl: c.sourceUrl,
        });
        added++;
      }
      ctx.invalidateQueries();
      return { added, skipped };
    },
  }),

  repairPolicies: defineAction({
    description: "一次性修复政策库（可重复执行，修完再跑计数为 0）：(1) 把全部政策的城市名规范化到城市档案名（上海市→上海、苏州市→苏州、杭州市→杭州、宁波市→宁波，宣城→宣城市），让政策真正参与评分与筛选；(2) 按原文链接相同、或同城且去掉《》与标点后标题相同，两把键合并重复政策——保留低 id 行，重复行的产业取并集，门槛/截止/链接等空缺字段互补，扶持条款里保留行未覆盖的并入；(3) 晶合集成、微导纳米、皇冠新材三家信号里联系方式仍为 0 条的，用全新任务键重新触发公开联系方式获取。返回修复前后条数、逐条合并明细与联系方式重触发清单。",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      policiesBefore: z.number(),
      policiesAfter: z.number(),
      citiesNormalized: z.number(),
      merges: z.array(
        z.object({
          keptId: z.number(),
          removedId: z.number(),
          keptTitle: z.string(),
          removedTitle: z.string(),
          reason: z.string(),
        }),
      ),
      contactLookupsStarted: z.array(
        z.object({ signalId: z.number(), company: z.string() }),
      ),
    }),
    handler: async (
      ctx,
    ): Promise<{
      ok: true;
      policiesBefore: number;
      policiesAfter: number;
      citiesNormalized: number;
      merges: Array<{
        keptId: number;
        removedId: number;
        keptTitle: string;
        removedTitle: string;
        reason: string;
      }>;
      contactLookupsStarted: Array<{ signalId: number; company: string }>;
    }> => {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.policies)
        .orderBy(asc(schema.policies.id));
      const policiesBefore = rows.length;

      // 分组：原文链接相同 → 同组；同城且规范化标题相同 → 同组。
      // 一条政策的两个键都登记到它所在的组，后来者任一键命中即并入（链式合并）。
      interface Group {
        members: PolicyRowT[];
        urlKeys: Map<string, number>;
        titleKeys: Map<string, number>;
      }
      const groups: Group[] = [];
      const byUrl = new Map<string, Group>();
      const byTitle = new Map<string, Group>();
      for (const r of rows) {
        const city = normalizeCityName(r.city);
        const urlKey = policyUrlKey(r.sourceUrl);
        const titleKey = `${city}|${policyTitleKey(r.title)}`;
        const g =
          (urlKey !== "" ? byUrl.get(urlKey) : undefined) ?? byTitle.get(titleKey);
        if (g) {
          g.members.push(r);
          if (urlKey !== "") {
            g.urlKeys.set(urlKey, r.id);
            byUrl.set(urlKey, g);
          }
          g.titleKeys.set(titleKey, r.id);
          byTitle.set(titleKey, g);
        } else {
          const ng: Group = {
            members: [r],
            urlKeys: new Map(urlKey !== "" ? [[urlKey, r.id]] : []),
            titleKeys: new Map([[titleKey, r.id]]),
          };
          groups.push(ng);
          if (urlKey !== "") byUrl.set(urlKey, ng);
          byTitle.set(titleKey, ng);
        }
      }

      // 扶持条款覆盖判定：把条款按 4 字滑窗切碎，看有多少碎片已出现在保留行文本里；
      // 覆盖率 ≥50% 视为已包含（同一条政策的改写说法），不重复并入。
      const stripText = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, "");
      const clauseCovered = (clause: string, haystackStripped: string): boolean => {
        const c = stripText(clause);
        if (c.length < 6) return true;
        let hits = 0;
        let total = 0;
        for (let i = 0; i + 4 <= c.length; i += 2) {
          total++;
          if (haystackStripped.includes(c.slice(i, i + 4))) hits++;
        }
        return total > 0 && hits / total >= 0.5;
      };

      let citiesNormalized = 0;
      const merges: Array<{
        keptId: number;
        removedId: number;
        keptTitle: string;
        removedTitle: string;
        reason: string;
      }> = [];
      for (const g of groups) {
        const sorted = [...g.members].sort((a, b) => a.id - b.id);
        const keeper = sorted[0];
        if (!keeper) continue;
        const dups = sorted.slice(1);
        const city = normalizeCityName(keeper.city);
        let benefit = keeper.benefit;
        const benefitStripped = stripText(benefit);
        for (const dup of dups) {
          for (const clause of dup.benefit.split(/[；;]/)) {
            const cl = clause.trim();
            if (cl === "" || clauseCovered(cl, benefitStripped)) continue;
            benefit = benefit === "" ? cl : `${benefit}；${cl}`;
          }
        }
        const firstNonEmpty = (vals: string[]) => vals.find((v) => v.trim() !== "") ?? "";
        const patch: {
          city?: string;
          industries?: string;
          benefit?: string;
          threshold?: string;
          deadline?: string;
          sourceUrl?: string;
        } = {};
        if (keeper.city !== city) {
          patch.city = city;
          citiesNormalized++;
        }
        if (dups.length > 0) {
          patch.industries = JSON.stringify(
            mergeStringLists(sorted.map((p) => parseIndustries(p.industries))),
          );
          patch.benefit = benefit;
          patch.threshold = keeper.threshold || firstNonEmpty(dups.map((d) => d.threshold));
          patch.deadline = keeper.deadline || firstNonEmpty(dups.map((d) => d.deadline));
          patch.sourceUrl = keeper.sourceUrl || firstNonEmpty(dups.map((d) => d.sourceUrl));
        }
        if (Object.keys(patch).length > 0) {
          await db.update(schema.policies).set(patch).where(eq(schema.policies.id, keeper.id));
        }
        for (const dup of dups) {
          const sameUrl =
            policyUrlKey(dup.sourceUrl) !== "" &&
            policyUrlKey(dup.sourceUrl) === policyUrlKey(keeper.sourceUrl);
          merges.push({
            keptId: keeper.id,
            removedId: dup.id,
            keptTitle: keeper.title,
            removedTitle: dup.title,
            reason: sameUrl ? "原文链接相同" : "同城同标题（去《》与标点后）",
          });
          await db.delete(schema.policies).where(eq(schema.policies.id, dup.id));
        }
      }
      // 不在重复组里、但城市名还带「市」的单条政策也要回填（组内单成员在上面已计数处理一部分，
      // 这里兜底扫一遍全表，确保修完每条政策的城市名都对得上城市档案）
      const remaining = await db.select().from(schema.policies);
      for (const p of remaining) {
        const city = normalizeCityName(p.city);
        if (p.city !== city) {
          await db.update(schema.policies).set({ city }).where(eq(schema.policies.id, p.id));
          citiesNormalized++;
        }
      }
      const after = await db.select({ id: schema.policies.id }).from(schema.policies);

      // 三家联系方式长期为 0 的信号：仍为 0 条的用全新任务键重新触发获取
      // （旧固定键任务可能已结束，重试只会恢复旧任务、研究不会重跑）。
      // 已回写的跳过，重复执行不会重复打扰。
      const contactCounts = await contactCountMap(ctx);
      const allSignals = await db
        .select()
        .from(schema.signals)
        .orderBy(asc(schema.signals.id));
      const contactLookupsStarted: Array<{ signalId: number; company: string }> = [];
      for (const a of KNOWN_CONTACT_ANCHORS) {
        const sig = allSignals.find((r) => r.company.includes(a.match));
        if (sig && (contactCounts.get(sig.id) ?? 0) === 0) {
          const r = await startContactLookup(
            ctx,
            sig,
            `contact-repair-${sig.id}-${Date.now()}`,
          );
          if (r.ok) contactLookupsStarted.push({ signalId: sig.id, company: sig.company });
        }
      }

      ctx.invalidateQueries();
      return {
        ok: true as const,
        policiesBefore,
        policiesAfter: after.length,
        citiesNormalized,
        merges,
        contactLookupsStarted,
      };
    },
  }),

  mergeDuplicateSignals: defineAction({
    description: "合并待核实里两对同事件重复信号（胜科纳米定增、福莱新材调研纪要）：每对保留内容更全的一条，把另一条的来源链接与关键数字并入摘要、空字段互补、联系方式与跟进记录改挂保留行后再删除重复行。只处理这两对（按规范化核心名定位），其余信号（含晶合集成）一律不动；可重复执行，已合并时各项计数为 0。",
    request: z.object({}),
    response: mergeDuplicateSignalsOut,
    handler: async (ctx): Promise<z.infer<typeof mergeDuplicateSignalsOut>> => {
      const db = ctx.db<typeof schema>();
      const all = await db
        .select()
        .from(schema.signals)
        .orderBy(asc(schema.signals.id));
      const signalsBefore = all.length;
      const pendingBefore = all.filter((r) => r.status === "pending").length;

      // 两对明确的重复：core = 规范化核心名，keepId = 保留行（内容更全的一条）。
      // 保留行 id 对不上时，以同组里摘要最长的一条为准，避免 id 漂移误合。
      const PAIRS: Array<{ core: string; keepId: number }> = [
        { core: "胜科纳米", keepId: 124 },
        { core: "福莱新材", keepId: 111 },
      ];

      // 数字 token 抽取（带单位的金额/规模表述）：另一来源里、保留行摘要还没有的
      // 数字才并入，避免把同一数字换个说法重复堆叠。
      const numTokens = (s: string): string[] => {
        const out: string[] = [];
        const re = /\d[\d,]*(?:\.\d+)?\s*(?:亿元|万元|万套|台套|万台|万吨|亩|平方米|%|人|套|台)/g;
        for (const m of (s ?? "").matchAll(re)) {
          const t = m[0].replace(/\s+/g, "");
          if (!out.includes(t)) out.push(t);
        }
        return out;
      };
      const digitsOf = (t: string) => t.replace(/[^\d.]/g, "");

      const merges: Array<{
        core: string;
        keptId: number;
        removedId: number;
        keptCompany: string;
        removedCompany: string;
        mergedNote: string;
      }> = [];
      const skippedPairs: Array<{ core: string; reason: string }> = [];
      const removedIds = new Set<number>();

      for (const pair of PAIRS) {
        const group = all.filter(
          (r) => !removedIds.has(r.id) && normalizeCompanyName(r.company) === pair.core,
        );
        if (group.length === 0) {
          skippedPairs.push({ core: pair.core, reason: "未找到该企业的信号，跳过" });
          continue;
        }
        if (group.length === 1) {
          skippedPairs.push({ core: pair.core, reason: "已只剩一条，无需合并" });
          continue;
        }
        const keeper =
          group.find((r) => r.id === pair.keepId) ??
          [...group].sort((a, b) => b.summary.length - a.summary.length)[0];
        if (!keeper) {
          skippedPairs.push({ core: pair.core, reason: "无法确定保留行，跳过" });
          continue;
        }
        const dups = group.filter((r) => r.id !== keeper.id);
        // 安全闸：整组都必须还是待核实，且没有任何一条已转项目，否则不动这一对。
        const linked = await db
          .select({ id: schema.projects.id, signalId: schema.projects.signalId })
          .from(schema.projects);
        const linkedSignalIds = new Set(linked.map((p) => p.signalId));
        const blocked = group.find(
          (r) => r.status !== "pending" || linkedSignalIds.has(r.id),
        );
        if (blocked) {
          skippedPairs.push({
            core: pair.core,
            reason: `信号 ${blocked.id} 状态为 ${blocked.status}${linkedSignalIds.has(blocked.id) ? " 且已关联项目" : ""}，不是待核实原样，跳过这一对`,
          });
          continue;
        }

        let summary = keeper.summary;
        const notes: string[] = [];
        const patch: {
          summary?: string;
          industry?: string;
          targetRegion?: string;
          investmentText?: string;
          investmentYi?: number;
          reportedDate?: string;
        } = {};
        const fill = <K extends "industry" | "targetRegion" | "investmentText" | "reportedDate">(
          field: K,
          keeperVal: string,
          dupVal: string,
        ): string => {
          if (keeperVal.trim() === "" && dupVal.trim() !== "") {
            patch[field] = dupVal;
            return dupVal;
          }
          return keeperVal;
        };
        let industry = keeper.industry;
        let targetRegion = keeper.targetRegion;
        let investmentText = keeper.investmentText;
        let reportedDate = keeper.reportedDate;
        let investmentYi = keeper.investmentYi;

        for (const dup of dups) {
          industry = fill("industry", industry, dup.industry);
          targetRegion = fill("targetRegion", targetRegion, dup.targetRegion);
          investmentText = fill("investmentText", investmentText, dup.investmentText);
          reportedDate = fill("reportedDate", reportedDate, dup.reportedDate);
          if (investmentYi == null && dup.investmentYi != null) {
            investmentYi = dup.investmentYi;
            patch.investmentYi = dup.investmentYi;
          }
          // 来源链接并入：另一来源的链接追加到摘要末尾（已包含则不重复）
          if (
            dup.sourceUrl.trim() !== "" &&
            dup.sourceUrl !== keeper.sourceUrl &&
            !summary.includes(dup.sourceUrl)
          ) {
            summary += `（同一事件另一来源：${dup.sourceName || "原文"} ${dup.sourceUrl}）`;
            notes.push(`并入来源「${dup.sourceName}」链接`);
          }
          // 关键数字并入：另一来源摘要/投资额里有、保留行还没有的带单位数字
          const missingNums = numTokens(`${dup.summary} ${dup.investmentText}`).filter(
            (t) => !summary.includes(t) && !summary.includes(digitsOf(t)),
          );
          if (missingNums.length > 0) {
            summary += `（另一来源关键数字：${missingNums.slice(0, 6).join("、")}）`;
            notes.push(`并入关键数字 ${missingNums.slice(0, 6).join("、")}`);
          }
          // 联系方式与线索跟进改挂保留行（先去掉与保留行完全相同的联系方式，避免重复行）
          const keeperContacts = await db
            .select()
            .from(schema.companyContacts)
            .where(eq(schema.companyContacts.signalId, keeper.id));
          const keeperContactKeys = new Set(
            keeperContacts.map(
              (c) => `${c.contactLabel}|${c.phone}|${c.email}`,
            ),
          );
          const dupContacts = await db
            .select()
            .from(schema.companyContacts)
            .where(eq(schema.companyContacts.signalId, dup.id));
          for (const c of dupContacts) {
            const k = `${c.contactLabel}|${c.phone}|${c.email}`;
            if (keeperContactKeys.has(k)) {
              await db
                .delete(schema.companyContacts)
                .where(eq(schema.companyContacts.id, c.id));
            } else {
              await db
                .update(schema.companyContacts)
                .set({ signalId: keeper.id, company: keeper.company })
                .where(eq(schema.companyContacts.id, c.id));
              keeperContactKeys.add(k);
            }
          }
          await db
            .update(schema.signalFollowups)
            .set({ signalId: keeper.id })
            .where(eq(schema.signalFollowups.signalId, dup.id));
          await db.delete(schema.signals).where(eq(schema.signals.id, dup.id));
          removedIds.add(dup.id);
          merges.push({
            core: pair.core,
            keptId: keeper.id,
            removedId: dup.id,
            keptCompany: keeper.company,
            removedCompany: dup.company,
            mergedNote: notes.join("；") || "内容基本一致，仅删除重复行",
          });
          notes.length = 0;
        }
        if (summary !== keeper.summary) patch.summary = summary;
        if (Object.keys(patch).length > 0) {
          await db.update(schema.signals).set(patch).where(eq(schema.signals.id, keeper.id));
        }
      }

      const after = await db.select().from(schema.signals);
      const remainingByCore = PAIRS.map((p) => ({
        core: p.core,
        count: after.filter((r) => normalizeCompanyName(r.company) === p.core).length,
      }));
      ctx.invalidateQueries();
      return {
        ok: true as const,
        signalsBefore,
        signalsAfter: after.length,
        pendingBefore,
        pendingAfter: after.filter((r) => r.status === "pending").length,
        merges,
        skippedPairs,
        remainingByCore,
      };
    },
  }),

  dedupeXuanchengCities: defineAction({
    description: "合并宣城市/宣城重复数据：城市档案只保留「宣城市」一条（产业、园区取并集，成本档位与备注空缺互补），删除「宣城」那条；政策的城市字段由「宣城」统一改「宣城市」，同城同名政策只留一条；信号落地城市与项目推荐城市里的「宣城」也一并改为「宣城市」。可重复执行，第二次起各项计数为 0。",
    request: z.object({}),
    response: z.object({
      ok: z.literal(true),
      cityProfilesBefore: z.number(),
      cityProfilesAfter: z.number(),
      keptCityProfileId: z.number(),
      deletedCityProfileIds: z.array(z.number()),
      policiesRenamed: z.number(),
      policiesDeleted: z.number(),
      signalsRenamed: z.number(),
      projectsRenamed: z.number(),
    }),
    handler: async (
      ctx,
    ): Promise<{
      ok: true;
      cityProfilesBefore: number;
      cityProfilesAfter: number;
      keptCityProfileId: number;
      deletedCityProfileIds: number[];
      policiesRenamed: number;
      policiesDeleted: number;
      signalsRenamed: number;
      projectsRenamed: number;
    }> => {
      const db = ctx.db<typeof schema>();
      await ensureSeedCities(ctx);

      // ---- 城市档案：宣城市/宣城合并为一条 ----
      const allProfiles = await db
        .select()
        .from(schema.cityProfiles)
        .orderBy(asc(schema.cityProfiles.id));
      const cityProfilesBefore = allProfiles.length;
      const xc = allProfiles
        .filter((r) => normalizeCityName(r.city) === CANONICAL_CITY)
        .sort((a, b) => a.id - b.id);
      let keptCityProfileId = 0;
      const deletedCityProfileIds: number[] = [];
      if (xc.length === 0) {
        const seed = SEED_CITIES.find((c) => c.city === CANONICAL_CITY);
        const inserted = await db
          .insert(schema.cityProfiles)
          .values({
            city: CANONICAL_CITY,
            province: seed?.province ?? "安徽省",
            industries: JSON.stringify(seed?.industries ?? []),
            parks: JSON.stringify(seed?.parks ?? []),
            landCostLevel: seed?.landCostLevel ?? "",
            laborCostLevel: seed?.laborCostLevel ?? "",
            note: seed?.note ?? "",
          })
          .returning({ id: schema.cityProfiles.id });
        keptCityProfileId = inserted[0]?.id ?? 0;
      } else {
        const keeper = xc.find((r) => r.city === CANONICAL_CITY) ?? xc[0];
        if (!keeper) throw new Error("dedupeXuanchengCities: keeper missing");
        keptCityProfileId = keeper.id;
        const others = xc.filter((r) => r.id !== keeper.id);
        await db
          .update(schema.cityProfiles)
          .set({
            city: CANONICAL_CITY,
            province: keeper.province || (others.find((r) => r.province !== "")?.province ?? ""),
            industries: JSON.stringify(
              mergeStringLists(xc.map((r) => parseIndustries(r.industries))),
            ),
            parks: JSON.stringify(mergeStringLists(xc.map((r) => parseIndustries(r.parks)))),
            landCostLevel:
              keeper.landCostLevel || (others.find((r) => r.landCostLevel !== "")?.landCostLevel ?? ""),
            laborCostLevel:
              keeper.laborCostLevel || (others.find((r) => r.laborCostLevel !== "")?.laborCostLevel ?? ""),
            note: keeper.note || (others.find((r) => r.note !== "")?.note ?? ""),
            updatedAt: new Date(),
          })
          .where(eq(schema.cityProfiles.id, keeper.id));
        for (const extra of others) {
          await db.delete(schema.cityProfiles).where(eq(schema.cityProfiles.id, extra.id));
          deletedCityProfileIds.push(extra.id);
        }
      }
      const afterProfiles = await db.select().from(schema.cityProfiles);
      const cityProfilesAfter = afterProfiles.length;

      // ---- 政策：城市改规范名 + 同城同名只留一条 ----
      const allPolicies = await db
        .select()
        .from(schema.policies)
        .orderBy(asc(schema.policies.id));
      let policiesRenamed = 0;
      let policiesDeleted = 0;
      const policyGroups = new Map<string, PolicyRowT[]>();
      for (const p of allPolicies) {
        const key = `${normalizeCityName(p.city)}|${p.title}`;
        const g = policyGroups.get(key);
        if (g) g.push(p);
        else policyGroups.set(key, [p]);
      }
      for (const group of policyGroups.values()) {
        const keeperP = group[0];
        if (!keeperP) continue;
        const dups = group.slice(1);
        const needsRename = keeperP.city !== normalizeCityName(keeperP.city);
        if (needsRename || dups.length > 0) {
          await db
            .update(schema.policies)
            .set({
              city: normalizeCityName(keeperP.city),
              industries: JSON.stringify(
                mergeStringLists(group.map((p) => parseIndustries(p.industries))),
              ),
              benefit: keeperP.benefit || (dups.find((p) => p.benefit !== "")?.benefit ?? ""),
              threshold: keeperP.threshold || (dups.find((p) => p.threshold !== "")?.threshold ?? ""),
              deadline: keeperP.deadline || (dups.find((p) => p.deadline !== "")?.deadline ?? ""),
              sourceUrl: keeperP.sourceUrl || (dups.find((p) => p.sourceUrl !== "")?.sourceUrl ?? ""),
            })
            .where(eq(schema.policies.id, keeperP.id));
          if (needsRename) policiesRenamed++;
        }
        for (const dup of dups) {
          await db.delete(schema.policies).where(eq(schema.policies.id, dup.id));
          policiesDeleted++;
        }
      }
      // 不在重复组内、但城市还是简称的单条政策也要改名
      const remainingPolicies = await db.select().from(schema.policies);
      for (const p of remainingPolicies) {
        if (p.city !== normalizeCityName(p.city)) {
          await db
            .update(schema.policies)
            .set({ city: normalizeCityName(p.city) })
            .where(eq(schema.policies.id, p.id));
          policiesRenamed++;
        }
      }

      // ---- 信号落地城市 / 项目推荐城市里的简称一并改名 ----
      let signalsRenamed = 0;
      const sigRows = await db
        .select({ id: schema.signals.id, landedCity: schema.signals.landedCity })
        .from(schema.signals);
      for (const s of sigRows) {
        if (s.landedCity.trim() !== "" && normalizeCityName(s.landedCity) !== s.landedCity.trim()) {
          await db
            .update(schema.signals)
            .set({ landedCity: normalizeCityName(s.landedCity) })
            .where(eq(schema.signals.id, s.id));
          signalsRenamed++;
        }
      }
      let projectsRenamed = 0;
      const projRows = await db
        .select({ id: schema.projects.id, recommendedCity: schema.projects.recommendedCity })
        .from(schema.projects);
      for (const p of projRows) {
        if (
          p.recommendedCity.trim() !== "" &&
          normalizeCityName(p.recommendedCity) !== p.recommendedCity.trim()
        ) {
          await db
            .update(schema.projects)
            .set({ recommendedCity: normalizeCityName(p.recommendedCity) })
            .where(eq(schema.projects.id, p.id));
          projectsRenamed++;
        }
      }

      ctx.invalidateQueries();
      return {
        ok: true as const,
        cityProfilesBefore,
        cityProfilesAfter,
        keptCityProfileId,
        deletedCityProfileIds,
        policiesRenamed,
        policiesDeleted,
        signalsRenamed,
        projectsRenamed,
      };
    },
  }),

  getExportInfo: defineAction({
    description: "源码包与数据导出概览：当前库各表条数（信号按状态、政策、城市档案、项目/线索、跟进记录、联系方式、刷新记录），供「我的」页导出区展示——源码包本身不含这些运行时数据。",
    request: z.object({}),
    response: z.object({
      signalsTotal: z.number(),
      signalsPending: z.number(),
      signalsConfirmed: z.number(),
      signalsDismissed: z.number(),
      signalsConverted: z.number(),
      policies: z.number(),
      cityProfiles: z.number(),
      projects: z.number(),
      projectFollowups: z.number(),
      signalFollowups: z.number(),
      contacts: z.number(),
      refreshRuns: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const sig = await db
        .select({ status: schema.signals.status })
        .from(schema.signals);
      const count = (rows: unknown[]) => rows.length;
      const policies = await db.select({ id: schema.policies.id }).from(schema.policies);
      const cities = await db.select({ id: schema.cityProfiles.id }).from(schema.cityProfiles);
      const projects = await db.select({ id: schema.projects.id }).from(schema.projects);
      const fus = await db.select({ id: schema.followups.id }).from(schema.followups);
      const sfus = await db
        .select({ id: schema.signalFollowups.id })
        .from(schema.signalFollowups);
      const contacts = await db
        .select({ id: schema.companyContacts.id })
        .from(schema.companyContacts);
      const runs = await db.select({ id: schema.refreshRuns.id }).from(schema.refreshRuns);
      return {
        signalsTotal: sig.length,
        signalsPending: sig.filter((s) => s.status === "pending").length,
        signalsConfirmed: sig.filter((s) => s.status === "confirmed").length,
        signalsDismissed: sig.filter((s) => s.status === "dismissed").length,
        signalsConverted: sig.filter((s) => s.status === "converted").length,
        policies: count(policies),
        cityProfiles: count(cities),
        projects: count(projects),
        projectFollowups: count(fus),
        signalFollowups: count(sfus),
        contacts: count(contacts),
        refreshRuns: count(runs),
      };
    },
  }),

  exportAllData: defineAction({
    description: "导出当前库全部数据快照：signals、city_profiles、policies、projects、followups、signal_followups、company_contacts、refresh_runs 八张表的全部行（时间转 ISO 字符串），供下载备份/迁移。源码包不含数据，数据走这条导出。",
    request: z.object({}),
    response: z.object({
      exportedAt: z.string(),
      counts: z.record(z.string(), z.number()),
      tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const toRecords = (
        rows: Array<Record<string, unknown>>,
      ): Array<Record<string, unknown>> =>
        rows.map((r) => {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(r)) {
            out[k] = v instanceof Date ? v.toISOString() : v;
          }
          return out;
        });
      const signals = toRecords(
        (await db.select().from(schema.signals)) as unknown as Array<Record<string, unknown>>,
      );
      const cityProfiles = toRecords(
        (await db.select().from(schema.cityProfiles)) as unknown as Array<Record<string, unknown>>,
      );
      const policies = toRecords(
        (await db.select().from(schema.policies)) as unknown as Array<Record<string, unknown>>,
      );
      const projects = toRecords(
        (await db.select().from(schema.projects)) as unknown as Array<Record<string, unknown>>,
      );
      const followups = toRecords(
        (await db.select().from(schema.followups)) as unknown as Array<Record<string, unknown>>,
      );
      const signalFollowups = toRecords(
        (await db.select().from(schema.signalFollowups)) as unknown as Array<Record<string, unknown>>,
      );
      const companyContacts = toRecords(
        (await db.select().from(schema.companyContacts)) as unknown as Array<Record<string, unknown>>,
      );
      const refreshRuns = toRecords(
        (await db.select().from(schema.refreshRuns)) as unknown as Array<Record<string, unknown>>,
      );
      const tables: Record<string, Array<Record<string, unknown>>> = {
        signals,
        city_profiles: cityProfiles,
        policies,
        projects,
        followups,
        signal_followups: signalFollowups,
        company_contacts: companyContacts,
        refresh_runs: refreshRuns,
      };
      const counts: Record<string, number> = {};
      for (const [name, rows] of Object.entries(tables)) counts[name] = rows.length;
      return { exportedAt: new Date().toISOString(), counts, tables };
    },
  }),
} satisfies ActionsModule;
