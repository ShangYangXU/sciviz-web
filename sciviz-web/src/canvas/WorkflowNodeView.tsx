import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useEffect, useState } from 'react'
import { getNodeTypeDef } from '../workflow/nodeRegistry'
import { resolvePorts } from '../workflow/ports'
import { usePortContext } from '../engine/portContext'
import { useWorkflowStore } from '../store/useWorkflowStore'
import { useNodeRefs, useNodeRuntime, useNodeOutputStore } from '../store/nodeOutputStore'
import { isEngineNode, trainingIdentity } from '../engine/plan'
import { useBackendKind } from '../engine/useBackendKind'
import { ProbePanel } from './ProbePanel'
import { TrainingCurve } from './TrainingCurve'
import { ChartPreview } from './ChartPreview'
import { formatNumber } from '../utils/stats'
import type { OutputRef } from '../engine/protocol'
import { WORKFLOW_GROUP_TYPE } from '../workflow/groups'
import {
  categoryMeta,
  portTypeMeta,
  type NodeRunStatus,
  type WorkflowNode,
} from '../workflow/types'

export interface ScivizNodeData extends Record<string, unknown> {
  node: WorkflowNode
  /** 组内节点的运行时身份带有完整组路径；所有输出与运行状态都按它查询。 */
  runtimeNodeId: string
  status: NodeRunStatus
  durationMs?: number
  /** 已接线的输入端口 id，用于把参数行切成"接线中/手填"两种状态 */
  connectedPorts: string[]
  /** 输入端口 id → 上游列名（仅当上游是数据源时有值） */
  upstreamLabels: Record<string, string>
  /** 数据预览节点要显示的上游。探针显示的一律是上游的输出，不是它自己的 */
  probe?: { upstreamNodeId: string; upstreamPortId: string; upstreamLabel: string }
  /** 紧凑档：卡片只留"名字 + 端口"，参数与预览都收起来（画布工具条上切） */
  compact?: boolean
}

const statusMeta: Record<NodeRunStatus, { label: string; className: string }> = {
  idle: { label: '', className: '' },
  pending: { label: '等待', className: 'st-pending' },
  running: { label: '运行中', className: 'st-running' },
  done: { label: '完成', className: 'st-done' },
  failed: { label: '失败', className: 'st-failed' },
}

/**
 * 这个端口的输出是不是"就是一个数"。是的话直接把它写在端口那一行上。
 *
 * 判据只有两条：**只有一个值**，而且那个值已经躺在输出摘要里（不用再去引擎取行）。
 * 所以函数 `return {"out": 3.7}`、标量指标这类输出会当场显出数来，而多指标（评估打分
 * 那份 8 个数的字典）与表类输出都不在这里挤 —— 前者该看探针与详情，后者根本不是一个数。
 *
 * 表类输出刻意不显示：一张 1×1 的表确实"就是一个数"，但要看到它得再去引擎取一次行值，
 * 而画布上几十个节点每次都去取一次，代价落在最不该花时间的地方（交互）。
 *
 * `null` 是算出来的 NaN / Inf（协议里就写 null），所以它显示成「—」而不是"没有值"：
 * 这两件事必须区分得开，否则会把"算出来了但不是一个有限数"看成"还没算"。
 */
function scalarOutput(ref: OutputRef | undefined): string | null {
  if (!ref || ref.kind !== 'metrics') return null
  const entries = Object.values(ref.values ?? {})
  if (entries.length !== 1) return null
  const v = entries[0]
  return v === null || v === undefined ? '—' : formatNumber(v)
}

/**
 * 引擎节点的状态徽标。
 *
 * 和"运行"那套分开：引擎节点没有"运行"这个动作，它是接线即算的，
 * 所以要说的是"算完了没有"，而不是"跑没跑过"。
 */
const engineStatusMeta: Record<string, { label: string; className: string }> = {
  idle: { label: '', className: '' },
  computing: { label: '计算中', className: 'st-running' },
  ready: { label: '已算', className: 'st-done' },
  error: { label: '失败', className: 'st-failed' },
  blocked: { label: '跳过', className: 'st-pending' },
  cancelled: { label: '已取消', className: 'st-cancelled' },
  manual: { label: '', className: '' },
}

export function WorkflowNodeView({ data, selected }: NodeProps) {
  const {
    node,
    runtimeNodeId = (data as ScivizNodeData).node.id,
    status,
    durationMs,
    connectedPorts,
    upstreamLabels,
    probe,
    compact = false,
  } = data as ScivizNodeData
  const def = getNodeTypeDef(node.type)
  const isGroup = node.type === WORKFLOW_GROUP_TYPE && Boolean(node.group)
  const cat = categoryMeta[def.category]
  const visibleParamPorts = useWorkflowStore((s) => s.visibleParamPorts)
  const activeGroupPath = useWorkflowStore((s) => s.activeGroupPath)
  // 只有真实执行引擎节点才会显示实时结果。
  const engineNode = isEngineNode(node.type)
  const runtime = useNodeRuntime(runtimeNodeId)
  const allModelArtifacts = useNodeOutputStore((s) => s.modelArtifacts)
  const modelArtifacts = allModelArtifacts.filter((artifact) => artifact.nodeId === runtimeNodeId)
  const currentArtifactId = modelArtifacts.find(
    // 与调度器同一条判据：比"同一个计算的身份"，位置（在不在组块里）不算内容
    (artifact) =>
      runtime.inputsFingerprint !== null &&
      trainingIdentity(artifact.trainingFingerprint) === trainingIdentity(runtime.inputsFingerprint),
  )?.artifactId
  // 输出摘要：端口上那个数就显示在这里，不需要"运行"一次去问
  const refs = useNodeRefs(runtimeNodeId)
  const backend = useBackendKind()
  const cancelNode = useWorkflowStore((s) => s.cancelNode)
  const startNode = useWorkflowStore((s) => s.startNode)
  const retryNode = useWorkflowStore((s) => s.retryNode)
  // 节点自报的元信息（设备、版本…）。指标只收数值，这类事实走它
  const metaText = runtime.meta ? Object.entries(runtime.meta).map(([k, v]) => `${k} ${v}`).join(' · ') : ''
  // 共享边界之外的算子（AGENTS.md R4）：判据来自清单，不在这里写类型名
  const hostOnly = def.requires?.runtime === 'host'
  const isTrainingFunction = node.type === 'train.function'
  const isTrainingNode = ['train.function', 'train.custom', 'train.mlp', 'train.cnn1d'].includes(node.type)
  const hasUnusableSavedModel =
    modelArtifacts.length > 0 &&
    (runtime.status === 'error' || Boolean(runtime.inputsFingerprint && !currentArtifactId))
  const st = engineNode ? engineStatusMeta[runtime.status] : statusMeta[status]

  // 取消按钮的两个条件：**这个执行面做得到**（只有本地宿主），以及**已经跑了一会儿**。
  // 后者刻意用"跑了两秒"这个事实，而不是清单里的 execClass 声明 ——
  // 用户写的一段长脚本也该能取消，而它声明的是 interactive。
  // 组块状态聚合自内部步骤，但取消必须落到具体运行节点；外层组块 id 不能停止子图。
  const canCancel = backend === 'local' && !isGroup
  const [slow, setSlow] = useState(false)
  const [cancelRequested, setCancelRequested] = useState(false)
  const [cancelFailed, setCancelFailed] = useState(false)
  useEffect(() => {
    if (runtime.status !== 'computing') {
      // 不再算了就把这三样都复位：下一次计算该从干净的状态开始
      setSlow(false)
      setCancelRequested(false)
      setCancelFailed(false)
      return
    }
    const timer = setTimeout(() => setSlow(true), 2000)
    return () => clearTimeout(timer)
  }, [runtime.status])

  const { inputs, outputs } = resolvePorts(node, usePortContext())

  const connected = new Set(connectedPorts ?? [])
  const dataInputs = inputs.filter((p) => p.kind !== 'param')
  const paramPorts = inputs.filter((p) => p.kind === 'param' && (
    !p.optional || connected.has(p.id) || visibleParamPorts.includes(JSON.stringify([...activeGroupPath, node.id, p.id]))
  ))

  const isSource = node.type === 'data.source'
  const isPreview = node.type === 'data.preview'
  /*
   * 图直接画在框上的节点。判据是"引擎算得出来 + 有一个 figure 输出端口"，不写类型名 ——
   * 以后再有出图的引擎算子（残差图、叠加对比…）不用回来加第二个 if。
   *
   * 必须带上"引擎算得出来"这一半，避免未知节点被当成可视化结果。
   */
  // 训练曲线由专用 TrainingCurve 绘制，避免把模型训练产物混成普通数据绘图块。
  const showsFigure = engineNode && !node.type.startsWith('train.') && outputs.some((p) => p.type === 'figure')
  const hasCustom = def.category === 'custom' && !isGroup
  const emptyBody = dataInputs.length === 0 && paramPorts.length === 0 && !isSource

  return (
    <div
      className={`wf-node ${isGroup ? 'wf-node-group' : ''} ${isPreview || showsFigure ? 'wf-node-wide' : ''} ${compact ? 'wf-node-compact' : ''} ${selected ? 'selected' : ''} ${st.className}`}
    >
      <div className="wf-node-head" style={{ borderLeftColor: cat.color }}>
        <span className="wf-node-cat" style={{ color: cat.color }}>
          {isGroup ? '组块' : cat.label}
        </span>
        <span className="wf-node-title">{node.label}</span>
        {hasCustom && (
          <span className="wf-node-badge" title="含自定义代码，分享时请留意">
            ⚠ 代码
          </span>
        )}
        {hostOnly && (
          <span
            className={`wf-node-badge host ${backend === 'local' ? 'host-local' : backend === null ? 'host-pending' : ''}`}
            title={
              backend === 'local'
                ? `当前选择本地执行模式；运行时仍需宿主保持在线。${def.requires?.reason ?? ''}`
                : backend === 'pyodide'
                  ? `${def.requires?.reason ?? '需要本地宿主'}。当前使用浏览器引擎，启动宿主后刷新页面才能运行`
                  : `正在检查可用执行模式。${def.requires?.reason ?? '需要本地宿主'}`
            }
          >
            {backend === 'local' ? '本地模式' : backend === 'pyodide' ? '需宿主' : '检查中'}
          </span>
        )}
        {st.label && (
          /*
           * 徽标带上原因：组块卡片只会显示"跳过"，而"为什么跳过"必须能问得到 ——
           * 否则用户看到的就是"这一步没结果，且没人说为什么"（训练块还没开始、
           * 上游被取消、上游出错，三种完全不同的事情长得一模一样）。
           * 组块的聚合状态把子节点的原因带出来了（见 graphRunner.aggregateGroupRuntime）。
           */
          <span className={`wf-node-status ${st.className}`} title={runtime.error?.message || undefined}>
            {runtime.status === 'ready' && runtime.loadedFromArtifact ? '已加载/已训练' : st.label}
          </span>
        )}
        {/*
         * 长任务的取消入口。
         *
         * 出现的条件是**已经跑了两秒**，而不是"清单说它是 background 级"：
         * 声明是给人看的，而"已经跑了两秒"是事实 —— 用户写的一段长脚本也该能取消。
         * 快速节点上按钮一出现就消失（闪一下），比没有按钮更烦人。
         *
         * 浏览器引擎那一侧不出现：Pyodide 里跑的是同步 Python，中断插不进去
         * （见 backend.cancelNode 的注释）。宁可没有按钮，也不给一个按下去没反应的。
         */}
        {!isTrainingFunction && canCancel && runtime.status === 'computing' && slow && (
          <button
            className="wf-node-run nodrag cancel"
            disabled={cancelRequested}
            title={
              cancelRequested
                ? '已经请引擎停下了。它会在下一个可中断点结束（通常不到一秒），这期间还在算'
                : '请引擎在下一个可中断点停下这次计算。停下之后这个节点可以重跑'
            }
            onClick={() => {
              setCancelRequested(true)
              if (!cancelNode(node.id)) {
                setCancelRequested(false)
                setCancelFailed(true)
              }
            }}
          >
            {cancelRequested ? '取消中…' : '■ 取消'}
          </button>
        )}
        {!isTrainingFunction && runtime.status === 'cancelled' && (
          <button
            className="wf-node-run nodrag"
            title="这次被取消了，没有产出。点这里重新算一遍"
            onClick={() => retryNode(node.id)}
          >
            ▶ 重跑
          </button>
        )}
      </div>

      {isGroup && (
        <div className="wf-group-summary nodrag" title="双击进入组块内部编辑">
          <span>
            {node.group!.workflow.nodes.length > 0
              ? `包含 ${node.group!.workflow.nodes.length} 个步骤`
              : '画布批注子空间'}
          </span>
          <span className="wf-group-open-hint">双击编辑内部</span>
        </div>
      )}

      {/*
       * 进度条。**只有引擎真的报了进度才画** —— 拿一个编的比例画出来，
       * 它就从"这个长任务还活着"变成了装饰。引擎不报进度的节点只有状态徽标。
       */}
      {runtime.status === 'computing' && runtime.progress ? (
        <div className="wf-node-progress" title={runtime.progress.message || undefined}>
          <div
            className="wf-node-progress-bar"
            style={{ width: `${Math.max(1, Math.round(runtime.progress.ratio * 100))}%` }}
          />
          <span className="wf-node-progress-text">
            {Math.round(runtime.progress.ratio * 100)}%
            {runtime.progress.message ? ` · ${runtime.progress.message}` : ''}
          </span>
        </div>
      ) : null}

      {isTrainingFunction ? (
        <div className="wf-training-controls nodrag">
          {runtime.status === 'computing' ? (
            <button
              className="wf-training-button stop"
              disabled={!canCancel || cancelRequested}
              title={
                !canCancel
                  ? '当前没有连接本地宿主，无法停止训练'
                  : cancelRequested
                    ? '停止请求已发送，正在等待训练函数到达下一个检查点'
                    : '停止当前训练；已完成的模型和曲线不会作为本次结果保留'
              }
              onClick={() => {
                setCancelRequested(true)
                if (!cancelNode(node.id)) {
                  setCancelRequested(false)
                  setCancelFailed(true)
                }
              }}
            >
              {cancelRequested ? '停止中…' : '■ 停止训练'}
            </button>
          ) : (
            <button
              className="wf-training-button start"
              disabled={backend !== 'local'}
              title={
                backend === 'local'
                  ? runtime.status === 'ready'
                    ? '使用当前模型定义、数据和参数重新训练'
                    : '使用当前模型定义、训练集和测试集开始训练'
                  : '训练需要本地宿主；宿主连接成功后才能开始'
              }
              onClick={() => startNode(node.id)}
            >
              {runtime.status === 'ready' ? '▶ 重新训练' : '▶ 开始训练'}
            </button>
          )}
          <span className="wf-training-control-note">
            {runtime.status === 'computing'
              ? '训练正在宿主中运行'
              : runtime.status === 'ready'
                ? runtime.loadedFromArtifact
                  ? '已从本机制品加载，可直接用于预测；没有重新训练'
                  : '当前训练已完成'
                : runtime.status === 'cancelled'
                  ? '上次训练已停止，可重新开始'
                  : runtime.status === 'error'
                    ? '修正错误后可重新开始'
                    : '调整好参数后手动开始，不会自动占用 GPU'}
          </span>
        </div>
      ) : null}

      {!isTrainingFunction && isTrainingNode && hasUnusableSavedModel && runtime.status !== 'computing' ? (
        <div className="wf-training-controls nodrag">
          <button
            className="wf-training-button start"
            disabled={backend !== 'local'}
            title={
              backend === 'local'
                ? '按当前设置重新训练；会创建新的制品，已保存的旧版本会保留'
                : '训练需要本地宿主；宿主连接成功后才能开始'
            }
            onClick={() => startNode(node.id)}
          >
            ▶ 重新训练
          </button>
          <span className="wf-training-control-note">
            旧制品仍保留；重新训练会创建新的模型版本
          </span>
        </div>
      ) : null}

      {cancelFailed ? (
        <div className="wf-node-err">
          <div className="wf-node-err-msg">取消请求没送出去：现在没连上本地宿主。</div>
        </div>
      ) : null}

      {/*
       * 产物（训练节点才有）。路径是**宿主机器上的**绝对路径，所以只显示文件名，
       * 完整路径放进 tooltip —— 它换台机器就不成立了，而指纹在运行清单里。
       */}
      {(runtime.artifacts ?? []).length > 0 ? (
        <div className="wf-node-artifacts">
          {runtime.artifacts!.map((a) => (
            <span key={`${a.kind}:${a.path}`} className="wf-node-artifact" title={a.path}>
              产物 {a.kind} · {a.path.split(/[\\/]/).pop()}
            </span>
          ))}
        </div>
      ) : null}

      {modelArtifacts.length > 0 ? (
        <div className="wf-node-artifacts" aria-label="已保存模型制品">
          {modelArtifacts.map((artifact) => (
            <span
              key={artifact.artifactId}
              className="wf-node-artifact"
              title={`artifact_id ${artifact.artifactId}\n训练指纹 ${artifact.trainingFingerprint}`}
            >
              {artifact.artifactId === currentArtifactId ? '当前制品' : '历史/已过期制品'} ·{' '}
              {artifact.artifactId.slice(0, 12)}
            </span>
          ))}
        </div>
      ) : null}

      {/* 元信息：指标里放不下的"数字之外的事实"（用了哪块 GPU、哪一版 torch） */}
      {metaText ? (
        <div className="wf-node-meta" title={metaText}>
          {metaText}
        </div>
      ) : null}

      {runtime.status === 'error' && runtime.error ? (
        <div className="wf-node-err">
          <div className="wf-node-err-msg">{runtime.error.message}</div>
          {runtime.error.traceback ? (
            <details className="wf-preview-tb">
              <summary>traceback</summary>
              <pre>{runtime.error.traceback}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      {/* ---------- 输入：数据端口 ---------- */}
      {dataInputs.length > 0 && (
        <div className="wf-rows">
          {dataInputs.map((port) => {
            const on = connected.has(port.id)
            return (
              <div className="wf-row" key={port.id}>
                <Handle
                  id={port.id}
                  type="target"
                  position={Position.Left}
                  className="wf-handle"
                  style={{ background: portTypeMeta[port.type].color }}
                  title={`${port.label} · ${portTypeMeta[port.type].label}${port.optional ? '（可选）' : ''}`}
                />
                <span className="wf-row-label" title={port.label}>
                  {port.label}
                </span>
                {/* 上游是数据源时显示具体列名而不是"已连接" —— 一眼看出这张图画的是哪一列 */}
                <span
                  className={`wf-row-value ${on ? 'on' : 'off'} ${
                    upstreamLabels[port.id] ? 'is-col' : ''
                  }`}
                  title={upstreamLabels[port.id]}
                >
                  {on
                    ? (upstreamLabels[port.id] ?? '已连接')
                    : port.optional
                      ? '可选'
                      : '待连接'}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* 仅显示必接、已接线或用户临时展开的参数端口。默认值在右侧栏编辑。 */}
      {paramPorts.length > 0 && (
        <div className="wf-rows">
          {paramPorts.map((port) => {
            const on = connected.has(port.id)
            return (
              <div className="wf-row" key={port.id}>
                <Handle
                  id={port.id}
                  type="target"
                  position={Position.Left}
                  className="wf-handle wf-handle-param"
                  title={`${port.label}${port.optional ? '（有默认值，可不接线）' : '（必接）'}`}
                />
                <span className={`wf-row-label ${on ? 'wired' : ''}`} title={port.label}>
                  {port.label}
                </span>
                <span className={`wf-row-value ${on ? 'on' : 'off'}`}>
                  {on ? '已连接' : port.optional ? '可接线' : '待连接'}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* ---------- 数据预览：接线即出数。显示的是上游的真实输出，不依赖"运行" ---------- */}
      {!compact && isPreview && (
        <ProbePanel
          upstreamNodeId={probe?.upstreamNodeId ?? null}
          upstreamPortId={probe?.upstreamPortId ?? null}
          upstreamLabel={probe?.upstreamLabel ?? ''}
          rows={Number(node.params.rows) > 0 ? Math.floor(Number(node.params.rows)) : 5}
        />
      )}

      {/* ---------- 训练节点：曲线直出。跑完就有走势，不必再接一个图表节点 ---------- */}
      {!compact && node.type.startsWith('train.') && (
        <TrainingCurve nodeId={runtimeNodeId} position={node.position} />
      )}

      {/* ---------- 出图的节点：图直出。接上数据就画，不需要先运行一次 ---------- */}
      {!compact && showsFigure && <ChartPreview node={node} />}

      {/*
       * 早停没接验证集：这一句必须在**动手之前**出现在框上。
       *
       * 训练完再看元信息里那句"盯训练损失"已经晚了 —— 而"用训练损失早停"防不了过拟合
       * （训练损失只会一路向下，于是它几乎不会触发，或者停在毫无意义的一轮）。
       * 验证集这个端口一直是可选的（不接也能训），所以这里不报错，只把代价说清楚。
       */}
      {String(node.type).startsWith('train.') &&
        !!node.params.earlyStop &&
        !connected.has('val') && (
          <div className="wf-node-warn">
            早停没接验证集：只能盯训练损失，防不了过拟合 —— 把外部准备好的<b>验证集</b>接到这个框上
          </div>
        )}

      {/* ---------- 数据源：唯一整表端口 ---------- */}
      {isSource && (
        <div className="wf-rows">
          {!String(node.params.datasetId ?? '') && (
            <div className="wf-row wf-row-inline">
              <span className="wf-row-value">未选择数据集</span>
            </div>
          )}
          {outputs.map((port) => (
              <div className="wf-row wf-row-out" key={port.id}>
                <span className="wf-row-label" title={port.label}>
                  {port.label}
                </span>
                <Handle
                  id={port.id}
                  type="source"
                  position={Position.Right}
                  className="wf-handle"
                  style={{ background: portTypeMeta[port.type].color }}
                  title={`${port.label} · ${portTypeMeta[port.type].label}`}
                />
              </div>
            ))}
        </div>
      )}

      {/* ---------- 输出 ---------- */}
      {!isSource && outputs.length > 0 && (
        <div className="wf-rows wf-rows-out">
          {outputs.map((port) => {
            const ref = refs?.[port.id]
            const scalar = scalarOutput(ref)
            return (
              <div className="wf-row wf-row-out" key={port.id}>
                <span className="wf-row-label" title={port.label}>
                  {port.label}
                </span>
                  {scalar && (
                   <span
                    className="wf-row-out-value"
                    title={`${port.label} = ${scalar}`}
                  >
                    {scalar}
                  </span>
                )}
                <Handle
                  id={port.id}
                  type="source"
                  position={Position.Right}
                  className="wf-handle"
                  style={{ background: portTypeMeta[port.type].color }}
                  title={`${port.label} · ${portTypeMeta[port.type].label}`}
                />
              </div>
            )
          })}
        </div>
      )}

      {emptyBody && !isSource && outputs.length === 0 && (
        <div className="wf-rows">
          <div className="wf-row wf-row-inline">
            <span className="wf-row-value">在右侧面板配置</span>
          </div>
        </div>
      )}

      {durationMs !== undefined && status === 'done' && (
        <div className="wf-node-duration">{(durationMs / 1000).toFixed(1)}s</div>
      )}
    </div>
  )
}
