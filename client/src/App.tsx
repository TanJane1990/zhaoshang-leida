// 招商雷达 — 移动优先的招商工作台。
// 五个 Tab：雷达（发现+待核实，确认后信号去「项目」当线索）、比选（多城市落地评分对比）、
// 项目（线索+跟进管道）、政策（结构化政策库）、我的（城市档案+刷新记录）。

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim } from "@hatch/space-sdk/client";
import { api, type ApiResponse } from "./api";

type Signal = ApiResponse<typeof api, "listSignals">["signals"][number];
type Assessment = ApiResponse<typeof api, "getSignalAssessment">;
type CityScore = Assessment["scores"][number];
type Policy = ApiResponse<typeof api, "listPolicies">["policies"][number];
type Project = ApiResponse<typeof api, "listProjects">["projects"][number];
type Lead = ApiResponse<typeof api, "listProjects">["leads"][number];
type CityProfile = ApiResponse<typeof api, "listCityProfiles">["cities"][number];
type Report = ApiResponse<typeof api, "getReport">;
type Contact = ApiResponse<typeof api, "listSignalContacts">["contacts"][number];

const INDUSTRIES = [
  "新能源汽车", "集成电路", "生物医药", "电子信息", "数字经济", "新材料",
  "装备制造", "动力电池", "人工智能", "软件", "物联网", "智能家电", "石化", "纳米技术", "汽车零部件",
];
const SIGNAL_TYPES = [
  "拿地", "环评公示", "项目备案", "施工许可", "建厂招标", "增资扩产",
  "新设子公司", "签约落户", "投产", "定增募投", "互动易问答", "调研纪要",
  "在建工程", "招聘扩张", "专利产业化", "融资", "战略合作", "其他",
];
const COST_LEVELS = ["", "低", "中", "中高", "高"];
const STAGES: Array<{ key: string; label: string }> = [
  { key: "lead", label: "线索" },
  { key: "talking", label: "洽谈" },
  { key: "signed", label: "签约" },
  { key: "landed", label: "落地" },
  { key: "producing", label: "投产" },
  { key: "dropped", label: "搁置" },
];
const FOLLOWUP_KINDS = ["跟进", "拜访", "电话", "会议", "材料", "考察"];

function stageLabel(key: string): string {
  return STAGES.find((s) => s.key === key)?.label ?? key;
}

// 城市规范名以城市档案为准（上海 / 苏州 / … / 宣城市），与服务端 normalizeCityName
// 同一套规则：简称「宣城」并入规范名「宣城市」；全称「上海市 / 宁波市」去掉末尾
// 的「市」对齐档案名。筛选标签、政策徽章、比选都只出现一个城市名。
function normalizeCityName(raw: string): string {
  const t = (raw ?? "").trim();
  if (t === "宣城市") return t;
  if (t === "宣城") return "宣城市";
  if (t.length > 1 && t.endsWith("市")) {
    const stripped = t.slice(0, -1);
    return stripped === "宣城" ? "宣城市" : stripped;
  }
  return t;
}

// 信号所处阶段：签约之前可招引，签约及之后已落地、只剩配套与二期价值
const DEAL_STAGES: Array<{ key: string; label: string }> = [
  { key: "intent", label: "意向" },
  { key: "negotiating", label: "洽谈" },
  { key: "signed", label: "已签约" },
  { key: "building", label: "已开工" },
  { key: "producing", label: "已投产" },
];

function DealStageBadge({
  signal,
}: {
  signal: { isLanded: boolean; dealStageLabel: string; landedCity: string };
}) {
  if (signal.isLanded) {
    return (
      <span className="inline-block rounded-md bg-[var(--warn)] px-2 py-0.5 text-xs font-semibold text-white">
        {signal.dealStageLabel}
        {signal.landedCity ? ` · ${signal.landedCity}已定` : ""}
      </span>
    );
  }
  return (
    <span className="inline-block rounded-md bg-[var(--good)] px-2 py-0.5 text-xs font-semibold text-white">
      {signal.dealStageLabel} · 可招引
    </span>
  );
}

function scoreColor(score: number): string {
  if (score >= 80) return "var(--good)";
  if (score >= 60) return "var(--warn)";
  return "var(--bad)";
}

function verdictColor(verdict: string): string {
  if (verdict === "建议引进") return "var(--good)";
  if (verdict === "重点跟进") return "var(--accent)";
  if (verdict === "观望") return "var(--warn)";
  if (verdict.startsWith("已落地")) return "var(--warn)";
  return "var(--bad)";
}

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries();
  };
}

// ---------- 小组件 ----------

function ScoreRing({ score, size = 58 }: { score: number; size?: number }) {
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const filled = (Math.max(0, Math.min(100, score)) / 100) * c;
  const color = scoreColor(score);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-label={`落地评分 ${score} 分`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth="5" />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={`${filled} ${c}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-lg font-bold leading-none" style={{ color }}>{score}</span>
        <span className="text-[10px] leading-tight text-[var(--dim)]">落地分</span>
      </div>
    </div>
  );
}

function VerdictPill({ verdict }: { verdict: string }) {
  if (!verdict) return null;
  const color = verdictColor(verdict);
  return (
    <span
      className="inline-block rounded-full px-2 py-0.5 text-xs font-semibold"
      style={{ color, backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {verdict}
    </span>
  );
}

function PartBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = Math.round((value / max) * 100);
  const color = pct >= 75 ? "var(--good)" : pct >= 45 ? "var(--warn)" : "var(--bad)";
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-sm text-[var(--dim)]">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums">
        {value}<span className="text-[var(--dim)]">/{max}</span>
      </span>
    </div>
  );
}

function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block rounded-md bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--dim)]">
      {children}
    </span>
  );
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 px-safe sm:items-center" role="dialog" aria-label={title}>
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-3xl bg-[var(--surface)] p-5 pb-safe-offset-5 sm:rounded-3xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-bold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="关闭" className="rounded-full bg-[var(--surface-2)] px-3 py-1 text-sm">
            关闭
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-[var(--dim)]">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]";
const btnPrimary =
  "rounded-xl bg-[var(--accent)] px-4 py-2.5 text-base font-semibold text-white disabled:opacity-50";
const btnGhost =
  "rounded-xl border border-[var(--border)] px-4 py-2.5 text-base font-medium text-[var(--text)] disabled:opacity-50";
const btnNavy =
  "rounded-xl bg-[var(--navy)] px-4 py-2.5 text-base font-semibold text-white disabled:opacity-50";

function TagInput({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !values.includes(v)) onChange([...values, v]);
    setDraft("");
  };
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-[var(--dim)]">{label}</span>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {values.map((v) => (
          <button
            key={v}
            type="button"
            aria-label={`移除 ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-sm"
          >
            {v} ✕
          </button>
        ))}
        {values.length === 0 && <span className="text-sm text-[var(--dim)]">未填写</span>}
      </div>
      <div className="flex gap-2">
        <input
          aria-label={label}
          className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" onClick={add} className={btnGhost} aria-label={`添加${label}`}>
          添加
        </button>
      </div>
    </div>
  );
}

// ---------- 信号卡片 ----------

function SignalCard({
  signal,
  onOpen,
  children,
}: {
  signal: Signal;
  onOpen: () => void;
  children?: ReactNode;
}) {
  const landed = signal.isLanded;
  return (
    <article
      className={`rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm ${landed ? "opacity-80" : ""}`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="block w-full text-left"
        aria-label={
          landed
            ? `查看 ${signal.company} 的配套与二期机会（已${signal.dealStageLabel}）`
            : `查看 ${signal.company} 的落地评估`
        }
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-lg font-bold">{signal.company}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <DealStageBadge signal={signal} />
              {signal.industry && <Chip>{signal.industry}</Chip>}
              <Chip>{signal.signalType}</Chip>
              {signal.targetRegion && <Chip>{signal.targetRegion}</Chip>}
              {signal.sourceName && <Chip>来源：{signal.sourceName}</Chip>}
              {signal.contactCount > 0 && <Chip>联系方式 {signal.contactCount} 条</Chip>}
              {signal.status === "converted" && <Chip>已转项目</Chip>}
            </div>
            {signal.summary && (
              <p className="mt-2 line-clamp-2 text-sm leading-relaxed text-[var(--dim)]">{signal.summary}</p>
            )}
            {landed ? (
              <div className="mt-2 space-y-1 text-sm">
                <p className="leading-relaxed text-[var(--dim)]">
                  落地城市已定{signal.landedCity ? `（${signal.landedCity}）` : ""}，不再跨市推荐。
                  <span className="font-medium text-[var(--text)]">跟进价值：配套招商 · 以商招商 · 二期扩产</span>
                </p>
                {signal.investmentText && (
                  <span className="font-semibold text-[var(--text)]">{signal.investmentText}</span>
                )}
              </div>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                {signal.investmentText && (
                  <span className="font-semibold text-[var(--text)]">{signal.investmentText}</span>
                )}
                {signal.bestCity && (
                  <span className="text-[var(--dim)]">
                    最佳落地：<span className="font-medium text-[var(--text)]">{signal.bestCity}</span>
                  </span>
                )}
                <VerdictPill verdict={signal.verdict} />
              </div>
            )}
          </div>
          {landed ? (
            <div
              className="flex shrink-0 flex-col items-center justify-center rounded-full border-2 border-dashed border-[var(--warn)] px-2 text-center"
              style={{ width: 58, height: 58 }}
              aria-label={`项目${signal.dealStageLabel}，落地城市已定`}
            >
              <span className="text-sm font-bold leading-tight text-[var(--warn)]">{signal.dealStageLabel}</span>
              <span className="text-[10px] leading-tight text-[var(--dim)]">不招引</span>
            </div>
          ) : (
            <ScoreRing score={signal.bestScore} />
          )}
        </div>
      </button>
      {children}
    </article>
  );
}

// ---------- 删除信号（二次确认；已转项目的会被服务端拦下） ----------

type DeletableSignal = {
  id: number;
  company: string;
  signalType: string;
  summary: string;
  status: string;
};

function DeleteSignalControl({
  signal,
  compact = false,
  onDeleted,
}: {
  signal: DeletableSignal;
  compact?: boolean;
  onDeleted?: () => void;
}) {
  const refreshAll = useRefreshAll();
  const [open, setOpen] = useState(false);
  const [blockedMsg, setBlockedMsg] = useState("");
  const isConverted = signal.status === "converted";
  const del = useMutation({
    mutationFn: () => api.deleteSignal({ id: signal.id }),
    onSuccess: (r) => {
      if (r.deleted) {
        setOpen(false);
        refreshAll();
        onDeleted?.();
      } else {
        setBlockedMsg(r.reason || "这条信号暂时不能删除。");
      }
    },
    onError: (e) => setBlockedMsg(`删除失败：${String(e)}`),
  });

  return (
    <>
      <button
        type="button"
        className={
          compact
            ? "shrink-0 text-sm font-medium text-[var(--bad)]"
            : "rounded-xl border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--bad)] disabled:opacity-50"
        }
        onClick={() => {
          setBlockedMsg("");
          setOpen(true);
        }}
        aria-label={`删除信号 ${signal.company}`}
      >
        删除
      </button>
      {open && (
        <Modal title="删除这条信号？" onClose={() => setOpen(false)}>
          <div className="space-y-3">
            <div>
              <p className="font-bold leading-snug">{signal.company}</p>
              <p className="mt-0.5 text-sm text-[var(--dim)]">{signal.signalType}</p>
              {signal.summary && (
                <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-[var(--dim)]">{signal.summary}</p>
              )}
            </div>
            {isConverted ? (
              <p className="rounded-xl bg-[var(--surface-2)] p-3 text-sm leading-relaxed">
                这条信号已经转成项目在跟进，不能直接删除，否则项目会失去来源记录。项目本身不受影响，请到「项目」里继续跟进或改为搁置；信号会保留并标注「已转项目」。
              </p>
            ) : blockedMsg ? (
              <p className="rounded-xl bg-[var(--surface-2)] p-3 text-sm leading-relaxed text-[var(--bad)]">{blockedMsg}</p>
            ) : (
              <p className="text-sm leading-relaxed text-[var(--dim)]">
                删除后不可恢复：这条信号会从项目线索中彻底移除，落地评分、报告与线索跟进记录也将无法再打开。只是暂时用不上时，把阶段改为「搁置」更稳妥。
              </p>
            )}
            <div className="flex gap-2">
              <button type="button" className={btnGhost + " flex-1"} onClick={() => setOpen(false)} aria-label="取消删除">
                {isConverted ? "知道了" : "取消"}
              </button>
              {!isConverted && (
                <button
                  type="button"
                  className="flex-1 rounded-xl bg-[var(--bad)] px-4 py-2.5 font-semibold text-white disabled:opacity-50"
                  disabled={del.isPending || blockedMsg !== ""}
                  onClick={() => del.mutate()}
                  aria-label={`确认删除信号 ${signal.company}`}
                >
                  {del.isPending ? "删除中…" : "确认删除"}
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

// ---------- 回到顶部（仅雷达页）：页首滚出视口后出现在右下角 ----------
// 显隐由 RadarView 里的多路信号驱动（滚动容器 scroll 监听 + document 捕获
// 阶段 scroll 监听 + IntersectionObserver 哨兵，见 RadarView 注释）。位置：
// 底部导航上方（bottom 5.25rem + mb-safe 避开安全区），宽屏（≥900px）时落在
// 内容列右侧的留白里（用户标注的位置），窄屏在右下角 right-4 + mr-safe；
// 44px 小圆钮，尽量不压信号卡片的操作区。

function BackToTopButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  if (!visible) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="一键回到页面顶部"
      className="no-print fixed bottom-[5.25rem] right-4 z-20 mb-safe mr-safe flex h-11 w-11 flex-col items-center justify-center rounded-full bg-[var(--navy)] text-white shadow-lg ring-1 ring-white/25 min-[900px]:right-[calc((100vw-48rem)/2-3.5rem)]"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 19V5M5 12l7-7 7 7" />
      </svg>
      <span className="text-[9px] font-medium leading-none">顶部</span>
    </button>
  );
}

// ---------- 雷达 Tab ----------

function RadarView({
  onOpenSignal,
  onGoProjects,
}: {
  onOpenSignal: (id: number) => void;
  onGoProjects: () => void;
}) {
  const refreshAll = useRefreshAll();
  const [refreshMsg, setRefreshMsg] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [justConfirmedId, setJustConfirmedId] = useState<number | null>(null);
  // 回到顶部显隐（多路信号，任一路判定「已离顶」就显示）：
  // 真正的滚动容器是 SDK 根节点 [data-generated-space-root]（position:fixed +
  // overflow:auto），window 本身不滚动：window.scrollY 恒为 0、window 的 scroll
  // 事件也不触发。旧实现只靠 IntersectionObserver，还附加了「哨兵的
  // boundingClientRect.top < 0」才显示——那个坐标是 iframe 内部坐标，壳层在
  // 外层滚动页面时它不变，IO 即使报了哨兵不可见也被这个条件挡掉，按钮在真机
  // 上永远不出现。现在三路并行：
  // ① 直接在真正的滚动容器上挂 scroll 监听，读它的 scrollTop；
  // ② document 捕获阶段的 scroll 监听，兜住任何祖先容器的滚动；
  // ③ IntersectionObserver 盯哨兵，只看 isIntersecting（外层滚动时哨兵被顶层
  //    视口裁掉同样报不可见），不再附加 iframe 内部坐标条件。
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const sentinelGoneRef = useRef(false);
  const [showBackTop, setShowBackTop] = useState(false);
  useEffect(() => {
    const sentinel = topSentinelRef.current;
    if (!sentinel) return;
    // 找真正的滚动容器：从哨兵向上第一个 overflow-y 可滚动的祖先（即 SDK 的
    // [data-generated-space-root]）；找不到退到文档滚动根。
    const findScroller = (): HTMLElement => {
      let node: HTMLElement | null = sentinel.parentElement;
      while (node && node !== document.body) {
        const oy = window.getComputedStyle(node).overflowY;
        if (oy === "auto" || oy === "scroll" || oy === "overlay") return node;
        node = node.parentElement;
      }
      return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
    };
    const scroller = findScroller();
    scrollerRef.current = scroller;
    const update = () => {
      const st = Math.max(scroller.scrollTop ?? 0, window.scrollY ?? 0);
      const rectTop = sentinel.getBoundingClientRect().top;
      setShowBackTop(st > 24 || rectTop < -8 || sentinelGoneRef.current);
    };
    update();
    scroller.addEventListener("scroll", update, { passive: true });
    document.addEventListener("scroll", update, { capture: true, passive: true });
    let io: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver(
        (entries) => {
          const e = entries[0];
          if (!e) return;
          sentinelGoneRef.current = !e.isIntersecting;
          update();
        },
        { threshold: 0 },
      );
      io.observe(sentinel);
    }
    return () => {
      scroller.removeEventListener("scroll", update);
      document.removeEventListener("scroll", update, { capture: true });
      io?.disconnect();
    };
  }, []);
  const scrollToTop = () => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const behavior: ScrollBehavior = reduceMotion ? "auto" : "smooth";
    // 顺序有讲究：scrollIntoView 只把哨兵对齐到视口顶部，停的位置是哨兵在内容
    // 里的偏移量（页首留白，约 32px）而不是 scrollTop=0，而且同容器的平滑滚动
    // 后发覆盖先发——所以让滚动容器的 scrollTo({top: 0}) 最后发、说了算；
    // window.scrollTo 与 scrollIntoView 先行，覆盖文档滚动 / 外层壳层滚动的环境。
    window.scrollTo({ top: 0, behavior });
    topSentinelRef.current?.scrollIntoView({ behavior });
    scrollerRef.current?.scrollTo({ top: 0, behavior });
  };

  const overview = useQuery({ queryKey: ["overview"], queryFn: () => api.getOverview({}) });
  const all = useQuery({
    queryKey: ["signals", "all"],
    queryFn: () => api.listSignals({ status: "all", limit: 100 }),
  });

  const refresh = useMutation({
    mutationFn: () => api.refreshSignals({ trigger: "manual" }),
    onSuccess: (r) => setRefreshMsg(r.message),
    onError: (e) => setRefreshMsg(`刷新失败：${String(e)}`),
  });
  const setStatus = useMutation({
    mutationFn: (args: { id: number; status: "confirmed" | "dismissed" | "pending" }) =>
      api.setSignalStatus(args),
    onSuccess: (_data, vars) => {
      // 确认成功后给一个明确去向：这条信号已经成为「项目」里的线索
      if (vars.status === "confirmed") setJustConfirmedId(vars.id);
      refreshAll();
    },
  });

  const signals = all.data?.signals ?? [];
  const pending = signals.filter((s) => s.status === "pending");
  const dismissed = signals.filter((s) => s.status === "dismissed");
  const justConfirmed =
    justConfirmedId != null
      ? signals.find((s) => s.id === justConfirmedId && s.status === "confirmed")
      : undefined;
  const ov = overview.data;
  const today = new Date();
  const dateStr = `${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`;

  return (
    <div className="space-y-4">
      <div ref={topSentinelRef} aria-hidden="true" className="h-0" />
      {/* 头部仪表 */}
      <section className="rounded-[var(--radius)] bg-[var(--navy)] p-5 text-white">
        <div className="flex items-baseline justify-between">
          <p className="text-sm opacity-80">{dateStr}</p>
          {ov?.lastRun && (
            <p className="text-xs opacity-70">
              上次刷新 {fmtDateTime(ov.lastRun.createdAt)} · 新增 {ov.lastRun.addedCount} 条
            </p>
          )}
        </div>
        <div className="mt-4 grid grid-cols-4 gap-2 text-center">
          <div>
            <p className="text-3xl font-bold tabular-nums">{ov?.pendingCount ?? "–"}</p>
            <p className="mt-1 text-xs opacity-80">待核实</p>
          </div>
          <div>
            <p className="text-3xl font-bold tabular-nums">{ov?.confirmedCount ?? "–"}</p>
            <p className="mt-1 text-xs opacity-80">项目线索</p>
          </div>
          <div>
            <p className="text-3xl font-bold tabular-nums">{ov?.activeProjectCount ?? "–"}</p>
            <p className="mt-1 text-xs opacity-80">跟进中</p>
          </div>
          <div>
            <p className="text-3xl font-bold tabular-nums">{ov?.landedCount ?? "–"}</p>
            <p className="mt-1 text-xs opacity-80">已落地</p>
          </div>
        </div>
        {ov && (
          <p className="mt-3 text-sm leading-relaxed text-white/90">
            雷达只做发现与核实：确认后的信号直接成为「项目」里的线索——可招引（意向/洽谈）
            <span className="font-bold text-white"> {ov.recruitableCount}</span> 条排在线索阶段；
            已落地（已签约/开工/投产）<span className="font-bold text-white">{ov.landedSignalCount}</span> 条
            在签约 / 落地 / 投产位置，只推配套与二期。
          </p>
        )}
        {ov && (
          <p className="mt-2 text-sm leading-relaxed text-white/90">
            待核实的可招引 <span className="font-bold text-white">{ov.pendingRecruitableCount} 条</span>
            ——还在下方待核实列表里（意向/洽谈、尚未确认），确认后即成为线索；最佳信号只从已确认线索里选，
            线索暂时为 0 时最佳信号为空是口径如此，不是没抓到可招引的。
          </p>
        )}
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-2.5 font-semibold text-white disabled:opacity-60"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
            aria-label="刷新雷达，搜索最新投资信号"
          >
            {refresh.isPending ? "正在启动…" : "↻ 全量刷新（13 路）"}
          </button>
          <button
            type="button"
            className="rounded-xl bg-white/15 px-4 py-2.5 font-medium text-white"
            onClick={() => setShowAdd(true)}
            aria-label="手工录入一条投资信号"
          >
            + 录入信号
          </button>
        </div>
        {refreshMsg && <p className="mt-3 text-sm leading-relaxed text-white/90">{refreshMsg}</p>}
      </section>

      {/* 去项目线索入口：已确认信号不在雷达停留，直接在「项目」里当线索跟进 */}
      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm" aria-label="项目线索入口">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-bold">已确认的信号在「项目 · 线索」里</h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
              {ov
                ? `当前线索 ${ov.confirmedCount} 条（可招引 ${ov.recruitableCount} · 已落地 ${ov.landedSignalCount}），跟进中项目 ${ov.activeProjectCount} 个。搜索、评分、跟进与阶段推进都在项目页完成。`
                : "搜索、评分、跟进与阶段推进都在项目页完成。"}
            </p>
          </div>
          <button
            type="button"
            className={btnNavy + " shrink-0"}
            onClick={onGoProjects}
            aria-label="去项目页查看线索"
          >
            去项目看线索 →
          </button>
        </div>
        {justConfirmed && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--surface-2)] p-3">
            <p className="min-w-0 flex-1 text-sm leading-relaxed">
              已确认「<span className="font-semibold">{justConfirmed.company}</span>」，
              {justConfirmed.isLanded
                ? `它已${justConfirmed.dealStageLabel}，已放进「项目」对应阶段，只做配套与二期跟进。`
                : "它已成为「项目」里的线索（管道第一阶段），可直接跟进、推进阶段。"}
            </p>
            <button
              type="button"
              className="shrink-0 rounded-lg bg-[var(--navy)] px-3 py-1.5 text-sm font-semibold text-white"
              onClick={onGoProjects}
              aria-label={`去项目页跟进 ${justConfirmed.company}`}
            >
              去跟进 →
            </button>
            <button
              type="button"
              className="shrink-0 text-sm text-[var(--dim)] underline"
              onClick={() => setJustConfirmedId(null)}
              aria-label="关闭确认提示"
            >
              留在雷达
            </button>
          </div>
        )}
      </section>

      {/* 待核实 */}
      {pending.length > 0 && (
        <section aria-label="待核实信号">
          <h2 className="mb-2 text-base font-bold">
            待核实 <span className="text-[var(--warn)]">{pending.length}</span>
            <span className="ml-2 text-sm font-normal text-[var(--dim)]">
              其中可招引（意向/洽谈）{pending.filter((s) => !s.isLanded).length} 条；确认后成为「项目」里的线索，在项目页跟进推进
            </span>
          </h2>
          <div className="space-y-3">
            {pending.map((s) => (
              <SignalCard key={s.id} signal={s} onOpen={() => onOpenSignal(s.id)}>
                <div className="mt-3 flex gap-2 border-t border-[var(--border)] pt-3">
                  <button
                    type="button"
                    className="flex-1 rounded-xl bg-[var(--good)] px-3 py-2 font-semibold text-white disabled:opacity-50"
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: s.id, status: "confirmed" })}
                    aria-label={`确认信号 ${s.company}`}
                  >
                    {s.isLanded ? "确认（转配套/二期）" : "确认信号"}
                  </button>
                  <button
                    type="button"
                    className={btnGhost + " flex-1"}
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: s.id, status: "dismissed" })}
                    aria-label={`忽略信号 ${s.company}`}
                  >
                    忽略
                  </button>
                  {s.sourceUrl && (
                    <a
                      href={s.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={btnGhost}
                      aria-label={`查看 ${s.company} 的来源原文`}
                    >
                      原文
                    </a>
                  )}
                </div>
              </SignalCard>
            ))}
          </div>
        </section>
      )}

      {all.isPending && <p className="text-[var(--dim)]">正在加载…</p>}
      {all.error && <p className="text-[var(--bad)]">加载失败：{String(all.error)}</p>}
      {all.data && pending.length === 0 && (
        <section className="rounded-[var(--radius)] bg-[var(--surface)] p-5 text-center shadow-sm" aria-label="待核实信号">
          <p className="font-medium">暂无待核实信号</p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            点上方「全量刷新（13 路）」，系统会同时去财经新闻、企业官网、上市公司公告、政府新闻、招投标、土地出让、园区官网、招商平台、股市聚合、融资、招聘、专利、环评公示搜索长三角最新的企业投资、扩产、建厂、拿地消息，
            找到的候选先到这里核实，确认后直接成为「项目」里的线索；也可以点「+ 录入信号」手工录入线下获知的信号。
          </p>
        </section>
      )}

      {/* 管道总览（精简）：完整管道与推进都在「项目」页，这里只给一眼概览 */}
      {ov && (
        <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm" aria-label="项目管道总览">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold">项目管道</h2>
            <button
              type="button"
              className="text-sm font-medium text-[var(--accent)]"
              onClick={onGoProjects}
              aria-label="去项目页查看完整管道"
            >
              去项目页推进 →
            </button>
          </div>
          <div className="mt-3 space-y-1.5">
            {ov.stageCounts.map((sc) => {
              const max = Math.max(1, ...ov.stageCounts.map((x) => x.count));
              return (
                <div key={sc.stage} className="flex items-center gap-2">
                  <span className="w-10 shrink-0 text-sm text-[var(--dim)]">{stageLabel(sc.stage)}</span>
                  <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                    <div
                      className="h-full rounded-full bg-[var(--navy)]"
                      style={{ width: `${Math.round((sc.count / max) * 100)}%` }}
                    />
                  </div>
                  <span className="w-8 shrink-0 text-right text-sm font-semibold tabular-nums">{sc.count}</span>
                </div>
              );
            })}
          </div>
          {ov.dueToday.length > 0 && (
            <p className="mt-3 border-t border-[var(--border)] pt-3 text-sm leading-relaxed text-[var(--dim)]">
              今日待办 <span className="font-semibold text-[var(--warn)]">{ov.dueToday.length}</span> 项：
              {ov.dueToday.slice(0, 2).map((p) => p.company).join("、")}
              {ov.dueToday.length > 2 ? " 等" : ""}，到「项目」页打开处理。
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--border)] pt-3 text-sm text-[var(--dim)]">
            <span>
              政策库 <span className="font-semibold text-[var(--text)]">{ov.policyCount}</span> 条
            </span>
            <span>
              城市成本档位已补全{" "}
              <span className="font-semibold text-[var(--text)]">
                {ov.cityCostComplete}/{ov.cityTotal}
              </span>
            </span>
            {ov.industryCounts.length > 0 && (
              <span>
                信号集中的产业：
                {ov.industryCounts
                  .slice(0, 3)
                  .map((x) => `${x.industry} ${x.count}`)
                  .join(" · ")}
              </span>
            )}
          </div>
        </section>
      )}

      {/* 已忽略 */}
      {dismissed.length > 0 && (
        <section aria-label="已忽略的信号">
          <button
            type="button"
            className="text-sm text-[var(--dim)] underline"
            onClick={() => setShowDismissed((v) => !v)}
            aria-expanded={showDismissed}
          >
            {showDismissed ? "收起" : "查看"}已忽略的信号（{dismissed.length}）
          </button>
          {showDismissed && (
            <div className="mt-2 space-y-2">
              {dismissed.map((s) => (
                <div key={s.id} className="flex items-center justify-between rounded-xl bg-[var(--surface)] p-3 shadow-sm">
                  <span className="min-w-0 truncate text-sm">
                    {s.company} <span className="text-[var(--dim)]">· {s.signalType}</span>
                  </span>
                  <span className="ml-2 flex shrink-0 items-center gap-3">
                    <button
                      type="button"
                      className="text-sm font-medium text-[var(--accent)]"
                      onClick={() => setStatus.mutate({ id: s.id, status: "confirmed" })}
                      aria-label={`恢复信号 ${s.company}`}
                    >
                      恢复
                    </button>
                    <DeleteSignalControl signal={s} compact />
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {showAdd && <AddSignalForm onClose={() => setShowAdd(false)} />}
      <BackToTopButton visible={showBackTop} onClick={scrollToTop} />
    </div>
  );
}

function AddSignalForm({ onClose }: { onClose: () => void }) {
  const refreshAll = useRefreshAll();
  const [company, setCompany] = useState("");
  const [industry, setIndustry] = useState("");
  const [signalType, setSignalType] = useState("其他");
  const [targetRegion, setTargetRegion] = useState("长三角");
  const [investmentText, setInvestmentText] = useState("");
  const [investmentYi, setInvestmentYi] = useState("");
  const [summary, setSummary] = useState("");
  const [dealStage, setDealStage] = useState("intent");
  const [landedCity, setLandedCity] = useState("");
  const [err, setErr] = useState("");
  const isLandedPick = dealStage === "signed" || dealStage === "building" || dealStage === "producing";

  const add = useMutation({
    mutationFn: () =>
      api.addSignal({
        company: company.trim(),
        industry,
        signalType,
        targetRegion: targetRegion.trim(),
        investmentText: investmentText.trim(),
        investmentYi: investmentYi.trim() === "" ? null : Number(investmentYi),
        summary: summary.trim(),
        sourceName: "手工录入",
        dealStage: dealStage as "intent" | "negotiating" | "signed" | "building" | "producing",
        landedCity: isLandedPick ? landedCity.trim() : "",
      }),
    onSuccess: () => {
      refreshAll();
      onClose();
    },
    onError: (e) => setErr(String(e)),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!company.trim()) {
      setErr("请填写企业名称");
      return;
    }
    if (investmentYi.trim() !== "" && Number.isNaN(Number(investmentYi))) {
      setErr("投资额（亿元）请填数字，或留空");
      return;
    }
    add.mutate();
  };

  return (
    <Modal title="录入投资信号" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="企业名称 *">
          <input aria-label="企业名称" className={inputCls} value={company} onChange={(e) => setCompany(e.target.value)} placeholder="如：某某新能源科技有限公司" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="所属产业">
            <select aria-label="所属产业" className={inputCls} value={industry} onChange={(e) => setIndustry(e.target.value)}>
              <option value="">未分类</option>
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </Field>
          <Field label="信号类型">
            <select aria-label="信号类型" className={inputCls} value={signalType} onChange={(e) => setSignalType(e.target.value)}>
              {SIGNAL_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="意向区域">
            <input aria-label="意向区域" className={inputCls} value={targetRegion} onChange={(e) => setTargetRegion(e.target.value)} />
          </Field>
          <Field label="投资额（亿元）">
            <input aria-label="投资额（亿元）" className={inputCls} inputMode="decimal" value={investmentYi} onChange={(e) => setInvestmentYi(e.target.value)} placeholder="不确定可留空" />
          </Field>
        </div>
        <Field label="投资额原文">
          <input aria-label="投资额原文" className={inputCls} value={investmentText} onChange={(e) => setInvestmentText(e.target.value)} placeholder="如：总投资50亿元" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="项目阶段">
            <select aria-label="项目阶段" className={inputCls} value={dealStage} onChange={(e) => setDealStage(e.target.value)}>
              {DEAL_STAGES.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </select>
          </Field>
          <Field label="已落地城市（已签约后填）">
            <input aria-label="已落地城市" className={inputCls} value={landedCity} onChange={(e) => setLandedCity(e.target.value)} placeholder="如：无锡" disabled={!isLandedPick} />
          </Field>
        </div>
        <p className="text-xs leading-relaxed text-[var(--dim)]">
          选「已签约 / 已开工 / 已投产」后，这条信号会被降级为配套/二期跟进，不再参与跨市落地推荐。
        </p>
        <Field label="一句话说明">
          <textarea aria-label="一句话说明" className={inputCls} rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="从哪里获知、企业想做什么" />
        </Field>
        {err && <p className="text-sm text-[var(--bad)]">{err}</p>}
        <button type="submit" className={btnPrimary + " w-full"} disabled={add.isPending}>
          {add.isPending ? "保存中…" : "保存并成为项目线索"}
        </button>
      </form>
    </Modal>
  );
}

// ---------- 企业联系方式（只收对公公开渠道） ----------

const CONTACT_LABELS = [
  "董事会秘书", "证券部", "投资者关系", "总机", "投资部", "招商/政府事务",
  "招标联系人", "环评公示联系人", "对公联系方式",
];
const CONTACT_SOURCE_TYPES = [
  "企业官网", "年报公告董秘", "交易所公告", "招标公告", "环评公示", "政府公示", "手工录入", "其他公开来源",
];

function verifyStatusMeta(status: string): { label: string; cls: string } {
  if (status === "verified") return { label: "已核实", cls: "bg-[var(--good)] text-white" };
  if (status === "stale") return { label: "已过期", cls: "bg-[var(--bad)] text-white" };
  return { label: "待核实", cls: "bg-[var(--warn)] text-white" };
}

function ContactForm({
  signalId,
  contact,
  onClose,
}: {
  signalId: number;
  contact: Contact | null;
  onClose: () => void;
}) {
  const refreshAll = useRefreshAll();
  const [label, setLabel] = useState(contact?.contactLabel ?? "董事会秘书");
  const [name, setName] = useState(contact?.contactName ?? "");
  const [title, setTitle] = useState(contact?.contactTitle ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [address, setAddress] = useState(contact?.address ?? "");
  const [sourceName, setSourceName] = useState(contact?.sourceName ?? "");
  const [sourceUrl, setSourceUrl] = useState(contact?.sourceUrl ?? "");
  const [sourceType, setSourceType] = useState(contact?.sourceType ?? "手工录入");
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.upsertContact({
        id: contact?.id ?? null,
        signalId,
        contactLabel: label.trim(),
        contactName: name.trim(),
        contactTitle: title.trim(),
        phone: phone.trim(),
        email: email.trim(),
        address: address.trim(),
        sourceName: sourceName.trim(),
        sourceUrl: sourceUrl.trim(),
        sourceType,
      }),
    onSuccess: (r) => {
      if (r.ok) {
        refreshAll();
        onClose();
      } else {
        setErr(r.error || "保存失败");
      }
    },
    onError: (e) => setErr(String(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (phone.trim() === "" && email.trim() === "" && address.trim() === "") {
      setErr("电话、邮箱、地址至少填一项");
      return;
    }
    save.mutate();
  };

  return (
    <Modal title={contact ? "编辑联系方式" : "手工补录联系方式"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="rounded-xl bg-[var(--surface-2)] p-3 text-sm leading-relaxed text-[var(--dim)]">
          只补录对公联系方式：企业座机（带区号，可带分机）、400/800 热线、官方域名邮箱。
          个人手机号、私人微信、私人邮箱会被系统拒绝，无法保存。
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Field label="对接入口">
            <input aria-label="对接入口" className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} list="contact-labels" placeholder="如：董事会秘书" />
            <datalist id="contact-labels">
              {CONTACT_LABELS.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </Field>
          <Field label="来源类型">
            <select aria-label="联系方式来源类型" className={inputCls} value={sourceType} onChange={(e) => setSourceType(e.target.value)}>
              {CONTACT_SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="公开姓名（董秘等，可空）">
            <input aria-label="联系人公开姓名" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} placeholder="如：朱才伟" />
          </Field>
          <Field label="职务">
            <input aria-label="联系人职务" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：董事会秘书" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="对公电话">
            <input aria-label="对公电话" className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="如：0551-62637000转612688" />
          </Field>
          <Field label="官方邮箱">
            <input aria-label="官方邮箱" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="如：stock@example.com.cn" />
          </Field>
        </div>
        <Field label="企业地址">
          <input aria-label="企业地址" className={inputCls} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="年报/官网披露的注册或办公地址" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="来源名称">
            <input aria-label="联系方式来源名称" className={inputCls} value={sourceName} onChange={(e) => setSourceName(e.target.value)} placeholder="如：2024 年年度报告" />
          </Field>
          <Field label="来源链接">
            <input aria-label="联系方式来源链接" className={inputCls} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="公开页面链接（可空）" />
          </Field>
        </div>
        {err && <p className="text-sm font-medium text-[var(--bad)]">{err}</p>}
        <button type="submit" className={btnPrimary + " w-full"} disabled={save.isPending}>
          {save.isPending ? "保存中…" : "保存联系方式"}
        </button>
      </form>
    </Modal>
  );
}

function ContactsSection({ signalId, company }: { signalId: number; company: string }) {
  const refreshAll = useRefreshAll();
  const [lookupMsg, setLookupMsg] = useState("");
  const [formContact, setFormContact] = useState<Contact | "new" | null>(null);
  const q = useQuery({
    queryKey: ["contacts", signalId],
    queryFn: () => api.listSignalContacts({ signalId }),
  });
  const lookup = useMutation({
    mutationFn: () => api.lookupSignalContacts({ signalId }),
    onSuccess: (r) => setLookupMsg(r.message),
    onError: (e) => setLookupMsg(`获取失败：${String(e)}`),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.deleteContact({ id }),
    onSuccess: refreshAll,
  });
  const setStatus = useMutation({
    mutationFn: (args: { id: number; verifyStatus: "unverified" | "verified" | "stale" }) =>
      api.setContactVerifyStatus(args),
    onSuccess: refreshAll,
  });
  const contacts = q.data?.contacts ?? [];

  return (
    <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm" aria-label={`${company} 的联系方式`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-bold">联系方式{contacts.length > 0 ? ` · ${contacts.length} 条` : ""}</h3>
        <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--dim)]">仅对公公开渠道</span>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
        只收录企业官网、年报董秘/证券部、交易所公告、招标与环评公示里公开的座机、400/800 热线和官方邮箱；
        个人手机号、私人微信、私人邮箱一律不采集、不入库。号码可能变更，联系前建议先点来源链接核对。
      </p>

      {q.isPending && <p className="mt-3 text-sm text-[var(--dim)]">正在加载联系方式…</p>}
      {q.data && contacts.length === 0 && (
        <p className="mt-3 rounded-xl bg-[var(--surface-2)] p-3 text-sm leading-relaxed">
          还没有这家企业的联系方式。点下方「获取联系方式」，系统会去企业官网、年报与公告里找董秘/证券部、总机等对公入口（约 1–3 分钟）；也可以手工补录线下获知的对公电话。
        </p>
      )}

      <div className="mt-3 space-y-3">
        {contacts.map((c) => {
          const vm = verifyStatusMeta(c.verifyStatus);
          return (
            <article key={c.id} className="rounded-xl border border-[var(--border)] p-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-bold">{c.contactLabel}</span>
                {(c.contactName || c.contactTitle) && (
                  <span className="text-sm text-[var(--dim)]">
                    {c.contactName}{c.contactName && c.contactTitle ? " · " : ""}{c.contactTitle}
                  </span>
                )}
                <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-semibold ${vm.cls}`}>{vm.label}</span>
                {c.isManual && <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs text-[var(--dim)]">手工录入</span>}
              </div>
              <div className="mt-2 space-y-1 text-base">
                {c.phone && (
                  <p>
                    <span className="text-sm text-[var(--dim)]">电话 </span>
                    <a href={`tel:${c.phone.replace(/[^0-9+]/g, "")}`} className="font-semibold text-[var(--accent)]" aria-label={`拨打 ${company} 的电话 ${c.phone}`}>
                      {c.phone}
                    </a>
                  </p>
                )}
                {c.email && (
                  <p>
                    <span className="text-sm text-[var(--dim)]">邮箱 </span>
                    <a href={`mailto:${c.email}`} className="font-medium text-[var(--accent)] break-all" aria-label={`给 ${company} 发邮件 ${c.email}`}>
                      {c.email}
                    </a>
                  </p>
                )}
                {c.address && (
                  <p className="text-sm leading-relaxed">
                    <span className="text-[var(--dim)]">地址 </span>{c.address}
                  </p>
                )}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                来源：{c.sourceType || "公开来源"}{c.sourceName ? ` · ${c.sourceName}` : ""} · 获取于 {fmtDateTime(c.createdAt)}
                {c.sourceUrl && (
                  <>
                    {" · "}
                    <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline" aria-label={`查看 ${company} 联系方式来源`}>
                      查看来源
                    </a>
                  </>
                )}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5 border-t border-[var(--border)] pt-2.5">
                {c.verifyStatus !== "verified" && (
                  <button
                    type="button"
                    className="rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: c.id, verifyStatus: "verified" })}
                    aria-label={`把 ${c.contactLabel} 标记为已核实`}
                  >
                    标已核实
                  </button>
                )}
                {c.verifyStatus !== "stale" && (
                  <button
                    type="button"
                    className="rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: c.id, verifyStatus: "stale" })}
                    aria-label={`把 ${c.contactLabel} 标记为已过期`}
                  >
                    标已过期
                  </button>
                )}
                {c.verifyStatus !== "unverified" && (
                  <button
                    type="button"
                    className="rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: c.id, verifyStatus: "unverified" })}
                    aria-label={`把 ${c.contactLabel} 恢复为待核实`}
                  >
                    恢复待核实
                  </button>
                )}
                <button
                  type="button"
                  className="rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-sm font-medium"
                  onClick={() => setFormContact(c)}
                  aria-label={`编辑 ${c.contactLabel} 联系方式`}
                >
                  编辑
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-[var(--surface-2)] px-3 py-1.5 text-sm font-medium text-[var(--bad)] disabled:opacity-50"
                  disabled={del.isPending}
                  onClick={() => del.mutate(c.id)}
                  aria-label={`删除 ${c.contactLabel} 联系方式`}
                >
                  删除
                </button>
              </div>
            </article>
          );
        })}
      </div>

      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-2.5 font-semibold text-white disabled:opacity-60"
          disabled={lookup.isPending}
          onClick={() => lookup.mutate()}
          aria-label={`获取 ${company} 的公开联系方式`}
        >
          {lookup.isPending ? "正在启动…" : "获取联系方式"}
        </button>
        <button
          type="button"
          className={btnGhost}
          onClick={() => setFormContact("new")}
          aria-label={`手工补录 ${company} 的联系方式`}
        >
          + 手工补录
        </button>
      </div>
      {lookupMsg && <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">{lookupMsg}</p>}
      {formContact && (
        <ContactForm
          signalId={signalId}
          contact={formContact === "new" ? null : formContact}
          onClose={() => setFormContact(null)}
        />
      )}
    </section>
  );
}

// ---------- 信号详情（多城市评估） ----------

function OverlayShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-40 overflow-y-auto bg-[var(--bg)]" role="dialog" aria-label={title}>
      <div className="mx-auto w-full max-w-3xl px-safe-offset-4 pb-safe-offset-10">
        <div className="sticky top-0 z-10 -mx-safe-offset-4 bg-[var(--bg)] px-safe-offset-4 pb-2 pt-safe">
          <div className="flex items-center gap-3 pt-3">
            <button
              type="button"
              onClick={onClose}
              aria-label="返回"
              className="rounded-full bg-[var(--surface)] px-3.5 py-1.5 font-medium shadow-sm"
            >
              ← 返回
            </button>
            <h2 className="truncate text-lg font-bold">{title}</h2>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

function ScoreBreakdown({ score }: { score: CityScore }) {
  return (
    <div className="space-y-2">
      <PartBar label="产业契合" value={score.parts.industryFit} max={30} />
      <PartBar label="投资规模" value={score.parts.scale} max={20} />
      <PartBar label="产业链" value={score.parts.chain} max={15} />
      <PartBar label="用地载体" value={score.parts.carrier} max={15} />
      <PartBar label="政策收益" value={score.parts.policy} max={10} />
      <PartBar label="风险" value={score.parts.risk} max={10} />
    </div>
  );
}

function SignalDetail({
  signalId,
  onClose,
  onReport,
}: {
  signalId: number;
  onClose: () => void;
  onReport: (signalId: number, city: string) => void;
}) {
  const refreshAll = useRefreshAll();
  const [expandedCity, setExpandedCity] = useState("");
  const [stagePick, setStagePick] = useState<string | null>(null);
  const [landedCityPick, setLandedCityPick] = useState<string | null>(null);
  const [fuKind, setFuKind] = useState("跟进");
  const [fuContent, setFuContent] = useState("");
  const [advanceMsg, setAdvanceMsg] = useState("");
  const q = useQuery({
    queryKey: ["assessment", signalId],
    queryFn: () => api.getSignalAssessment({ signalId }),
  });
  const data = q.data;
  const bestCity = data?.scores[0]?.city ?? "";
  const sig = data?.signal;
  const landed = sig?.isLanded ?? false;
  const isLead = sig?.status === "confirmed";
  const leadFollowups = useQuery({
    queryKey: ["signalFollowups", signalId],
    queryFn: () => api.listSignalFollowups({ signalId }),
    enabled: isLead,
  });
  const advanceStage = useMutation({
    mutationFn: (stage: "lead" | "talking" | "signed" | "landed" | "producing" | "dropped") =>
      api.setSignalStage({
        signalId,
        stage,
        // 推进到签约及之后且还没记落地城市时，先按当前最佳落地城市记，后续可在上方阶段修正里改
        landedCity:
          (stage === "signed" || stage === "landed" || stage === "producing") && !sig?.landedCity
            ? bestCity
            : "",
      }),
    onSuccess: (r) => {
      setAdvanceMsg(
        r.pipelineStage === "dropped"
          ? "已搁置：这条线索已移出管道，可在雷达「已忽略的信号」里恢复。"
          : `阶段已更新为「${stageLabel(r.pipelineStage)}」${r.isLanded ? "，按已落地处理，只跟配套与二期" : ""}。`,
      );
      refreshAll();
    },
    onError: (e) => setAdvanceMsg(`阶段更新失败：${String(e)}`),
  });
  const addFu = useMutation({
    mutationFn: () => api.addSignalFollowup({ signalId, kind: fuKind, content: fuContent.trim() }),
    onSuccess: () => {
      setFuContent("");
      refreshAll();
    },
    onError: (e) => setAdvanceMsg(`跟进保存失败：${String(e)}`),
  });
  const setStage = useMutation({
    mutationFn: () =>
      api.setSignalDealStage({
        id: signalId,
        dealStage: (stagePick ?? sig?.dealStage ?? "intent") as
          | "intent"
          | "negotiating"
          | "signed"
          | "building"
          | "producing",
        landedCity: (landedCityPick ?? sig?.landedCity ?? "").trim(),
      }),
    onSuccess: refreshAll,
  });

  return (
    <OverlayShell title={sig ? `${sig.company} · 落地评估` : "落地评估"} onClose={onClose}>
      {q.isPending && <p className="mt-6 text-[var(--dim)]">正在评估各城市落地条件…</p>}
      {q.error && <p className="mt-6 text-[var(--bad)]">评估失败：{String(q.error)}</p>}
      {data && sig && (
        <div className="mt-2 space-y-4">
          <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex flex-wrap items-center gap-1.5">
              <DealStageBadge signal={sig} />
              {sig.industry && <Chip>{sig.industry}</Chip>}
              <Chip>{sig.signalType}</Chip>
              {sig.targetRegion && <Chip>意向：{sig.targetRegion}</Chip>}
              {sig.investmentText && <Chip>{sig.investmentText}</Chip>}
              {sig.reportedDate && <Chip>{sig.reportedDate}</Chip>}
            </div>
            {sig.summary && <p className="mt-3 leading-relaxed">{sig.summary}</p>}
            <p className="mt-3 text-sm text-[var(--dim)]">
              来源：{sig.sourceName || "—"}
              {sig.sourceUrl && (
                <>
                  {" · "}
                  <a href={sig.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">
                    查看原文
                  </a>
                </>
              )}
            </p>
            {landed ? (
              <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                该项目已{ sig.dealStageLabel }、落地城市已定，下面的各城市分数只作参考，不再产生「建议引进 / 重点跟进」结论。
              </p>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-[var(--dim)]">
                评分按既定模型计算：产业契合 30 + 投资规模 20 + 产业链 15 + 用地载体 15 + 政策收益 10 + 风险 10；
                产业不在城市主导目录内属硬过滤，直接判「暂不建议」。政策收益只统计政策库里已录入的条目。
              </p>
            )}
            <div className="mt-3 border-t border-[var(--border)] pt-3">
              <p className="text-sm font-medium text-[var(--dim)]">阶段不对？在这里修正（改成已签约及之后会自动降级）</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <select
                  aria-label="修正项目阶段"
                  className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  value={stagePick ?? sig.dealStage}
                  onChange={(e) => setStagePick(e.target.value)}
                >
                  {DEAL_STAGES.map((s) => (
                    <option key={s.key} value={s.key}>{s.label}</option>
                  ))}
                </select>
                <input
                  aria-label="修正已落地城市"
                  className="w-32 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]"
                  value={landedCityPick ?? sig.landedCity}
                  onChange={(e) => setLandedCityPick(e.target.value)}
                  placeholder="落地城市"
                />
                <button
                  type="button"
                  className={btnGhost}
                  disabled={setStage.isPending}
                  onClick={() => setStage.mutate()}
                  aria-label="保存阶段修正"
                >
                  {setStage.isPending ? "保存中…" : "保存阶段"}
                </button>
              </div>
              {setStage.isSuccess && <p className="mt-1.5 text-sm text-[var(--good)]">阶段已更新。</p>}
              {setStage.error && <p className="mt-1.5 text-sm text-[var(--bad)]">{String(setStage.error)}</p>}
            </div>
          </section>

          <ContactsSection signalId={signalId} company={sig.company} />

          {landed && (
            <section className="rounded-[var(--radius)] border-2 border-[var(--warn)] bg-[var(--surface)] p-4 shadow-sm" aria-label="已落地项目的配套与二期机会">
              <h3 className="font-bold text-[var(--warn)]">
                已落地 · 不再招引 —— 只跟这三件事
              </h3>
              <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
                项目已{sig.dealStageLabel}
                {sig.landedCity ? `，落地 ${sig.landedCity}` : ""}，其他城市再谈引进就是白费功夫。剩下的价值在这里：
              </p>
              <ol className="mt-3 list-inside list-decimal space-y-2 leading-relaxed">
                {sig.opportunities.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ol>
            </section>
          )}

          {landed && (
            <h3 className="text-base font-bold">
              各城市评分（仅参考）<span className="ml-2 text-sm font-normal text-[var(--dim)]">已落地项目不产生招引结论</span>
            </h3>
          )}
          <section className="space-y-3" aria-label="各城市落地评分">
            {data.scores.map((s, idx) => (
              <article key={s.city} className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
                <button
                  type="button"
                  className="block w-full text-left"
                  onClick={() => setExpandedCity(expandedCity === s.city ? "" : s.city)}
                  aria-expanded={expandedCity === s.city}
                  aria-label={`${s.city} 评分 ${s.total} 分，${expandedCity === s.city ? "收起" : "展开"}拆解`}
                >
                  <div className="flex items-center gap-3">
                    <ScoreRing score={s.total} size={52} />
                    <div className="min-w-0 flex-1">
                      <p className="text-lg font-bold">
                        {!landed && idx === 0 && <span className="mr-1.5 rounded bg-[var(--navy)] px-1.5 py-0.5 text-xs font-semibold text-white">最佳</span>}
                        {landed && sig.landedCity === s.city && <span className="mr-1.5 rounded bg-[var(--warn)] px-1.5 py-0.5 text-xs font-semibold text-white">已落地</span>}
                        {s.city}
                      </p>
                      <p className="text-sm text-[var(--dim)]">
                        匹配政策 {s.matchedPolicies.length} 条{s.hardBlocked ? " · 产业不在主导目录" : ""}
                      </p>
                    </div>
                    <VerdictPill verdict={s.verdict} />
                  </div>
                </button>
                {expandedCity === s.city && (
                  <div className="mt-3 space-y-3 border-t border-[var(--border)] pt-3">
                    <ScoreBreakdown score={s} />
                    {s.reasons.length > 0 && (
                      <div>
                        <p className="mb-1 text-sm font-semibold text-[var(--good)]">有利因素</p>
                        <ul className="list-inside list-disc space-y-0.5 text-sm leading-relaxed">
                          {s.reasons.map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {s.gaps.length > 0 && (
                      <div>
                        <p className="mb-1 text-sm font-semibold text-[var(--warn)]">缺口与待核实</p>
                        <ul className="list-inside list-disc space-y-0.5 text-sm leading-relaxed">
                          {s.gaps.map((g) => (
                            <li key={g}>{g}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {s.matchedPolicies.length > 0 && (
                      <div>
                        <p className="mb-1 text-sm font-semibold">可匹配政策（{s.matchedPolicies.length} 条）</p>
                        <div className="space-y-1.5">
                          {s.matchedPolicies.map((p) => (
                            <div key={p.id} className="rounded-lg bg-[var(--surface-2)] px-3 py-2 text-sm">
                              <span className="font-medium">{p.title}</span>
                              {p.benefit && <span className="block text-[var(--dim)]">{p.benefit}</span>}
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <button
                      type="button"
                      className={btnGhost + " w-full"}
                      onClick={() => onReport(signalId, s.city)}
                      aria-label={
                        landed
                          ? `生成 ${sig.company} 在 ${s.city} 的配套与二期跟进报告`
                          : `生成 ${sig.company} 落地 ${s.city} 的一页纸报告`
                      }
                    >
                      {landed ? `生成${s.city}配套/二期跟进报告` : `生成${s.city}落地报告`}
                    </button>
                  </div>
                )}
              </article>
            ))}
          </section>

          {isLead && sig && (
            <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm" aria-label="线索跟进与阶段推进">
              <h3 className="font-bold">线索跟进 · 在项目管道里推进</h3>
              <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
                这条信号已确认，就是「项目」里的一条线索，不用再单独转项目。
                当前阶段：<span className="font-semibold text-[var(--text)]">{stageLabel(sig.pipelineStage)}</span>
                {landed
                  ? "。已落地线索只跟三件事：配套招商、以商招商、二期扩产。"
                  : "。推进到「签约」时，落地城市先按当前最佳落地城市记，之后可在上方阶段修正里改。"}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="推进线索阶段">
                {STAGES.map((s) => (
                  <button
                    key={s.key}
                    type="button"
                    aria-pressed={sig.pipelineStage === s.key}
                    disabled={advanceStage.isPending}
                    onClick={() =>
                      advanceStage.mutate(
                        s.key as "lead" | "talking" | "signed" | "landed" | "producing" | "dropped",
                      )
                    }
                    className={`rounded-full px-3.5 py-1.5 font-medium disabled:opacity-50 ${sig.pipelineStage === s.key ? "bg-[var(--navy)] text-white" : "bg-[var(--surface-2)]"}`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
              {advanceMsg && <p className="mt-2 text-sm leading-relaxed">{advanceMsg}</p>}

              <div className="mt-4 border-t border-[var(--border)] pt-3">
                <p className="text-sm font-semibold">记一条跟进</p>
                <div className="mt-2 flex gap-2">
                  <select
                    aria-label="线索跟进类型"
                    className="w-24 shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    value={fuKind}
                    onChange={(e) => setFuKind(e.target.value)}
                  >
                    {FOLLOWUP_KINDS.map((k) => (
                      <option key={k} value={k}>{k}</option>
                    ))}
                  </select>
                  <input
                    aria-label="线索跟进内容"
                    className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]"
                    value={fuContent}
                    onChange={(e) => setFuContent(e.target.value)}
                    placeholder="如：与企业通话，确认下月来考察"
                  />
                </div>
                <button
                  type="button"
                  className={btnNavy + " mt-3 w-full"}
                  disabled={addFu.isPending || fuContent.trim() === ""}
                  onClick={() => addFu.mutate()}
                  aria-label="添加线索跟进记录"
                >
                  {addFu.isPending ? "保存中…" : "添加记录"}
                </button>
                {leadFollowups.data && leadFollowups.data.followups.length > 0 && (
                  <ol className="mt-3 space-y-2">
                    {leadFollowups.data.followups.map((f) => (
                      <li key={f.id} className="rounded-xl bg-[var(--surface-2)] p-3">
                        <p className="text-xs text-[var(--dim)]">
                          <span className="mr-2 rounded bg-[var(--surface)] px-1.5 py-0.5 font-medium text-[var(--text)]">{f.kind}</span>
                          {fmtDateTime(f.createdAt)}
                        </p>
                        <p className="mt-1 text-sm leading-relaxed">{f.content}</p>
                      </li>
                    ))}
                  </ol>
                )}
                {leadFollowups.data && leadFollowups.data.followups.length === 0 && (
                  <p className="mt-2 text-sm text-[var(--dim)]">还没有跟进记录，先记一条再推进阶段。</p>
                )}
              </div>
            </section>
          )}
          {sig.status === "converted" && (
            <p className="rounded-[var(--radius)] bg-[var(--surface)] p-4 text-center text-[var(--dim)] shadow-sm">
              这条信号此前已转成项目行，在「项目」里打开对应项目继续跟进；新确认的信号直接当线索跟进，不再需要转项目。
            </p>
          )}
          <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm" aria-label="删除这条信号">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-bold text-[var(--bad)]">删除这条信号</h3>
                <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
                  {sig.status === "converted"
                    ? "这条信号已转成项目，删除会被拦截，项目与跟进记录不受影响。"
                    : "确认有误或不再需要时可彻底删除，删除后不可恢复。"}
                </p>
              </div>
              <div className="shrink-0">
                <DeleteSignalControl signal={sig} onDeleted={onClose} />
              </div>
            </div>
          </section>
        </div>
      )}
    </OverlayShell>
  );
}

// ---------- 落地报告 ----------

function ReportView({
  signalId,
  city,
  onClose,
}: {
  signalId: number;
  city: string;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ["report", signalId, city],
    queryFn: () => api.getReport({ signalId, city }),
  });
  const contactsQ = useQuery({
    queryKey: ["contacts", signalId],
    queryFn: () => api.listSignalContacts({ signalId }),
  });
  const r: Report | undefined = q.data;
  const [copyMsg, setCopyMsg] = useState("");

  const copyReport = async () => {
    if (!r) return;
    const landedReport = r.signal.isLanded;
    const lines = [
      landedReport
        ? `【配套与二期跟进报告】${r.signal.company}（已${r.signal.dealStageLabel} · ${r.signal.landedCity || r.profile.city}）`
        : `【落地评估报告】${r.signal.company} → ${r.profile.city}`,
      landedReport
        ? `结论：项目已落地，不再招引；跟进配套招商、以商招商与二期扩产（参考评分 ${r.score.total}/100）`
        : `结论：${r.score.verdict}（落地评分 ${r.score.total}/100）`,
      ...(landedReport
        ? r.signal.opportunities.map((o, i) => `机会${i + 1}：${o}`)
        : []),
      r.signal.summary ? `信号：${r.signal.summary}` : "",
      `评分拆解：产业契合 ${r.score.parts.industryFit}/30 · 投资规模 ${r.score.parts.scale}/20 · 产业链 ${r.score.parts.chain}/15 · 用地载体 ${r.score.parts.carrier}/15 · 政策收益 ${r.score.parts.policy}/10 · 风险 ${r.score.parts.risk}/10`,
      r.score.reasons.length > 0 ? `引进理由：${r.score.reasons.join("；")}` : "",
      r.score.gaps.length > 0 ? `缺口待核实：${r.score.gaps.join("；")}` : "",
      r.score.matchedPolicies.length > 0
        ? `可匹配政策：${r.score.matchedPolicies.map((p) => p.title).join("、")}`
        : "可匹配政策：暂无（政策库待录入）",
      `承接园区：${r.profile.parks.join("、") || "待录入"} · 用地成本 ${r.profile.landCostLevel || "待录入"} · 人力成本 ${r.profile.laborCostLevel || "待录入"}`,
      `来源：${r.signal.sourceName}${r.signal.sourceUrl ? ` ${r.signal.sourceUrl}` : ""}`,
      ...(contactsQ.data?.contacts ?? [])
        .filter((c) => c.verifyStatus !== "stale")
        .map(
          (c) =>
            `联系方式（${c.contactLabel}${c.contactName ? ` ${c.contactName}` : ""}）：${[c.phone, c.email, c.address].filter((x) => x !== "").join(" · ")}（出处：${c.sourceType}${c.sourceUrl ? ` ${c.sourceUrl}` : ""}）`,
        ),
    ].filter((x) => x !== "");
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopyMsg("报告文本已复制，可直接粘贴发送。");
    } catch {
      setCopyMsg("复制失败，请长按选择报告内容手动复制。");
    }
  };
  return (
    <OverlayShell title={r?.signal.isLanded ? "配套与二期跟进报告" : "落地报告"} onClose={onClose}>
      {q.isPending && <p className="mt-6 text-[var(--dim)]">正在生成报告…</p>}
      {q.error && <p className="mt-6 text-[var(--bad)]">生成失败：{String(q.error)}</p>}
      {r && (
        <article className="mt-2 overflow-hidden rounded-[var(--radius)] bg-[var(--surface)] shadow-sm">
          <header className="bg-[var(--navy)] p-5 text-white">
            <p className="text-sm opacity-80">
              招商雷达 · {r.signal.isLanded ? "配套与二期跟进报告" : "落地评估报告"}
            </p>
            <h3 className="mt-1 text-2xl font-bold">{r.signal.company}</h3>
            <p className="mt-1 text-sm opacity-90">
              {r.signal.isLanded
                ? `已${r.signal.dealStageLabel}，落地城市：${r.signal.landedCity || r.profile.city}（已定，不再招引） · 生成于 ${fmtDateTime(r.generatedAt)}`
                : `拟落地城市：${r.profile.city}（${r.profile.province}） · 生成于 ${fmtDateTime(r.generatedAt)}`}
            </p>
          </header>
          <div className="space-y-5 p-5">
            <div className="flex items-center gap-4">
              <ScoreRing score={r.score.total} size={76} />
              <div>
                <p className="text-xl font-bold" style={{ color: verdictColor(r.score.verdict) }}>
                  结论：{r.score.verdict}
                </p>
                <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
                  {r.signal.industry && <>产业：{r.signal.industry} · </>}
                  信号：{r.signal.signalType} · 阶段：{r.signal.dealStageLabel}
                  {r.signal.investmentText && <> · {r.signal.investmentText}</>}
                  {r.signal.isLanded && <> · 上方分数为参考分，不构成任何城市的引进建议</>}
                </p>
              </div>
            </div>

            {r.signal.isLanded && (
              <section>
                <h4 className="mb-1 font-bold">配套与二期机会（本报告的跟进重点）</h4>
                <ol className="list-inside list-decimal space-y-1 leading-relaxed">
                  {r.signal.opportunities.map((o) => (
                    <li key={o}>{o}</li>
                  ))}
                </ol>
              </section>
            )}

            {r.signal.summary && (
              <section>
                <h4 className="mb-1 font-bold">信号摘要</h4>
                <p className="leading-relaxed">{r.signal.summary}</p>
                <p className="mt-1 text-sm text-[var(--dim)]">
                  来源：{r.signal.sourceName}
                  {r.signal.reportedDate && <> · {r.signal.reportedDate}</>}
                  {r.signal.sourceUrl && (
                    <>
                      {" · "}
                      <a href={r.signal.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">
                        原文链接
                      </a>
                    </>
                  )}
                </p>
              </section>
            )}

            {(contactsQ.data?.contacts ?? []).length > 0 && (
              <section>
                <h4 className="mb-1 font-bold">企业联系方式（对公公开渠道）</h4>
                <div className="space-y-2">
                  {(contactsQ.data?.contacts ?? []).map((c) => (
                    <p key={c.id} className="rounded-xl bg-[var(--surface-2)] p-3 text-sm leading-relaxed">
                      <span className="font-semibold">{c.contactLabel}</span>
                      {(c.contactName || c.contactTitle) && (
                        <span> {c.contactName}{c.contactName && c.contactTitle ? " · " : ""}{c.contactTitle}</span>
                      )}
                      {c.verifyStatus === "stale" && <span className="font-semibold text-[var(--bad)]">（已过期）</span>}
                      <br />
                      {[c.phone, c.email, c.address].filter((x) => x !== "").join(" · ")}
                      <br />
                      <span className="text-[var(--dim)]">
                        出处：{c.sourceType}{c.sourceName ? ` · ${c.sourceName}` : ""}
                        {c.sourceUrl && (
                          <>
                            {" · "}
                            <a href={c.sourceUrl} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">
                              来源链接
                            </a>
                          </>
                        )}
                      </span>
                    </p>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h4 className="mb-2 font-bold">评分拆解（满分 100）</h4>
              <ScoreBreakdown score={r.score} />
            </section>

            <section>
              <h4 className="mb-1 font-bold">承接条件</h4>
              <p className="text-sm leading-relaxed">
                代表园区：{r.profile.parks.length > 0 ? r.profile.parks.join("、") : "待录入"}
                <br />
                用地成本：{r.profile.landCostLevel || "待录入"} · 人力成本：{r.profile.laborCostLevel || "待录入"}
                {r.profile.note && (
                  <>
                    <br />
                    {r.profile.note}
                  </>
                )}
              </p>
            </section>

            {r.score.reasons.length > 0 && (
              <section>
                <h4 className="mb-1 font-bold">{r.signal.isLanded ? "跟进判断" : "引进理由"}</h4>
                <ul className="list-inside list-disc space-y-1 leading-relaxed">
                  {r.score.reasons.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </section>
            )}

            {r.score.gaps.length > 0 && (
              <section>
                <h4 className="mb-1 font-bold">缺的条件 / 待核实</h4>
                <ul className="list-inside list-disc space-y-1 leading-relaxed">
                  {r.score.gaps.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <h4 className="mb-2 font-bold">可匹配政策（政策库已录入）</h4>
              {r.score.matchedPolicies.length === 0 && (
                <p className="text-sm text-[var(--dim)]">
                  暂无可匹配条目。请先在「政策」里录入{r.profile.city}的相关政策，报告会自动带上可享受的扶持。
                </p>
              )}
              <div className="space-y-2">
                {r.score.matchedPolicies.map((p) => (
                  <div key={p.id} className="rounded-xl bg-[var(--surface-2)] p-3">
                    <p className="font-semibold">{p.title}</p>
                    {p.benefit && <p className="mt-0.5 text-sm">扶持：{p.benefit}</p>}
                    {p.threshold && <p className="text-sm text-[var(--dim)]">门槛：{p.threshold}</p>}
                    {p.deadline && <p className="text-sm text-[var(--dim)]">截止：{p.deadline}</p>}
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h4 className="mb-1 font-bold">建议下一步</h4>
              {r.signal.isLanded ? (
                <ol className="list-inside list-decimal space-y-1 leading-relaxed">
                  <li>对接{r.signal.landedCity || r.profile.city}项目服务专员，确认投产/满产进度与当前配套缺口，不再谈整体引进。</li>
                  <li>按上方机会清单逐项推进：配套供应商对接、以商招商引荐、二期扩产摸排，各定一个负责人。</li>
                  <li>二期出现明确意向后，把二期作为一条新的可招引信号单独录入，再做落地评估。</li>
                </ol>
              ) : (
                <ol className="list-inside list-decimal space-y-1 leading-relaxed">
                  <li>先核实企业投资意向与真实投资额、用地/能耗需求。</li>
                  <li>把本报告发对接人确认，约企业到{r.profile.city}实地考察{r.profile.parks[0] ?? "园区"}。</li>
                  <li>按上方缺口逐项补齐条件后，重新评估再定档。</li>
                </ol>
              )}
            </section>

            <div className="no-print border-t border-[var(--border)] pt-4">
              <button type="button" className={btnPrimary + " w-full"} onClick={() => void copyReport()} aria-label="复制报告文本">
                复制报告文本
              </button>
              {copyMsg && <p className="mt-2 text-center text-sm text-[var(--dim)]">{copyMsg}</p>}
            </div>
          </div>
        </article>
      )}
    </OverlayShell>
  );
}

// ---------- 比选 Tab ----------

function CompareView({ onReport }: { onReport: (signalId: number, city: string) => void }) {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const feed = useQuery({
    queryKey: ["signals", "confirmed"],
    queryFn: () => api.listSignals({ status: "confirmed", limit: 100 }),
  });
  const converted = useQuery({
    queryKey: ["signals", "converted"],
    queryFn: () => api.listSignals({ status: "converted", limit: 100 }),
  });
  const profiles = useQuery({ queryKey: ["cities"], queryFn: () => api.listCityProfiles({}) });

  const allOptions = [...(feed.data?.signals ?? []), ...(converted.data?.signals ?? [])];
  // 比选只比可招引的：已签约/开工/投产的项目城市已定，跨市比选没有意义
  const landedExcluded = allOptions.filter((s) => s.isLanded).length;
  const options = allOptions.filter((s) => !s.isLanded);
  const activeId =
    selectedId != null && options.some((s) => s.id === selectedId)
      ? selectedId
      : (options[0]?.id ?? null);
  const assessment = useQuery({
    queryKey: ["assessment", activeId],
    queryFn: () => api.getSignalAssessment({ signalId: activeId as number }),
    enabled: activeId != null,
  });
  const profileByCity = new Map((profiles.data?.cities ?? []).map((c) => [c.city, c]));

  return (
    <div className="space-y-4">
      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
        <Field label="选择要比选的企业信号">
          <select
            aria-label="选择要比选的企业信号"
            className={inputCls}
            value={activeId ?? ""}
            onChange={(e) => setSelectedId(Number(e.target.value))}
          >
            {options.length === 0 && <option value="">暂无已确认信号</option>}
            {options.map((s) => (
              <option key={s.id} value={s.id}>
                {s.company}{s.industry ? ` · ${s.industry}` : ""}
              </option>
            ))}
          </select>
        </Field>
        {options.length === 0 && (
          <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
            先在「雷达」里刷新或录入信号并确认（确认后在「项目」里当线索跟进），这里就能把同一家企业放到各城市同台比选。
          </p>
        )}
        {landedExcluded > 0 && (
          <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
            另有 {landedExcluded} 条已落地信号（已签约 / 开工 / 投产）不在比选范围内：城市已定，不比选，只在「项目」的签约 / 落地 / 投产阶段看配套与二期机会。
          </p>
        )}
      </section>

      {assessment.isPending && activeId != null && <p className="text-[var(--dim)]">正在计算各城市得分…</p>}
      {assessment.data && (
        <>
          <section className="space-y-2" aria-label="城市总分对比">
            {assessment.data.scores.map((s) => (
              <div key={s.city} className="flex items-center gap-3 rounded-[var(--radius)] bg-[var(--surface)] p-3 shadow-sm">
                <span className="w-12 shrink-0 text-lg font-bold">{s.city}</span>
                <div className="h-3.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${s.total}%`, backgroundColor: scoreColor(s.total) }}
                  />
                </div>
                <span className="w-10 shrink-0 text-right text-lg font-bold tabular-nums" style={{ color: scoreColor(s.total) }}>
                  {s.total}
                </span>
                <VerdictPill verdict={s.verdict} />
              </div>
            ))}
          </section>

          <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm" aria-label="分项对比">
            <h3 className="font-bold">分项对比（同一维度看哪个城市更强）</h3>
            <div className="mt-3 space-y-4">
              {(
                [
                  { key: "industryFit", label: "产业契合", max: 30 },
                  { key: "scale", label: "投资规模", max: 20 },
                  { key: "chain", label: "产业链", max: 15 },
                  { key: "carrier", label: "用地载体", max: 15 },
                  { key: "policy", label: "政策收益", max: 10 },
                  { key: "risk", label: "风险", max: 10 },
                ] as const
              ).map((dim) => (
                <div key={dim.key}>
                  <p className="mb-1.5 text-sm font-semibold text-[var(--dim)]">
                    {dim.label} <span className="font-normal">/ {dim.max} 分</span>
                  </p>
                  <div className="space-y-1">
                    {assessment.data.scores.map((s) => {
                      const v = s.parts[dim.key];
                      const pct = Math.round((v / dim.max) * 100);
                      return (
                        <div key={s.city} className="flex items-center gap-2">
                          <span className="w-10 shrink-0 text-sm font-medium">{s.city}</span>
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--surface-2)]">
                            <div
                              className="h-full rounded-full"
                              style={{
                                width: `${pct}%`,
                                backgroundColor: pct >= 75 ? "var(--good)" : pct >= 45 ? "var(--warn)" : "var(--bad)",
                              }}
                            />
                          </div>
                          <span className="w-8 shrink-0 text-right text-sm tabular-nums">{v}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-2" aria-label="城市承接条件与报告">
            {assessment.data.scores.map((s) => {
              const prof: CityProfile | undefined = profileByCity.get(s.city);
              return (
                <div key={s.city} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-[var(--radius)] bg-[var(--surface)] px-4 py-3 text-sm shadow-sm">
                  <span className="font-bold">{s.city}</span>
                  <span className="text-[var(--dim)]">用地 {prof?.landCostLevel || "待录入"}</span>
                  <span className="text-[var(--dim)]">人力 {prof?.laborCostLevel || "待录入"}</span>
                  <span className="text-[var(--dim)]">园区 {prof && prof.parks.length > 0 ? prof.parks.join("、") : "待录入"}</span>
                  <span className="text-[var(--dim)]">匹配政策 {s.matchedPolicies.length} 条</span>
                  <button
                    type="button"
                    className="ml-auto font-medium text-[var(--accent)]"
                    onClick={() => activeId != null && onReport(activeId, s.city)}
                    aria-label={`生成 ${s.city} 落地报告`}
                  >
                    落地报告 →
                  </button>
                </div>
              );
            })}
          </section>
          <p className="text-xs leading-relaxed text-[var(--dim)]">
            用地/人力为成本档位（低档更利于落地）；档位为参考档，可在「我的 → 城市产业档案」里按当地实际修改，改完后比选立即按新档位计算。
          </p>
        </>
      )}
    </div>
  );
}

// ---------- 项目 Tab ----------

function LeadCard({
  lead,
  onOpen,
}: {
  lead: Lead;
  onOpen: () => void;
}) {
  const refreshAll = useRefreshAll();
  const [advanceMsg, setAdvanceMsg] = useState("");
  const advance = useMutation({
    mutationFn: (stage: string) =>
      api.setSignalStage({
        signalId: lead.id,
        stage: stage as "lead" | "talking" | "signed" | "landed" | "producing" | "dropped",
        // 推进到签约及之后且还没记落地城市时，先按最佳落地城市记，详情里可再修正
        landedCity:
          (stage === "signed" || stage === "landed" || stage === "producing") && !lead.landedCity
            ? lead.bestCity
            : "",
      }),
    onSuccess: (r) => {
      setAdvanceMsg(
        r.pipelineStage === "dropped"
          ? "已搁置，可在雷达「已忽略的信号」里恢复。"
          : `已推进到「${stageLabel(r.pipelineStage)}」${r.isLanded ? "，按已落地处理，只跟配套与二期" : ""}。`,
      );
      refreshAll();
    },
    onError: (e) => setAdvanceMsg(`阶段更新失败：${String(e)}`),
  });

  return (
    <SignalCard signal={lead} onOpen={onOpen}>
      <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-3">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="rounded-full bg-[var(--navy)] px-2.5 py-0.5 text-xs font-semibold text-white">
            线索 · {stageLabel(lead.pipelineStage)}
          </span>
          <span className="text-xs text-[var(--dim)]">
            跟进记录 {lead.followupCount} 条 · 点开卡片看评分拆解、落地报告并记跟进
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-sm text-[var(--dim)]" htmlFor={`lead-stage-${lead.id}`}>
            推进阶段
          </label>
          <select
            id={`lead-stage-${lead.id}`}
            aria-label={`推进 ${lead.company} 的阶段`}
            className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] sm:flex-none"
            value={lead.pipelineStage}
            disabled={advance.isPending}
            onChange={(e) => advance.mutate(e.target.value)}
          >
            {STAGES.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="ml-auto">
            <DeleteSignalControl signal={lead} />
          </span>
        </div>
        {advanceMsg && <p className="text-sm leading-relaxed">{advanceMsg}</p>}
      </div>
    </SignalCard>
  );
}

function ProjectsView({
  onOpenProject,
  onOpenSignal,
}: {
  onOpenProject: (id: number) => void;
  onOpenSignal: (id: number) => void;
}) {
  const [showNew, setShowNew] = useState(false);
  const [stageFilter, setStageFilter] = useState("all");
  const [keyword, setKeyword] = useState("");
  const [industryFilter, setIndustryFilter] = useState("");
  const [sortMode, setSortMode] = useState<"new" | "score">("new");
  const q = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects({}) });
  const projects = q.data?.projects ?? [];
  const leads = q.data?.leads ?? [];
  const today = new Date().toISOString().slice(0, 10);
  const kw = keyword.trim();

  const shownProjects = projects.filter(
    (p) =>
      kw === "" ||
      p.company.includes(kw) ||
      p.industry.includes(kw) ||
      p.recommendedCity.includes(kw) ||
      p.owner.includes(kw),
  );
  const shownLeads = leads
    .filter((l) => !industryFilter || l.industry === industryFilter)
    .filter(
      (l) =>
        kw === "" ||
        l.company.includes(kw) ||
        l.summary.includes(kw) ||
        l.targetRegion.includes(kw) ||
        l.sourceName.includes(kw) ||
        l.signalType.includes(kw),
    )
    // 线索排序沿用信号流口径：可招引在前，同为最新/评分排序
    .sort((a, b) =>
      sortMode === "score"
        ? Number(a.isLanded) - Number(b.isLanded) || b.bestScore - a.bestScore
        : Number(a.isLanded) - Number(b.isLanded) || b.id - a.id,
    );

  const counts = new Map<string, number>();
  for (const p of projects) counts.set(p.stage, (counts.get(p.stage) ?? 0) + 1);
  for (const l of leads) counts.set(l.pipelineStage, (counts.get(l.pipelineStage) ?? 0) + 1);
  const total = projects.length + leads.length;
  const stagesToShow =
    stageFilter === "all" ? STAGES : STAGES.filter((s) => s.key === stageFilter);

  const renderProjectCard = (p: Project) => {
    const overdue =
      p.nextStepDate !== "" &&
      p.nextStepDate < today &&
      !["landed", "producing", "dropped"].includes(p.stage);
    return (
      <button
        key={`project-${p.id}`}
        type="button"
        onClick={() => onOpenProject(p.id)}
        className="block w-full rounded-[var(--radius)] bg-[var(--surface)] p-4 text-left shadow-sm"
        aria-label={`打开项目 ${p.company}`}
      >
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-lg font-bold">{p.company}</h3>
          <span className="shrink-0 rounded-full bg-[var(--navy)] px-2.5 py-0.5 text-xs font-semibold text-white">
            {stageLabel(p.stage)}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {p.industry && <Chip>{p.industry}</Chip>}
          {p.recommendedCity && <Chip>推荐：{p.recommendedCity}</Chip>}
          {p.owner && <Chip>负责人：{p.owner}</Chip>}
          <Chip>跟进记录 {p.followupCount} 条</Chip>
        </div>
        {p.nextStep && (
          <p className={`mt-2 text-sm ${overdue ? "font-semibold text-[var(--bad)]" : "text-[var(--dim)]"}`}>
            下一步：{p.nextStep}
            {p.nextStepDate && (
              <>
                {" "}· {p.nextStepDate}
                {overdue ? "（已逾期）" : ""}
              </>
            )}
          </p>
        )}
      </button>
    );
  };

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-[var(--dim)]">
        确认后的信号就是这里的线索，排在管道第一阶段，后面依次是洽谈、签约、落地、投产；
        线索不用再转项目，点开就能看评分拆解、生成落地报告、记跟进，阶段在这里直接推进。
        已签约 / 开工 / 投产的信号落在对应阶段，只做配套与二期。
      </p>
      <div className="flex flex-col gap-2">
        <input
          aria-label="搜索线索与项目（企业、摘要、区域、来源、城市、负责人）"
          className={inputCls}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索企业、摘要、区域、来源（如 土地 / 巨潮 / 定增 / 环评）…"
        />
        <div className="flex gap-2">
          <select
            aria-label="按产业筛选线索"
            className={inputCls + " min-w-0 flex-1"}
            value={industryFilter}
            onChange={(e) => setIndustryFilter(e.target.value)}
          >
            <option value="">全部产业</option>
            {INDUSTRIES.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
          <div
            className="flex shrink-0 overflow-hidden rounded-xl border border-[var(--border)]"
            role="group"
            aria-label="线索排序"
          >
            <button
              type="button"
              aria-pressed={sortMode === "new"}
              onClick={() => setSortMode("new")}
              className={`px-3 py-2 text-sm font-medium ${sortMode === "new" ? "bg-[var(--navy)] text-white" : "bg-[var(--surface)]"}`}
            >
              最新
            </button>
            <button
              type="button"
              aria-pressed={sortMode === "score"}
              onClick={() => setSortMode("score")}
              className={`px-3 py-2 text-sm font-medium ${sortMode === "score" ? "bg-[var(--navy)] text-white" : "bg-[var(--surface)]"}`}
            >
              评分最高
            </button>
          </div>
        </div>
      </div>
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="按阶段筛选管道">
          <button
            type="button"
            onClick={() => setStageFilter("all")}
            aria-pressed={stageFilter === "all"}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${stageFilter === "all" ? "bg-[var(--navy)] text-white" : "bg-[var(--surface)] shadow-sm"}`}
          >
            全部 {total}
          </button>
          {STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setStageFilter(s.key)}
              aria-pressed={stageFilter === s.key}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${stageFilter === s.key ? "bg-[var(--navy)] text-white" : "bg-[var(--surface)] shadow-sm"}`}
            >
              {s.label} {counts.get(s.key) ?? 0}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={btnNavy + " shrink-0"}
          onClick={() => setShowNew(true)}
          aria-label="手工新建项目"
        >
          + 新建
        </button>
      </div>

      {q.isPending && <p className="text-[var(--dim)]">正在加载…</p>}
      {q.error && <p className="text-[var(--bad)]">加载失败：{String(q.error)}</p>}
      {q.data && total === 0 && (
        <div className="rounded-[var(--radius)] bg-[var(--surface)] p-5 text-center shadow-sm">
          <p className="font-medium">管道里还没有线索和项目</p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            去「雷达」刷新或录入信号并确认，确认后的信号会直接出现在这里的线索阶段；
            也可以点右上角手工新建项目。
          </p>
        </div>
      )}
      {q.data && total > 0 && shownLeads.length === 0 && shownProjects.length === 0 && (
        <div className="rounded-[var(--radius)] bg-[var(--surface)] p-5 text-center shadow-sm">
          <p className="font-medium">没有符合筛选条件的线索或项目</p>
          <p className="mt-1 text-sm text-[var(--dim)]">换个关键词、产业或阶段再试试。</p>
        </div>
      )}

      {stagesToShow.map((st) => {
        const gLeads = shownLeads.filter((l) => l.pipelineStage === st.key);
        const gProjects = shownProjects.filter((p) => p.stage === st.key);
        if (stageFilter === "all" && gLeads.length === 0 && gProjects.length === 0) return null;
        const landedLeads = gLeads.filter((l) => l.isLanded).length;
        return (
          <section key={st.key} aria-label={`${st.label}阶段`} className="space-y-3">
            <h3 className="text-sm font-bold">
              {st.label} · {gLeads.length + gProjects.length}
              {st.key === "lead" && gLeads.length > 0 && (
                <span className="ml-2 font-normal text-[var(--dim)]">已确认信号即线索（意向 / 洽谈）</span>
              )}
              {landedLeads > 0 && (
                <span className="ml-2 font-normal text-[var(--warn)]">
                  其中已落地线索 {landedLeads} 条，只做配套与二期
                </span>
              )}
            </h3>
            {stageFilter !== "all" && gLeads.length === 0 && gProjects.length === 0 && (
              <p className="text-sm text-[var(--dim)]">这个阶段暂时没有符合条件的线索或项目。</p>
            )}
            {gLeads.map((l) => (
              <LeadCard key={`lead-${l.id}`} lead={l} onOpen={() => onOpenSignal(l.id)} />
            ))}
            {gProjects.map((p) => renderProjectCard(p))}
          </section>
        );
      })}
      {showNew && <NewProjectForm onClose={() => setShowNew(false)} />}
    </div>
  );
}

function NewProjectForm({ onClose }: { onClose: () => void }) {
  const refreshAll = useRefreshAll();
  const [company, setCompany] = useState("");
  const [industry, setIndustry] = useState("");
  const [city, setCity] = useState("");
  const [owner, setOwner] = useState("");
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const cities = useQuery({ queryKey: ["cities"], queryFn: () => api.listCityProfiles({}) });
  const create = useMutation({
    mutationFn: () =>
      api.createProject({ company: company.trim(), industry, recommendedCity: city, owner: owner.trim(), note: note.trim() }),
    onSuccess: () => {
      refreshAll();
      onClose();
    },
    onError: (e) => setErr(String(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!company.trim()) {
      setErr("请填写企业名称");
      return;
    }
    create.mutate();
  };
  return (
    <Modal title="新建招商项目" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="企业名称 *">
          <input aria-label="企业名称" className={inputCls} value={company} onChange={(e) => setCompany(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="所属产业">
            <select aria-label="所属产业" className={inputCls} value={industry} onChange={(e) => setIndustry(e.target.value)}>
              <option value="">未分类</option>
              {INDUSTRIES.map((i) => (
                <option key={i} value={i}>{i}</option>
              ))}
            </select>
          </Field>
          <Field label="推荐落地城市">
            <select aria-label="推荐落地城市" className={inputCls} value={city} onChange={(e) => setCity(e.target.value)}>
              <option value="">未定</option>
              {(cities.data?.cities ?? []).map((c) => (
                <option key={c.city} value={c.city}>{c.city}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="跟进负责人">
          <input aria-label="跟进负责人" className={inputCls} value={owner} onChange={(e) => setOwner(e.target.value)} />
        </Field>
        <Field label="备注">
          <textarea aria-label="备注" className={inputCls} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        {err && <p className="text-sm text-[var(--bad)]">{err}</p>}
        <button type="submit" className={btnPrimary + " w-full"} disabled={create.isPending}>
          {create.isPending ? "创建中…" : "创建项目"}
        </button>
      </form>
    </Modal>
  );
}

function ProjectDetail({ projectId, onClose }: { projectId: number; onClose: () => void }) {
  const refreshAll = useRefreshAll();
  const projects = useQuery({ queryKey: ["projects"], queryFn: () => api.listProjects({}) });
  const followups = useQuery({
    queryKey: ["followups", projectId],
    queryFn: () => api.listFollowups({ projectId }),
  });
  const cities = useQuery({ queryKey: ["cities"], queryFn: () => api.listCityProfiles({}) });
  const project: Project | undefined = projects.data?.projects.find((p) => p.id === projectId);

  const [owner, setOwner] = useState<string | null>(null);
  const [city, setCity] = useState<string | null>(null);
  const [nextStep, setNextStep] = useState<string | null>(null);
  const [nextStepDate, setNextStepDate] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fuKind, setFuKind] = useState("跟进");
  const [fuContent, setFuContent] = useState("");

  type ProjectUpdate = {
    id: number;
    stage?: "lead" | "talking" | "signed" | "landed" | "producing" | "dropped";
    owner?: string;
    recommendedCity?: string;
    nextStep?: string;
    nextStepDate?: string;
    note?: string;
  };
  const update = useMutation({
    mutationFn: (args: ProjectUpdate) => api.updateProject(args),
    onSuccess: refreshAll,
  });
  const addFu = useMutation({
    mutationFn: () => api.addFollowup({ projectId, kind: fuKind, content: fuContent.trim() }),
    onSuccess: () => {
      setFuContent("");
      refreshAll();
    },
  });

  if (projects.isPending) {
    return (
      <OverlayShell title="项目详情" onClose={onClose}>
        <p className="mt-6 text-[var(--dim)]">正在加载…</p>
      </OverlayShell>
    );
  }
  if (!project) {
    return (
      <OverlayShell title="项目详情" onClose={onClose}>
        <p className="mt-6 text-[var(--dim)]">项目不存在或已被删除。</p>
      </OverlayShell>
    );
  }

  const savePlan = () => {
    update.mutate({
      id: project.id,
      owner: (owner ?? project.owner).trim(),
      recommendedCity: city ?? project.recommendedCity,
      nextStep: (nextStep ?? project.nextStep).trim(),
      nextStepDate: nextStepDate ?? project.nextStepDate,
      note: (note ?? project.note).trim(),
    });
  };

  return (
    <OverlayShell title={project.company} onClose={onClose}>
      <div className="mt-2 space-y-4">
        <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
          <div className="flex flex-wrap gap-1.5">
            {project.industry && <Chip>{project.industry}</Chip>}
            <Chip>建档 {fmtDateTime(project.createdAt)}</Chip>
            <Chip>跟进记录 {project.followupCount} 条</Chip>
          </div>
          <p className="mb-2 mt-4 text-sm font-medium text-[var(--dim)]">推进阶段（点选即变更）</p>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="推进阶段">
            {STAGES.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={project.stage === s.key}
                onClick={() => update.mutate({ id: project.id, stage: s.key as NonNullable<ProjectUpdate["stage"]> })}
                className={`rounded-full px-3.5 py-1.5 font-medium ${project.stage === s.key ? "bg-[var(--navy)] text-white" : "bg-[var(--surface-2)]"}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <Field label="跟进负责人">
              <input aria-label="跟进负责人" className={inputCls} value={owner ?? project.owner} onChange={(e) => setOwner(e.target.value)} />
            </Field>
            <Field label="推荐落地城市">
              <select aria-label="推荐落地城市" className={inputCls} value={city ?? project.recommendedCity} onChange={(e) => setCity(e.target.value)}>
                <option value="">未定</option>
                {(cities.data?.cities ?? []).map((c) => (
                  <option key={c.city} value={c.city}>{c.city}</option>
                ))}
              </select>
            </Field>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label="下一步动作">
              <input aria-label="下一步动作" className={inputCls} value={nextStep ?? project.nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="如：约企业来园区考察" />
            </Field>
            <Field label="计划日期">
              <input aria-label="计划日期" type="date" className={inputCls} value={nextStepDate ?? project.nextStepDate} onChange={(e) => setNextStepDate(e.target.value)} />
            </Field>
          </div>
          <div className="mt-3">
            <Field label="备注">
              <textarea aria-label="备注" className={inputCls} rows={2} value={note ?? project.note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
          <button type="button" className={btnPrimary + " mt-3 w-full"} disabled={update.isPending} onClick={savePlan} aria-label="保存项目计划">
            {update.isPending ? "保存中…" : "保存"}
          </button>
        </section>

        <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm" aria-label="添加跟进记录">
          <h3 className="font-bold">记一条跟进</h3>
          <div className="mt-3 flex gap-2">
            <select
              aria-label="跟进类型"
              className="w-24 shrink-0 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-2 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]"
              value={fuKind}
              onChange={(e) => setFuKind(e.target.value)}
            >
              {FOLLOWUP_KINDS.map((k) => (
                <option key={k} value={k}>{k}</option>
              ))}
            </select>
            <input
              aria-label="跟进内容"
              className="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 text-base text-[var(--text)] outline-none focus:border-[var(--accent)]"
              value={fuContent}
              onChange={(e) => setFuContent(e.target.value)}
              placeholder="如：与张总通话，确认下月来考察"
            />
          </div>
          <button
            type="button"
            className={btnNavy + " mt-3 w-full"}
            disabled={addFu.isPending || fuContent.trim() === ""}
            onClick={() => addFu.mutate()}
            aria-label="添加跟进记录"
          >
            {addFu.isPending ? "保存中…" : "添加记录"}
          </button>
        </section>

        <section aria-label="跟进时间线">
          <h3 className="mb-2 font-bold">跟进时间线</h3>
          {followups.isPending && <p className="text-[var(--dim)]">正在加载…</p>}
          {followups.data && followups.data.followups.length === 0 && (
            <p className="text-sm text-[var(--dim)]">还没有跟进记录。</p>
          )}
          <ol className="space-y-2">
            {(followups.data?.followups ?? []).map((f) => (
              <li key={f.id} className="rounded-[var(--radius)] bg-[var(--surface)] p-3 shadow-sm">
                <p className="text-xs text-[var(--dim)]">
                  <span className="mr-2 rounded bg-[var(--surface-2)] px-1.5 py-0.5 font-medium text-[var(--text)]">{f.kind}</span>
                  {fmtDateTime(f.createdAt)}
                </p>
                <p className="mt-1 leading-relaxed">{f.content}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </OverlayShell>
  );
}

// ---------- 政策 Tab ----------

function PoliciesView() {
  const [cityFilter, setCityFilter] = useState("");
  const [keyword, setKeyword] = useState("");
  const [collectMsg, setCollectMsg] = useState("");
  const [editing, setEditing] = useState<Policy | "new" | null>(null);
  const refreshAll = useRefreshAll();
  const q = useQuery({ queryKey: ["policies"], queryFn: () => api.listPolicies({ city: "" }) });
  const cities = useQuery({ queryKey: ["cities"], queryFn: () => api.listCityProfiles({}) });
  const del = useMutation({
    mutationFn: (id: number) => api.deletePolicy({ id }),
    onSuccess: refreshAll,
  });
  const collect = useMutation({
    mutationFn: () => api.refreshPolicies({}),
    onSuccess: (r) => setCollectMsg(r.message),
    onError: (e) => setCollectMsg(`采集失败：${String(e)}`),
  });
  const kw = keyword.trim();
  const policies = (q.data?.policies ?? [])
    .filter((p) => !cityFilter || normalizeCityName(p.city) === normalizeCityName(cityFilter))
    .filter(
      (p) =>
        kw === "" ||
        p.title.includes(kw) ||
        p.benefit.includes(kw) ||
        p.threshold.includes(kw) ||
        p.industries.some((i) => i.includes(kw)),
    );
  // 筛选标签按规范名合并：城市档案与政策里的「宣城」都并入「宣城市」，只出一个标签
  const cityNames = [
    ...new Set(
      [
        ...(cities.data?.cities ?? []).map((c) => normalizeCityName(c.city)),
        ...(q.data?.policies ?? []).map((p) => normalizeCityName(p.city)),
      ].filter((c) => c !== ""),
    ),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2">
        <input
          aria-label="搜索政策（名称、扶持内容、产业）"
          className={inputCls}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          placeholder="搜索政策名称、扶持内容或产业…"
        />
        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-xl bg-[var(--accent)] px-4 py-2.5 font-semibold text-white disabled:opacity-60"
            disabled={collect.isPending}
            onClick={() => collect.mutate()}
            aria-label="采集最新政策，从公开网络查找各市现行扶持政策"
          >
            {collect.isPending ? "正在启动…" : "↻ 采集最新政策"}
          </button>
          <button type="button" className={btnNavy} onClick={() => setEditing("new")} aria-label="录入一条政策">
            + 录入政策
          </button>
        </div>
        {collectMsg && <p className="text-sm leading-relaxed text-[var(--dim)]">{collectMsg}</p>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="按城市筛选政策">
          <button
            type="button"
            onClick={() => setCityFilter("")}
            aria-pressed={cityFilter === ""}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${cityFilter === "" ? "bg-[var(--navy)] text-white" : "bg-[var(--surface)] shadow-sm"}`}
          >
            全部
          </button>
          {cityNames.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCityFilter(c)}
              aria-pressed={cityFilter === c}
              className={`rounded-full px-3 py-1.5 text-sm font-medium ${cityFilter === c ? "bg-[var(--navy)] text-white" : "bg-[var(--surface)] shadow-sm"}`}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {q.isPending && <p className="text-[var(--dim)]">正在加载…</p>}
      {q.data && policies.length === 0 && (q.data.policies.length > 0 || kw !== "" || cityFilter !== "") && (
        <div className="rounded-[var(--radius)] bg-[var(--surface)] p-5 text-center shadow-sm">
          <p className="font-medium">没有符合条件的政策</p>
          <p className="mt-1 text-sm text-[var(--dim)]">换个城市或关键词再试试。</p>
        </div>
      )}
      {q.data && q.data.policies.length === 0 && (
        <div className="rounded-[var(--radius)] bg-[var(--surface)] p-5 text-center shadow-sm">
          <p className="font-medium">政策库还是空的</p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--dim)]">
            点上方「采集最新政策」，系统会去公开网络查找各市现行扶持政策原文并入库；
            也可以手工把手头政策按「能拿什么、门槛是什么、什么时候截止」录进来。
            政策入库后，落地评估和报告会自动匹配到对应企业，并计入政策收益分。
          </p>
        </div>
      )}
      <div className="space-y-3">
        {policies.map((p) => (
          <article key={p.id} className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <h3 className="font-bold leading-snug">{p.title}</h3>
              <span className="shrink-0 rounded-full bg-[var(--navy)] px-2.5 py-0.5 text-xs font-semibold text-white">{normalizeCityName(p.city)}</span>
            </div>
            {p.industries.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {p.industries.map((i) => (
                  <Chip key={i}>{i}</Chip>
                ))}
              </div>
            )}
            <dl className="mt-2 space-y-1 text-sm leading-relaxed">
              {p.benefit && (
                <div><dt className="inline font-semibold">能拿什么：</dt><dd className="inline">{p.benefit}</dd></div>
              )}
              {p.threshold && (
                <div><dt className="inline font-semibold">门槛：</dt><dd className="inline">{p.threshold}</dd></div>
              )}
              {p.deadline && (
                <div><dt className="inline font-semibold">截止：</dt><dd className="inline">{p.deadline}</dd></div>
              )}
            </dl>
            <div className="mt-3 flex gap-2 border-t border-[var(--border)] pt-3">
              {p.sourceUrl && (
                <a href={p.sourceUrl} target="_blank" rel="noreferrer" className={btnGhost} aria-label={`查看政策原文 ${p.title}`}>
                  原文
                </a>
              )}
              <button type="button" className={btnGhost} onClick={() => setEditing(p)} aria-label={`编辑政策 ${p.title}`}>
                编辑
              </button>
              <button
                type="button"
                className="rounded-xl border border-[var(--border)] px-4 py-2.5 font-medium text-[var(--bad)] disabled:opacity-50"
                disabled={del.isPending}
                onClick={() => del.mutate(p.id)}
                aria-label={`删除政策 ${p.title}`}
              >
                删除
              </button>
            </div>
          </article>
        ))}
      </div>
      {editing && (
        <PolicyForm policy={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

function PolicyForm({ policy, onClose }: { policy: Policy | null; onClose: () => void }) {
  const refreshAll = useRefreshAll();
  const [city, setCity] = useState(policy?.city ?? "");
  const [title, setTitle] = useState(policy?.title ?? "");
  const [industries, setIndustries] = useState<string[]>(policy?.industries ?? []);
  const [benefit, setBenefit] = useState(policy?.benefit ?? "");
  const [threshold, setThreshold] = useState(policy?.threshold ?? "");
  const [deadline, setDeadline] = useState(policy?.deadline ?? "");
  const [sourceUrl, setSourceUrl] = useState(policy?.sourceUrl ?? "");
  const [err, setErr] = useState("");
  const cities = useQuery({ queryKey: ["cities"], queryFn: () => api.listCityProfiles({}) });

  const save = useMutation({
    mutationFn: () =>
      api.upsertPolicy({
        id: policy?.id ?? null,
        city: city.trim(),
        title: title.trim(),
        industries,
        benefit: benefit.trim(),
        threshold: threshold.trim(),
        deadline: deadline.trim(),
        sourceUrl: sourceUrl.trim(),
      }),
    onSuccess: () => {
      refreshAll();
      onClose();
    },
    onError: (e) => setErr(String(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!city.trim() || !title.trim()) {
      setErr("城市和政策名称必填");
      return;
    }
    save.mutate();
  };

  return (
    <Modal title={policy ? "编辑政策" : "录入政策"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="城市 *">
            <input aria-label="政策城市" className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} placeholder="如：合肥" list="policy-cities" />
            <datalist id="policy-cities">
              {(cities.data?.cities ?? []).map((c) => (
                <option key={c.city} value={c.city} />
              ))}
            </datalist>
          </Field>
          <Field label="截止时间">
            <input aria-label="截止时间" className={inputCls} value={deadline} onChange={(e) => setDeadline(e.target.value)} placeholder="如：2027-12-31" />
          </Field>
        </div>
        <Field label="政策名称 *">
          <input aria-label="政策名称" className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：合肥市新能源汽车产业扶持办法" />
        </Field>
        <TagInput label="适用产业（留空 = 不限产业）" values={industries} onChange={setIndustries} placeholder="输入产业后点添加，如：新能源汽车" />
        <Field label="能拿什么（扶持内容）">
          <textarea aria-label="扶持内容" className={inputCls} rows={2} value={benefit} onChange={(e) => setBenefit(e.target.value)} placeholder="如：设备投资补贴 10%，最高 2000 万元；厂房租金补贴三年" />
        </Field>
        <Field label="门槛">
          <input aria-label="申报门槛" className={inputCls} value={threshold} onChange={(e) => setThreshold(e.target.value)} placeholder="如：固定资产投资不低于 1 亿元" />
        </Field>
        <Field label="政策原文链接">
          <input aria-label="政策原文链接" className={inputCls} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="政府官网原文链接" />
        </Field>
        {err && <p className="text-sm text-[var(--bad)]">{err}</p>}
        <button type="submit" className={btnPrimary + " w-full"} disabled={save.isPending}>
          {save.isPending ? "保存中…" : "保存政策"}
        </button>
      </form>
    </Modal>
  );
}

// ---------- 我的 Tab ----------

function MineView() {
  const refreshAll = useRefreshAll();
  const [editingCity, setEditingCity] = useState<CityProfile | "new" | null>(null);
  const [fillMsg, setFillMsg] = useState("");
  const cities = useQuery({ queryKey: ["cities"], queryFn: () => api.listCityProfiles({}) });
  const runs = useQuery({ queryKey: ["runs"], queryFn: () => api.listRefreshRuns({ limit: 10 }) });
  const policiesQ = useQuery({ queryKey: ["policies"], queryFn: () => api.listPolicies({ city: "" }) });
  const fill = useMutation({
    mutationFn: () => api.completeReferenceData({}),
    onSuccess: (r) => {
      refreshAll();
      setFillMsg(
        r.updated + r.inserted > 0
          ? `已补全 ${r.updated} 个城市的成本档位${r.inserted > 0 ? `，补建 ${r.inserted} 个城市档案` : ""}。评分已按新档位计算。`
          : "参考数据已经齐全，没有需要补全的空缺。",
      );
    },
    onError: (e) => setFillMsg(`补全失败：${String(e)}`),
  });
  const cityList = cities.data?.cities ?? [];
  const costComplete = cityList.filter((c) => c.landCostLevel !== "" && c.laborCostLevel !== "").length;

  return (
    <div className="space-y-5">
      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm" aria-label="数据完整度">
        <h2 className="text-base font-bold">数据完整度</h2>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-[var(--surface-2)] py-3">
            <p className="text-2xl font-bold tabular-nums">{cityList.length}</p>
            <p className="mt-0.5 text-xs text-[var(--dim)]">城市档案</p>
          </div>
          <div className="rounded-xl bg-[var(--surface-2)] py-3">
            <p className="text-2xl font-bold tabular-nums">
              {costComplete}<span className="text-base text-[var(--dim)]">/{cityList.length}</span>
            </p>
            <p className="mt-0.5 text-xs text-[var(--dim)]">成本档位已补全</p>
          </div>
          <div className="rounded-xl bg-[var(--surface-2)] py-3">
            <p className="text-2xl font-bold tabular-nums">{policiesQ.data?.policies.length ?? "–"}</p>
            <p className="mt-0.5 text-xs text-[var(--dim)]">政策库条目</p>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-[var(--dim)]">
          成本档位是定性参考档（高 / 中高 / 中 / 低），只影响用地载体分，不含具体价格。
          补全只填空缺，不会覆盖你已经改过的档位；填错了随时在下方档案里改。
        </p>
        <button
          type="button"
          className={btnNavy + " mt-3 w-full"}
          disabled={fill.isPending}
          onClick={() => fill.mutate()}
          aria-label="补全城市成本参考档位"
        >
          {fill.isPending ? "补全中…" : "补全城市成本参考档位"}
        </button>
        {fillMsg && <p className="mt-2 text-sm leading-relaxed">{fillMsg}</p>}
      </section>

      <section aria-label="城市产业档案">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-bold">长三角城市产业档案</h2>
          <button type="button" className={btnNavy} onClick={() => setEditingCity("new")} aria-label="新增城市档案">
            + 新增城市
          </button>
        </div>
        <p className="mb-3 text-sm leading-relaxed text-[var(--dim)]">
          这是落地评分的依据：主导产业决定产业契合分，成本档位决定载体分。档位按当地实际补录，改完后所有评估立即按新档案计算。
        </p>
        <div className="space-y-3">
          {(cities.data?.cities ?? []).map((c) => (
            <article key={c.id} className="rounded-[var(--radius)] bg-[var(--surface)] p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <h3 className="text-lg font-bold">
                  {c.city} <span className="text-sm font-normal text-[var(--dim)]">{c.province}</span>
                </h3>
                <button type="button" className="text-sm font-medium text-[var(--accent)]" onClick={() => setEditingCity(c)} aria-label={`编辑 ${c.city} 档案`}>
                  编辑
                </button>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {c.industries.map((i) => (
                  <Chip key={i}>{i}</Chip>
                ))}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-[var(--dim)]">
                园区：{c.parks.length > 0 ? c.parks.join("、") : "待录入"} · 用地成本：{c.landCostLevel || "待录入"} · 人力成本：{c.laborCostLevel || "待录入"}
              </p>
              {c.note && <p className="mt-1 text-sm leading-relaxed">{c.note}</p>}
            </article>
          ))}
        </div>
      </section>

      <section aria-label="雷达刷新记录">
        <h2 className="mb-2 text-base font-bold">雷达刷新记录</h2>
        <p className="mb-2 text-sm leading-relaxed text-[var(--dim)]">
          每天 08:00、13:00、18:00 自动全量刷新一次（13 路公开数据源一起搜），也可在雷达页手动全量刷新。每次刷新只新增待核实候选，不会自动改动已确认的信号和项目；刷新记录的 note 会逐路写明每路新增几条。
        </p>
        {runs.isPending && <p className="text-[var(--dim)]">正在加载…</p>}
        {runs.data && runs.data.runs.length === 0 && <p className="text-sm text-[var(--dim)]">还没有刷新记录。</p>}
        <div className="space-y-2">
          {(runs.data?.runs ?? []).map((r) => (
            <div key={r.id} className="flex items-center justify-between rounded-xl bg-[var(--surface)] p-3 text-sm shadow-sm">
              <span>
                {fmtDateTime(r.createdAt)}
                <span className="ml-2 text-[var(--dim)]">{r.trigger === "scheduled" ? "定时" : "手动"}</span>
              </span>
              <span className="font-medium">新增 {r.addedCount} 条</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-[var(--radius)] bg-[var(--surface)] p-4 text-sm leading-relaxed text-[var(--dim)] shadow-sm" aria-label="评分模型说明">
        <h2 className="mb-1 text-base font-bold text-[var(--text)]">评分模型</h2>
        <p>
          阶段先行：信号先分意向 / 洽谈 / 已签约 / 已开工 / 已投产。确认后的信号就是「项目」里的线索：
          可招引的排在线索阶段，已签约及之后的落在签约 / 落地 / 投产位置。已签约及之后的项目落地城市已定，
          一律降级处理——不进最佳信号、不参与城市比选、不给出「建议引进」结论，只推配套招商、以商招商与二期扩产；
          阶段按来源证据判定（摘要写了已签约/拿地/开工/投产的按已落地处理），也可在信号详情里手工修正；
          线索在「项目」里可直接记跟进、推进阶段，推进会同步修正信号阶段。
          股市聚合（定增募投/互动易问答/调研纪要/在建工程）、融资、招聘、专利这几路是签约前信号，一律按意向/洽谈处理、
          风险分如实偏低并标注不确定性；环评公示则相反，选址已定，按已落地处理。
        </p>
        <p className="mt-2">
          硬过滤：企业产业不在城市主导产业目录内，直接判「暂不建议」。六维评分：产业契合 30、投资规模 20、
          产业链 15、用地载体 15、政策收益 10、风险（信号强度）10。结论分级：≥80 建议引进、65–79 重点跟进、
          50–64 观望、&lt;50 暂不建议。投资额只采用公开来源明确披露的数字，未披露时规模分按中性计并在报告中标注。
        </p>
      </section>

      {editingCity && (
        <CityProfileForm profile={editingCity === "new" ? null : editingCity} onClose={() => setEditingCity(null)} />
      )}
    </div>
  );
}

function CityProfileForm({ profile, onClose }: { profile: CityProfile | null; onClose: () => void }) {
  const refreshAll = useRefreshAll();
  const [city, setCity] = useState(profile?.city ?? "");
  const [province, setProvince] = useState(profile?.province ?? "");
  const [industries, setIndustries] = useState<string[]>(profile?.industries ?? []);
  const [parks, setParks] = useState<string[]>(profile?.parks ?? []);
  const [land, setLand] = useState(profile?.landCostLevel ?? "");
  const [labor, setLabor] = useState(profile?.laborCostLevel ?? "");
  const [note, setNote] = useState(profile?.note ?? "");
  const [err, setErr] = useState("");

  const save = useMutation({
    mutationFn: () =>
      api.upsertCityProfile({
        city: city.trim(),
        province: province.trim(),
        industries,
        parks,
        landCostLevel: land,
        laborCostLevel: labor,
        note: note.trim(),
      }),
    onSuccess: () => {
      refreshAll();
      onClose();
    },
    onError: (e) => setErr(String(e)),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!city.trim()) {
      setErr("城市名必填");
      return;
    }
    save.mutate();
  };

  return (
    <Modal title={profile ? `编辑 ${profile.city} 档案` : "新增城市档案"} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="城市 *">
            <input aria-label="城市名" className={inputCls} value={city} onChange={(e) => setCity(e.target.value)} disabled={profile != null} placeholder="如：嘉兴" />
          </Field>
          <Field label="省份">
            <input aria-label="省份" className={inputCls} value={province} onChange={(e) => setProvince(e.target.value)} placeholder="如：浙江省" />
          </Field>
        </div>
        <TagInput label="主导产业" values={industries} onChange={setIndustries} placeholder="如：集成电路" />
        <TagInput label="代表园区" values={parks} onChange={setParks} placeholder="如：嘉兴经开区" />
        <div className="grid grid-cols-2 gap-3">
          <Field label="用地成本档位">
            <select aria-label="用地成本档位" className={inputCls} value={land} onChange={(e) => setLand(e.target.value)}>
              {COST_LEVELS.map((l) => (
                <option key={l} value={l}>{l === "" ? "待录入" : l}</option>
              ))}
            </select>
          </Field>
          <Field label="人力成本档位">
            <select aria-label="人力成本档位" className={inputCls} value={labor} onChange={(e) => setLabor(e.target.value)}>
              {COST_LEVELS.map((l) => (
                <option key={l} value={l}>{l === "" ? "待录入" : l}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="备注">
          <textarea aria-label="城市备注" className={inputCls} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="如：港口优势，材料产业基础强" />
        </Field>
        {err && <p className="text-sm text-[var(--bad)]">{err}</p>}
        <button type="submit" className={btnPrimary + " w-full"} disabled={save.isPending}>
          {save.isPending ? "保存中…" : "保存档案"}
        </button>
      </form>
    </Modal>
  );
}

// ---------- App 外壳 ----------

type Tab = "radar" | "compare" | "projects" | "policies" | "mine";

const TABS: Array<{ key: Tab; label: string; icon: string }> = [
  { key: "radar", label: "雷达", icon: "M12 3a9 9 0 1 0 9 9M12 7a5 5 0 1 0 5 5M12 12l6.5-6.5M12 10.5A1.5 1.5 0 1 0 12 13.5 1.5 1.5 0 0 0 12 10.5Z" },
  { key: "compare", label: "比选", icon: "M4 20V10M10 20V4M16 20v-8M22 20H2" },
  { key: "projects", label: "项目", icon: "M4 5a1 1 0 0 1 1-1h4v16H5a1 1 0 0 1-1-1V5Zm7 0a1 1 0 0 1 1-1h4v16h-4a1 1 0 0 1-1-1V5Zm7 3a1 1 0 0 1 1-1h1v13h-1a1 1 0 0 1-1-1V8Z" },
  { key: "policies", label: "政策", icon: "M7 3h8l4 4v14H7zM15 3v4h4M10 12h5M10 16h5" },
  { key: "mine", label: "我的", icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("radar");
  const [signalId, setSignalId] = useState<number | null>(null);
  const [projectId, setProjectId] = useState<number | null>(null);
  const [report, setReport] = useState<{ signalId: number; city: string } | null>(null);

  const openSignal = (id: number) => setSignalId(id);
  const openProject = (id: number) => setProjectId(id);

  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)]">
      <SafeAreaTopScrim backgroundColor="var(--bg)" />
      <main className="mx-auto w-full max-w-3xl px-safe-offset-4 pb-safe-offset-28 pt-safe-offset-4">
        {tab === "radar" && (
          <RadarView onOpenSignal={openSignal} onGoProjects={() => setTab("projects")} />
        )}
        {tab === "compare" && (
          <CompareView onReport={(sid, city) => setReport({ signalId: sid, city })} />
        )}
        {tab === "projects" && (
          <ProjectsView onOpenProject={openProject} onOpenSignal={openSignal} />
        )}
        {tab === "policies" && <PoliciesView />}
        {tab === "mine" && <MineView />}
      </main>

      <nav
        className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-[var(--border)] bg-[var(--surface)] px-safe pb-safe"
        aria-label="主导航"
      >
        <div className="mx-auto grid max-w-3xl grid-cols-5">
          {TABS.map((t) => {
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                aria-current={active ? "page" : undefined}
                aria-label={t.label}
                className={`flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium ${active ? "text-[var(--accent)]" : "text-[var(--dim)]"}`}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d={t.icon} />
                </svg>
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      {signalId != null && (
        <SignalDetail
          signalId={signalId}
          onClose={() => setSignalId(null)}
          onReport={(sid, city) => setReport({ signalId: sid, city })}
        />
      )}
      {report && (
        <ReportView signalId={report.signalId} city={report.city} onClose={() => setReport(null)} />
      )}
      {projectId != null && (
        <ProjectDetail projectId={projectId} onClose={() => setProjectId(null)} />
      )}
    </div>
  );
}
