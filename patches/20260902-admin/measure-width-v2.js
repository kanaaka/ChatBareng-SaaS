// v0.3.3 diagnosis — ukur empiris lebar card Templates vs Users (mobile viewport)
// Perbaikan v2: domcontentloaded+timeout (bukan networkidle — socket.io bikin hang),
// cache dinonaktifkan via CDP, satu sesi untuk kedua halaman.
const { chromium } = require('/home/kanakxxx/.openclaw/workspace/node_modules/playwright');
const jwt = require('/home/kanakxxx/.openclaw/workspace/wa-cs-hub/node_modules/jsonwebtoken');
const config = require('/home/kanakxxx/.openclaw/workspace/wa-cs-hub/src/config');

(async () => {
  const token = jwt.sign({ id: 1, username: 'admin', role: 'admin' }, config.jwtSecret, { expiresIn: '10m' });
  const user = JSON.stringify({ id: 1, username: 'admin', role: 'admin' });

  const browser = await chromium.connectOverCDP('http://localhost:18801');
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto('http://localhost:5030/login', { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.evaluate(([t, u]) => {
    localStorage.setItem('token', t);
    localStorage.setItem('user', u);
  }, [token, user]);

  async function measure(path) {
    await page.goto('http://localhost:5030' + path, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);
    return await page.evaluate(() => {
      const vw = window.innerWidth;
      const shell = document.querySelector('.max-w-4xl');
      const listWrap = document.querySelector('div[class*="md:hidden"]');
      const card = listWrap ? listWrap.querySelector(':scope > .bg-white') : null;
      const rs = shell ? shell.getBoundingClientRect() : null;
      const r = card ? card.getBoundingClientRect() : null;
      const overflowers = [...document.querySelectorAll('body *')]
        .filter(el => el.scrollWidth > vw + 2)
        .slice(0, 6)
        .map(el => ({ tag: el.tagName, cls: String(el.className).slice(0, 60), sw: el.scrollWidth }));
      return {
        path: location.pathname,
        vw,
        shell: rs ? {
          left: Math.round(rs.left),
          rightGap: Math.round(vw - rs.right),
          width: Math.round(rs.width),
          maxW: getComputedStyle(shell).maxWidth,
          pad: getComputedStyle(shell).paddingLeft + ' / ' + getComputedStyle(shell).paddingRight,
        } : 'SHELL NOT FOUND',
        card: r ? {
          left: Math.round(r.left),
          rightGap: Math.round(vw - r.right),
          width: Math.round(r.width),
          pct: Math.round((r.width / vw) * 100) + '%',
        } : 'CARD NOT FOUND',
        overflowers,
      };
    });
  }

  const tmpl = await measure('/admin/templates');
  const users = await measure('/admin/users');
  console.log(JSON.stringify({ templates: tmpl, users }, null, 1));
  await page.close();
  console.log('done');
})().catch(e => { console.error('ERR:', e.message); process.exit(1); });