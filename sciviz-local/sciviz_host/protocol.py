"""主线程 ↔ 执行宿主 的消息契约（Python 侧）。

与 `sciviz-web/src/engine/protocol.ts` 同构：前端把 Worker 换成 WebSocket 时，
这套消息原样保留，所以这里不做任何"服务端更顺手"的改写。

两处刻意的差异，都是为了不要把大数据编码成 JSON：

1. 数据集不走 JSON 传数值：先发一条 `setDataset`（只描述列名、顺序与类型），
   紧跟着按同一个顺序发等量的二进制帧；
2. 其余消息全部是 JSON 文本。

顺序由 WebSocket 自身保证，所以不需要给每个二进制帧加包头。
"""

from __future__ import annotations

from typing import Literal, NotRequired, TypedDict

OutputKind = Literal["table", "metrics", "figure", "model", "scaler"]
ColumnKind = Literal["time", "column"]
ColumnDType = Literal["float32", "float64"]


class FigureImage(TypedDict):
    """静态 figure 图片：PNG 的 Base64 与原始像素尺寸。"""

    mimeType: Literal["image/png"]
    data: str
    width: int
    height: int


class ColumnMeta(TypedDict):
    """数据集的一列。顺序 = 后面二进制帧的顺序"""

    name: str
    dtype: ColumnDType
    kind: ColumnKind


class DatasetPayload(TypedDict):
    datasetId: str
    rowCount: int
    timeColumn: str | None
    columns: list[ColumnMeta]


class InputBindingPort(TypedDict):
    kind: Literal["port"]
    nodeId: str
    portId: str


class InputBindingLiteral(TypedDict):
    kind: Literal["literal"]
    value: str | int | float | bool


InputBinding = InputBindingPort | InputBindingLiteral


class OutputPortSpec(TypedDict):
    id: str
    shape: Literal["table", "column", "time", "auto"]
    #: 前端端口的语义类型；figure / scaler 等动态输出靠它区分普通表
    kind: NotRequired[OutputKind]


class EvalPayload(TypedDict):
    nodeId: str
    nodeType: str
    params: dict[str, str | int | float | bool]
    inputs: dict[str, InputBinding]
    outputPorts: list[OutputPortSpec]
    #: 主线程算好的输入指纹（见 `nodeFingerprint`）。产物按它归档
    fingerprint: str
    #: 输出摘要中的上游端口身份链（可选，向后兼容旧客户端）
    lineage: NotRequired[list[str]]
    #: 仅工程中保存的精确引用可设置；存在时宿主只恢复制品，绝不重新训练
    restoreArtifactId: NotRequired[str]
    restoreArtifactSha256: NotRequired[str]


class ArtifactRef(TypedDict):
    """落盘的产物。`path` 是**宿主机器上的绝对路径**，`fingerprint` 是产出它的输入指纹"""

    kind: str
    path: str
    bytes: int
    fingerprint: str
    artifactId: NotRequired[str]
    sha256: NotRequired[str]
    createdAt: NotRequired[str]


class HealthBody(TypedDict):
    ok: bool
    backend: Literal["local"]
    agentGatewayVersion: int
    fixedDatasetConfigured: bool
    engine: str
    python: str
    numpy: str
    pandas: str
    #: 可能为 None：scipy 只被一部分共享算子用到，装不上时宿主仍要能提供服务
    scipy: str | None
    device: dict[str, object]
    operators: list[str]


#: 引擎协议的子协议版本。前端握手时对不上就回落，而不是带着错的假设硬连
PROTOCOL_VERSION = 1
