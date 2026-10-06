import Decimal from "@/lib/decimal";
import type { GroupView } from "@/lib/classify/classifier";
import type { Category } from "@/lib/classify/types";

// "매칭으로 줄인 세금": 내 계정 간 이체로 짝지은 이동을 짝짓지 않았다고 가정한 분류를 만든다.
// 보낸 쪽 = 외부로 보냄(시가로 양도), 받은 쪽 = 외부에서 받음(취득가 0원) — 짝을 못 찾았을 때 앱의 기본 정책과 같다.
// 같은 계정 안에서 자기에게 보낸 것(한 계정, 한 위치)은 원래부터 짝지을 필요가 없으므로 그대로 둔다.

export function unmatchedCounterfactual(groups: GroupView[]): { groups: GroupView[]; matched: number } {
  const out: GroupView[] = [];
  let matched = 0;
  for (const g of groups) {
    const c = g.classification;
    if (c.category !== "internal_transfer") {
      out.push(g);
      continue;
    }
    const legs = g.entries.filter((e) => e.kind !== "fee");
    const sides = new Map<string, typeof g.entries>();
    for (const e of g.entries) sides.set(`${e.sourceId}|${e.location}`, [...(sides.get(`${e.sourceId}|${e.location}`) ?? []), e]);
    const crossAccount = sides.size > 1 || c.rule === "R11" || c.rule === "R5";
    if (!crossAccount || legs.length === 0) {
      out.push(g);
      continue;
    }
    matched += c.rule === "R11" ? 0.5 : 1; // R11은 보낸 쪽·받은 쪽이 따로 묶여 있어 둘이 한 건
    // 계정·위치마다 나눠 각자 순방향으로 외부 입출금이 된다
    for (const [side, entries] of sides) {
      const net = entries.filter((e) => e.kind !== "fee").reduce((s, e) => s.plus(e.amount), new Decimal(0));
      const category: Category = net.isNegative() ? "external_out" : net.isPositive() ? "external_in" : "fee_only";
      const key = `${g.key}#${side}`;
      out.push({
        ...g,
        key,
        entries,
        time: Math.min(...entries.map((e) => e.time)),
        classification: { key, category, status: "needs_review", rule: "가정", reason: "짝짓지 않았다고 가정" },
      });
    }
  }
  return { groups: out, matched: Math.round(matched) };
}
