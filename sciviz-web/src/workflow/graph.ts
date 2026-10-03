/**
 * 图结构上的纯函数：这张图有没有环、这条线会不会让它成环。
 *
 * 为什么单独成文件：这两件事原先住在两个地方 —— 私有的 `findCycle` 在
 * `contract/validate.ts`，`wouldCreateCycle` 在 `workflow/executor.ts`。
 * 而 `executor.ts` 会 import store（它是界面资产辅助逻辑），**L1 校验器一旦复用它，
 * 就等于把 store 拖进契约层** —— R2 要求契约层能在 `node --test` 里直接跑。
 *
 * 所以判环这件事现在只有一份实现，住在不依赖任何东西的地方；谁要判环都来这儿拿。
 */

import type { Workflow } from './types'

/**
 * 找出一个环，返回环上的节点 id 序列（首尾相接，如 `['a', 'b', 'a']`）。
 *
 * 深度优先、按节点顺序走：结果对同一张图是稳定的 —— 界面拒绝一条线时给出的
 * 那句话，与校验器事后看同一张图时给出的那句话因此能一字不差。
 */
export function findCycle(workflow: Workflow): string[] | null {
  const out = new Map<string, string[]>()
  for (const n of workflow.nodes) out.set(n.id, [])
  for (const e of workflow.edges) {
    if (!out.has(e.source) || !out.has(e.target)) continue
    out.get(e.source)!.push(e.target)
  }

  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const n of workflow.nodes) color.set(n.id, WHITE)
  const stack: string[] = []

  const walk = (id: string): string[] | null => {
    color.set(id, GRAY)
    stack.push(id)
    for (const next of out.get(id) ?? []) {
      const c = color.get(next)
      if (c === GRAY) {
        // 环 = 栈里从 next 到栈顶这一段
        const at = stack.indexOf(next)
        return [...stack.slice(at), next]
      }
      if (c === WHITE) {
        const hit = walk(next)
        if (hit) return hit
      }
    }
    stack.pop()
    color.set(id, BLACK)
    return null
  }

  for (const n of workflow.nodes) {
    if (color.get(n.id) === WHITE) {
      const hit = walk(n.id)
      if (hit) return hit
    }
  }
  return null
}

/** 把环写成一句人话：`表 → 分帧 → 表`。用节点名，不用 id —— 这句话是给人看的 */
export function cyclePath(workflow: Workflow, cycle: string[]): string {
  const label = new Map(workflow.nodes.map((n) => [n.id, n.label]))
  return cycle.map((id) => label.get(id) ?? id).join(' → ')
}

export interface GraphFocus {
  /** 亮着的节点（含焦点自己） */
  nodes: Set<string>
  /** 亮着的连线 */
  edges: Set<string>
}

/**
 * 从一个节点出发的"关系网"：沿有向边往上、往下各走多少层。
 *
 * `depth = 1` 只拿直接相连的邻居（鼠标划过时的预览）；`depth = Infinity` 拿到整条链
 * （点一下锁定看的那种）。方向是**有向**的：上游=能走到它的那些、下游=它能走到的那些，
 * 两者合起来才是"这个块在流程里的位置"。
 *
 * 为什么放在这里：和判环一样，这是**纯图算法**，界面（画布）与将来的任何视图都用同一份。
 * 也是同一个理由 —— 它不能依赖 store，否则要用它的地方就得先有界面。
 *
 * 环安全：手改 YAML 能造出环，`visited` 保证不会转圈。
 */
export function graphFocus(workflow: Workflow, nodeId: string, depth = Infinity): GraphFocus {
  const nodes = new Set<string>([nodeId])
  const edges = new Set<string>()
  const known = new Set(workflow.nodes.map((node) => node.id))
  if (!known.has(nodeId) || depth <= 0) return { nodes, edges }

  let frontier = [nodeId]
  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: string[] = []
    for (const id of frontier) {
      for (const edge of workflow.edges) {
        const other = edge.source === id ? edge.target : edge.target === id ? edge.source : null
        // 悬空连线（指向不存在的节点）不算数：画布上一个不存在的节点也不该被点亮
        if (!other || !known.has(other)) continue
        edges.add(edge.id)
        if (nodes.has(other)) continue
        nodes.add(other)
        next.push(other)
      }
    }
    frontier = next
  }
  return { nodes, edges }
}
