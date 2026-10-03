import { useMemo } from 'react'
import { useReactFlow } from '@xyflow/react'
import { nextNodePosition } from './placement'
import { allNodeDefs } from '../workflow/nodeRegistry'
import { categoryMeta, type NodeTypeDef } from '../workflow/types'
import { useWorkflowStore } from '../store/useWorkflowStore'
import { useModuleStore } from '../store/useModuleStore'
import { isUserModuleType } from '../workflow/userModules'

/**
 * 常用工具栏：把反复用到的模块钉在画布左上角，点一下就落到视口中央。
 *
 * 放在画布而不是节点库里，是因为它的价值是"不用找" ——
 * 如果还要先去左栏展开分组，那和翻节点库没有区别。
 */
export function FavoriteBar() {
  const favorites = useModuleStore((s) => s.favorites)
  const customModules = useModuleStore((s) => s.modules)
  const toggleFavorite = useModuleStore((s) => s.toggleFavorite)
  const openEditor = useModuleStore((s) => s.openEditor)
  const nodes = useWorkflowStore((s) => s.workflow.nodes)
  const addNode = useWorkflowStore((s) => s.addNode)
  const { screenToFlowPosition } = useReactFlow()

  /*
   * 自建模块清单变了（新建 / 删除 / 改代码），这条栏要跟着重算 ——
   * allNodeDefs() 是现取的，依赖数组里必须挂着 customModules 才能触发重算，
   * 否则删掉一个自建模块后，常用栏里那个按钮会一直显示到下次别的状态变化为止。
   */
  const pinned: NodeTypeDef[] = useMemo(() => {
    void customModules
    const byType = new Map(allNodeDefs().map((d) => [d.type, d]))
    // 已经不存在的 type 直接跳过：删了模块还留个点不动的空按钮，比不显示更糟
    return favorites.map((t) => byType.get(t)).filter((d): d is NodeTypeDef => !!d)
  }, [favorites, customModules])

  const add = (type: string) => addNode(type, nextNodePosition(screenToFlowPosition, nodes))

  return (
    <div className="fav-bar">
      <span className="fav-bar-label">常用</span>

      {pinned.length === 0 ? (
        <span className="fav-bar-empty">在左侧节点库点 ★ 把模块钉在这里</span>
      ) : (
        pinned.map((d) => {
          const cat = categoryMeta[d.category]
          return (
            <span className="fav-chip" key={d.type}>
              <button
                className="fav-chip-main"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => add(d.type)}
                title={`${d.description}\n\n点击加到视口中央`}
              >
                <span className="cat-dot" style={{ background: cat.color }} />
                {d.label}
                {isUserModuleType(d.type) && <span className="fav-chip-tag">自建</span>}
              </button>
              <button
                className="fav-chip-x"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleFavorite(d.type)}
                title="从常用栏移除（模块本身还在节点库里）"
              >
                ×
              </button>
            </span>
          )
        })
      )}

      <button
        className="fav-new"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => openEditor(null)}
        title="定义一个自己的模块：起个名字、写一段 Python，形参自动成为输入端口"
      >
        ＋ 模块
      </button>
    </div>
  )
}
