export const SCHEDULE_TOOLS = ['schedule_create', 'schedule_list', 'schedule_view', 'schedule_edit'];

// Preset-local restrictions leave the host and other presets untouched.
export function restrictToPresetTools(ctx, names) {
  const allowed = new Set(names);
  const inherited = ctx.tools.schemas().map(t => t.name).filter(name => name !== 'run_code' && !allowed.has(name));
  ctx.effect(() => ctx.tools.restrict({ deny: inherited }), 'whale-watch inherited tools');
  // Cover tools registered after this preset was mounted, too. run_code is the
  // reserved PTC transport; its end-capability calls pass this guard separately.
  ctx.effect(() => ctx.tools.guard(exec => allowed.has(exec.name) || exec.name === 'run_code' ? undefined
    : '当前鲸声守望模式只允许专用工具；不能通过浏览器、终端或委派绕行。缺少能力时请直接说明。'), 'whale-watch tool guard');
}
