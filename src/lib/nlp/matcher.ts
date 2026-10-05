// Resolves the words a person typed ("wp", "white papers", "paper") to a real product.
// Deterministic and explainable. It never guesses: when it is not sure it says so,
// and the caller asks the person.
//
//   match      sure. Exact name or alias, or the typed words are all part of exactly one name.
//   confirm    one close spelling ("whte paper"). Ask "Did you mean ...?" before using it.
//   ambiguous  several products fit ("paper"). Ask which one.
//   none       nothing fits.

export interface MatchableProduct {
  id: string;
  name: string;
  /** Short names staff use, e.g. "wp". Only explicit aliases count, never automatic initials. */
  aliases: string[];
}

export type MatchResult<P extends MatchableProduct> =
  | { kind: "match"; product: P; via: "name" | "alias" | "partial" }
  | { kind: "confirm"; product: P }
  | { kind: "ambiguous"; candidates: P[] }
  | { kind: "none" };

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && /(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** Lowercase, punctuation to spaces, plurals reduced ("White-Papers" -> "white paper"). */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(singular)
    .join(" ");
}

/** Edit distance where swapping two neighbouring letters ("floarl") counts as one typo. */
function distance(a: string, b: string): number {
  let older: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        cur[j] = Math.min(cur[j], older[j - 2] + 1);
      }
    }
    older = prev;
    prev = cur;
  }
  return prev[b.length];
}

function ambiguous<P extends MatchableProduct>(list: P[]): MatchResult<P> {
  const unique = [...new Map(list.map((p) => [p.id, p])).values()];
  unique.sort((x, y) => x.name.localeCompare(y.name));
  return { kind: "ambiguous", candidates: unique.slice(0, 5) };
}

export function matchProduct<P extends MatchableProduct>(text: string, products: P[]): MatchResult<P> {
  const q = normalizeName(text);
  if (q === "") return { kind: "none" };

  const entries = products.map((p) => ({
    p,
    name: normalizeName(p.name),
    aliases: p.aliases.map(normalizeName).filter(Boolean),
  }));

  // 1. Exact name or alias.
  const exact = entries.filter((e) => e.name === q || e.aliases.includes(q));
  if (exact.length === 1) {
    return { kind: "match", product: exact[0].p, via: exact[0].name === q ? "name" : "alias" };
  }
  if (exact.length > 1) return ambiguous(exact.map((e) => e.p));

  // 2. Every word typed is a word of the product's name ("gold" -> "Gold Border").
  const words = q.split(" ");
  if (words.every((w) => w.length >= 2)) {
    const partial = entries.filter((e) => {
      const nameWords = e.name.split(" ");
      return words.every((w) => nameWords.includes(w));
    });
    if (partial.length === 1) return { kind: "match", product: partial[0].p, via: "partial" };
    if (partial.length > 1) return ambiguous(partial.map((e) => e.p));
  }

  // 3. A close spelling. Never used silently: the caller must confirm.
  const limit = q.length <= 4 ? 0 : q.length <= 8 ? 1 : 2;
  if (limit > 0) {
    let best = Infinity;
    let bestProducts: P[] = [];
    for (const e of entries) {
      const d = Math.min(distance(q, e.name), ...e.aliases.map((a) => distance(q, a)));
      if (d > limit) continue;
      if (d < best) {
        best = d;
        bestProducts = [e.p];
      } else if (d === best) {
        bestProducts.push(e.p);
      }
    }
    if (bestProducts.length === 1) return { kind: "confirm", product: bestProducts[0] };
    if (bestProducts.length > 1) return ambiguous(bestProducts);
  }

  return { kind: "none" };
}
