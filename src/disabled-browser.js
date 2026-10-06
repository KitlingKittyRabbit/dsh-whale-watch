export const BROWSER_DISABLED_MESSAGE = '浏览器采集已停用，待风控问题解决后再考虑恢复。请使用数据 API 或导入原文；原帖可由你手动打开。';
// No browser process, page, login or automatic navigation exists in this adapter.
export class DisabledBrowser {
  context = null;
  async login() { throw new Error(BROWSER_DISABLED_MESSAGE); }
  async openNote() { throw new Error(BROWSER_DISABLED_MESSAGE); }
  async *collect() { throw new Error(BROWSER_DISABLED_MESSAGE); }
  async close() {}
}
