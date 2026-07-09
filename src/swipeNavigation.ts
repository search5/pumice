// Left/right navigation gesture based on Pointer Events (pointerdown/move/up). Touch swipes and
// mouse drags are handled as literally the same events per the browser standard, so desktop and
// mobile run through the exact same code path (no separate touch-only events like touchstart). To
// avoid confusing this with vertical scrolling, onPrev/onNext only fire when the horizontal movement
// is clearly larger than the vertical movement.
export interface SwipeNavigationOptions {
  onPrev: () => void;
  onNext: () => void;
  threshold?: number;
}

export function enableSwipeNavigation(el: HTMLElement, opts: SwipeNavigationOptions): () => void {
  const threshold = opts.threshold ?? 60;
  let startX = 0;
  let startY = 0;
  let pointerId: number | null = null;

  const onPointerDown = (e: PointerEvent) => {
    if (pointerId !== null) return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    pointerId = null;
    if (Math.abs(dx) > threshold && Math.abs(dx) > Math.abs(dy)) {
      if (dx < 0) opts.onNext();
      else opts.onPrev();
    }
  };

  const onPointerCancel = () => {
    pointerId = null;
  };

  el.addEventListener("pointerdown", onPointerDown);
  el.addEventListener("pointerup", onPointerUp);
  el.addEventListener("pointercancel", onPointerCancel);

  return () => {
    el.removeEventListener("pointerdown", onPointerDown);
    el.removeEventListener("pointerup", onPointerUp);
    el.removeEventListener("pointercancel", onPointerCancel);
  };
}
