import test from 'node:test'
import assert from 'node:assert/strict'
import { promptForSidebarTurn, SIDEBAR_PROMPT_VERSION } from './prompt'

test('侧边问答提示词只允许解释项目，不授权执行操作', () => {
  const prompt = promptForSidebarTurn('{"project":"current"}', '这个项目怎么处理数据？', '用户之前在问导入流程')

  assert.equal(SIDEBAR_PROMPT_VERSION, 'sidebar-readonly-v1')
  assert.match(prompt, /只能解释、总结和给出建议/)
  assert.match(prompt, /不能修改工程或源码/)
  assert.match(prompt, /<当前项目上下文>[\s\S]*current[\s\S]*<\/当前项目上下文>/)
  assert.match(prompt, /<用户问题>[\s\S]*这个项目怎么处理数据？[\s\S]*<\/用户问题>/)
  assert.match(prompt, /历史用户原话与工具事实/)
})
