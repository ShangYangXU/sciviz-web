import type { ChartTypeMeta } from '../types'

export const chartTypes: ChartTypeMeta[] = [
  {
    type: 'scatter',
    label: '散点图',
    hint: '看两个连续变量之间的关系，可用颜色区分分组',
    slots: ['x', 'y', 'color'],
    accepts: {
      x: ['continuous'],
      y: ['continuous'],
      color: ['categorical', 'continuous'],
    },
  },
  {
    type: 'line',
    label: '折线图',
    hint: '看随自变量变化的趋势，颜色区分多条序列',
    slots: ['x', 'y', 'color'],
    accepts: {
      x: ['continuous', 'time'],
      y: ['continuous'],
      color: ['categorical'],
    },
  },
  {
    type: 'bar',
    label: '柱状图',
    hint: '比较不同分类下的均值，自动带误差棒',
    slots: ['x', 'y', 'color'],
    accepts: {
      x: ['categorical'],
      y: ['continuous'],
      color: ['categorical'],
    },
  },
  {
    type: 'box',
    label: '箱线图',
    hint: '看分布的四分位数与离群点',
    slots: ['x', 'y', 'color'],
    accepts: {
      x: ['categorical'],
      y: ['continuous'],
      color: ['categorical'],
    },
  },
  {
    type: 'histogram',
    label: '直方图',
    hint: '看单个连续变量的分布形态',
    slots: ['x', 'color'],
    accepts: {
      x: ['continuous'],
      color: ['categorical'],
    },
  },
  {
    type: 'density',
    label: '概率密度图',
    hint: '单个连续变量的概率密度曲线，比直方图平滑、不受分箱数影响',
    slots: ['x'],
    accepts: {
      x: ['continuous'],
    },
  },
]
