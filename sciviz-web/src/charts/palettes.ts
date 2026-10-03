export interface Palette {
  id: string
  name: string
  /** 分类配色，用尽后循环 */
  categorical: string[]
  /** 连续型配色（低 → 高），用于连续变量的颜色映射 */
  sequential: string[]
  /** 是否色盲友好 */
  colorblindSafe: boolean
}

export const palettes: Palette[] = [
  {
    id: 'okabe-ito',
    name: 'Okabe-Ito（色盲友好）',
    categorical: ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#F0E442', '#000000'],
    sequential: ['#F7FBFF', '#C6DBEF', '#6BAED6', '#2171B5', '#08306B'],
    colorblindSafe: true,
  },
  {
    id: 'viridis',
    name: 'Viridis（感知均匀）',
    categorical: ['#440154', '#3B528B', '#21918C', '#5EC962', '#FDE725', '#46327E', '#31688E'],
    sequential: ['#440154', '#414487', '#2A788E', '#22A884', '#7AD151', '#FDE725'],
    colorblindSafe: true,
  },
  {
    id: 'nature',
    name: 'Nature 期刊风',
    categorical: ['#3C5488', '#E64B35', '#00A087', '#4DBBD5', '#F39B7F', '#8491B4', '#91D1C2', '#DC0000'],
    sequential: ['#F0F4F8', '#B8CDE0', '#7BA7C9', '#4A7FAC', '#2B547E'],
    colorblindSafe: false,
  },
  {
    id: 'lancet',
    name: 'Lancet 期刊风',
    categorical: ['#00468B', '#ED0000', '#42B540', '#0099B4', '#925E9F', '#FDAF91', '#AD002A'],
    sequential: ['#EFF6FB', '#BBD8EA', '#7FB3D5', '#4682B4', '#1F4E79'],
    colorblindSafe: false,
  },
  {
    id: 'mono',
    name: '灰度（黑白印刷）',
    categorical: ['#1A1A1A', '#4D4D4D', '#808080', '#B3B3B3', '#D9D9D9', '#666666', '#999999'],
    sequential: ['#F7F7F7', '#D9D9D9', '#BDBDBD', '#969696', '#636363', '#252525'],
    colorblindSafe: true,
  },
]

export function getPalette(id: string): Palette {
  return palettes.find((p) => p.id === id) ?? palettes[0]
}

/** 给一组分类值分配颜色，返回 value -> color 的映射 */
export function buildColorScale(
  values: (string | number)[],
  palette: Palette,
  continuous: boolean,
): { map: Map<string, string>; domain: string[] } {
  const domain = [...new Set(values.map((v) => String(v)))]

  if (continuous) {
    const nums = domain.map(Number).filter((n) => Number.isFinite(n))
    const min = Math.min(...nums)
    const max = Math.max(...nums)
    const scale = palette.sequential
    const map = new Map<string, string>()
    for (const v of domain) {
      const n = Number(v)
      if (!Number.isFinite(n) || max === min) {
        map.set(v, scale[scale.length - 1])
        continue
      }
      const t = (n - min) / (max - min)
      const idx = Math.min(scale.length - 1, Math.max(0, Math.round(t * (scale.length - 1))))
      map.set(v, scale[idx])
    }
    return { map, domain }
  }

  const map = new Map<string, string>()
  domain.forEach((v, i) => map.set(v, palette.categorical[i % palette.categorical.length]))
  return { map, domain }
}
