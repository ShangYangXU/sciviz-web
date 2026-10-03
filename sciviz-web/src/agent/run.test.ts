import test from 'node:test'
import assert from 'node:assert/strict'

import { artifactLookupOf } from './run'
import { runtimeNodeIdForPath } from '../workflow/groups'
import type { ProjectModelArtifactRef } from '../workflow/project'

/**
 * 无头运行也要读工程里的模型制品引用。
 *
 * 这条是"训练一次就好了"在命令行那一半：CLI 曾经完全不看 `modelArtifacts`
 * （`runProject` 的依赖里没有这一项），于是界面重开能恢复、命令行跑一遍却把模型重训了一次。
 */

const NEW_STYLE = 'train.mlp\u0002epochs=50\u0002train=port:n1:__table__@up#1'
const OLD_STYLE = 'train.mlp\u0002epochs=50\u0002train=port:group:["g1"]:"n1":__table__@up#1'

const ref = (nodeId: string, trainingFingerprint: string, artifactId: string): ProjectModelArtifactRef => ({
  nodeId,
  artifactId,
  trainingFingerprint,
  manifestSha256: 'f'.repeat(64),
  createdAt: '2026-09-21T08:00:00Z',
})

test('CLI 按同一条身份规则挑制品：块进了子空间，训好的权重照样认得出', () => {
  const inner = runtimeNodeIdForPath(['g1'], 'trainer')
  const lookup = artifactLookupOf([ref(inner, OLD_STYLE, 'a'.repeat(32))])

  const hit = lookup(inner, NEW_STYLE)
  assert.equal(hit?.artifactId, 'a'.repeat(32), '封装前后的指纹只是位置不同，要认得出')
  assert.equal(hit?.trainingFingerprint, OLD_STYLE, '带的必须是引用里那份：宿主拿它和 meta.json 严格比对')

  assert.equal(lookup(inner, '别的计算'), undefined, '对不上就是没有，绝不拿别的制品顶上')
  assert.equal(lookup('trainer', NEW_STYLE), undefined, '另一个节点（根层同名 id）的引用不能串')
})

test('同一个节点保存了多条引用时取最近保存的那一条', () => {
  const lookup = artifactLookupOf([
    ref('trainer', NEW_STYLE, '1'.repeat(32)),
    ref('trainer', NEW_STYLE, '2'.repeat(32)),
  ])
  assert.equal(lookup('trainer', NEW_STYLE)?.artifactId, '2'.repeat(32))
})
