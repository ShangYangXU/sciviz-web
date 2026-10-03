import type { FigureImage } from '../types'

export function figureImageUrl(image: FigureImage): string {
  return `data:${image.mimeType};base64,${image.data}`
}

export function FigureImageView({
  image,
  alt,
  className,
}: {
  image: FigureImage
  alt: string
  className?: string
}) {
  return (
    <img
      className={`wf-figure-image${className ? ` ${className}` : ''}`}
      src={figureImageUrl(image)}
      alt={alt}
      width={image.width}
      height={image.height}
    />
  )
}
