/**
 * 给 TypeScript 一侧用的类型声明。
 *
 * 脚本本身刻意保持 `.mjs`：这样 `node scripts/gen-operator-hashes.mjs` 直接能跑，
 * 不依赖 tsx（CI 只装 Node 是最省事的）。但有 TS 测试要 import 它来验证
 * "生成物是不是最新"，所以要补这份声明，而不是在测试里加 ts-ignore。
 */

export interface SourceHashes {
  /** 节点类型 → 实现哈希 */
  hashes: Record<string, string>
  /** 该文件模块上下文（imports 与模块级常量）的哈希 */
  contextHash: string
}

export interface ComputedHashes {
  hashes: Record<string, string>
  moduleHashes: Record<string, string>
  sources: string[]
}

/** 从一份 Python 源码算出算子哈希。测试用它喂合成源码 */
export function hashOperatorsFromSource(text: string): SourceHashes

/** 算出全部算子的实现哈希（读真实的算子文件） */
export function computeOperatorHashes(): Promise<ComputedHashes>

/** 渲染成 TypeScript 源文本 */
export function render(computed: ComputedHashes): string

/** compute + render */
export function generate(): Promise<string>

/** 生成物路径：src/contract/operatorHashes.generated.ts */
export const OUTPUT_PATH: string
