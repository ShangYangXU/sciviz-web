/** 摆放只看坐标，所以任何"有位置的东西"都能参与：工作流节点、画布批注都一样 */
export interface Positioned {
  position: { x: number; y: number }
  /**
   * 名义尺寸。省略 = 按算子节点那一档（216×150），与改动前的判据等价。
   * 表格与思维图能宽到 400+，不给尺寸就会让新落点压在它们身上。
   */
  size?: { w: number; h: number }
}

type ScreenToFlow = (point: { x: number; y: number }) => { x: number; y: number }

/**
 * 点选添加节点时的落点。
 *
 * 之前两个问题：
 * 1. 放在画布最右边（rightmost + 250），新节点常常落在可视区外，看不到也点不到
 * 2. 连续添加时错开量太小（26px），节点宽 216px，直接叠在一起、端口互相遮挡
 * 现在：从可视区中央起算，找第一个不与现有节点重叠的槽位。
 *
 * 节点库与画布上的"常用工具栏"共用这一份 —— 两处各写一遍，落点迟早不一样。
 *
 * **已知未修**（见 spec §16）：槽位只按世界坐标排，没考虑缩放。视口放大到 1.8 倍时
 * 一列四个槽位有三个落在屏幕外，连点几次就会有节点看不见；全并排的宽节点
 * （数据预览宽约 380，而列间距只有 260）也会横向重叠。两处都要按"实测尺寸"排布，
 * 属于画布布局的独立改动，不在这一批里混着做。
 */
export function nextNodePosition(
  screenToFlowPosition: ScreenToFlow,
  occupied: Positioned[],
  incoming: { w: number; h: number } = { w: 216, h: 150 },
): { x: number; y: number } {
  const host = document.querySelector('.canvas-host')?.getBoundingClientRect()
  const base = host
    ? screenToFlowPosition({ x: host.x + host.width / 2, y: host.y + host.height / 2 })
    : { x: 320, y: 260 }
  const origin = { x: base.x - 108, y: base.y - 90 }

  /*
   * 可视区在画布坐标下的范围。
   *
   * 加进来的东西必须**看得见**：落在视口外的节点/批注，用户会以为没加上，
   * 于是再点一次 —— 然后画布上凭空多了三个他看不见的节点。这条以前只是"槽位排得开一点"
   * 时不明显，批注（一张表格宽到 460）把它放大了：碰撞判据一收紧，第二、三个落点
   * 就被推到屏幕外去了。
   */
  const view = host
    ? {
        x0: screenToFlowPosition({ x: host.x, y: host.y }).x,
        y0: screenToFlowPosition({ x: host.x, y: host.y }).y,
        x1: screenToFlowPosition({ x: host.x + host.width, y: host.y + host.height }).x,
        y1: screenToFlowPosition({ x: host.x + host.width, y: host.y + host.height }).y,
      }
    : null
  const fitsView = (c: { x: number; y: number }) => {
    if (!view) return true
    // 要求整个盒子都在可视区内；盒子比视口还大时（缩得很小）退化成"中心在区内就行"
    if (incoming.w >= view.x1 - view.x0 || incoming.h >= view.y1 - view.y0) {
      return c.x > view.x0 && c.x < view.x1 && c.y > view.y0 && c.y < view.y1
    }
    // position 是节点的**左上角**（React Flow 的口径），所以盒子是 [c, c+尺寸]
    return (
      c.x > view.x0 &&
      c.x + incoming.w < view.x1 &&
      c.y > view.y0 &&
      c.y + incoming.h < view.y1
    )
  }

  /** 第一个不撞车的落点：可视区内的优先，实在没有才退回区外那个（总比丢了好） */
  let fallback: { x: number; y: number } | null = null

  for (let i = 0; i < 32; i++) {
    const cand = { x: origin.x + Math.floor(i / 4) * 260, y: origin.y + (i % 4) * 170 }
    /*
     * `position` 是左上角，所以"撞不上"的条件是**两边之差小于较宽那一个的宽度**
     * （谁在左边决定该看谁的宽度；取 max 是偏保守的那一侧 —— 宁可多让一点，
     * 也不要留一处重叠）。
     *
     * 两个算子节点（216×150）时阈值是 216 + 4 = 220、150 + 4 = 154 —— 与改动前那两条
     * 写死的 `220 / 150` 基本等价，所以算子的落点行为不变；只有批注这种宽东西会推远新落点。
     */
    const clash = occupied.some((n) => {
      const w = Math.max(n.size?.w ?? 216, incoming.w)
      const h = Math.max(n.size?.h ?? 150, incoming.h)
      return Math.abs(n.position.x - cand.x) < w + 4 && Math.abs(n.position.y - cand.y) < h + 4
    })
    if (clash) continue
    if (fitsView(cand)) return cand
    fallback ??= cand
  }
  return fallback ?? origin
}

/**
 * 批注的落点：接着上一条的**下方**排，放不下就换到它**右边**一列。
 *
 * 为什么不用上面那个格子式的 `nextNodePosition`：那条路只认识 216 宽的算子节点，
 * 而一张表格能量到 460 宽 —— 用猜的盒子算碰撞，第二、三条会被推到视口外
 * （实测：点了三下只看见第一下，剩下两条落在画布边上看不见的地方）。
 *
 * 这里直接量 DOM：真实尺寸就写在 `.react-flow__node` 的矩形上，不用估。
 * 量不到（上一条还没渲染出来）才退回格子摆放。
 */
export function nextAnnotationPosition(
  screenToFlowPosition: ScreenToFlow,
  previousId: string | null,
  incoming: { w: number; h: number },
  fallbackGrid: () => { x: number; y: number },
): { x: number; y: number } {
  const host = document.querySelector('.canvas-host')?.getBoundingClientRect()
  const el = previousId ? document.querySelector(`.react-flow__node[data-id="${previousId}"]`) : null
  if (!host || !el) return fallbackGrid()

  const view = {
    x0: screenToFlowPosition({ x: host.x, y: host.y }).x,
    y0: screenToFlowPosition({ x: host.x, y: host.y }).y,
    x1: screenToFlowPosition({ x: host.x + host.width, y: host.y + host.height }).x,
    y1: screenToFlowPosition({ x: host.x + host.width, y: host.y + host.height }).y,
  }
  const r = el.getBoundingClientRect()
  const prev0 = screenToFlowPosition({ x: r.left, y: r.top })
  const prev1 = screenToFlowPosition({ x: r.right, y: r.bottom })

  // position 是左上角，所以盒子是 [c, c + 尺寸]
  const fits = (c: { x: number; y: number }) =>
    c.x >= view.x0 && c.y >= view.y0 && c.x + incoming.w <= view.x1 && c.y + incoming.h <= view.y1

  const below = { x: prev0.x, y: prev1.y + 24 }
  if (fits(below)) return below
  const right = { x: prev1.x + 24, y: prev0.y }
  if (fits(right)) return right
  // 两个方向都放不下（视口太小或已经排满）：照排到下方 —— 看得见一半也比看不见强
  return below
}
