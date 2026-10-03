import { useEffect, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { TopBar } from './components/TopBar'
import { NodeLibrary } from './components/NodeLibrary'
import { WorkflowCanvas } from './canvas/WorkflowCanvas'
import { ParamPanel } from './components/ParamPanel'
import { AssetPanel } from './components/AssetPanel'
import { NotebookPanel } from './components/NotebookPanel'
import { ReportPanel } from './components/ReportPanel'
import { FloatingReportWindow, type ReportWindowMode } from './components/FloatingReportWindow'
import { RunLog } from './components/RunLog'
import { YamlDialog } from './components/YamlDialog'
import { ImportDialog } from './components/ImportDialog'
import { ModuleDialog } from './components/ModuleDialog'
import { ChatPanel } from './components/ChatPanel'
import { usePrimarySelectedId, useWorkflowStore } from './store/useWorkflowStore'
import { useModuleStore } from './store/useModuleStore'
import { startEngineRunner } from './engine/graphRunner'
import { localEngineUrl } from './engine/localClient'
import { FIXED_DATASET_ID, fixedDatasetLoader } from './data/fixedDataset'
import { useDataStore } from './store/useDataStore'
import { startLiveCanvasBridge } from './agent/liveCanvasBridge'
import type { ImportProgress } from './data/importCsv'

type FixedDatasetUiState =
  | { state: 'loading'; progress: ImportProgress }
  | { state: 'ready'; rowCount: number }
  | { state: 'error'; message: string }

type WorkspaceView = 'canvas' | 'chat'

/** 右侧栏入口清单写一处：收起态（竖排窄边）与展开态（横排标签）都从它来 */
const RIGHT_TABS: { id: 'params' | 'assets' | 'notebook' | 'reports' | 'chat'; label: string; title: string }[] = [
  { id: 'params', label: '节点参数', title: '选中节点后在这里改参数' },
  { id: 'assets', label: '资产库', title: '跑出来的数据集、图与模型制品' },
  { id: 'notebook', label: '实验笔记', title: '实验笔记：Markdown 记录，粘贴图片，引用画布上的块' },
  { id: 'reports', label: '项目报告', title: '在浮窗中查看和管理随当前 .sciviz 工程保存的 Markdown 报告' },
  { id: 'chat', label: '只读问答', title: '在画布旁读取当前工程并回答问题，不修改或运行工程' },
]

export default function App() {
  const [yamlMode, setYamlMode] = useState<null | 'export' | 'import'>(null)
  const [importOpen, setImportOpen] = useState(false)
  /** Codex 式项目工作区：对话与画布是两个平级视图，不再把对话当成右栏附件。 */
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(() => (
    localStorage.getItem('sciviz.workspaceView') === 'chat' ? 'chat' : 'canvas'
  ))
  const [rightTab, setRightTab] = useState<'params' | 'assets' | 'notebook' | 'reports' | 'chat'>('params')
  const [reportWindowMode, setReportWindowMode] = useState<ReportWindowMode>('closed')
  const openReportWindow = () => setReportWindowMode('normal')
  /**
   * 右侧栏能不能收起来。
   *
   * 收起只留一条窄边（标签竖着排）：**点哪个就直接展开到对应页面**，
   * 而不是"先展开、再找标签"。这是画布优先的做法 —— 平时它不该占着 330px。
   * 选择记在 localStorage：它是看界面的习惯，不是这份工程的内容。
   */
  const [rightCollapsed, setRightCollapsed] = useState(
    () => localStorage.getItem('sciviz.rightPanel') === 'collapsed',
  )
  const setRightPanel = (collapsed: boolean) => {
    localStorage.setItem('sciviz.rightPanel', collapsed ? 'collapsed' : 'open')
    setRightCollapsed(collapsed)
  }
  const switchWorkspace = (view: WorkspaceView) => {
    localStorage.setItem('sciviz.workspaceView', view)
    setWorkspaceView(view)
  }
  const openRightTab = (tab: 'params' | 'assets' | 'notebook' | 'reports' | 'chat') => {
    if (tab === 'reports') {
      openReportWindow()
      return
    }
    setRightTab(tab)
    setRightPanel(false)
  }
  useEffect(() => {
    const openReport = () => {
      openReportWindow()
    }
    window.addEventListener('sciviz-open-report', openReport)
    return () => window.removeEventListener('sciviz-open-report', openReport)
  }, [])
  /**
   * AI 对话是不是正待在独立窗口里。
   *
   * 独立窗口承载的是**同一个** ChatPanel（portal），所以它的开合只该由人决定：
   * 点「回到主窗口」，或者关掉那个窗口。页签切换、点画布上的块都不算 ——
   * 这个标志就是那条边界，用来挡住"顺手把对话拉回右栏"的动作。
   */
  const [chatDetached, setChatDetached] = useState(false)
  useEffect(() => {
    const onChatDetached = (event: Event) => {
      const detached = (event as CustomEvent<{ detached?: boolean }>).detail?.detached !== false
      setChatDetached(detached)
      if (detached) {
        // 弹窗是独立对话面，主窗口让出空间回到画布，方便人边看图边继续对话。
        // 右栏收起仍是临时状态，不写 localStorage —— 弹窗不该改人的布局偏好。
        setRightCollapsed(true)
        switchWorkspace('canvas')
      } else {
        // 关掉弹窗（含浏览器的 ×）或点了「回到主窗口」：回到独立 Agent 工作区，
        // 同时让隐藏的画布面板恢复展开，旧的右栏入口和回归测试仍保持可用。
        setRightCollapsed(false)
        setRightTab('chat')
        switchWorkspace('chat')
      }
    }
    window.addEventListener('sciviz-chat-detached', onChatDetached)
    return () => window.removeEventListener('sciviz-chat-detached', onChatDetached)
  }, [])
  const [fixedDatasetState, setFixedDatasetState] = useState<FixedDatasetUiState | null>(null)

  // 执行引擎的调度器：订阅画布与数据的变化，把数据面上的节点实时算出来。
  // 它只在真的需要求值时才会去加载 Pyodide，所以这里启动没有启动成本。
  useEffect(() => startEngineRunner(), [])

  // 外部 MCP 通过本机宿主转发到当前页面；页面只执行 liveCanvasBridge 的固定动作。
  useEffect(() => startLiveCanvasBridge({
    activateCanvas: () => {
      localStorage.setItem('sciviz.workspaceView', 'canvas')
      setWorkspaceView('canvas')
    },
  }), [])

  const loadFixedDataset = () => {
    setFixedDatasetState({ state: 'loading', progress: { phase: '准备读取', ratio: 0 } })
    void fixedDatasetLoader
      .load((progress) => setFixedDatasetState({ state: 'loading', progress }))
      .then((dataset) => {
        const existing = useDataStore.getState().imported.find((item) => item.id === FIXED_DATASET_ID)
        if (!existing) useDataStore.getState().addImported(dataset)
        setFixedDatasetState({ state: 'ready', rowCount: existing?.rowCount ?? dataset.rowCount })
      })
      .catch((error: unknown) => {
        setFixedDatasetState({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })
  }

  // 桌面入口带 ?engine=local。其他网页/开发模式不依赖这份本机固定数据。
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('engine') !== 'local') return
    let alive = true
    void fetch(`${localEngineUrl()}/health`)
      .then((response) => response.ok ? response.json() as Promise<{ fixedDatasetConfigured?: boolean }> : null)
      .then((health) => { if (alive && health?.fixedDatasetConfigured) loadFixedDataset() })
      .catch(() => { /* 宿主状态由已有引擎状态栏呈现；可选预载不阻断启动。 */ })
    return () => { alive = false }
  }, [])

  const selectedNodeId = usePrimarySelectedId()
  // 定义模块弹窗的开关挂在 module store 上：画布上的常用工具栏与左侧节点库
  // 都要能打开它，从 App 往下传两层反而更绕
  const editorOpen = useModuleStore((s) => s.editorOpen)
  const editingType = useModuleStore((s) => s.editingType)
  const runAssetCount = useWorkflowStore((s) => {
    const active = s.runs.find((r) => r.id === s.activeRunId)
    return active?.assets.length ?? 0
  })

  /**
   * 选中节点时自动切到参数页，符合"点节点是为了改参数"的直觉 ——
   * 但只在右栏真的看得见的时候切。
   *
   * 右栏收着的时候切页签，人当时看不见，代价却落在他展开右栏的那一刻：当前页被顶掉了。
   * 对话在独立窗口里时更直接：点一个块等于把「AI 对话」这一页换掉，人一回来就得重新找。
   * 只在 selectedNodeId 变化时运行：换页或展开右栏不应因上一次选中的节点抢回参数页。
   * effect 执行时读取当前页签；若当前是只读问答，选中块也不应打断对话。
   */
  useEffect(() => {
    if (!selectedNodeId) return
    if (workspaceView !== 'canvas' || rightCollapsed || rightTab === 'chat' || chatDetached) return
    setRightTab('params')
  }, [selectedNodeId])

  return (
    <div className="app">
      <TopBar
        onOpenYaml={setYamlMode}
        onOpenImport={() => setImportOpen(true)}
        fixedDatasetState={fixedDatasetState}
        onRetryFixedDataset={loadFixedDataset}
        workspaceView={workspaceView}
        onOpenCanvas={() => switchWorkspace('canvas')}
        onOpenChat={() => {
          setRightTab('chat')
          switchWorkspace('chat')
        }}
        onOpenReports={openReportWindow}
      />

      <ReactFlowProvider>
        <div className="workspace-stage">
          <div className="canvas-workspace" hidden={workspaceView !== 'canvas'}>
            <div
              className={`app-main${rightCollapsed ? ' right-collapsed' : ''}${
                    !rightCollapsed && rightTab === 'notebook' ? ' notebook-open' :
                  !rightCollapsed && rightTab === 'chat' ? ' chat-sidebar-open' : ''
              }`}
            >
              <NodeLibrary />

              <WorkflowCanvas />

              <aside
                className={`panel right${rightCollapsed ? ' collapsed' : ''}`}
                aria-label="右侧栏"
              >
            {/*
              收起态：一条窄边，三个标签竖着排。点哪个直接展开到哪一页 ——
              "想要直接点开"就是这一步不能分两次。

              展开态的内容**始终挂载**，收起时只是 hidden：这样收起再展开，
              笔记里的编辑/预览、展开的大纲都还在原处（卸载会把这些状态一起丢掉）。
            */}
            <div className="panel-rail" hidden={!rightCollapsed}>
              <button
                type="button"
                className="panel-rail-toggle"
                title="展开右侧栏"
                aria-label="展开右侧栏"
                onClick={() => setRightPanel(false)}
              >
                ‹
              </button>
              {RIGHT_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  className={`panel-rail-tab${rightTab === tab.id ? ' on' : ''}`}
                  aria-label={tab.label}
                  title={tab.id === 'reports' ? '打开项目报告浮窗' : `展开并切到「${tab.label}」`}
                  onClick={() => openRightTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
              <button
                type="button"
                className="panel-rail-toggle"
                title="收起右侧栏"
                aria-label="收起右侧栏"
                onClick={() => setRightPanel(true)}
              >
                ›
              </button>
            </div>
                <div className="panel-main" hidden={rightCollapsed}>
                  <div className="tab-row panel-tabs">
                    {RIGHT_TABS.map((tab) => (
                      <button
                        key={tab.id}
                        className={rightTab === tab.id ? 'tab active' : 'tab'}
                        onClick={() => {
                          if (tab.id === 'reports') openReportWindow()
                          else setRightTab(tab.id)
                        }}
                        title={tab.title}
                      >
                        {tab.label}
                        {tab.id === 'assets' && runAssetCount > 0 && (
                          <span className="tab-badge">{runAssetCount}</span>
                        )}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="panel-collapse"
                      title="收起右侧栏（点窄边上的标签可直接展开回来）"
                      aria-label="收起右侧栏"
                      onClick={() => setRightPanel(true)}
                    >
                      ›
                    </button>
                  </div>
                  {rightTab === 'params' && <ParamPanel />}
                  {rightTab === 'assets' && <AssetPanel />}
                  {rightTab === 'notebook' && <NotebookPanel />}
                  <div className="chat-sidebar-host" hidden={rightTab !== 'chat'}>
                    <ChatPanel mode="sidebar" hidden={rightTab !== 'chat' || rightCollapsed || workspaceView !== 'canvas'} />
                  </div>
                </div>
              </aside>
            </div>
          </div>
          <div className="chat-workspace-view" hidden={workspaceView !== 'chat'}>
            <ChatPanel mode="workspace" onReturnToCanvas={() => switchWorkspace('canvas')} />
          </div>
        </div>
      </ReactFlowProvider>

      {workspaceView === 'canvas' && <RunLog />}

      <FloatingReportWindow mode={reportWindowMode} onModeChange={setReportWindowMode}>
        <ReportPanel />
      </FloatingReportWindow>

      {yamlMode && <YamlDialog mode={yamlMode} onClose={() => setYamlMode(null)} />}
      {importOpen && <ImportDialog onClose={() => setImportOpen(false)} />}
      {/* key 让"新建"与"编辑某个模块"之间切换时表单重新初始化 */}
      {editorOpen && <ModuleDialog key={editingType ?? 'new'} />}
    </div>
  )
}
