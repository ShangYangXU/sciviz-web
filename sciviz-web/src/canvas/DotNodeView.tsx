import { Handle, Position, type NodeProps } from '@xyflow/react'
import { getNodeTypeDef } from '../workflow/nodeRegistry'
import { useNodeRuntime } from '../store/nodeOutputStore'
import { portTypeMeta } from '../workflow/types'
import type { ScivizNodeData } from './WorkflowNodeView'

/**
 * 圆点形状的节点：左边一个入口、右边一个出口、中间一个 ＋。
 *
 * 给"只做一件事、没有参数"的节点用（现在是列拼表）。这类节点画成卡片的话，
 * 框上那一堆行全是噪声 —— 用户要看的是"这里能接好几路"，不是又一张 216px 宽的表。
 *
 * 左边那个入口**能接任意多根线**（多入端口，契约规格 R13），所以圈上写的是 ＋
 * 而不是一个普通的端口点：它在说"往这儿接，接几个都行"。
 */
export function DotNodeView({ id, data, selected }: NodeProps) {
  const { node, runtimeNodeId = id, connectedPorts } = data as ScivizNodeData
  const def = getNodeTypeDef(node.type)
  const runtime = useNodeRuntime(runtimeNodeId)
  const wired = (connectedPorts ?? []).filter((p) => p === 'in').length
  const inPort = def.inputs.find((p) => p.id === 'in')
  const outPort = def.outputs[0]
  const color = (t: string) => portTypeMeta[t as keyof typeof portTypeMeta]?.color ?? '#9aa3ad'

  return (
    <div className={`wf-dot-wrap${selected ? ' selected' : ''}`}>
      <div className={`wf-dot${wired > 0 ? ' wired' : ''}${runtime.status === 'error' ? ' st-error' : ''}`}>
        {inPort && (
          <Handle
            id={inPort.id}
            type="target"
            position={Position.Left}
            className="wf-handle"
            style={{ background: color(inPort.type) }}
            title={`${inPort.label} · 可以接任意多根线`}
          />
        )}
        <span className="wf-dot-plus" aria-hidden="true">
          ＋
        </span>
        {outPort && (
          <Handle
            id={outPort.id}
            type="source"
            position={Position.Right}
            className="wf-handle"
            style={{ background: color(outPort.type) }}
            title={`${outPort.label} · ${portTypeMeta[outPort.type as keyof typeof portTypeMeta]?.label ?? outPort.type}`}
          />
        )}
      </div>
      <div className="wf-dot-label" title={node.label}>
        {node.label}
        {wired > 0 && <b>{` ×${wired}`}</b>}
      </div>
      {/* 出错要说出来：圆点小到放不下那句话，但"什么都不报"是更糟的选择 */}
      {runtime.status === 'error' && runtime.error && (
        <div className="wf-dot-err" title={runtime.error.message}>
          {runtime.error.message.length > 26 ? `${runtime.error.message.slice(0, 26)}…` : runtime.error.message}
        </div>
      )}
    </div>
  )
}
