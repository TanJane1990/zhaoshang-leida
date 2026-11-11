// 落地评估模型 — 按已定方案实现：
// 硬过滤（产业不在城市主导目录内 → 直接判「暂不建议」）+ 六维评分（满分 100）：
//   产业契合 30 / 投资规模 20 / 产业链 15 / 用地载体 15 / 政策收益 10 / 风险 10
// 结论分级：≥80 建议引进 · 65–79 重点跟进 · 50–64 观望 · <50 暂不建议
// 所有分数都由结构化字段算出；缺数据时明确标注「信息不足」，不臆测。

export interface CityProfileRow {
  city: string;
  province: string;
  industries: string[];
  parks: string[];
  landCostLevel: string;
  laborCostLevel: string;
}

export interface PolicyRow {
  id: number;
  city: string;
  title: string;
  industries: string[];
  benefit: string;
  threshold: string;
  deadline: string;
  sourceUrl: string;
  createdAt: string;
}

export interface SignalLike {
  company: string;
  industry: string;
  signalType: string;
  investmentYi: number | null;
  dealStage?: DealStage;
  landedCity?: string;
  targetRegion?: string;
  summary?: string;
}

// ---------- 项目阶段（意向/洽谈/签约/开工/投产） ----------
// 招引价值的分水岭：签约之前（intent/negotiating）城市还没定，才值得跨市
// 评分推荐；签约及之后（signed/building/producing）项目已经选定城市，
// 对其他城市没有直接招引价值，只剩配套招商、以商招商与二期扩产价值。

export type DealStage = "intent" | "negotiating" | "signed" | "building" | "producing";

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  intent: "意向",
  negotiating: "洽谈",
  signed: "已签约",
  building: "已开工",
  producing: "已投产",
};

export function isLandedStage(stage: DealStage): boolean {
  return stage === "signed" || stage === "building" || stage === "producing";
}

/**
 * 从信号类型与摘要推断阶段。证据优先级：摘要/类型里明确写了投产、开工、
 * 签约、拿地等已落地事实时，一律按已落地处理（哪怕类型挂的是「增资扩产」）；
 * 拿地、项目备案、环评、施工许可、建厂招标都意味着城市已经选定。
 * 没有任何已落地证据时，有考察/洽谈/意向表述的归洽谈，其余归意向。
 */
// 早期信号类型（股市/融资/招聘/专利路）：它们的价值恰恰在签约之前——
// 定增募投、互动易问答、调研纪要、年报在建工程、招聘扩张、专利产业化
// 本身都不证明项目已选定城市，绝不能仅凭类型或「在建工程」这类会计科目
// 措辞就标成已落地。只有来源原文明确写了已签约/已开工/已投产（且指向
// 具体项目）时，才按证据升级阶段。
export const EARLY_SIGNAL_TYPES = [
  "定增募投",
  "互动易问答",
  "调研纪要",
  "在建工程",
  "招聘扩张",
  "专利产业化",
  "融资",
  "战略合作",
];

export function deriveDealStage(signalType: string, summary: string): DealStage {
  // 「在建工程」是年报会计科目名，不是「项目正在建设」的事实陈述，先摘掉再判定，
  // 否则年报在建工程类信号会被「在建」二字误判为已开工。
  const cleanSummary = summary.replace(/在建工程/g, "");
  const text = `${signalType} ${cleanSummary}`;
  if (EARLY_SIGNAL_TYPES.includes(signalType)) {
    // 早期信号：只有原文明确的已完成动作才升级阶段，拟/计划/预计一律不算
    if (/已投产|正式投产|建成投产|投产达效/.test(cleanSummary)) return "producing";
    if (/已开工|正式开工|开工建设|开工奠基/.test(cleanSummary)) return "building";
    if (/已签约|正式签约|完成签约|签约落户/.test(cleanSummary)) return "signed";
    if (/洽谈|考察|对接|意向|拟|计划|预计|选址|规划/.test(cleanSummary)) return "negotiating";
    return "intent";
  }
  if (signalType === "投产" || /已投产|正式投产|投产达效|建成投产/.test(text)) return "producing";
  if (
    signalType === "施工许可" ||
    signalType === "建厂招标" ||
    /已开工|开工建设|正式开工|开工奠基|启动建设|在建|施工许可|建厂招标/.test(text)
  )
    return "building";
  if (
    signalType === "签约落户" ||
    signalType === "拿地" ||
    signalType === "项目备案" ||
    signalType === "环评公示" ||
    /已签约|签约落户|完成签约|项目签约|正式签约|竞得.*用地|摘牌|拿地|落户.*签约/.test(text)
  )
    return "signed";
  if (/洽谈|考察|对接|意向|拟投资|计划投资|选址/.test(text)) return "negotiating";
  return "intent";
}

/** 已落地信号的有效阶段：存量阶段与来源证据取「更靠后」的一个，签约证据不会被旧的类型标签盖掉。 */
export function effectiveDealStage(
  stored: string,
  signalType: string,
  summary: string,
): DealStage {
  const order: DealStage[] = ["intent", "negotiating", "signed", "building", "producing"];
  const storedStage = (order as string[]).includes(stored) ? (stored as DealStage) : "intent";
  const derived = deriveDealStage(signalType, summary);
  return order.indexOf(derived) > order.indexOf(storedStage) ? derived : storedStage;
}

/** 从意向区域/摘要里找已落地城市：优先用显式记录，其次在已知城市名里匹配。 */
export function resolveLandedCity(
  landedCity: string,
  targetRegion: string,
  summary: string,
  knownCities: string[],
): string {
  if (landedCity.trim() !== "") return landedCity.trim();
  for (const c of knownCities) {
    if (targetRegion.includes(c)) return c;
  }
  for (const c of knownCities) {
    if (summary.includes(c)) return c;
  }
  return targetRegion.trim();
}

/** 已落地项目还剩下的三类可跟进机会（确定性文案，不虚构具体企业名单）。 */
export function landedOpportunities(industry: string, landedCity: string): string[] {
  const ind = industry.trim() === "" ? "该产业" : industry.trim();
  const city = landedCity.trim() === "" ? "当地" : landedCity.trim();
  return [
    `配套招商：围绕该项目在${city}的上下游需求，梳理${ind}配套供应商与服务商清单，逐个对接引进`,
    `二期扩产：跟踪该项目产能利用与满产进度，提前摸排二期扩产的用地、用工需求并预留载体`,
    `以商招商：请该企业引荐其母公司、合作方与客户中尚未定址的新项目，争取落户本地`,
  ];
}

export interface CityScore {
  city: string;
  total: number;
  verdict: string;
  hardBlocked: boolean;
  // 阶段上下文：已落地信号不做跨市招引结论，verdict 改为「已落地 · 看配套/二期」
  dealStage: DealStage;
  isLanded: boolean;
  landedCity: string;
  parts: {
    industryFit: number;
    scale: number;
    chain: number;
    carrier: number;
    policy: number;
    risk: number;
  };
  reasons: string[];
  gaps: string[];
  matchedPolicies: PolicyRow[];
}

const STRONG_SIGNALS = ["拿地", "环评公示", "项目备案", "施工许可", "建厂招标"];
const MID_SIGNALS = ["增资扩产", "扩产", "新设子公司", "签约落户", "投产", "定增募投"];

// 弱信号的诚实标注：分数低不是缺陷，是如实反映这类来源的确定性
const WEAK_SIGNAL_GAPS: Record<string, string> = {
  互动易问答: "信号来自互动易/e互动问答，属企业意向表述，正式立项前确定性弱，需跟踪后续公告核实",
  调研纪要: "信号来自投资者调研纪要，属管理层口头规划，尚未形成公告级决议，需核实",
  在建工程: "信号来自年报/半年报在建工程披露，是存量科目信息，是否对应长三角新项目、地点与进度都需回原文核实",
  招聘扩张: "招聘扩张只是扩产前兆，岗位地点与规模口径不一，不能单独作为落地依据，需与公告/新闻交叉验证",
  专利产业化: "专利只证明技术储备，是否产业化、何时何地落地均未定，确定性最弱，仅作长期跟踪线索",
  融资: "融资只证明资金到位，资金投向与选址未定，需跟踪其后续扩产/设厂动作",
  战略合作: "战略合作多为框架性表述，是否转化为实体投资项目需后续核实",
};

function costScore(level: string, good: number, mid: number, bad: number): number {
  if (level === "低") return good;
  if (level === "中") return mid;
  if (level === "中高") return Math.round((mid + bad) / 2);
  if (level === "高") return bad;
  return Math.round((good + mid + bad) / 3); // 未录入 → 中性
}

export function scoreCity(
  signal: SignalLike,
  profile: CityProfileRow,
  allPolicies: PolicyRow[],
): CityScore {
  const industry = signal.industry.trim();
  const matchedPolicies = allPolicies.filter(
    (p) =>
      p.city === profile.city &&
      (p.industries.length === 0 ||
        (industry !== "" && p.industries.includes(industry))),
  );

  const reasons: string[] = [];
  const gaps: string[] = [];

  // ---- 产业契合 30 + 产业链 15 ----
  const industryListed = industry !== "" && profile.industries.includes(industry);
  let industryFit: number;
  let chain: number;
  if (industry === "") {
    industryFit = 12;
    chain = 6;
    gaps.push("信号未标注产业，产业契合度无法准确判断");
  } else if (industryListed) {
    industryFit = 28;
    chain = 13;
    reasons.push(`${profile.city}主导产业包含${industry}，产业契合度高`);
  } else {
    industryFit = 8;
    chain = 4;
    gaps.push(`${industry}不在${profile.city}主导产业目录内`);
  }

  // ---- 投资规模 20 ----
  let scale: number;
  const yi = signal.investmentYi;
  if (yi == null) {
    scale = 10;
    gaps.push("公开来源未披露投资额，规模分按中性计，需核实后再定档");
  } else if (yi >= 50) {
    scale = 20;
    reasons.push(`投资额约 ${yi} 亿元，属重大项目量级`);
  } else if (yi >= 10) {
    scale = 17;
    reasons.push(`投资额约 ${yi} 亿元，规模可观`);
  } else if (yi >= 5) {
    scale = 14;
  } else if (yi >= 1) {
    scale = 11;
  } else {
    scale = 7;
    gaps.push(`投资额约 ${yi} 亿元，低于多数园区重点项目门槛`);
  }

  // ---- 用地载体 15 ----
  let carrier: number;
  if (profile.parks.length === 0) {
    carrier = 7;
    gaps.push(`${profile.city}尚未录入代表园区/载体信息`);
  } else {
    const land = costScore(profile.landCostLevel, 8, 6, 3);
    const labor = costScore(profile.laborCostLevel, 7, 5, 3);
    carrier = land + labor;
    if (profile.landCostLevel === "低" || profile.laborCostLevel === "低") {
      reasons.push(
        `${profile.city}用地/人力成本处于低档（${profile.parks.join("、")}可承接）`,
      );
    }
    if (profile.landCostLevel === "高") {
      gaps.push(`${profile.city}用地成本高，需重点测算租金与地价`);
    }
  }

  // ---- 政策收益 10 ----
  let policyScore: number;
  if (matchedPolicies.length >= 2) {
    policyScore = 10;
    reasons.push(`已录入政策中有 ${matchedPolicies.length} 条可匹配`);
  } else if (matchedPolicies.length === 1) {
    policyScore = 7;
    reasons.push("已录入政策中有 1 条可匹配");
  } else {
    policyScore = 3;
    gaps.push(`${profile.city}政策库暂无可匹配条目（或尚未录入当地政策）`);
  }

  // ---- 风险 10（按信号强度） ----
  let risk: number;
  if (STRONG_SIGNALS.includes(signal.signalType)) {
    risk = 9;
    reasons.push(`信号类型为「${signal.signalType}」，属强落地信号`);
  } else if (MID_SIGNALS.includes(signal.signalType)) {
    risk = 7;
    if (signal.signalType === "定增募投") {
      reasons.push("信号类型为「定增募投」，有董事会决议与募资用途支撑，但募资尚未完成、选址仍可变，属签约前信号");
    }
  } else if (signal.signalType === "专利产业化") {
    risk = 4;
    gaps.push(WEAK_SIGNAL_GAPS["专利产业化"] ?? "专利只证明技术储备，是否产业化、何时何地落地均未定，确定性最弱，仅作长期跟踪线索");
  } else if (WEAK_SIGNAL_GAPS[signal.signalType] !== undefined) {
    risk = 5;
    gaps.push(WEAK_SIGNAL_GAPS[signal.signalType] ?? `信号类型为「${signal.signalType}」，确定性偏弱，需先核实企业真实意向`);
  } else {
    risk = 5;
    gaps.push(`信号类型为「${signal.signalType}」，确定性偏弱，需先核实企业真实意向`);
  }

  const total = industryFit + scale + chain + carrier + policyScore + risk;
  const industryBlocked = industry !== "" && !industryListed;

  // ---- 阶段门：已签约/开工/投产的项目已经选定城市，不再做招引结论 ----
  const dealStage: DealStage = signal.dealStage ?? "intent";
  const landed = isLandedStage(dealStage);
  const landedCity = (signal.landedCity ?? "").trim();
  let hardBlocked = industryBlocked;
  let verdict: string;
  if (landed) {
    verdict = "已落地 · 看配套/二期";
    hardBlocked = false; // 已落地不是产业不匹配，是阶段不适用招引评分
    gaps.unshift(
      landedCity !== ""
        ? `项目${DEAL_STAGE_LABELS[dealStage]}、落地城市已定为${landedCity}，本评分仅作参考，不再对任何城市给出「建议引进」结论`
        : `项目${DEAL_STAGE_LABELS[dealStage]}、落地城市已定，本评分仅作参考，不再对任何城市给出「建议引进」结论`,
    );
    reasons.length = 0;
    reasons.push("对其他城市的直接招引窗口已关闭，跟进价值在配套招商、以商招商与二期扩产");
  } else {
    verdict =
      total >= 80
        ? "建议引进"
        : total >= 65
          ? "重点跟进"
          : total >= 50
            ? "观望"
            : "暂不建议";
    if (industryBlocked) {
      // 硬过滤：产业不在该城市主导目录内，直接不建议，不进正常结论档位
      verdict = "暂不建议";
    }
  }

  return {
    city: profile.city,
    total,
    verdict,
    hardBlocked,
    dealStage,
    isLanded: landed,
    landedCity,
    parts: {
      industryFit,
      scale,
      chain,
      carrier,
      policy: policyScore,
      risk,
    },
    reasons,
    gaps,
    matchedPolicies,
  };
}

export function parseIndustries(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
