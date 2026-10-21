/** Chart symbols, not photographic extent or calibrated surface brightness. */
export function drawDeepSkySymbol(ctx: CanvasRenderingContext2D, x: number, y: number, type: string, selected = false): void {
  ctx.save(); ctx.strokeStyle = selected ? '#c8dfed' : '#839dab'; ctx.lineWidth = selected ? 1.4 : 1;
  ctx.beginPath();
  if (type === 'G') ctx.ellipse(x, y, 6, 3, -.5, 0, Math.PI * 2);
  else if (['Neb', 'HII', 'RfN', 'SNR', 'Cl+N'].includes(type)) ctx.rect(x - 4, y - 4, 8, 8);
  else { if (type === 'OCl' || type === '*Ass') ctx.setLineDash([2, 2]); ctx.arc(x, y, 4, 0, Math.PI * 2); }
  ctx.stroke(); ctx.restore();
}
export function drawPlanetSymbol(ctx: CanvasRenderingContext2D, x: number, y: number, magnitude: number, color: string, alpha: number): void {
  ctx.save(); ctx.globalAlpha *= alpha; ctx.fillStyle = color;
  const radius = Math.max(1.5, Math.min(3.8, 2.3 - magnitude * .22));
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill(); ctx.restore();
}
