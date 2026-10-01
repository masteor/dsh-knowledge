import { useCallback, useEffect, useRef, useState } from 'react'

interface ResizableSplitterProps {
  left: React.ReactNode
  right: React.ReactNode
  defaultRatio?: number
  minLeftWidth?: number
  minRightWidth?: number
}

export function ResizableSplitter({
  left,
  right,
  defaultRatio = 0.4,
  minLeftWidth = 200,
  minRightWidth = 300,
}: ResizableSplitterProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(defaultRatio)
  const [isDragging, setIsDragging] = useState(false)

  const handleMouseDown = useCallback(() => {
    setIsDragging(true)
  }, [])

  useEffect(() => {
    if (!isDragging) return

    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current
      if (!container) return

      const containerRect = container.getBoundingClientRect()
      const newLeftWidth = e.clientX - containerRect.left
      const containerWidth = containerRect.width

      // Ensure constraints
      if (newLeftWidth < minLeftWidth || containerWidth - newLeftWidth < minRightWidth) {
        return
      }

      const newRatio = newLeftWidth / containerWidth
      setRatio(Math.max(minLeftWidth / containerWidth, Math.min(newRatio, 1 - minRightWidth / containerWidth)))
    }

    const handleMouseUp = () => {
      setIsDragging(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, minLeftWidth, minRightWidth])

  return (
    <div
      ref={containerRef}
      className="dsh-knowledge-activity-split-container"
      data-dragging={isDragging ? 'true' : 'false'}
    >
      <div className="dsh-knowledge-activity-split-left" style={{ width: `${ratio * 100}%` }}>
        {left}
      </div>
      <div
        className="dsh-knowledge-activity-split-divider"
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Перетащите для изменения размера панелей"
      />
      <div className="dsh-knowledge-activity-split-right" style={{ width: `${(1 - ratio) * 100}%` }}>
        {right}
      </div>
    </div>
  )
}
