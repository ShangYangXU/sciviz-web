/**
 * 从算子注册表读出"与一次运行有关的那几项事实"（版本、实现哈希、执行面、确定性、执行等级）。
 *
 * 单独一个小模块，是为了让界面（`graphRunner`）与 CLI（`agent/run.ts`）拿到**同一份**事实。
 * 两边各写一遍的话，运行清单里的版本号与确定性等级就会各说各话 —— 而那份清单正是
 * 用来回答"这次和上次是不是同一件事"的。
 *
 * `operatorHashes.generated.ts` 虽然住在 `contract/`，但它就是这份清单的一部分
 * （由 `scripts/gen-operator-hashes.mjs` 从算子源码生成），所以在这里读它是自然的。
 */

import { OPERATOR_IMPLEMENTATION_HASHES } from '../contract/operatorHashes.generated'
import { getNodeTypeDef, hasNodeType } from './nodeRegistry'
import type { OperatorFacts } from './types'

export function operatorFactsOf(type: string): OperatorFacts | null {
  if (!hasNodeType(type)) return null
  const def = getNodeTypeDef(type)
  return {
    version: def.version,
    // 用户代码（custom.* / 自建模块）没有实现哈希：它的实现在参数里，已经随参数进指纹
    implementationHash: OPERATOR_IMPLEMENTATION_HASHES[type] ?? null,
    runtimeClass: def.runtimeClass,
    determinism: def.determinism,
    execClass: def.execClass,
    requires: def.requires,
  }
}
