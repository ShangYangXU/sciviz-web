/**
 * 行级差异 —— 给人看的。
 *
 * 为什么自己写而不引一个库：需求只有一条 —— 把"这份工程文件改了哪几行"说清楚。
 * 工程文件几百行量级，朴素的 LCS 足够，而且没有依赖。
 *
 * 输出格式沿用大家看惯的那种（`-` 删、`+` 增、` ` 上下文），因为它就是
 * review 时最省眼力的形态：看到 `-` 和 `+` 就知道 agent 动了什么。
 */

/** 逐行比对。返回一段可直接打印的 diff；没有差异时返回空串 */
export function diffLines(before: string, after: string, context = 2): string {
  const a = before.split('\n')
  const b = after.split('\n')
  const lcs = longestCommonSubsequence(a, b)

  /** 逐行的标记：' ' 保留、'-' 只在前、'+' 只在后 */
  const marks: { sign: ' ' | '-' | '+'; text: string }[] = []
  let i = 0
  let j = 0
  for (const [ai, bi] of lcs) {
    while (i < ai) marks.push({ sign: '-', text: a[i++] })
    while (j < bi) marks.push({ sign: '+', text: b[j++] })
    marks.push({ sign: ' ', text: a[ai] })
    i = ai + 1
    j = bi + 1
  }
  while (i < a.length) marks.push({ sign: '-', text: a[i++] })
  while (j < b.length) marks.push({ sign: '+', text: b[j++] })

  const changed = marks.map((m) => m.sign !== ' ').some(Boolean)
  if (!changed) return ''

  // 只保留改动附近的行：整份文件贴出来，人反而不看
  const keep = new Array(marks.length).fill(false)
  for (let k = 0; k < marks.length; k++) {
    if (marks[k].sign === ' ') continue
    for (let d = -context; d <= context; d++) {
      const at = k + d
      if (at >= 0 && at < marks.length) keep[at] = true
    }
  }

  const out: string[] = []
  let lastKept = -2
  let skipped = 0
  for (let k = 0; k < marks.length; k++) {
    if (!keep[k]) {
      skipped++
      continue
    }
    if (skipped > 0 && lastKept >= 0) out.push(`  …（跳过 ${skipped} 行）`)
    skipped = 0
    lastKept = k
    out.push(`${marks[k].sign} ${marks[k].text}`)
  }
  return out.join('\n')
}

/** 最长公共子序列的下标对。工程文件这个量级，DP 就够了 */
function longestCommonSubsequence(a: string[], b: string[]): [number, number][] {
  const n = a.length
  const m = b.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs: [number, number][] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return pairs
}
