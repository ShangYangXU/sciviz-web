/**
 * 算子实现的哈希 —— **由 scripts/gen-operator-hashes.mjs 生成，不要手改**。
 *
 * 它进 `nodeFingerprint`。没有它，改一次算子实现，图里已算出的节点指纹不变，
 * 界面会继续把旧结果显示为"最新" —— 同图、同参数、不同结果，而系统不报警。
 *
 * 哈希的构成：函数的源码 + 该文件的模块上下文（imports 与模块级常量）。
 * 所以改常量会让同一文件里的算子**一起**失效 —— 宁可多失效，不能少失效。
 * 新增算子不改变已有算子的哈希（OPERATORS 表本身不进哈希）。
 *
 * 重新生成：`node scripts/gen-operator-hashes.mjs`
 * 忘了重新生成会让 `npm test` 失败（见 operatorHashes.test.ts），不会静默过期。
 */

/** 节点类型 → 实现哈希。查不到的（函数节点、自建模块）取空串 */
export const OPERATOR_IMPLEMENTATION_HASHES: Record<string, string> = {
  'custom.model':
    '8983eee514ea019543cc5bca5b9a91d4c96c336865412a33491a32c34f943b41',
  'data.collect':
    'c5216f4f2e5af7ae2c41d91e16aa64bd4de832b5b3caed797523fd6dd22b0cae',
  'data.columns':
    '4b2cb87554aad17f4e32181a5ad4dff3c9e75865598b1011925fdab4af783d8b',
  'data.preview':
    '6205e144923bb4db16be5a3ab826050ef630ffeaf4489c111eedc4bc83f37e95',
  'data.source':
    '3576e0cfbb6f4a8ded64b136fb23b5b370f068367e6a2e31016ce5daf95dec52',
  'eval.score':
    '882baabdb55d6a6e53edae9caee6572da87fefed2886623c76bb038c989083b5',
  'model.predict':
    'e93c2fbb779c145f08ae0c81347ad4d5bc71488f100d4da6286389e4c5674f78',
  'train.cnn1d':
    'fe2482cd2ed564058548f2b5591f6aaaaa9448922770f79de6d9af460ebd123e',
  'train.custom':
    'dac0652af281d3a845d3e8eeebc82fa7bec2864bf7f0ab436ad99e05c64be8c6',
  'train.function':
    '4f20827a98dccc32965914b87dac045894b7eed4fd9d974229050fac91576031',
  'train.mlp':
    '547cc98633dd5b23d82ecd09222aa7c4583bcb73b69dd488bc7cfd74bd529bfd',
  'viz.chart':
    '02d1565445438dc21bc5bb5010aa01ecceb7a900bad983cb5a78fd71bfe928c4',
  'viz.density':
    'ebbe3a6f9faefff50f9f50bd907e5b237297ed57a8cc6344550bbc5d7a73f1d1',
}

/**
 * 源文件 → 模块上下文哈希。
 * 算子哈希由它和函数体一起算出，所以这一项变了，那个文件里所有算子都会变。
 * 排障时先看它：能一眼分清"是函数改了"还是"是常量改了"。
 */
export const OPERATOR_MODULE_CONTEXT_HASHES: Record<string, string> = {
  'sciviz-local/sciviz_host/gpu_ops.py': 'd11449be078cd814dd0985541a3bd066ed5197ffff5b28be3265ce9b91106fd6',
  'sciviz-web/src/engine/python/operators.py': 'b29b1c35fe4b23529be898947adc1859e90fd27f384d5fb87726fc1159b30f3e',
}

/** 生成时读了哪些文件。换路径时这份清单跟着变，便于看出哈希为何整体变了 */
export const OPERATOR_HASH_SOURCES: string[] = [
  'sciviz-web/src/engine/python/operators.py',
  'sciviz-local/sciviz_host/gpu_ops.py',
]
