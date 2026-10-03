import { useWorkflowStore } from '../store/useWorkflowStore'
import { useEngineInfo } from '../store/nodeOutputStore'
import { useBackendKind } from '../engine/useBackendKind'
import { ProjectFileBar } from './ProjectFileBar'

interface Props {
  onOpenYaml: (mode: 'export' | 'import') => void
  onOpenImport: () => void
  workspaceView: 'canvas' | 'chat'
  onOpenCanvas: () => void
  onOpenChat: () => void
  onOpenReports: () => void
  fixedDatasetState: null | {
    state: 'loading';
    progress: { phase: string; ratio: number }
  } | { state: 'ready'; rowCount: number } | { state: 'error'; message: string }
  onRetryFixedDataset: () => void
}

export function TopBar({
  onOpenYaml,
  onOpenImport,
  workspaceView,
  onOpenCanvas,
  onOpenChat,
  onOpenReports,
  fixedDatasetState,
  onRetryFixedDataset,
}: Props) {
  const workflow = useWorkflowStore((s) => s.workflow)
  const renameWorkflow = useWorkflowStore((s) => s.renameWorkflow)
  const isRunning = useWorkflowStore((s) => s.isRunning)
  const runWorkflow = useWorkflowStore((s) => s.runWorkflow)
  const cancelRun = useWorkflowStore((s) => s.cancelRun)

  return (
    <header className={`topbar${workspaceView === 'chat' ? ' chat-view' : ''}`}>
      <div className="brand">
        <strong>SciViz</strong>
        <span>实验工作流平台</span>
      </div>

      <div className="workspace-switcher" role="tablist" aria-label="工作区视图">
        <button
          type="button"
          role="tab"
          aria-selected={workspaceView === 'canvas'}
          className={workspaceView === 'canvas' ? 'active' : ''}
          onClick={onOpenCanvas}
          title="查看并人工编辑工作流画布"
        >
          画布
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={workspaceView === 'chat'}
          className={workspaceView === 'chat' ? 'active' : ''}
          onClick={onOpenChat}
          title="打开当前项目的独立 AI 对话工作区"
        >
          AI 工作区
        </button>
      </div>

      <div className="topbar-sep" />
      {workspaceView === 'chat' ? (
        <div className="topbar-chat-project" title={workflow.name}>
          <span>当前项目</span>
          <strong>{workflow.name || '未命名工作流'}</strong>
          <small>{workflow.nodes.length} 节点 · {workflow.edges.length} 连线</small>
        </div>
      ) : (
        <div className="topbar-group" style={{ flex: 1, minWidth: 0 }}>
          <label>工作流</label>
          <input
            type="text"
            className="wf-name-input"
            value={workflow.name}
            onChange={(e) => renameWorkflow(e.target.value)}
          />
          <span className="wf-count">
            {workflow.nodes.length} 节点 · {workflow.edges.length} 连线
          </span>
        </div>
      )}

      <div className={workspaceView === 'chat' ? 'topbar-spacer' : 'topbar-sep'} />

      <div className="topbar-group" style={{ display: workspaceView === 'canvas' ? undefined : 'none' }}>
        <button className="primary" onClick={onOpenImport}>
          导入数据
        </button>
      </div>
      <div className="topbar-group topbar-project-actions">
        <ProjectFileBar />
        <button type="button" onClick={onOpenReports} title="查看当前项目的全部实验报告">项目报告</button>
      </div>
      <div className="topbar-group" style={{ display: workspaceView === 'canvas' ? undefined : 'none' }}>
        <button onClick={() => onOpenYaml('import')}>导入 YAML</button>
        <button onClick={() => onOpenYaml('export')}>导出 YAML</button>
      </div>

      {workspaceView === 'canvas' && (
        <>
          <div className="topbar-sep" />

          {fixedDatasetState && (
            <FixedDatasetChip state={fixedDatasetState} onRetry={onRetryFixedDataset} />
          )}

          <EngineChip />

          {isRunning ? (
            <button className="danger" onClick={cancelRun}>
              停止执行
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => void runWorkflow()}
              title="运行所有需要手动触发的节点（特征 / 划分 / 模型 / 评估）。数据面上的节点是实时算的，不需要运行"
            >
              运行
            </button>
          )}
        </>
      )}
    </header>
  )
}

function FixedDatasetChip({ state, onRetry }: { state: NonNullable<Props['fixedDatasetState']>; onRetry: () => void }) {
  if (state.state === 'loading') {
    const percent = Math.round(state.progress.ratio * 100)
    return (
      <span className="engine-chip fixed-dataset-status" title={`固定数据集正在${state.progress.phase}`}>
        {state.progress.phase === '读取固定数据集' ? 'Sheet1 读取中…' : `Sheet1 ${state.progress.phase} ${percent}%`}
      </span>
    )
  }
  if (state.state === 'ready') {
    return (
      <span className="engine-chip ok fixed-dataset-status" title="固定数据集已加入数据列表；新建数据源可直接使用">
        Sheet1 已就绪 · {state.rowCount.toLocaleString('zh-CN')} 行
      </span>
    )
  }
  return (
    <button
      className="engine-chip bad fixed-dataset-status fixed-dataset-retry"
      onClick={onRetry}
      title={`${state.message}。点击重新读取固定数据集。`}
    >
      Sheet1 未加载 · 点击重试
    </button>
  )
}

/**
 * 执行引擎的状态。
 *
 * 必须常驻可见：数据面上的节点现在靠它出数，引擎没起来的话，
 * 界面上那些"等待上游求值"就成了无解的谜。
 *
 * 三件事分开说，因为它们互相独立：**选址**（这一页用宿主还是浏览器引擎）、
 * **连接**（选中的那个连上没有）、**这一轮**（有没有东西在算）。此前只有一个
 * `cold` 状态被渲染成"引擎未启动"——一句关于宿主的断言，而 `cold` 说的其实是
 * "这一页还没请求过引擎"。空画布上二者恰好相反：宿主在跑，界面却宣布它没启动。
 */
function EngineChip() {
  const { status, detail } = useEngineInfo()
  const backend = useBackendKind()
  const where = backend === 'local' ? '本地宿主' : backend === 'pyodide' ? '浏览器引擎' : null

  if (status === 'ready') {
    return (
      <span className="engine-chip ok" title={`执行引擎就绪${where ? `（${where}）` : ''}：${detail}`}>
        {`引擎就绪${where ? ` · ${where}` : ''}`}
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className="engine-chip bad" title={detail}>
        引擎不可用
      </span>
    )
  }
  if (status === 'loading') {
    return <span className="engine-chip" title={detail}>{`引擎加载中${detail ? `：${detail}` : ''}`}</span>
  }
  /*
   * 还没开始算（cold）。这时能说的只有"选了谁、还没连上"：
   * - 浏览器引擎按需加载，第一个要算的节点出现时才动手 —— 这句话就是全部事实；
   * - 本地宿主在正常路径上会由 `primeBackend` 连上，停在这里说明正在握手；
   * - 还没选址 = 正在探活（900ms 内给结论）。
   */
  if (backend === 'pyodide') {
    return (
      <span className="engine-chip" title="浏览器引擎（Pyodide）按需加载：出现第一个需要计算的节点时才开始">
        浏览器引擎待命 · 按需加载
      </span>
    )
  }
  if (backend === 'local') {
    return (
      <span className="engine-chip" title="正在连接本地执行宿主">
        正在连接本地宿主
      </span>
    )
  }
  return (
    <span className="engine-chip" title="正在探测本机有没有可用的执行宿主">
      正在检查执行环境
    </span>
  )
}
